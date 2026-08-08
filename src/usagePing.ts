/**
 * Anonymous usage ping.
 *
 * GitHub Pages exposes no logs, so nothing else can answer whether the app is
 * actually being used. This reports one fact — that some browser session
 * imported media — and carries nothing that could identify who.
 *
 * Deliberately absent, and asserted by the smoke suite: no user agent, no
 * screen or viewport size, no language, no timezone, no referrer, no cookie,
 * and no persistent identifier. The body is a single fixed string. Only the
 * request itself, plus the connection details any HTTP request unavoidably
 * carries, ever reach the Worker, and the Worker stores none of them.
 *
 * The endpoint is the origin already present in the CSP for feedback, so
 * counting introduces no new network destination.
 */
const PING_ENDPOINT = 'https://pictayo.cch13.workers.dev/api/ping';

/**
 * One ping per browser session rather than per import.
 *
 * `sessionStorage` is used as a flag, not as an identity: it holds a constant,
 * never a generated id, and it is gone when the tab closes. Counting sessions
 * instead of imports also keeps a single enthusiastic afternoon from reading
 * like a crowd.
 */
const SESSION_FLAG = 'pictayo-import-counted';

/** Short enough that a stalled counter never delays anything the user sees. */
const PING_TIMEOUT_MS = 4_000;

/** The three things counted. Each is a separate tally that is never joined. */
type UsageEvent = 'open' | 'import' | 'export';

/**
 * Sends one ping for `event`, at most once per browser session.
 *
 * Never throws and never returns a rejected promise: counting is the least
 * important thing happening on this page, and a failure here must not surface
 * to someone who has just used the app successfully.
 */
function report(event: UsageEvent): void {
  const flag = `${SESSION_FLAG}-${event}`;
  let alreadyCounted = false;
  try {
    alreadyCounted = sessionStorage.getItem(flag) === '1';
    if (!alreadyCounted) sessionStorage.setItem(flag, '1');
  } catch {
    // Private modes and blocked storage throw on access. Skip rather than
    // count every occurrence in the session, which would overstate use.
    return;
  }
  if (alreadyCounted) return;

  try {
    void fetch(PING_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event }),
      // Survives the tab being closed moments after the event.
      keepalive: true,
      // No cookies are set by the Worker, but say so explicitly rather than
      // relying on the default.
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    }).catch(() => {});
  } catch {
    // Ignored on purpose.
  }
}

/**
 * Records that this session opened the app.
 *
 * Counts more automated traffic than the other two, because it asks nothing of
 * the visitor. It is worth having anyway: paired with imports it says how many
 * people who arrive go on to use the thing.
 */
export function reportAppOpened(): void {
  report('open');
}

/** Records that this session imported media. Needs a file picker driven. */
export function reportImportCompleted(): void {
  report('import');
}

/** Records that this session exported a standalone album. */
export function reportExportCompleted(): void {
  report('export');
}
