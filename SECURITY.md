# Security policy and threat model

## Supported release

Security fixes are applied to the current `master` branch and the public beta
deployed from it.

## Reporting a vulnerability

Do not put security reports, private photo details, credentials, or personal
information in the public feedback form or a public GitHub issue. Use GitHub's
private vulnerability reporting for the PicturePicture repository when it is
available, and include only the minimum reproduction data required. Never attach
a personal photo library.

## Trust boundaries

PicturePicture has no user accounts and no media backend. Imported photos,
derived previews, and original videos are stored in the browser's IndexedDB.
They are not sent to PicturePicture or its feedback service. Local browser data
is not encrypted by the application; anyone with access to the browser profile
may be able to read it.

When a file contains GPS coordinates, only coordinates are shared with:

- BigDataCloud for reverse geocoding;
- OpenStreetMap Overpass mirrors for landmarks and nearby dining;
- Google Maps when a map is displayed; and
- Wikipedia or Google Maps only after the user follows an information link.

Those services receive normal connection data such as an IP address. Filenames,
photo bytes, captions, and timestamps are not included in location lookups.

Public-beta feedback sends the selected category, user-entered text, current app
route, viewport, app version, and browser user agent to a dedicated Cloudflare
Worker. The Worker creates a public GitHub issue. It never receives photos or a
contact email.

## Implemented controls

- A restrictive Content Security Policy limits scripts, workers, frames,
  network connections, media, and form actions to the app's required origins.
- User-controlled names and third-party place names are escaped before entering
  generated HTML; dynamic lightbox content uses DOM text nodes. Exported album
  metadata is stored as inert, script-safe JSON rather than executable code.
- External windows use `noopener noreferrer`.
- File processing happens locally, with bounded sampled hashing and compressed
  derivatives to limit memory and storage pressure.
- Feedback uses a server-side, Issues-only GitHub token stored as an encrypted
  Cloudflare secret. The API enforces an origin allowlist, JSON content type,
  body limits, rate limiting, a bot honeypot, hostile-content rejection,
  neutralized mentions/HTML, request timeout, and generic failures.
- CI uses a locked dependency install, TypeScript, production build, dependency
  audit, fixture tests, and security-focused smoke checks before deployment.

## Hosting limitation

GitHub Pages provides HTTPS and HSTS but does not allow this repository to set
custom response headers. CSP is therefore delivered by a supported HTML meta
policy. Header-only protections such as `frame-ancestors`, Permissions Policy,
and `X-Content-Type-Options` cannot be enforced on the static page. Before a
general-availability launch, consider a host or edge proxy that can attach
those headers. The feedback Worker already sends its own defensive headers.

## Secret handling

Never commit or paste `GITHUB_TOKEN`, Cloudflare credentials, or any other secret
into browser code, HTML, logs, documentation, issues, or chat. Follow
`FEEDBACK-WORKER-SETUP.md`; the intended token has access only to
`christopher-013/PicturePicture` and only **Issues: Read and write**.
