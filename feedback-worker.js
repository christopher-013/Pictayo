/**
 * Pictayo's Worker: the site and its API.
 *
 * The built site is uploaded as this Worker's static assets and served
 * directly. Only the two paths below run this script — `run_worker_first` in
 * wrangler.jsonc decides that, so everything else is a static file.
 *
 * For feedback, the browser posts here and the Worker creates a public GitHub
 * issue using a narrowly scoped secret. The credential is never embedded in
 * the website.
 */

const API_PATH = '/api/feedback';
/**
 * Anonymous usage counter.
 *
 * The site is served as static assets, which produce no visitor log anyone
 * here reads, so without this there is no way to tell whether the app is being
 * used. It answers exactly one question — how many browser sessions imported
 * media on a given day — and is deliberately incapable of answering anything
 * narrower.
 *
 * What it stores is a single integer per UTC day. There is no identifier, no
 * cookie, no per-event row, and the client IP is used only transiently as a
 * rate-limit key, exactly as feedback already does. Nothing written here can be
 * traced back to a person, because nothing about the person is ever received.
 */
const PING_PATH = '/api/ping';
/** The only event the counter accepts. Anything else is discarded. */
const PING_EVENTS = new Set(['import']);
/** A ping is two short fields; anything larger is not one. */
const MAX_PING_BYTES = 512;
/** Roughly 13 months, so a year-over-year digest still has something to read. */
const COUNT_TTL_SECONDS = 400 * 24 * 60 * 60;
/** Where the daily line is appended, and the KV key remembering which issue. */
const DIGEST_ISSUE_TITLE = 'Pictayo usage log';
const DIGEST_ISSUE_KEY = 'digest:issue';
/**
 * Must track the repository's current name. GitHub answers a renamed repo with
 * a 301, and a followed redirect rewrites a POST into a GET — so a stale name
 * here would read the issue list, return 200, and report success without
 * filing anything.
 *
 * Every fetch below therefore uses `redirect: 'manual'`, which hands back the
 * 3xx instead of following it. A redirect then fails the `response.ok` check
 * and is logged with its status. `redirect: 'error'` would express the same
 * intent but the Workers runtime rejects it outright, throwing a TypeError
 * before the request is sent — a failure that looks exactly like a bad
 * credential from the browser.
 *
 * The Worker's own hostname is a separate matter: renaming it mints a new
 * `*.workers.dev` address, so the CSP, both client endpoints, and the origin
 * allowlist have to move in the same commit or feedback starts failing.
 */
const DEFAULT_REPO = 'christopher-013/Pictayo';
const DEFAULT_ALLOWED_ORIGINS = [
  'https://pictayo.com',
  'https://www.pictayo.com',
  'https://christopher-013.github.io',
  'https://pictayo.cch13.workers.dev',
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
    if (url.pathname === PING_PATH) return handlePing(request, env);
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

    // A pasted secret can arrive with a trailing newline or space, and a header
    // value containing one is invalid: `fetch` throws before sending anything.
    // That failure is indistinguishable from a rejected token at the browser,
    // so name it here rather than leaving a 502 with no cause.
    const token = String(env.GITHUB_TOKEN);
    if (token !== token.trim()) {
      console.error(
        'GitHub secret has surrounding whitespace; the request was never sent. Re-enter it with no trailing newline or space.',
      );
      return json({ ok: false, error: 'Feedback could not be submitted right now.' }, 503, cors);
    }

    let response;
    try {
      response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO || DEFAULT_REPO}/issues`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          'User-Agent': 'Pictayo-Feedback-Worker',
        },
        body: JSON.stringify({ title: `[${typeLabel}] ${summary}`, body: issueBody }),
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      // Never silent: this branch covers a refused redirect, a timeout, and a
      // malformed header, which look identical from outside and are the reason
      // a 502 here used to be unexplainable. The message is the error's own,
      // so no token material can reach the log.
      console.error('GitHub request never completed', {
        reason: String(error?.name || 'Error'),
        message: String(error?.message || '').slice(0, 200),
      });
      return json({ ok: false, error: 'Feedback could not be submitted right now.' }, 502, cors);
    }
    if (!response.ok) {
      console.error('GitHub issue creation failed', { status: response.status });
      return json({ ok: false, error: 'Feedback could not be submitted right now.' }, 502, cors);
    }

    const issue = await response.json().catch(() => ({}));
    return json({ ok: true, number: Number.isFinite(issue.number) ? issue.number : null }, 201, cors);
  },

  /**
   * Daily digest. Reads yesterday's totals and posts them to a webhook held in
   * the encrypted secret store. Only counts are sent; there is nothing else
   * stored to send.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDigest(env));
  },
};

async function handlePing(request, env) {
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

  const declaredLength = Number.parseInt(request.headers.get('Content-Length') || '', 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PING_BYTES) {
    return new Response(null, { status: 204, headers: cors });
  }

  let payload;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_PING_BYTES) {
      return new Response(null, { status: 204, headers: cors });
    }
    payload = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 204, headers: cors });
  }

  const event = payload && typeof payload === 'object' ? payload.event : null;
  if (!PING_EVENTS.has(event)) return new Response(null, { status: 204, headers: cors });

  // Same reasoning as feedback: an absent limiter is an absent control, and a
  // counter with no throttle is a counter anyone can inflate at will.
  const limiter = env.FEEDBACK_RATE_LIMITER;
  if (typeof limiter?.limit !== 'function') {
    console.error('Usage counter is missing its rate limiter binding');
    return new Response(null, { status: 204, headers: cors });
  }
  // A distinct key prefix gives pings their own bucket, so counting can never
  // consume somebody's budget for filing feedback.
  const client = request.headers.get('CF-Connecting-IP') || 'unknown';
  try {
    if (!(await limiter.limit({ key: `ping:${client}` })).success) {
      return new Response(null, { status: 204, headers: cors });
    }
  } catch {
    return new Response(null, { status: 204, headers: cors });
  }

  const counts = env.USAGE_COUNTS;
  if (!counts || typeof counts.get !== 'function') {
    console.error('Usage counter is missing its KV binding');
    return new Response(null, { status: 204, headers: cors });
  }

  // Read-modify-write is not atomic in KV, so simultaneous pings can land on
  // the same value and lose one. That is acceptable here: the question is
  // whether people are using the app, not the exact number, and the
  // alternative — a row per event — stores strictly more about visitors.
  const key = countKey(utcDate(new Date()), event);
  try {
    const current = Number.parseInt((await counts.get(key)) || '0', 10);
    const next = (Number.isFinite(current) ? current : 0) + 1;
    await counts.put(key, String(next), { expirationTtl: COUNT_TTL_SECONDS });
  } catch (error) {
    console.error('Usage counter could not record a ping', { message: String(error?.message || '') });
  }

  // Always no-content: the client neither needs nor reads an answer, and a
  // silent response gives a caller nothing to probe.
  return new Response(null, { status: 204, headers: cors });
}

async function sendDigest(env) {
  const counts = env.USAGE_COUNTS;
  if (!counts || typeof counts.get !== 'function') {
    console.error('Usage digest is missing its KV binding');
    return;
  }

  const day = utcDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const imports = Number.parseInt((await counts.get(countKey(day, 'import')).catch(() => '0')) || '0', 10) || 0;

  // Quiet days are not news. Staying silent keeps the log to real signal and
  // stops a daily "no imports" comment from training the inbox to ignore it.
  if (imports === 0) return;

  const line = `**${day}** — ${imports} session${imports === 1 ? '' : 's'} imported photos.`;

  await postDigestToGitHub(env, counts, line);

  // Optional second destination. Only fires when the secret exists, so a
  // Discord or Slack channel can mirror the log without being required.
  const webhook = env.DIGEST_WEBHOOK_URL;
  if (webhook) {
    try {
      // `content` is what Discord reads and `text` is what Slack reads, so one
      // body works with either without needing to know which was configured.
      const plain = `Pictayo ${day}: ${imports} session${imports === 1 ? '' : 's'} imported photos.`;
      await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: plain, text: plain }),
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      console.error('Usage digest could not reach the webhook');
    }
  }
}

/**
 * Appends the day's line to a single long-lived issue.
 *
 * This reuses the Issues-scoped token feedback already needs, so the digest
 * introduces no new credential and no new service. The issue lives in the
 * public repository, so it carries counts only — never anything about a
 * visitor, because nothing about a visitor was ever stored to carry.
 */
async function postDigestToGitHub(env, counts, line) {
  if (!env.GITHUB_TOKEN) {
    console.error('Usage digest is missing its GitHub secret');
    return;
  }
  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'Pictayo-Feedback-Worker',
  };

  let issue = Number.parseInt((await counts.get(DIGEST_ISSUE_KEY).catch(() => '')) || '', 10);

  if (!Number.isFinite(issue) || issue <= 0) {
    try {
      const created = await fetch(`https://api.github.com/repos/${repo}/issues`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: DIGEST_ISSUE_TITLE,
          body: [
            'Running log of anonymous usage counts, appended by the Pictayo Worker.',
            '',
            'Each line is the number of browser sessions that imported photos on a',
            'given UTC day. There is no identifier, cookie, IP, or device detail',
            'behind these numbers — only a daily total is stored. Days with no',
            'imports are skipped.',
          ].join('\n'),
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      if (!created.ok) {
        console.error('Usage digest could not open its log issue', { status: created.status });
        return;
      }
      const body = await created.json().catch(() => ({}));
      if (!Number.isFinite(body.number)) {
        console.error('Usage digest got no issue number back');
        return;
      }
      issue = body.number;
      // Remembered without a TTL: losing this would silently start a second log.
      await counts.put(DIGEST_ISSUE_KEY, String(issue));
    } catch {
      console.error('Usage digest could not open its log issue');
      return;
    }
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/issues/${issue}/comments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: line }),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error('Usage digest could not append to its log issue', { status: response.status });
    }
  } catch {
    console.error('Usage digest could not append to its log issue');
  }
}

function utcDate(date) {
  return date.toISOString().slice(0, 10);
}

function countKey(day, event) {
  return `count:${day}:${event}`;
}

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
