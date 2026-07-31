/**
 * Public-beta feedback API for PicturePicture.
 *
 * The browser posts here and this Worker creates a public GitHub issue using a
 * narrowly scoped secret. The credential is never embedded in the website.
 */

const API_PATH = '/api/feedback';
const DEFAULT_REPO = 'christopher-013/PicturePicture';
const DEFAULT_ALLOWED_ORIGINS = [
  'https://christopher-013.github.io',
  'https://picturepicture-feedback.cch13.workers.dev',
  'http://127.0.0.1:5276',
  'http://127.0.0.1:5273',
  'http://localhost:5276',
  'http://localhost:5273',
];
const CATEGORIES = new Set(['bug', 'idea', 'praise', 'other']);
const MAX_BODY_BYTES = 16 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== API_PATH) return new Response('Not found', { status: 404 });

    const origin = request.headers.get('Origin') || '';
    const allowed = allowedOrigins(env.ALLOWED_ORIGINS).includes(origin);
    const cors = corsHeaders(allowed ? origin : '');

    if (request.method === 'OPTIONS') {
      return allowed
        ? new Response(null, { status: 204, headers: cors })
        : json({ ok: false, error: 'Origin not allowed' }, 403, cors);
    }
    if (!allowed) return json({ ok: false, error: 'Origin not allowed' }, 403, cors);
    if (request.method !== 'POST') {
      return json({ ok: false, error: 'Method not allowed' }, 405, cors);
    }
    if ((request.headers.get('Content-Type') || '').split(';', 1)[0].trim() !== 'application/json') {
      return json({ ok: false, error: 'Content-Type must be application/json' }, 415, cors);
    }

    const declaredLength = Number.parseInt(request.headers.get('Content-Length') || '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return json({ ok: false, error: 'Feedback is too large' }, 413, cors);
    }

    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json({ ok: false, error: 'Feedback is too large' }, 413, cors);
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return json({ ok: false, error: 'Invalid JSON body' }, 400, cors);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return json({ ok: false, error: 'Invalid feedback payload' }, 400, cors);
    }

    // Bots commonly fill invisible fields. Quiet success prevents retries while
    // ensuring their content never reaches GitHub.
    if (String(payload.website || '').trim()) {
      return json({ ok: true, number: null }, 201, cors);
    }

    if (env.FEEDBACK_RATE_LIMITER?.limit) {
      const client = request.headers.get('CF-Connecting-IP') || 'unknown';
      const result = await env.FEEDBACK_RATE_LIMITER.limit({ key: client });
      if (!result.success) return json({ ok: false, error: 'Please wait before sending more feedback.' }, 429, cors);
    }

    const category = CATEGORIES.has(payload.category) ? payload.category : 'other';
    const summary = clean(payload.summary, 120, true);
    const message = clean(payload.message, 2000, false);
    const page = clean(payload.page, 300, true);
    const viewport = clean(payload.viewport, 40, true);
    const version = clean(payload.version, 40, true);
    const userAgent = clean(payload.userAgent, 400, true);
    if (!summary) return json({ ok: false, error: 'A summary is required' }, 400, cors);
    if (!env.GITHUB_TOKEN) return json({ ok: false, error: 'Feedback service is not configured' }, 503, cors);

    const typeLabel = { bug: 'Bug', idea: 'Idea', praise: 'Praise', other: 'Feedback' }[category];
    const issueBody = [
      `**Type:** ${typeLabel}`,
      '',
      message || '_(no details provided)_',
      '',
      '---',
      `**Page:** ${page || '—'}`,
      `**Viewport:** ${viewport || '—'}`,
      `**Version:** ${version || '—'}`,
      `**User agent:** ${userAgent || '—'}`,
      '',
      '_Filed automatically from the PicturePicture in-app public-beta feedback form._',
    ].join('\n');

    let response;
    try {
      response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO || DEFAULT_REPO}/issues`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          'User-Agent': 'PicturePicture-Feedback-Worker',
        },
        body: JSON.stringify({ title: `[${typeLabel}] ${summary}`, body: issueBody }),
      });
    } catch {
      return json({ ok: false, error: 'Feedback could not be submitted right now.' }, 502, cors);
    }
    if (!response.ok) {
      console.error('GitHub issue creation failed', { status: response.status });
      return json({ ok: false, error: 'Feedback could not be submitted right now.' }, 502, cors);
    }

    const issue = await response.json().catch(() => ({}));
    return json({ ok: true, number: Number.isFinite(issue.number) ? issue.number : null }, 201, cors);
  },
};

function allowedOrigins(value) {
  const configured = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  return configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
}

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(value, status, headers) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function clean(value, maximum, singleLine) {
  let text = String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/@/g, '＠')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  if (singleLine) text = text.replace(/\s+/g, ' ');
  return text.trim().slice(0, maximum);
}
