import { codeSeconds, createSession, signature } from './session.mjs';

const emailPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const workEmailPattern = /@bvclogistics\.com$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const hour = 60 * 60 * 1000;

export class AuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function emailAddress(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return email.length <= 254 && emailPattern.test(email) ? email : null;
}

export async function readJson(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json') || !request.body) {
    throw new AuthError('Send the request from the sign-in form.');
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) {
      await reader.cancel();
      throw new AuthError('This request is too large.', 413);
    }
    text += decoder.decode(value, { stream: true });
  }
  try {
    const data = JSON.parse(text + decoder.decode());
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {}
  throw new AuthError('The request could not be read.');
}

export async function reviewerRole(env, email) {
  if (!email) return null;
  if (email === emailAddress(env.REVIEWER_ADMIN_EMAIL)) return 'admin';
  const row = await env.DB.prepare('SELECT role FROM dashboard_reviewers WHERE email = ?').bind(email).first();
  return row?.role === 'reviewer' ? 'reviewer' : null;
}

export function mailReady(env) {
  return Boolean(env.AUTH_SECRET && env.BREVO_API_KEY && emailAddress(env.EMAIL_FROM) && emailAddress(env.REVIEWER_ADMIN_EMAIL));
}

export function workEmail(value) {
  const email = emailAddress(value);
  return email && workEmailPattern.test(email) ? email : null;
}

export async function employeeAllowed(env, email) {
  return Boolean(workEmail(email) && await env.DB.prepare('SELECT email FROM employee_allowlist WHERE email = ?').bind(email).first());
}

function code() {
  const random = new Uint32Array(1);
  const max = 4_294_000_000;
  do { crypto.getRandomValues(random); } while (random[0] >= max);
  return String(random[0] % 1_000_000).padStart(6, '0');
}

async function rateLimit(env, ip, scope) {
  const now = Date.now();
  const expires = (Math.floor(now / hour) + 1) * hour;
  const bucket = await signature(env.AUTH_SECRET, 'rate:' + scope + ':' + (ip || 'unknown') + ':' + expires);
  const result = await env.DB.prepare(`INSERT INTO email_login_rate (bucket, expires_at, attempts) VALUES (?, ?, 1)
    ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1 WHERE attempts < 120
    RETURNING attempts`).bind(bucket, expires).first();
  if (!result) throw new AuthError('Too many code requests. Try again later.', 429);
  if (result.attempts === 1 && Math.random() < 0.03) {
    await env.DB.prepare('DELETE FROM email_login_rate WHERE expires_at < ?').bind(now).run();
  }
}

async function sendCode(env, {email, verificationCode}) {
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      sender: { email: emailAddress(env.EMAIL_FROM), name: 'BVC Foundation Week' },
      to: [{ email }],
      subject: 'Your BVC Foundation Week sign-in code',
      textContent: 'Your BVC Foundation Week sign-in code is ' + verificationCode +
        '. It expires in 10 minutes. If you didn’t request it, you can ignore this message.'
    })
  }).catch(() => null);
  if (!response?.ok) throw new AuthError('We couldn’t send your code. Please try again shortly.', 503);
}

export async function startCode(env, scope, value, ip, currentChallenge = '') {
  const email = emailAddress(value);
  if (!email || (scope === 'employee' && !workEmailPattern.test(email))) {
    throw new AuthError(scope === 'employee' ? 'Enter your @bvclogistics.com work email.' : 'Enter a valid email address.');
  }
  if (!mailReady(env)) {
    throw new AuthError('Email sign-in is not available yet.', 503);
  }
  await rateLimit(env, ip, scope);
  const challenge = crypto.randomUUID();
  if (scope === 'reviewer' && !await reviewerRole(env, email)) return challenge;
  if (scope === 'employee' && !await employeeAllowed(env, email)) return challenge;
  const verificationCode = code();
  const now = Date.now();
  const hash = await signature(env.AUTH_SECRET, 'code:' + scope + ':' + challenge + ':' + verificationCode);
  const inserted = await env.DB.prepare(`INSERT INTO email_login_challenges
    (scope, email, challenge, code_hash, expires_at, sent_at, window_start, send_count, attempts)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)
    ON CONFLICT(scope, email) DO UPDATE SET
      challenge = excluded.challenge, code_hash = excluded.code_hash, expires_at = excluded.expires_at, sent_at = excluded.sent_at,
      send_count = CASE WHEN email_login_challenges.window_start <= ? THEN 1 ELSE email_login_challenges.send_count + 1 END,
      window_start = CASE WHEN email_login_challenges.window_start <= ? THEN excluded.window_start ELSE email_login_challenges.window_start END,
      attempts = 0
    WHERE email_login_challenges.sent_at <= ?
      AND (email_login_challenges.window_start <= ? OR email_login_challenges.send_count < 5)
    RETURNING challenge`).bind(scope, email, challenge, hash, now + codeSeconds * 1000, now, now,
    now - hour, now - hour, now - 60_000, now - hour).first();
  if (!inserted) {
    if (scope === 'reviewer') {
      const current = uuid.test(currentChallenge) && await env.DB.prepare(
        'SELECT challenge FROM email_login_challenges WHERE scope = ? AND email = ? AND challenge = ? AND expires_at > ?'
      ).bind(scope, email, currentChallenge, now).first();
      return current?.challenge || challenge;
    }
    throw new AuthError('Please wait at least one minute before requesting another code.', 429);
  }
  await sendCode(env, { email, verificationCode });
  return challenge;
}

export async function verifyCode(env, scope, challenge, value) {
  if (!env.AUTH_SECRET || !uuid.test(challenge) || typeof value !== 'string' || !/^\d{6}$/.test(value)) {
    throw new AuthError('Enter the six-digit code sent to your email.');
  }
  const hash = await signature(env.AUTH_SECRET, 'code:' + scope + ':' + challenge + ':' + value);
  const now = Date.now();
  const conditions = 'scope = ? AND challenge = ? AND expires_at > ? AND attempts < 5';
  const result = await env.DB.prepare(`UPDATE email_login_challenges SET expires_at = 0, code_hash = ''
    WHERE ${conditions} AND code_hash = ?
    RETURNING email`).bind(scope, challenge, now, hash).first();
  if (!result) {
    await env.DB.prepare(`UPDATE email_login_challenges SET attempts = attempts + 1 WHERE ${conditions}`)
      .bind(scope, challenge, now).run();
    throw new AuthError('That code is incorrect or expired. Enter it again or request a new code.');
  }
  if (scope === 'reviewer' && !await reviewerRole(env, result.email)) throw new AuthError('This email does not have reviewer access.', 403);
  if (scope === 'employee' && !await employeeAllowed(env, result.email)) throw new AuthError('This email does not have employee access.', 403);
  return createSession(result.email, scope, env.AUTH_SECRET);
}

