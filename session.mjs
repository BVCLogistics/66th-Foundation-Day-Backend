const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const sessionName = '__Host-bvc_foundation_session';
export const challengeName = '__Host-bvc_foundation_challenge';
export const sessionSeconds = 8 * 60 * 60;
export const codeSeconds = 10 * 60;

export function cookie(request, name) {
  return request.headers.get('cookie')?.split(';').map(part => part.trim())
    .find(part => part.startsWith(name + '='))?.slice(name.length + 1) || '';
}

export function setCookie(name, value, seconds) {
  return name + '=' + value + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=' + seconds;
}

export function encode(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(value) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
}

function signingKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signature(secret, value) {
  return encode(await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(value)));
}

export async function createSession(email, scope, secret) {
  const body = encode(encoder.encode(JSON.stringify({
    email, scope, expires: Date.now() + sessionSeconds * 1000, nonce: crypto.randomUUID()
  })));
  return body + '.' + await signature(secret, 'session:' + body);
}

export async function sessionEmail(request, scope, secret) {
  return verifiedEmail(cookie(request, sessionName), scope, secret);
}

export async function verifiedEmail(token, scope, secret) {
  if (!secret || !/^[a-z0-9_-]{1,512}\.[a-z0-9_-]{43}$/i.test(token)) return null;
  const [body, mac] = token.split('.');
  try {
    if (!await crypto.subtle.verify('HMAC', await signingKey(secret), decode(mac), encoder.encode('session:' + body))) return null;
    const claims = JSON.parse(decoder.decode(decode(body)));
    return claims.scope === scope && claims.expires > Date.now() && typeof claims.email === 'string' ? claims.email : null;
  } catch {
    return null;
  }
}

export function authResponse(result) {
  const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  if (result.challenge) headers.append('Set-Cookie', setCookie(challengeName, result.challenge, codeSeconds));
  if (result.token) {
    headers.append('Set-Cookie', setCookie(sessionName, result.token, sessionSeconds));
    headers.append('Set-Cookie', setCookie(challengeName, '', 0));
  }
  return Response.json({ ok: true }, { headers });
}

export function signOut() {
  return new Response(null, { status: 303, headers: {
    'Set-Cookie': setCookie(sessionName, '', 0), 'Location': '/', 'Cache-Control': 'no-store'
  } });
}
