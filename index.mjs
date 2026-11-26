import page from './dashboard.html';
import { ZipWriter } from '@zip.js/zip.js/lib/zip-core-writer.js';
import { AuthError, emailAddress, employeeAllowed, mailReady, readJson, reviewerRole, startCode, verifyCode, workEmail } from './email-auth.mjs';
import { authResponse, challengeName, cookie, sessionEmail, signOut, verifiedEmail } from './session.mjs';
import { loginPage } from './login-page.mjs';

const limit = 25 * 1024 * 1024;
const maxRequest = 26 * 1024 * 1024;
const deadline = Date.parse('2026-12-03T00:00:00+05:30');
const activities = {
  drawing: 'Drawing Competition',
  collage: 'A Day in Our Branch',
  campaign: 'Best Ad Campaign',
  journal: 'Grateful Journal'
};
const imageTypes = {
  jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif'
};
const videoTypes = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
const idPattern = /^[a-f0-9]{64}$/;
const requestIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const emailPattern = /^[^@\s]+@bvclogistics\.com$/;
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

function json(body, status = 200) {
  return Response.json(body, { status, headers });
}

class InvalidEntry extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function field(form, key, label, max, required = true) {
  const value = form.get(key);
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && !text) throw new InvalidEntry('Enter ' + label + '.');
  if (text.length > max) throw new InvalidEntry(label + ' must be ' + max + ' characters or fewer.');
  return text || null;
}

async function cappedForm(request) {
  const type = request.headers.get('content-type');
  if (!request.body || !type?.startsWith('multipart/form-data;')) throw new InvalidEntry('Use the entry form to submit.', 415);
  let size = 0;
  let oversized = false;
  const body = request.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > maxRequest) {
        oversized = true;
        controller.error(new Error('Request exceeded the upload limit.'));
        return;
      }
      controller.enqueue(chunk);
    }
  }));
  try {
    return await new Response(body, { headers: { 'content-type': type } }).formData();
  } catch {
    if (oversized) throw new InvalidEntry('Keep all attachments together under 25 MB.', 413);
    throw new InvalidEntry('The entry could not be read. Reopen the form and try again.');
  }
}

function nameFor(file, extension) {
  const stem = file.name.replace(/\.[^.]*$/, '').normalize('NFKC')
    .replace(/[^\p{L}\p{N} ._-]/gu, '_').replace(/^[._\s]+|[.\s]+$/g, '').slice(0, 80);
  return (stem || 'attachment') + '.' + extension;
}

function matchesFile(bytes, extension) {
  const ascii = new TextDecoder('latin1').decode(bytes);
  const starts = (...signature) => signature.every((byte, i) => byte === bytes[i]);
  switch (extension) {
    case 'jpeg': case 'jpg': return starts(255, 216, 255);
    case 'png': return starts(137, 80, 78, 71, 13, 10, 26, 10);
    case 'webp': return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP';
    case 'gif': return /^(GIF87a|GIF89a)/.test(ascii);
    case 'avif': return ascii.slice(4, 8) === 'ftyp' && /avif|avis/.test(ascii.slice(8));
    case 'heic': case 'heif': return ascii.slice(4, 8) === 'ftyp' && /hei[cmsx]|hev[cx]|mif1|msf1/.test(ascii.slice(8));
    case 'mp4': case 'mov': return ascii.slice(4, 8) === 'ftyp' && !/avif|avis|hei[cmsx]|hev[cx]|mif1|msf1/.test(ascii.slice(8));
    case 'webm': return starts(26, 69, 223, 163) && ascii.includes('webm');
    default: return false;
  }
}

async function validateFiles(form, activity) {
  const files = form.getAll('entry-file');
  const child = form.get('child-photo');
  if (activity === 'drawing' && (files.length !== 1 || !child?.size)) {
    throw new InvalidEntry('Add the drawing and a separate photo of your child.');
  }
  if (activity === 'collage' && files.length !== 1) throw new InvalidEntry('Upload one image containing the finished collage.');
  if (activity === 'campaign' && (files.length < 1 || files.length > 6)) throw new InvalidEntry('Upload one to six campaign files.');
  if (activity === 'journal' && files.length) throw new InvalidEntry('Write your journal entry in the text field.');
  const uploads = files.map(file => ({
    file, label: activity === 'drawing' ? 'Drawing' : activity === 'collage' ? 'Branch collage' : 'Campaign media'
  }));
  if (activity === 'drawing') uploads.unshift({ file: child, label: 'Child’s photo' });
  if (uploads.some(({ file }) => !(file instanceof File) || !file.size)) throw new InvalidEntry('Choose a file that is not empty.');
  if (uploads.reduce((total, { file }) => total + file.size, 0) > limit) {
    throw new InvalidEntry('Keep all attachments together under 25 MB.', 413);
  }
  return Promise.all(uploads.map(async ({ file, label }) => {
    const extension = file.name.split('.').at(-1)?.toLowerCase();
    const mime = imageTypes[extension] || (activity === 'campaign' ? videoTypes[extension] : '');
    if (typeof mime !== 'string' || !matchesFile(new Uint8Array(await file.slice(0, 128).arrayBuffer()), extension)) {
      throw new InvalidEntry('Use JPEG, PNG, WebP, GIF, HEIC, HEIF or AVIF images. Campaigns can also use MP4, MOV or WebM videos.', 415);
    }
    return { file, label, mime, name: nameFor(file, extension) };
  }));
}

async function digest(value) {
  const data = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(data), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function saveEntry(request, env) {
  if (!env.INGEST_KEY || request.headers.get('x-bvc-ingest-key') !== env.INGEST_KEY) return json({ error: 'Forbidden' }, 403);
  return saveEmployeeEntry(request, env, request.headers.get('x-bvc-employee-email') || '');
}

async function saveEmployeeEntry(request, env, email) {
  const requestId = request.headers.get('idempotency-key') || '';
  if (!emailPattern.test(email) || !requestIdPattern.test(requestId)) return json({ error: 'Invalid entry identity.' }, 400);
  const id = await digest(email + ':' + requestId);
  if (await env.DB.prepare('SELECT id FROM submissions WHERE id = ?').bind(id).first()) return json({ id: id.slice(0, 16) });
  if (Date.now() >= deadline) return json({ error: 'Submissions closed after 2 December, India time.' }, 409);

  const form = await cappedForm(request);
  const activity = field(form, 'activity', 'an activity', 30);
  if (!Object.hasOwn(activities, activity)) throw new InvalidEntry('Choose an activity.');
  const employee = field(form, 'employee', 'your employee name', 150);
  const code = field(form, 'employee-code', 'your employee code', 60);
  const branch = field(form, 'branch', 'your branch city', 100);
  const childName = activity === 'drawing' ? field(form, 'child-name', 'your child’s name', 150) : null;
  const title = activity === 'campaign' ? field(form, 'campaign-title', 'your campaign title', 200) : null;
  const journal = activity === 'journal' ? field(form, 'journal', 'your journal entry', 8000) : null;
  const files = await validateFiles(form, activity);
  const attempt = crypto.randomUUID();
  const attachments = [];
  const keys = [];
  try {
    for (const [index, file] of files.entries()) {
      const key = id + '/' + attempt + '/' + (index + 1);
      keys.push(key);
      await env.BUCKET.put(key, file.file, { httpMetadata: { contentType: file.mime } });
      attachments.push({ key, name: file.name, mime: file.mime, label: file.label });
    }
  } catch (error) {
    if (keys.length) await env.BUCKET.delete(keys).catch(() => {});
    throw error;
  }
  // If the database result is uncertain, retain the files so any committed record still works.
  const saved = await env.DB.prepare(`INSERT INTO submissions
    (id, activity, employee, employee_code, employee_email, branch, child_name, campaign_title, journal, received_at, attachments)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
    .bind(id, activity, employee, code, email, branch, childName, title, journal, new Date().toISOString(), JSON.stringify(attachments)).run();
  if (!saved.meta.changes && keys.length) await env.BUCKET.delete(keys).catch(() => {});
  return json({ id: id.slice(0, 16) }, saved.meta.changes ? 201 : 200);
}

async function employeeApi(request, env, path) {
  const origin = env.EMPLOYEE_WEB_ORIGIN || 'https://bvclogistics.github.io';
  if (request.headers.get('origin') !== origin) return json({ error: 'Open the Foundation Week employee site to continue.' }, 403);
  const corsHeaders = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  let response;
  try {
    if (request.method === 'GET' && path === '/api/employee/status') {
      response = json({ emailSignInReady: mailReady(env), entriesOpen: Date.now() < deadline });
    } else if (request.method === 'POST' && path === '/api/employee/send-code') {
      const data = await readJson(request);
      response = json({ challenge: await startCode(env, 'employee', data.email, request.headers.get('cf-connecting-ip')) });
    } else if (request.method === 'POST' && path === '/api/employee/verify-code') {
      const data = await readJson(request);
      const challenge = typeof data.challenge === 'string' ? data.challenge : '';
      response = json({ token: await verifyCode(env, 'employee', challenge, data.code) });
    } else if (request.method === 'POST' && path === '/api/employee/submissions') {
      const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1] || '';
      const email = await verifiedEmail(token, 'employee', env.AUTH_SECRET);
      if (!email) response = json({ error: 'Verify your work email before submitting.' }, 401);
      else if (!await employeeAllowed(env, email)) response = json({ error: 'This email no longer has submission access. Contact the BVC team.' }, 403);
      else response = await saveEmployeeEntry(request, env, email);
    } else {
      response = json({ error: 'Not found.' }, 404);
    }
  } catch (error) {
    if (error instanceof InvalidEntry || error instanceof AuthError) response = json({ error: error.message }, error.status);
    else {
      console.error('The employee request could not be processed.');
      response = json({ error: 'The submission service is unavailable. Please try again.' }, 503);
    }
  }
  const combinedHeaders = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders)) combinedHeaders.set(name, value);
  return new Response(response.body, { status: response.status, headers: combinedHeaders });
}

function present(row) {
  return {
    id: row.id, receipt: row.id.slice(0, 16), activity: activities[row.activity], type: row.activity,
    employee: row.employee, code: row.employee_code, email: row.employee_email, branch: row.branch,
    name: row.child_name, campaign: row.campaign_title, journal: row.journal, received: row.received_at,
    attachments: JSON.parse(row.attachments).map(({name, mime, label}, i) => ({
      name, mime, label, url: '/api/entries/' + row.id + '/files/' + (i + 1)
    }))
  };
}

async function reviewList(url, db) {
  const activity = url.searchParams.get('activity');
  const before = Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(before) || before < 1 || (activity && !Object.hasOwn(activities, activity))) return json({ error: 'Invalid filter.' }, 400);
  const query = 'SELECT rowid AS cursor, * FROM submissions WHERE rowid < ?' +
    (activity ? ' AND activity = ?' : '') + ' ORDER BY rowid DESC LIMIT 51';
  const { results } = await db.prepare(query).bind(...(activity ? [before, activity] : [before])).all();
  return json({ entries: results.slice(0, 50).map(present), next: results.length > 50 ? results[49].cursor : null });
}

async function fileResponse(request, env, id, number, url) {
  const row = await env.DB.prepare('SELECT attachments FROM submissions WHERE id = ?').bind(id).first();
  const item = row && JSON.parse(row.attachments)[number - 1];
  if (!item) return json({ error: 'File not found.' }, 404);
  const rangeHeader = request.headers.get('range');
  let range;
  let size;
  if (rangeHeader) {
    const metadata = await env.BUCKET.head(item.key);
    if (!metadata) return json({ error: 'File not found.' }, 404);
    size = metadata.size;
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    const start = match?.[1] ? Number(match[1]) : Math.max(0, size - Number(match?.[2]));
    const end = match?.[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (!match || !Number.isSafeInteger(start) || start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': 'bytes */' + size } });
    }
    range = { offset: start, length: end - start + 1 };
  }
  const object = await env.BUCKET.get(item.key, range ? { range } : undefined);
  if (!object) return json({ error: 'File not found.' }, 404);
  const download = url.searchParams.has('download');
  const fileHeaders = {
    ...headers, 'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Type': item.mime, 'Content-Length': String(range?.length ?? object.size), 'Accept-Ranges': 'bytes',
    'Content-Disposition': (download ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(item.name).replace(/'/g, '%27')
  };
  if (range) fileHeaders['Content-Range'] = `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`;
  return new Response(object.body, { status: range ? 206 : 200, headers: fileHeaders });
}

function csvRow(values) {
  return values.map(value => {
    let text = String(value ?? '');
    if (/^[\s]*[=+@\-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }).join(',') + '\r\n';
}

function attachmentPath(row, file, index) {
  return 'attachments/' + row.id.slice(0, 16) + '/' + (index + 1) + '-' + file.name;
}

async function* rows(db, last) {
  let after = 0;
  while (after < last) {
    const { results } = await db.prepare('SELECT rowid AS cursor, * FROM submissions WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT 100').bind(after, last).all();
    if (!results.length) break;
    yield* results;
    after = results.at(-1).cursor;
  }
}

async function* csv(db, last) {
  const encoder = new TextEncoder();
  yield encoder.encode('\uFEFF' + csvRow(['Receipt', 'Activity', 'Employee name', 'Employee code', 'Work email', 'Branch city',
    'Received (UTC)', 'Child’s name', 'Campaign title', 'Journal entry', 'Attachments in ZIP']));
  for await (const row of rows(db, last)) {
    yield encoder.encode(csvRow([row.id.slice(0, 16), activities[row.activity], row.employee, row.employee_code, row.employee_email,
      row.branch, row.received_at, row.child_name, row.campaign_title, row.journal,
      JSON.parse(row.attachments).map((item, i) => attachmentPath(row, item, i)).join('\n')]));
  }
}

function readable(iterator) {
  return new ReadableStream({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel() { return iterator.return?.(); }
  });
}

async function exportAll(env, ctx) {
  const snapshot = await env.DB.prepare('SELECT COALESCE(MAX(rowid), 0) AS last FROM submissions').first();
  let controller;
  const stream = new TransformStream({ start(value) { controller = value; } });
  const archive = new ZipWriter(stream.writable, { level: 0, useWebWorkers: false, zip64: true });
  ctx.waitUntil((async () => {
    try {
      await archive.add('submissions.csv', readable(csv(env.DB, snapshot.last)));
      for await (const row of rows(env.DB, snapshot.last)) {
        for (const [index, file] of JSON.parse(row.attachments).entries()) {
          const item = await env.BUCKET.get(file.key);
          if (!item) throw new Error('Submission attachment is missing.');
          await archive.add(attachmentPath(row, file, index), item.body);
        }
      }
      await archive.close();
    } catch (error) {
      controller.error(error);
      console.error('Could not finish the submissions export.');
    }
  })());
  return new Response(stream.readable, { headers: {
    ...headers, 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="bvc-foundation-week-submissions.zip"'
  } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/employee/')) return await employeeApi(request, env, url.pathname);
      if (request.method === 'POST' && url.pathname === '/internal/submissions') return await saveEntry(request, env);
      if (request.method === 'GET' && url.pathname === '/internal/health') {
        if (!env.INGEST_KEY || request.headers.get('x-bvc-ingest-key') !== env.INGEST_KEY) return json({ error: 'Forbidden' }, 403);
        await env.DB.prepare('SELECT id FROM submissions LIMIT 1').all();
        await env.BUCKET.list({ limit: 1 });
        return json({ ready: true, emailSignInReady: mailReady(env) });
      }
      if (request.method === 'POST' && ['/internal/auth/send', '/internal/auth/verify'].includes(url.pathname)) {
        if (!env.INGEST_KEY || request.headers.get('x-bvc-ingest-key') !== env.INGEST_KEY) return json({ error: 'Forbidden' }, 403);
        const data = await readJson(request);
        if (url.pathname.endsWith('/send')) {
          return json({ challenge: await startCode(env, 'employee', data.email, request.headers.get('x-bvc-client-ip')) });
        }
        return json({ token: await verifyCode(env, 'employee', request.headers.get('x-bvc-challenge') || '', data.code) });
      }
      if (request.method === 'POST' && request.headers.get('origin') !== url.origin) {
        return json({ error: 'Open the reviewer dashboard to continue.' }, 403);
      }
      if (request.method === 'POST' && url.pathname === '/auth/send') {
        const data = await readJson(request);
        return authResponse({ challenge: await startCode(
          env, 'reviewer', data.email, request.headers.get('cf-connecting-ip'), cookie(request, challengeName)
        ) });
      }
      if (request.method === 'POST' && url.pathname === '/auth/verify') {
        const data = await readJson(request);
        return authResponse({ token: await verifyCode(env, 'reviewer', cookie(request, challengeName), data.code) });
      }
      if (request.method === 'POST' && url.pathname === '/auth/signout') return signOut();
      const email = await sessionEmail(request, 'reviewer', env.AUTH_SECRET);
      const role = await reviewerRole(env, email);
      if (!role) {
        if (url.pathname === '/' && request.method === 'GET') {
          return new Response(loginPage('reviewer'), { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
        }
        return json({ error: 'Sign in with an approved reviewer email.' }, 401);
      }
      if (request.method === 'GET' && url.pathname === '/api/account') return json({ role, emailSignInReady: mailReady(env) });
      if (url.pathname === '/api/reviewers') return await manageReviewers(request, env, role);
      if (url.pathname === '/api/employees') return await manageEmployees(request, env, role);
      if (request.method !== 'GET') return json({ error: 'Not found.' }, 404);
      if (url.pathname === '/') return new Response(page, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
      if (url.pathname === '/api/entries') return await reviewList(url, env.DB);
      if (url.pathname === '/api/export') return await exportAll(env, ctx);
      const path = url.pathname.split('/');
      if (path.length === 6 && path[1] === 'api' && path[2] === 'entries' && idPattern.test(path[3]) &&
          path[4] === 'files' && /^[1-6]$/.test(path[5])) {
        return await fileResponse(request, env, path[3], Number(path[5]), url);
      }
      return json({ error: 'Not found.' }, 404);
    } catch (error) {
      if (error instanceof InvalidEntry || error instanceof AuthError) return json({ error: error.message }, error.status);
      console.error('BVC submissions request failed.');
      return json({ error: 'This service is temporarily unavailable. Please try again.' }, 503);
    }
  }
};

async function manageReviewers(request, env, role) {
  if (role !== 'admin') return json({ error: 'Reviewer management is available to the dashboard admin.' }, 403);
  if (request.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT email, role FROM dashboard_reviewers ORDER BY role, email').all();
    const admin = emailAddress(env.REVIEWER_ADMIN_EMAIL);
    return json({ reviewers: [{ email: admin, role: 'admin' }, ...results.filter(reviewer => reviewer.email !== admin)] });
  }
  if (request.method !== 'POST') return json({ error: 'Not found.' }, 404);
  const body = await readJson(request);
  const email = emailAddress(body.email);
  if (!email || !['add', 'remove'].includes(body.action)) return json({ error: 'Enter a valid email address.' }, 400);
  if (email === emailAddress(env.REVIEWER_ADMIN_EMAIL)) return json({ error: 'The main administrator is managed in backend settings.' }, 409);
  if (body.action === 'add') {
    await env.DB.prepare("INSERT INTO dashboard_reviewers (email, role) VALUES (?, 'reviewer') ON CONFLICT(email) DO NOTHING").bind(email).run();
  } else {
    await env.DB.prepare("DELETE FROM dashboard_reviewers WHERE email = ? AND role = 'reviewer'").bind(email).run();
  }
  return json({ ok: true });
}

async function manageEmployees(request, env, role) {
  if (role !== 'admin') return json({ error: 'Employee access is managed by the dashboard admin.' }, 403);
  if (request.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT email FROM employee_allowlist ORDER BY email').all();
    return json({ employees: results });
  }
  if (request.method !== 'POST') return json({ error: 'Not found.' }, 404);
  const body = await readJson(request);
  const email = workEmail(body.email);
  if (!email || !['add', 'remove'].includes(body.action)) return json({ error: 'Enter a valid @bvclogistics.com email address.' }, 400);
  if (body.action === 'add') {
    await env.DB.prepare('INSERT INTO employee_allowlist (email, added_at) VALUES (?, ?) ON CONFLICT(email) DO NOTHING')
      .bind(email, new Date().toISOString()).run();
  } else {
    await env.DB.prepare('DELETE FROM employee_allowlist WHERE email = ?').bind(email).run();
  }
  return json({ ok: true });
}
