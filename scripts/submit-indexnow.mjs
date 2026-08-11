/*
 * submit-indexnow.mjs — tell search engines a new version is live.
 *
 * Google finds this site on its own; Bing has been slower, and a freshly moved
 * domain can sit on a stale crawl for a long time. IndexNow is the fix: one
 * ping reaches Bing, Yandex, Seznam and Naver, and asks them to re-fetch rather
 * than wait for their own schedule.
 *
 * Ownership is proven by hosting a key file at the site root, so the key is
 * public by design and lives in the repository beside the script that uses it.
 * It is not a credential and grants nothing beyond "this host may submit URLs
 * for itself".
 *
 * Never fails a build: a search engine being slow or rate limited is not a
 * reason to hold back a release, and nothing downstream depends on the answer.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const HOST = process.env.INDEXNOW_HOST || 'pictayo.com';
const URLS = [`https://${HOST}/`, `https://${HOST}/about`, `https://${HOST}/privacy`];
const TIMEOUT_MS = 15_000;

/** The key file's name is the key, so `public/` is the single source of truth. */
async function readIndexNowKey() {
  const entries = await readdir(join(process.cwd(), 'public')).catch(() => []);
  const keyFile = entries.find((name) => /^[0-9a-f]{16,128}\.txt$/i.test(name));
  return keyFile ? keyFile.replace(/\.txt$/i, '') : '';
}

/**
 * Posts JSON and reports only the status.
 *
 * The caller may be sending a credential, so nothing here echoes the URL or the
 * request: a key that reaches a build log is a key that has to be rotated.
 */
async function postJson(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, status: 0, error: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

const key = await readIndexNowKey();
if (!key) {
  console.warn('No IndexNow key file in public/; skipping submission.');
} else {
  const result = await postJson('https://api.indexnow.org/IndexNow', {
    host: HOST,
    key,
    keyLocation: `https://${HOST}/${key}.txt`,
    urlList: URLS,
  });
  console.log(result.ok
    ? `IndexNow accepted ${URLS.length} URL(s) (HTTP ${result.status}).`
    : `IndexNow submission skipped (HTTP ${result.status}${result.error ? `: ${result.error}` : ''}).`);
}

/*
 * The Bing URL Submission API is a different thing from IndexNow above. Its key
 * is a real credential from Bing Webmaster Tools, not a public ownership proof,
 * so it is read from the environment and must never be committed.
 *
 * Bing's API takes it as a query parameter — its design, not a choice made here
 * — which is precisely why the URL is never logged and never echoed on failure.
 * Unset simply skips: IndexNow already reaches Bing, so this is a second, more
 * direct nudge rather than the only route.
 */
const bingKey = process.env.BING_WEBMASTER_API_KEY;
if (!bingKey) {
  console.log('BING_WEBMASTER_API_KEY not set; skipping the Bing URL Submission API.');
} else {
  const result = await postJson(
    `https://ssl.bing.com/webmaster/api.svc/json/SubmitUrlbatch?apikey=${encodeURIComponent(bingKey)}`,
    { siteUrl: `https://${HOST}`, urlList: URLS },
  );
  console.log(result.ok
    ? `Bing URL Submission accepted ${URLS.length} URL(s).`
    : `Bing URL Submission skipped (HTTP ${result.status}).`);
}
