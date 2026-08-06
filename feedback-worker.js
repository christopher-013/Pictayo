/**
 * Feedback API for Pictayo.
 *
 * The browser posts here and this Worker creates a public GitHub issue using a
 * narrowly scoped secret. The credential is never embedded in the website.
 */

const API_PATH = '/api/feedback';
/**
 * Must track the repository's current name. GitHub answers a renamed repo with
 * a 301, and fetch rewrites a redirected POST into a GET — so a stale name here
 * reads the issue list, returns 200, and reports success without filing
 * anything. The Worker hostname below is deliberately not renamed: it is the
 * live endpoint the site and its CSP already point at.
 */
const DEFAULT_REPO = 'christopher-013/Pictayo';
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
const UNSAFE_FEEDBACK_ERROR = 'Feedback contains content that cannot be submitted.';

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

    let raw;
    try {
      raw = await request.text();
    } catch {
      return json({ ok: false, error: 'Could not read feedback' }, 400, cors);
    }
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

    // Rate limiting is required, not best-effort.
    //
    // Treating the binding as optional fails open: a deploy that loses it —
    // wrong environment, a dropped namespace, an older config — would keep
    // creating issues with a live token and no throttle at all, silently. The
    // binding is declared in wrangler.jsonc, so its absence is a misconfigured
    // deploy rather than a request worth serving.
    const limiter = env.FEEDBACK_RATE_LIMITER;
    if (typeof limiter?.limit !== 'function') {
      console.error('Feedback service is missing its rate limiter binding');
      return json({ ok: false, error: 'Feedback could not be submitted right now.' }, 503, cors);
    }

    const client = request.headers.get('CF-Connecting-IP') || 'unknown';
    let withinLimit;
    try {
      withinLimit = (await limiter.limit({ key: client })).success;
    } catch {
      // An unavailable limiter is still an absent control.
      withinLimit = false;
    }
    if (!withinLimit) {
      return json({ ok: false, error: 'Please wait before sending more feedback.' }, 429, cors);
    }

    if (!isSafeFeedbackText(payload.summary, 120, true) ||
        !isSafeFeedbackText(payload.message, 2000, false)) {
      return json({ ok: false, error: UNSAFE_FEEDBACK_ERROR }, 422, cors);
    }

    const category = CATEGORIES.has(payload.category) ? payload.category : 'other';
    const summary = clean(payload.summary, 120, true);
    const message = clean(payload.message, 2000, false);
    const page = clean(payload.page, 300, true);
    const viewport = clean(payload.viewport, 40, true);
    const version = clean(payload.version, 40, true);
    const userAgent = clean(payload.userAgent, 400, true);
    if (!summary) return json({ ok: false, error: 'A summary is required' }, 400, cors);
    if (!env.GITHUB_TOKEN) {
      console.error('Feedback service is missing its GitHub secret');
      return json({ ok: false, error: 'Feedback could not be submitted right now.' }, 503, cors);
    }

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
      '_Filed automatically from the Pictayo in-app feedback form._',
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
          'User-Agent': 'Pictayo-Feedback-Worker',
        },
        body: JSON.stringify({ title: `[${typeLabel}] ${summary}`, body: issueBody }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
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
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
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

function isSafeFeedbackText(value, maximum, singleLine) {
  const raw = String(value == null ? '' : value);
  if (raw.length > maximum) return false;
  if (singleLine && /[\r\n]/u.test(raw)) return false;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u.test(raw)) {
    return false;
  }

  const text = raw.normalize('NFKC').toLowerCase();
  if (/<\s*\/?\s*(?:script|iframe|img|svg|object|embed|link|meta|style|form|input|button|video|audio|source|base|math)\b/iu.test(text)) {
    return false;
  }
  if (/\bon[a-z]{2,30}\s*=/iu.test(text)) return false;
  if (/\b(?:javascript|vbscript)\s*:/iu.test(text)) return false;
  if (/\bdata\s*:\s*(?:text\/html|image\/svg\+xml|application\/(?:javascript|xhtml\+xml))/iu.test(text)) {
    return false;
  }
  // The issue tracker is public and the page is attached automatically. Links
  // and contact details are unnecessary here and are common spam payloads.
  if (/\b(?:https?:\/\/|www\.)\S+/iu.test(text)) return false;
  if (/\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/iu.test(text)) return false;
  return true;
}
