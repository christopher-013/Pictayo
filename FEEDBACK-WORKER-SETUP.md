# Public-beta feedback setup

PicturePicture's in-app form posts to
`https://picturepicture-feedback.cch13.workers.dev/api/feedback`. The Cloudflare
Worker in `feedback-worker.js` creates a public issue in
`christopher-013/PicturePicture`, so visitors stay inside PicturePicture and do
not need a GitHub account.

The GitHub credential must remain an encrypted Cloudflare secret. Never put it
in the browser code, HTML, Wrangler configuration, GitHub Actions variables, or
documentation.

## One-time activation

1. Create a fine-grained GitHub personal access token.
2. Limit repository access to **PicturePicture** only.
3. Grant **Issues: Read and write** and no other write permission.
4. From an authenticated terminal, run:

```powershell
npx wrangler secret put GITHUB_TOKEN --name picturepicture-feedback
npx wrangler deploy
```

Wrangler prompts for the token without storing it in the repository. Give the
token a short expiration and rotate it before it expires.

## Security and privacy

Feedback becomes a public GitHub issue, which the dialog clearly discloses. The
form does not collect an email address or attach photos. The Worker restricts
origins and methods, limits request size and submission rate, uses a honeypot,
escapes user text, and returns only the new issue number. The GitHub token stays
inside Cloudflare's encrypted secret store.

After deployment, submit a clearly labeled test report in the app, confirm the
in-app success message appears without opening GitHub, and then close the test
issue.
