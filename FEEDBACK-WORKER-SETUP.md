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
integer per UTC day and a daily cron posts the previous day's total to a webhook.

Activation needs two things Wrangler cannot guess:

```powershell
npx wrangler kv namespace create USAGE_COUNTS
```

Put the printed id into `kv_namespaces[0].id` in `wrangler.jsonc`, replacing
`REPLACE_WITH_KV_NAMESPACE_ID`. Then set the digest destination — any Discord or
Slack incoming webhook URL, which is a secret because anyone holding it can post
to that channel:

```powershell
npx wrangler secret put DIGEST_WEBHOOK_URL --name picturepicture-feedback
npx wrangler deploy
```

The cron runs at 08:00 UTC. To see a digest immediately rather than waiting:

```powershell
npx wrangler tail --name picturepicture-feedback
```

If the KV binding or the webhook secret is missing, counting and the digest log
an error and do nothing else. Neither failure is ever visible to a visitor, and
neither blocks an import.

## Security and privacy

Feedback becomes a public GitHub issue, which the dialog clearly discloses. The
form does not collect an email address or attach photos. The Worker restricts
origins and methods, limits request size and submission rate, uses a honeypot,
escapes user text, and returns only the new issue number. The GitHub token stays
inside Cloudflare's encrypted secret store.

After deployment, submit a clearly labeled test report in the app, confirm the
in-app success message appears without opening GitHub, and then close the test
issue.
