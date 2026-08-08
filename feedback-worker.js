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
/**
 * The events the counter accepts. Anything else is discarded.
 *
 * Three separate tallies, never joined: nothing links an `open` to the `import`
 * that may have followed it, because no request carries anything to join on.
 * `import` needs a file picker driven, which is the strongest evidence of a
 * person; `open` counts more bot traffic precisely because it needs nothing.
 */
const PING_EVENTS = new Set(['import', 'export', 'open']);
/** Ordered for display: the funnel reads open, then import, then export. */
const REPORTED_EVENTS = ['open', 'import', 'export'];
const EVENT_LABELS = { open: 'Sessions', import: 'Imports', export: 'Exports' };
/** A ping is two short fields; anything larger is not one. */
const MAX_PING_BYTES = 512;
/** Roughly 13 months, so a year-over-year digest still has something to read. */
const COUNT_TTL_SECONDS = 400 * 24 * 60 * 60;
/** Where the daily line is appended, and the KV key remembering which issue. */
const DIGEST_ISSUE_TITLE = 'Pictayo usage log';
const DIGEST_ISSUE_KEY = 'digest:issue';
/**
 * Lifetime figures, kept alongside the per-day ones. The daily keys expire, so
 * anything meant to outlive them is maintained here as it happens rather than
 * recomputed later from records that will be gone. None carry a TTL.
 *
 * `first` and `best` and `active` exist because they cannot be derived from a
 * bounded window: a best day in 2026 is still the best day in 2027, and an
 * average per active day needs every active day, not the last thirty.
 */
const totalKey = (event) => `count:total:${event}`;
const firstDayKey = (event) => `stats:first:${event}`;
const bestDayKey = (event) => `stats:best:${event}`;
const activeDaysKey = (event) => `stats:active:${event}`;
/** How far back the rolling windows look. Also caps the streak search. */
const WINDOW_DAYS = 30;
/**
 * The issue body is rewritten as imports arrive, so a burst of them would mean
 * a burst of GitHub writes. One update a minute is frequent enough to feel live
 * and slow enough that traffic can never turn into an API problem.
 */
const ISSUE_SYNC_KEY = 'digest:issue-synced';
const ISSUE_SYNC_MIN_MS = 60_000;
/**
 * The fallback used when the body cannot be edited. A comment is permanent
 * where an edit is not, so it is throttled by the hour rather than the minute.
 */
const COMMENT_SYNC_KEY = 'digest:comment-synced';
const COMMENT_SYNC_MIN_MS = 60 * 60_000;
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === PING_PATH) return handlePing(request, env, ctx);
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

async function handlePing(request, env, ctx) {
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
  const today = utcDate(new Date());
  const key = countKey(today, event);
  let recorded = null;
  try {
    const current = readInt(await counts.get(key));
    const next = current + 1;
    await counts.put(key, String(next), { expirationTtl: COUNT_TTL_SECONDS });

    // The running total is what the log issue shows, so it is kept here rather
    // than recomputed by summing daily keys that eventually expire.
    const nextTotal = readInt(await counts.get(totalKey(event))) + 1;
    await counts.put(totalKey(event), String(nextTotal));

    // A day becoming active is the only moment these can change, so they are
    // maintained here rather than recounted from history that expires.
    if (current === 0) {
      await counts.put(activeDaysKey(event), String(readInt(await counts.get(activeDaysKey(event))) + 1));
      if (!(await counts.get(firstDayKey(event)))) await counts.put(firstDayKey(event), today);
    }
    const best = parseBest(await counts.get(bestDayKey(event)));
    if (next > best.count) await counts.put(bestDayKey(event), `${today}:${next}`);

    // KV is eventually consistent, so the publisher below can read back the
    // values from before these writes. Hand it what was actually written and
    // let it take the larger of the two, which can never under-report.
    recorded = { event, day: today, count: next, total: nextTotal };
  } catch (error) {
    console.error('Usage counter could not record a ping', { message: String(error?.message || '') });
  }

  // Publish after responding. Whatever the visitor was doing has already
  // finished, and nothing they see should wait on GitHub.
  if (recorded && ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(syncLogIssue(env, counts, false, recorded));
  }

  // Always no-content: the client neither needs nor reads an answer, and a
  // silent response gives a caller nothing to probe.
  return new Response(null, { status: 204, headers: cors });
}

/**
 * Rewrites the log issue so its opening lines always carry the current numbers.
 *
 * The daily comments below it are the history; this is the figure you read
 * without scrolling. It publishes counts and a date and nothing else, because
 * counts and dates are the only things stored.
 *
 * `fresh` carries figures the caller has just written. KV is eventually
 * consistent, so reading them back here can return the values from before the
 * increment — which is how a counter that had just been raised was published as
 * zero. The cron path passes nothing and reads, which is correct for it: by
 * then the writes are long settled.
 */
async function syncLogIssue(env, counts, force, fresh) {
  if (!env.GITHUB_TOKEN) {
    console.error('Usage counter cannot update the log issue without its GitHub secret');
    return;
  }

  if (!force) {
    const last = Number.parseInt((await counts.get(ISSUE_SYNC_KEY).catch(() => '')) || '0', 10);
    if (Number.isFinite(last) && Date.now() - last < ISSUE_SYNC_MIN_MS) return;
  }

  const today = utcDate(new Date());
  const stats = [];
  for (const name of REPORTED_EVENTS) {
    stats.push(await eventStats(counts, name, today, fresh));
  }

  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  const headers = githubHeaders(env);
  const body = logIssueBody(stats, today);
  const issue = await ensureLogIssue(env, counts, repo, headers, body);
  if (!issue) return;

  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/issues/${issue}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ body }),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      // GitHub explains a refusal in the body. Without it a 403 is just a
      // number, and the last one cost a long hunt through the wrong things.
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      console.error('Usage counter could not update the log issue', {
        status: response.status,
        detail,
      });
      // Kept as insurance rather than as a fix for anything known: the 403 this
      // was written for turned out to be a token carrying Actions write and no
      // Issues permission at all, which refuses commenting just as flatly. If
      // some future refusal applies only to editing, the figure still lands.
      if (response.status === 403) {
        await commentRunningTotal(env, counts, repo, headers, issue, stats, today);
      }
      return;
    }
    await counts.put(ISSUE_SYNC_KEY, String(Date.now()));
  } catch (error) {
    console.error('Usage counter could not update the log issue', {
      reason: String(error?.name || 'Error'),
      message: String(error?.message || '').slice(0, 200),
    });
  }
}

/**
 * Publishes the running figure as a comment when the body cannot be edited.
 *
 * Throttled far harder than the body rewrite it stands in for: an edit leaves
 * one line that keeps changing, whereas a comment is permanent, so the same
 * cadence would bury the log in its own updates.
 */
async function commentRunningTotal(env, counts, repo, headers, issue, stats, today) {
  const last = Number.parseInt((await counts.get(COMMENT_SYNC_KEY).catch(() => '')) || '0', 10);
  if (Number.isFinite(last) && Date.now() - last < COMMENT_SYNC_MIN_MS) return;

  // Same shape as the daily comment, so the thread reads consistently whether
  // a line was written by the cron or by this fallback.
  const line = `**${today} (UTC)** — ${dailySummary(stats)}`;
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/issues/${issue}/comments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: line }),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      console.error('Usage counter could not comment the running total', {
        status: response.status,
        detail,
      });
      return;
    }
    await counts.put(COMMENT_SYNC_KEY, String(Date.now()));
  } catch (error) {
    console.error('Usage counter could not comment the running total', {
      reason: String(error?.name || 'Error'),
      message: String(error?.message || '').slice(0, 200),
    });
  }
}

/**
 * Renders the whole board.
 *
 * Every column is either a stored counter or arithmetic on stored counters.
 * Nothing here needed a new fact about a visitor to be collected, which is why
 * the privacy notice reads the same after this table as it did before it.
 */
function logIssueBody(stats, today) {
  const imports = stats.find((s) => s.event === 'import') ?? stats[0];
  const rows = stats.map((s) =>
    `| ${EVENT_LABELS[s.event]} | ${s.total} | ${s.today} | ${s.last7} | ${s.last30} | ` +
    `${s.activeDays} | ${s.perActiveDay} | ${s.bestDay ? `${s.bestCount} on ${s.bestDay}` : '—'} |`);

  return [
    `## Imports to date: ${imports.total}`,
    '',
    `Today (${today} UTC): ${imports.today}`,
    '',
    // Without this the figure is unfalsifiable: a stalled publisher and a quiet
    // day look identical, and both look like a working counter.
    `_Updated ${new Date().toISOString()}_`,
    '',
    '| | Total | Today | 7 days | 30 days | Active days | Avg/active day | Best day |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...rows,
    '',
    `Active ${imports.activeDays} day${imports.activeDays === 1 ? '' : 's'} since ` +
      `${imports.firstDay || '—'}${imports.streak > 0 ? `, currently ${imports.streak} day${imports.streak === 1 ? '' : 's'} running` : ''}.`,
    '',
    '---',
    '',
    'Running log of anonymous usage counts, maintained by the Pictayo Worker.',
    'The figures above update as events arrive; the comments below are the',
    'daily history.',
    '',
    'Three things are counted, and never joined to one another: sessions that',
    'opened the app, sessions that imported photos, and sessions that exported',
    'an album. There is no identifier, cookie, IP, or device detail behind any',
    'of them — only daily totals are stored, so only totals can be shown, and',
    'every other column here is arithmetic on those totals. Days with no',
    'imports are skipped in the comments.',
  ].join('\n');
}

/** One line summarising a day across all three counters. */
function dailySummary(stats) {
  const parts = stats
    .filter((s) => s.today > 0)
    .map((s) => `${s.today} ${EVENT_LABELS[s.event].toLowerCase()}`);
  const imports = stats.find((s) => s.event === 'import');
  return `${parts.join(', ') || 'no activity'}. Running total: ${imports ? imports.total : 0} imports.`;
}

/**
 * Everything known about one counter, from the stored figures plus a bounded
 * window of daily keys. `fresh` is what the caller has just written; taking the
 * larger of the two survives KV's eventual consistency without over-reporting.
 */
async function eventStats(counts, event, today, fresh) {
  const override = fresh && fresh.event === event ? fresh : null;
  const read = async (key) => readInt(await counts.get(key).catch(() => null));

  let total = await read(totalKey(event));
  if (override) total = Math.max(total, override.total);

  // One read per day in the window. Bounded by WINDOW_DAYS, so this cannot grow
  // with the age of the log the way summing all history would.
  const days = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const day = utcDate(new Date(Date.parse(`${today}T00:00:00Z`) - i * 86_400_000));
    let value = await read(countKey(day, event));
    if (override && override.day === day) value = Math.max(value, override.count);
    days.push(value);
  }

  const last7 = days.slice(0, 7).reduce((a, b) => a + b, 0);
  const last30 = days.reduce((a, b) => a + b, 0);

  // Counted from today backwards, stopping at the first blank day. Today being
  // blank is not a broken streak yet, so the search starts at yesterday then.
  let streak = 0;
  for (let i = days[0] > 0 ? 0 : 1; i < days.length; i++) {
    if (days[i] <= 0) break;
    streak++;
  }

  const activeDays = Math.max(await read(activeDaysKey(event)), days.filter((d) => d > 0).length);
  const best = parseBest(await counts.get(bestDayKey(event)).catch(() => null));
  if (override && override.count > best.count) {
    best.count = override.count;
    best.day = override.day;
  }

  return {
    event,
    total,
    today: days[0],
    last7,
    last30,
    activeDays,
    streak,
    perActiveDay: activeDays > 0 ? (total / activeDays).toFixed(1) : '0.0',
    bestDay: best.day,
    bestCount: best.count,
    firstDay: (await counts.get(firstDayKey(event)).catch(() => null)) || '',
  };
}

function readInt(value) {
  const parsed = Number.parseInt(value || '0', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Stored as `YYYY-MM-DD:count`, so a single key carries both halves. */
function parseBest(value) {
  const [day, count] = String(value || '').split(':');
  return { day: day || '', count: readInt(count) };
}

function githubHeaders(env) {
  return {
    Authorization: `Bearer ${String(env.GITHUB_TOKEN).trim()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'Pictayo-Feedback-Worker',
  };
}

/**
 * Returns the log issue's number, opening it the first time.
 *
 * The caller supplies the opening body so the issue is right the moment it
 * appears. Creating it with zeros and correcting it a beat later would leave
 * the first version of a public page saying nobody had used the app.
 */
async function ensureLogIssue(env, counts, repo, headers, initialBody) {
  const remembered = Number.parseInt((await counts.get(DIGEST_ISSUE_KEY).catch(() => '')) || '', 10);
  if (Number.isFinite(remembered) && remembered > 0) return remembered;

  try {
    const created = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: DIGEST_ISSUE_TITLE,
        body: initialBody,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (!created.ok) {
      console.error('Usage log issue could not be opened', { status: created.status });
      return null;
    }
    const body = await created.json().catch(() => ({}));
    if (!Number.isFinite(body.number)) {
      console.error('Usage log issue was created without a number');
      return null;
    }
    // Remembered without a TTL: losing this would silently start a second log.
    await counts.put(DIGEST_ISSUE_KEY, String(body.number));
    return body.number;
  } catch (error) {
    console.error('Usage log issue could not be opened', {
      reason: String(error?.name || 'Error'),
      message: String(error?.message || '').slice(0, 200),
    });
    return null;
  }
}

async function sendDigest(env) {
  const counts = env.USAGE_COUNTS;
  if (!counts || typeof counts.get !== 'function') {
    console.error('Usage digest is missing its KV binding');
    return;
  }

  const day = utcDate(new Date(Date.now() - 24 * 60 * 60 * 1000));

  // Yesterday's figures for every counter. `eventStats` is keyed on the day it
  // is given, so the day's own column comes out right even though the lifetime
  // ones are current.
  const stats = [];
  for (const name of REPORTED_EVENTS) stats.push(await eventStats(counts, name, day, null));

  // Quiet days are not news. Staying silent keeps the log to real signal and
  // stops a daily "no activity" comment from training the inbox to ignore it.
  if (stats.every((s) => s.today === 0)) return;

  const line = `**${day} (UTC)** — ${dailySummary(stats)}`;

  await postDigestToGitHub(env, counts, line);

  // Force a rewrite of the running figures too. A ping can be throttled out of
  // syncing, so without this the headline number could sit a day behind the
  // comment directly under it.
  await syncLogIssue(env, counts, true);

  // Optional second destination. Only fires when the secret exists, so a
  // Discord or Slack channel can mirror the log without being required.
  const webhook = env.DIGEST_WEBHOOK_URL;
  if (webhook) {
    try {
      // `content` is what Discord reads and `text` is what Slack reads, so one
      // body works with either without needing to know which was configured.
      const plain = `Pictayo ${day}: ${dailySummary(stats)}`;
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
  const headers = githubHeaders(env);
  // The forced sync in sendDigest rewrites this body straight afterwards, so a
  // placeholder here only ever exists between two calls.
  const issue = await ensureLogIssue(
    env, counts, repo, headers,
    logIssueBody(
      REPORTED_EVENTS.map((event) => ({
        event, total: 0, today: 0, last7: 0, last30: 0, activeDays: 0,
        streak: 0, perActiveDay: '0.0', bestDay: '', bestCount: 0, firstDay: '',
      })),
      utcDate(new Date()),
    ),
  );
  if (!issue) return;

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
