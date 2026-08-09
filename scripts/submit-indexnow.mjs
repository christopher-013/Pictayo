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
const URLS = [`https://${HOST}/`, `https://${HOST}/privacy`];
const TIMEOUT_MS = 15_000;

/** The key file's name is the key, so `public/` is the single source of truth. */
async function readIndexNowKey() {
  const entries = await readdir(join(process.cwd(), 'public')).catch(() => []);
  const keyFile = entries.find((name) => /^[0-9a-f]{16,128}\.txt$/i.test(name));
  return keyFile ? keyFile.replace(/\.txt$/i, '') : '';
}

const key = await readIndexNowKey();
if (!key) {
  console.warn('No IndexNow key file in public/; skipping submission.');
  process.exit(0);
}

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
try {
  const response = await fetch('https://api.indexnow.org/IndexNow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host: HOST,
      key,
      keyLocation: `https://${HOST}/${key}.txt`,
      urlList: URLS,
    }),
    signal: controller.signal,
  });
  console.log(response.ok
    ? `IndexNow accepted ${URLS.length} URL(s) (HTTP ${response.status}).`
    : `IndexNow declined the submission (HTTP ${response.status}).`);
} catch (error) {
  console.log(`IndexNow submission skipped: ${error?.message || error}`);
} finally {
  clearTimeout(timer);
}
