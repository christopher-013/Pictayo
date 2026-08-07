# Pictayo feedback setup

Pictayo's in-app form posts to
`https://picturepicture-feedback.cch13.workers.dev/api/feedback`. The Cloudflare
Worker in `feedback-worker.js` creates a public issue in
`christopher-013/Pictayo`, so visitors stay inside Pictayo and do
not need a GitHub account.

The GitHub credential must remain an encrypted Cloudflare secret. Never put it
in the browser code, HTML, Wrangler configuration, GitHub Actions variables, or
documentation.

## One-time activation

1. Create a fine-grained GitHub personal access token.
2. Limit repository access to **Pictayo** only.
3. Grant **Issues: Read and write** and no other write permission.
4. From an authenticated terminal, run:

```powershell
npx wrangler secret put GITHUB_TOKEN --name picturepicture-feedback
npx wrangler deploy
```

Wrangler prompts for the token without storing it in the repository. Give the
token a short expiration and rotate it before it expires.

## Usage counting

The same Worker serves `/api/ping`, an anonymous counter that answers one
question: did anyone import photos today. GitHub Pages keeps no visitor logs, so
nothing else can tell you whether the site is used.

The browser sends `{"event":"import"}` once per session, after media is actually
stored. There is no identifier, cookie, user agent, or IP retention — the client
address is a rate-limit key and is never written down. The Worker keeps one
integer per UTC day.

### Where the counts appear

A cron at 08:00 UTC appends the previous day's total as a comment on a single
issue titled **Pictayo usage log**, created on first use. It reuses the
Issues-scoped token feedback already needs, so the digest adds no credential and
no third-party service, and GitHub's own notifications deliver it by email.

Days with no imports are skipped, so the log and the inbox carry only real
signal. Watching the repository is what produces the email; because the comment
is authored by the token's owner, GitHub suppresses it unless
**Settings → Notifications → Include your own updates** is enabled.

The issue lives in a public repository, so the daily counts are publicly
readable. They contain nothing but a date and a number.

### Activation

Only one value cannot be guessed:

```powershell
npx wrangler kv namespace create USAGE_COUNTS
```

Put the printed id into `kv_namespaces[0].id` in `wrangler.jsonc`, replacing
`REPLACE_WITH_KV_NAMESPACE_ID`, then deploy:

```powershell
npx wrangler deploy
```

To mirror the digest into Discord or Slack as well, set the optional webhook
secret. Without it, the GitHub log is the only destination:

```powershell
npx wrangler secret put DIGEST_WEBHOOK_URL --name picturepicture-feedback
```

### Reading counts without waiting

Raw values are visible in the Cloudflare dashboard under **Workers & Pages → KV
→ USAGE_COUNTS**, keyed `count:YYYY-MM-DD:import`. To watch a ping arrive live:

```powershell
npx wrangler tail --name picturepicture-feedback
```

If the KV binding or the GitHub secret is missing, counting and the digest log an
error and do nothing else. Neither failure is visible to a visitor, and neither
blocks an import.

## Security and privacy

Feedback becomes a public GitHub issue, which the dialog clearly discloses. The
form does not collect an email address or attach photos. The Worker restricts
origins and methods, limits request size and submission rate, uses a honeypot,
escapes user text, and returns only the new issue number. The GitHub token stays
inside Cloudflare's encrypted secret store.

After deployment, submit a clearly labeled test report in the app, confirm the
in-app success message appears without opening GitHub, and then close the test
issue.
