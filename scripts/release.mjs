/**
 * Release pipeline: validate, then publish.
 *
 *   npm run release          validate only, and report what a push would do
 *   npm run release -- --push   validate, then push to the tracking branch
 *
 * Pushing is opt-in rather than automatic. A release script that publishes as a
 * side effect of running it is one fat-fingered command away from shipping
 * whatever happened to be in the working tree.
 *
 * Every step shells out to `node` directly rather than through npm, so the
 * pipeline behaves the same on Windows as anywhere else.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const PUSH = process.argv.includes('--push');
const ALLOW_DIRTY = process.argv.includes('--allow-dirty');

const node = process.execPath;
const started = Date.now();

let step = 0;

function heading(text) {
  console.log(`\n\x1b[36m[${++step}] ${text}\x1b[0m`);
}

function fail(message, detail = '') {
  console.error(`\n\x1b[31m✗ RELEASE HALTED — ${message}\x1b[0m`);
  if (detail) console.error(detail);
  process.exit(1);
}

function run(label, command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) fail(`${label} could not run`, String(result.error));
  if (result.status !== 0) fail(`${label} failed`, `exit code ${result.status}`);
}

function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    fail(`git ${args.join(' ')} failed`, (result.stderr || '').trim());
  }
  return (result.stdout || '').trim();
}

function gitQuiet(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return { ok: result.status === 0, out: (result.stdout || '').trim() };
}

// ── Pre-flight ───────────────────────────────────────────────────────────────
// Checked before any work, so an obvious blocker fails in a second rather than
// after a full build.

heading('Pre-flight');

if (!existsSync('package.json')) fail('run this from the project root');

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const dirty = git('status', '--porcelain');

console.log(`    branch:      ${branch}`);
console.log(`    working tree: ${dirty ? `${dirty.split('\n').length} change(s)` : 'clean'}`);

if (dirty && !ALLOW_DIRTY) {
  fail(
    'the working tree has uncommitted changes',
    `${dirty}\n\nCommit them first, or pass --allow-dirty to validate without publishing.`,
  );
}

const upstream = gitQuiet('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
if (!upstream.ok) {
  console.log('    upstream:    none configured');
} else {
  console.log(`    upstream:    ${upstream.out}`);
}

// ── Validation ───────────────────────────────────────────────────────────────

heading('Regenerating test fixtures');
run('fixtures', node, ['scripts/make-fixtures.mjs']);

heading('Type checking');
run('typecheck', node, ['node_modules/typescript/bin/tsc', '--noEmit']);

heading('Building');
run('build', node, ['node_modules/vite/bin/vite.js', 'build']);

heading('Smoke tests');
run('smoke tests', node, ['--import', './scripts/ts-resolve-register.mjs', 'scripts/smoke.mjs']);

// ── Publish ──────────────────────────────────────────────────────────────────

heading(PUSH ? 'Publishing' : 'Publish check (dry run)');

if (!upstream.ok) {
  console.log('    No upstream branch — nothing to push against.');
  console.log(`    Set one with:  git push -u origin ${branch}`);
} else {
  // Fetch first: pushing on top of a stale view of the remote is how work gets
  // clobbered or rejected mid-release.
  const fetched = gitQuiet('fetch', 'origin', '--quiet');
  if (!fetched.ok) console.log('    (could not reach the remote; comparing against the last known state)');

  const ahead = git('rev-list', '--count', `${upstream.out}..HEAD`);
  const behind = git('rev-list', '--count', `HEAD..${upstream.out}`);

  console.log(`    ahead of ${upstream.out} by ${ahead}, behind by ${behind}`);

  if (Number(behind) > 0) {
    fail(
      'the remote has commits this branch does not',
      `Reconcile first:  git pull --rebase\n(then re-run the release)`,
    );
  }

  if (Number(ahead) === 0) {
    console.log('    Nothing to push — the remote already matches.');
  } else {
    console.log('\n    Commits that would ship:');
    console.log(
      git('log', '--oneline', `${upstream.out}..HEAD`)
        .split('\n')
        .map((line) => `      ${line}`)
        .join('\n'),
    );

    if (PUSH) {
      console.log('');
      run('push', 'git', ['push']);
      console.log(`\n    Pushed to ${upstream.out}.`);
    } else {
      console.log('\n    Dry run — nothing was pushed.');
      console.log('    Re-run with:  npm run release -- --push');
    }
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n\x1b[32m✓ Release checks passed in ${seconds}s\x1b[0m`);

if (PUSH) {
  console.log('\nRemaining manual step — the browser pass the automated tests cannot cover:');
} else {
  console.log('\nBefore publishing, run the manual browser pass:');
}
console.log(`
  npm run dev, then at http://localhost:5273 confirm:
    · start screen → import → library view
    · pins land on the right places on the basemap
    · clicking a pin filters that day only
    · switching days, back button, map collapse
    · Export site → unpack → index.html opens standalone
`);
