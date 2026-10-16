# Notebook composer

The notebook is still ordinary Hugo Markdown under `content/notes/`. The existing
Cloudflare Worker now serves a small web composer at its root URL. Open it on
an iPhone or Mac, sign in with your existing publishing secret, write, and tap
**Publish**. Apple Shortcuts are no longer required.

Live composer: **https://yasharma-note-publisher.yasharma.workers.dev/**

The date/category/photo upgrade is deployed as Worker version
`ca858100-aac2-49b4-93c4-6743503b7d00`. Reload the composer to use it; existing
sign-in sessions and text drafts are preserved. No new secrets are required.

The composer upgrade was deployed to the existing Worker on 2026-10-15, version
`29116c31-8422-4c8f-b610-c92d827e8bc4`. Both existing server-side secrets were kept.
The publishing runtime fix was deployed on 2026-10-15 (Pacific), version
`4e059cbe-80ce-4e81-b741-129f42f52c1e`: GitHub requests now use Cloudflare's
supported manual redirect mode. The previous unsupported mode prevented the
request from reaching GitHub and produced an unconfirmed-publishing message.

## Deploy the composer

From the repository root:

```sh
cd tools/note-publisher
npm test
wrangler deploy
```

Use the HTTPS address printed by Wrangler, **without `/publish`**. `/` is the
composer; `/publish` remains the authenticated JSON API. This deployment updates
the existing `yasharma-note-publisher` Worker and its static assets. It does not
create a second service, database, or CMS. Your installed Homebrew Wrangler can
be used directly; there is no need to run it through npx.

The existing `GITHUB_TOKEN` and `PUBLISH_SECRET` secrets are reused. You do not need
to replace them to upgrade. `wrangler secret list` shows their names, not values.
If setting up from scratch, run `wrangler login`, `wrangler deploy`, then:

```sh
wrangler secret put GITHUB_TOKEN
wrangler secret put PUBLISH_SECRET
```

Paste credentials only at the interactive prompts. `PUBLISH_SECRET` should be a
random 64-character hexadecimal value saved in your password manager. To generate
one on a Mac and copy it directly to the clipboard:

```sh
openssl rand -hex 32 | tr -d '\n' | pbcopy
```

The GitHub credential must be a fine-grained token owned by `yashrmaa`, restricted
to **only `yasharma`**, with **Contents: Read and write**. Metadata read-only is
included automatically; no Actions, Workflows, Pages, or Administration permission
is required. Create it under GitHub Settings → Developer settings → Personal
access tokens → Fine-grained tokens. Give it an expiration and renewal reminder.
Never enter this GitHub token in the composer. [GitHub permissions](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents)

The repository settings in `wrangler.toml` remain `yashrmaa/yasharma`, branch `main`,
site `https://yasharma.com`. No website hosting or DNS changes are needed. Pushing
the source repository deploys the Hugo website; Worker code/assets are deployed
separately with `wrangler deploy`.

## Use and install

1. Open the Worker's root HTTPS URL in Safari.
2. Enter your **publishing secret** once and sign in. The browser keeps a session
   for up to 30 days, subject to browser cookie retention.
3. Write in the text area and tap **Publish**. Optionally expand **Categories &
   photos** to add comma-separated categories or choose photos. No title required.

Ordinary text creates an untitled note. To save a link, put a complete HTTP/HTTPS
URL by itself on the first line; any text below it becomes your comment. A URL
alone is valid. Link titles fall back to the hostname. No metadata is fetched.
URLs appearing later in a thought remain part of that thought. Existing input
validation, literal Markdown escaping, UTC timestamps, UUID filenames, collision
handling, and GitHub commits are reused.

## Days, times, categories, and photos

The Notes feed groups entries by calendar day, inspired by
[Simon Willison's feed](https://simonwillison.net/). Publishing again adds another
entry under that day's heading. Each entry keeps its own Markdown file, timestamp,
and permanent URL; this does not merge or overwrite earlier posts. Times and day
boundaries use `params.notesTimeZone: America/Los_Angeles` in `config.yml`, including
daylight-saving changes. Stored timestamps remain UTC. A day can continue onto
the next archive page, where its heading is repeated.

Categories are optional: enter up to eight comma-separated names, each at most
40 characters. Names are normalized to lowercase; reusing a name collects entries
on the existing `/categories/<name>/` page. Blog posts and notes can share a
category. Notes display their actual text on those pages. Categories also appear
in Notes RSS. Existing entries and URLs need no migration.

Choose up to three photos from the system photo/file picker. The composer shows
previews, optional descriptions (alt text), and a Remove button for each. It
resizes to at most 1600 pixels on either side and converts to JPEG, at most 500
KiB per image. Canvas re-encoding discards original photo EXIF/GPS metadata;
transparent pixels become white and animations become a still image. Files over
30 MiB are rejected before decoding. Supported formats depend on the browser:
if an HEIC/HEIF photo cannot be opened, export it as JPEG and choose that copy.
Photo-only posts are valid. Text, categories, and processed photos are saved in
the local draft together, subject to browser storage limits.

Photos are stored as ordinary files under `static/notes-media/`, with server-made
UUID names. Notes use standard Markdown image links with absolute website URLs
(also usable in RSS). No R2 bucket, new credential, or paid image service is needed.
These are public website photos, not a private image backup; Git retains history.

The Worker uploads photos sequentially with the existing GitHub Contents API,
then commits the Markdown note only when every photo is confirmed. Photo commits
include `[skip ci]`; the final note commit triggers the existing site deployment,
including all its photos. This avoids a full deployment for each intermediate
image. [GitHub skip semantics](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs)
If an upload fails, no note is created and the complete draft remains available.
An interrupted attempt can leave unreferenced photo files: remove these manually
only after checking that no note links to them. A lost response to the final
note commit remains ambiguous—check Notes before retrying.

Existing JSON clients continue to work. Optional additions to `/publish` are
`categories: ["life", "places"]` and `photos: [{"data": "<base64 JPEG>", "alt":
"Optional description"}]`. The composer performs conversion; API clients must
provide JPEGs within the same byte/dimension limits. The server checks JPEG
structure/dimensions; it does not re-encode images from custom API clients.

**iPhone Home Screen:** in Safari, open the composer URL → Share → Add to Home
Screen → leave **Open as Web App** enabled if offered → name it **Notebook** → Add.
Open that icon and sign in there if asked. The manifest provides standalone mode
and icons, including an Apple touch icon. [Apple's iPhone instructions](https://support.apple.com/guide/iphone/iphea86e5236/ios)

**macOS Dock:** in Safari on macOS Sonoma 14 or later, open the composer →
File → Add to Dock (or Share → Add to Dock) → name it **Notebook** → Add. Open the
Dock app and sign in if asked. On older macOS, bookmark the same URL in Safari.
[Apple's Mac instructions](https://support.apple.com/en-us/104996)

Install before writing a long draft: Safari and installed web apps can have
separate cookies and storage. iPhone and Mac do not share drafts or sessions.

## Drafts and feedback

- A draft is saved to localStorage on each edit and restored when this browser
  or installed app reopens. It is not uploaded until you press Publish.
- Drafts are local, unencrypted browser data, not a synced backup. Clearing site
  data or browser storage can remove them. Signing out keeps the draft; delete
  the text and categories and remove photos before signing out if you want to
  clear it on a shared device.
- One current draft is stored per browser/app. Avoid composing different entries
  in multiple tabs at the same time.
- If local storage is unavailable, the composer explicitly says saving is
  unavailable and keeps the text in the open window.
- If connectivity drops while the composer is open, you can keep writing locally.
  Reconnect to publish. There is no service worker, offline launch cache, or
  automatic background publishing; a fresh launch needs a network connection.
- While publishing, the button is disabled and the text is read-only to prevent
  repeated submits. Errors and expired sign-in preserve your draft.
- A successful response means **committed to GitHub**, not necessarily live.
  The composer provides the permanent note link and a deployment-status link.
  The permanent URL can briefly return 404 until GitHub Pages finishes.
- A timeout or incomplete response could follow a successful commit. The draft
  and an unconfirmed-attempt marker are retained across reloads. Check Notes and
  GitHub Actions before manually retrying. There are no automatic client retries.
- The draft is cleared only after a confirmed commit; a newer stored draft from
  another window is preserved if detected at that moment.

## Authentication and security

The login page sends the publishing secret once over HTTPS to `POST /session`.
The Worker compares it with `PUBLISH_SECRET`, then issues a signed HMAC-SHA256
session cookie bound to the Worker's origin and expiring after 30 days. No extra
server secret or session database is needed. The cookie has `HttpOnly`, `Secure`,
`SameSite=Strict`, `Path=/`, and a `__Host-` prefix; browser JavaScript cannot read
it. The publishing secret is cleared from the input after login and is never
stored in localStorage or sessionStorage by the app. A password manager may save
it if you choose. The GitHub token never leaves the Worker.

`GET /session` reports session status; `DELETE /session` clears the current
browser's cookie. Cookie-authenticated publishing, login, and logout enforce an
exact same-origin check. Existing bearer-authenticated `/publish` clients remain
compatible; cross-origin browser requests are not enabled. The static app shell
is public, but all writes require authentication. There is no unauthenticated
write endpoint.

The app uses only local scripts/styles, a restrictive Content Security Policy,
frame blocking, no-referrer, no-store responses, and noindex headers. It displays
messages as text, never injected HTML. It never fetches user-supplied URLs, logs
secrets, or returns upstream response bodies. Stored observability remains off.

The API allows at most 2 MiB UTF-8 JSON including photos, with text/metadata capped
at 32 KiB, 10,000 text characters, 4,096 URL characters, and 300 optional title
characters. Photos have independent count, byte, and dimension limits. The composer checks
lengths before submitting; the Worker independently validates every request.
Only new `content/notes/YYYY-MM-DD-UUID.md` and `static/notes-media/YYYY-MM-DD-UUID.jpg`
files can be created. It never accepts
caller-chosen paths or passes a file SHA that could overwrite existing content.

This is single-owner authentication. Anyone with the publishing secret can sign
in; there are no accounts or per-device revocation lists. Sign-out clears this
browser's cookie, but a previously copied cookie remains usable until expiration
or secret rotation. GitHub's token itself is repository-scoped, not directory-
scoped; the Worker enforces the notes/media path restrictions. There is no application
rate limiter; keep the publishing secret long and random.

## Verify automatic site deployment

The existing `.github/workflows/hugo.yaml` runs on **pushes to `main`** with
no path filter. It builds with Hugo 0.115.1 extended, runs Pagefind, and deploys to
GitHub Pages. The Worker still uses GitHub's Contents API with the fine-grained
PAT, so successful commits produce push events. Do not substitute Actions'
built-in `GITHUB_TOKEN`, whose pushes generally do not trigger another workflow.
[GitHub's trigger rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)

Repository inspection on 2026-10-15 found `main` unprotected, with the latest
notebook implementation commit `9c15afdc7228f427eb66e8a3519808ec28cce3d0`
automatically deployed by successful push-triggered run
[38793077488](https://github.com/yashrmaa/yasharma/actions/runs/38793077488).
The owner's first real composer note, commit
`cae0583484b103a72cade5cd1abbb66ba56fcf3a`, subsequently triggered successful
push deployment [38833332010](https://github.com/yashrmaa/yasharma/actions/runs/38833332010).
This confirms the live composer → GitHub → Pages pipeline. The original
inspection and the composer upgrade both confirmed workflow-based Pages hosting,
no applicable branch rules, no required deployment reviewers, and that `main` is
allowed by the Pages environment. No workflow changes are necessary. Secrets were
not retrieved and no fabricated public entry was created for verification.

For a live end-to-end check, sign in and publish a real thought you want to keep.
Then match the new Contents API commit SHA to a push-triggered Pages run:

```sh
gh api 'repos/yashrmaa/yasharma/commits?path=content/notes&per_page=5' \
  --jq '.[] | {sha, message: .commit.message}'
gh run list --repo yashrmaa/yasharma --workflow hugo.yaml --limit 5 \
  --json headSha,event,status,conclusion,url
```

Wait for that run to succeed, then check the returned permalink, `/notes/`, the
homepage preview, and `/notes/index.xml`. Do not populate the public feed with
fabricated test posts. Mocked endpoint/browser tests verify the authenticated
composer-to-Contents-API behavior without publishing content.

If repository settings change later, required PRs/checks or Pages environment
reviewers can block unattended publishing. Allow the intended publisher to write
`main` through an appropriate rule bypass, keep `main` permitted for Pages, and
remove any required manual deployment review if automatic publishing is intended.
A PAT cannot bypass branch rules by itself; adding token permissions is not the
fix. Keep Pages configured for GitHub Actions and the workflow enabled.

## Files and cleanup audit

Preserved:

- Homepage preview, navigation, published files, permalinks, portable Markdown,
  PaperMod theme, and the existing GitHub Pages workflow.
- The Worker's GitHub Contents API writes,
  create-only collision handling, and structured commit/error responses.
- `GITHUB_TOKEN`, `PUBLISH_SECRET`, and the fine-grained token permissions.
- The `kind: link` model, source URL rendering, and bearer API support. These are
  useful to the composer and existing clients, not Shortcut-specific code.

Added/modified:

- `tools/note-publisher/src/worker.mjs`: serves static assets and session routes;
  accepts authenticated browser sessions alongside the existing bearer API.
- `tools/note-publisher/src/session.mjs`: cookie signing, verification, origin
  checks, and response security headers.
- `src/photos.mjs` and `public/photo-input.js`: JPEG validation and on-device
  photo preparation; composer fields and drafts now support categories/photos.
- `layouts/notes/`, `layouts/partials/notes/`, `assets/css/extended/notes.css`,
  and `config.yml`: local day headings, timed permalinks, categories, photo styling,
  and RSS categories. `layouts/_default/list.html` mirrors PaperMod's existing
  list, adding a branch to render notes properly in category/searchable lists.
- `tools/note-publisher/public/`: HTML, CSS, a small JavaScript module, manifest,
  and app icons. No framework, remote scripts, or runtime packages.
- `tools/note-publisher/wrangler.toml`: serves those assets from the same Worker.
- Endpoint/composer/browser tests and package scripts.
- This guide and README now describe the composer. The obsolete Shortcut
  construction walkthrough and Shortcut-dependent setup requirements were
  removed. There were no checked-in Shortcut artifacts or separate sharing
  service to remove. No content or Hugo features were deleted.

If you created the old Shortcuts on your phone, you can remove them manually.
They are not required by the new flow. Nothing is installed or removed on your
phone or Dock automatically.

## Tests

```sh
npm test --prefix tools/note-publisher
npm run test:runtime --prefix tools/note-publisher
HUGO_BIN=/path/to/hugo-0.115.1 npm run test:site --prefix tools/note-publisher
cd tools/note-publisher
wrangler deploy --dry-run --outdir /tmp/yasharma-note-worker
```

Node 22+ is required. Site tests also use Python 3's standard XML parser and the
existing deployment version of Hugo. They build temporary fixtures, not real
public notes, and cover existing page preservation, feeds, ordering, pagination,
metadata, Unicode, and titleless entries. Do not upgrade Hugo/PaperMod just to
run these checks.

The runtime test reuses Miniflare bundled with your installed `wrangler` (no
download or global npm installation). You may override its location with
`MINIFLARE_MODULE`. It runs the production Worker in Cloudflare's workerd runtime
with fake credentials and a local GitHub stub, covering cookie authentication,
note/link writes, redirect refusal, and collision recovery. This catches runtime
differences that Node mocks miss: GitHub requests must use `redirect: "manual"`
because workerd rejects `redirect: "error"`. Redirects are treated as failures;
credentials are never forwarded to another host.

Browser tests use Playwright as an optional development tool. If already
installed, set `PLAYWRIGHT_MODULE` to its `index.mjs` path. Otherwise install it
locally for testing only:

```sh
cd tools/note-publisher
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:browser
```

You can set `CHROME_PATH` to an installed Chrome executable instead of downloading
a browser, and `SCREENSHOT_DIR` to a temporary directory for screenshots. Tests
run the actual Worker/auth code and browser UI, mocking only GitHub writes.
They cover sign-in/out, inaccessible HttpOnly cookies, draft persistence,
Unicode, note/link commits, error/expired-session recovery, offline drafting,
storage denial, and mobile/desktop light/dark layouts. Home Screen/Dock metadata
is checked, but actual installation on your devices must be done by you.

## Credentials and maintenance

Run these inside `tools/note-publisher`:

- GitHub token expired or leaked: revoke it in GitHub, create a new repository-only
  token with Contents read/write, then `wrangler secret put GITHUB_TOKEN`.
  Browser sign-in does not change. Review commits if it was compromised.
- Publishing secret leaked: generate a replacement, then
  `wrangler secret put PUBLISH_SECRET`. This invalidates every existing session
  and old bearer client. Sign in again on each device with the new value.
- Disable publishing immediately: `wrangler secret delete PUBLISH_SECRET`.
  The app may still load, but authentication and writes fail closed.
- Inspect live requests while troubleshooting: `wrangler tail`. Do not add logs
  of authorization headers, cookies, request bodies, or secret values.

Edit a note's Markdown in GitHub or your checkout and push `main` to update it.
Keep its filename to preserve the URL. To remove it from the site, set
`draft: true` or delete its file and push; Git history and external caches can
retain older copies. The composer intentionally has no remote edit/delete UI.
All entries remain portable Markdown even if you stop using the Worker.
