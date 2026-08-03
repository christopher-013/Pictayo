# Pictayo 1.0 release-readiness audit

Audit date: 2026-08-02

Release reviewed: `1.0.0`

## Result

No known dependency vulnerabilities or exposed credentials were found. The
browser app has a deliberately small trust surface: local file processing,
IndexedDB storage, keyless location services, Google map frames, and one text-
only feedback API. The hardening work in this audit is covered by the normal
`npm run verify` gate.

| Area | Result | Evidence / action |
| --- | --- | --- |
| Dependencies | Pass | `npm audit` reported 0 vulnerabilities across 99 installed dependencies. |
| Secrets | Pass | No browser or repository token; feedback reads only `env.GITHUB_TOKEN`. |
| DOM injection | Pass | All HTML-string inputs are escaped; feedback and lightbox text use DOM text nodes. |
| Export injection | Fixed | Lightbox metadata is inert JSON with HTML-significant characters escaped before ZIP generation. |
| Browser policy | Improved | Added a restrictive CSP for scripts, workers, frames, connections, forms, media, and objects. |
| External navigation | Improved | All new-window links use `noopener noreferrer`. |
| Feedback abuse | Improved | Allowlisted origins, rate limit, honeypot, size/type checks, hostile-content rejection, sanitization, timeout, generic errors. |
| Import memory | Improved | Photo IDs sample at most 768 KiB instead of buffering every complete original for hashing. |
| Feedback rate limit | Fixed | The Worker treated `FEEDBACK_RATE_LIMITER` as optional and failed **open**: with the binding absent, 12 rapid requests created 12 GitHub issues. It now refuses to file issues without a working limiter, and smoke covers the missing, throttling, and failing-limiter cases. |
| Dev-server styling | Fixed | `style-src 'self'` blocked Vite's dev-mode inline styles, leaving `npm run dev` completely unstyled and the manual review pass unable to verify anything. The relaxation now lives in `vite.config.ts` for `serve` only; smoke asserts it never reaches the built page. |
| Release gate | Improved | CI now runs an npm vulnerability audit before build and smoke tests. |
| Privacy | Documented | `SECURITY.md` records every outbound data flow and local-storage limitation. |
| AI/code review | Documented | `CLAUDE.md` lists architecture, invariants, commands, and review priorities. |

## Residual risks and follow-up

1. GitHub Pages cannot set header-only protections. Use Cloudflare or another
   configurable edge before GA if clickjacking/Permissions Policy headers are a
   release requirement.
2. The feedback Worker must be deployed and receive its encrypted Issues-only
   token before submissions succeed. The UI fails closed and never redirects to
   GitHub when the endpoint is unavailable.
3. Browser storage is not application-encrypted. Shared-device users should
   clear imported items when finished and protect their operating-system/browser
   profile.
4. Third-party place results are suggestions, not authoritative identifications.
   The UI deliberately says “Near” or “Nearby” where confidence is limited.
5. HEIC/HEVC preview support depends on the browser codec stack; metadata and map
   placement remain available when decoding fails.

## Reproduce the audit

```powershell
npm ci
npm audit --audit-level=high
npm run verify
git diff --check
```

Then exercise import, map zoom, photo lightbox, deletion, export, and the
feedback dialog in a browser at desktop and phone widths. Confirm the production
GitHub Pages run completed successfully and inspect the deployed CSP/metadata.
