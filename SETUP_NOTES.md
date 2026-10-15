# Publish to the notebook from an iPhone

The implementation is ready in this checkout. It is **not deployed yet**, and no
Shortcut has been installed on your phone. Complete the one-time steps below;
afterward publishing needs only the Share Sheet or the Home Screen Shortcut.
No sample posts have been added to the public content.

## What changed

- `config.yml`: adds `/notes/:filename/` permalinks and the notes navigation item.
- `content/notes/_index.md`: introduction and inherited PaperMod settings. The
  inherited title `Note` gives untitled entries readable metadata without adding
  a visible headline. Actual entries can omit `title` entirely.
- `layouts/notes/{list.html,single.html,rss.xml}` and
  `layouts/partials/notes/{entry.html,label.html}`: one dated feed, 20 entries per
  page, permanent pages, and full-content RSS (latest 50 entries).
- `assets/css/extended/notes.css`: small typography adjustments using PaperMod's
  existing color variables, including dark mode and narrow screens.
- `content/_index.md` and `layouts/shortcodes/recent-notes.html`: four newest notes
  and a “More notes” link. Existing homepage text is preserved.
- `tools/note-publisher/`: Worker source, configuration, dependency-free Node
  tests, isolated Hugo integration tests, and local secret/build ignores.

The bundled PaperMod theme, reading page, blog archive, existing URLs, blog RSS,
legacy `/posts/` redirects/feed, and deployment workflow are retained. The blog
archive stays a blog archive; the paginated `/notes/` feed is the notebook archive.
The site-wide `/index.xml` also includes notes, while `/blog/index.xml` stays
blog-only. `/notes/index.xml` includes source links and full note bodies. Tags
remain optional and unused; this does not introduce another taxonomy.

## How publishing works

`iPhone → HTTPS POST /publish → Cloudflare Worker → GitHub Contents API → main → existing Pages workflow`

GitHub Pages is static hosting and supplies no server-side write endpoint. The
Worker is separate from the Hugo build and needs no database or runtime packages.
It writes only new `content/notes/YYYY-MM-DD-<UUID>.md` files. The UTC timestamp and
UUID are generated on the server; titles and edits never change the URL.

The Worker validates a maximum 32 KiB UTF-8 JSON body, kind, URL (4,096 characters),
title (300), and text (10,000, measured as JavaScript string length). Link titles
default to the source hostname. It accepts external HTTP/HTTPS links, rejects
embedded credentials and own-site/localhost URLs, and never fetches the source.
Phone text is saved as literal Markdown text: punctuation is escaped so HTML,
Markdown headings, and Hugo shortcodes typed into a thought remain text. Unicode
and paragraph breaks are preserved. You can write ordinary Markdown when editing
files manually. JSON-quoted YAML strings prevent front matter injection.

An authenticated success is HTTP 201:

```json
{
  "ok": true,
  "status": "committed",
  "live": false,
  "message": "Saved to your repository. The site will update after deployment.",
  "url": "https://yasharma.com/notes/YYYY-MM-DD-UUID/",
  "path": "content/notes/YYYY-MM-DD-UUID.md",
  "commit_sha": "..."
}
```

This confirms a Git commit, **not a live deployment**. The URL can return 404 until
Pages finishes. The API does not poll deployments or need Actions permissions.
Errors have non-2xx status and `{ "ok": false, "error": { "code": "...",
"message": "..." } }`. Collision/concurrent-write retries are bounded to three
attempts and never overwrite an existing file. A lost GitHub response returns
`commit_unknown` with `status: "unknown"`, the expected path and URL: check the
repository or feed before resubmitting. Re-running a Shortcut deliberately creates
a new entry; there is no automatic client retry or deduplication database.

## 1. Put the site changes on main

Review and commit these changes through your usual Git workflow, then push `main`.
Keep unrelated existing working-tree files out of that commit. Wait for the
**Deploy Hugo site to Pages** action to pass and visit `/notes/` before testing
phone publishing. The feed will initially be empty.

## 2. Create the GitHub credential

In GitHub, open **Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate new token**.

1. Name: `yasharma note publisher`; choose an expiration and set a renewal reminder.
2. Resource owner: **yashrmaa**.
3. Repository access: **Only select repositories → yasharma**.
4. Repository permissions: **Contents: Read and write**. **Metadata: Read-only**
   is automatically included. Leave all other repository/account permissions off.
   No Actions, Workflows, Pages, Administration, or organization permissions are
   required.
5. Generate and copy the token into your password manager, then into the Worker
   secret prompt below. Never put it in the Shortcut, this repository, or Hugo
   config.

GitHub does not restrict a fine-grained token to a directory. Repository selection
limits the credential; the Worker enforces create-only writes under
`content/notes/`. See [GitHub's Contents API permissions](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents).

## 3. Configure and deploy the Worker

Prerequisites: a Cloudflare account, Node.js 22 or later, and npm. Run from the
repository root:

```sh
cd tools/note-publisher
npm test
npx wrangler@4 login
npx wrangler@4 deploy
```

`wrangler.toml` already targets `yashrmaa/yasharma`, branch `main`, and
`https://yasharma.com`. Keep those values unless the site moves. The first deploy
creates the Worker; it rejects publishing until both secrets are set. Wrangler
prints a URL like `https://yasharma-note-publisher.YOUR-SUBDOMAIN.workers.dev`.
The Shortcut endpoint is that URL plus **`/publish`**. No DNS change to the site is
needed. Wrangler may ask you to choose an account or enable your workers.dev
subdomain the first time.

Set secrets interactively (paste at the hidden prompt, not as shell arguments):

```sh
npx wrangler@4 secret put GITHUB_TOKEN
npx wrangler@4 secret put PUBLISH_SECRET
```

For `PUBLISH_SECRET`, generate a **different** random 64-character hexadecimal
secret in your password manager. Alternatively, on macOS copy fresh randomness
directly to the clipboard:

```sh
openssl rand -hex 32 | tr -d '\n' | pbcopy
```

Store it in your password manager and paste it into the second secret prompt and
both Shortcuts. The Worker accepts 32–256 characters from letters, digits, `_`,
and `-`. The GitHub token stays server-side. The publishing secret grants only the
Worker's publishing capability, but someone who has it can post to your site.
Do not share a configured Shortcut or an iCloud sharing link containing it.

`wrangler secret put` updates/deploys the secret; no further site deployment is
needed for secret changes. Inspect names (not values) with:

```sh
npx wrangler@4 secret list
```

See [Cloudflare's secret setup](https://developers.cloudflare.com/workers/configuration/secrets/).
The Worker rejects HTTP, does not redirect authorization to another host, exposes
no browser admin interface or CORS write access, and never logs request bodies,
authorization headers, or upstream error bodies. Observability is disabled in
the checked-in Worker configuration. Keep tokens out of terminal transcripts.

## 4. Build “Save to my site” in Apple Shortcuts

These instructions use native actions. Search by the bold action names. Action
wording can vary slightly with iOS version. Insert named variables using the
variable picker; do not type variable names as plain text. This guide is provided
instead of an unverified `.shortcut` artifact: the available CLI signs existing
Shortcuts but does not provide a supported action-construction/validation API.

### Receive and extract a shared link

1. In Shortcuts, tap **+**, name it **Save to my site**. Open the shortcut's details
   and enable **Show in Share Sheet**. In the top **Receive … input from Share
   Sheet** block, select **URLs**, **Safari Web Pages**, and **Text**. Set **If
   there's no input** to **Continue** so the fallback below runs.
2. Add **Get URLs from Input**. Set its input explicitly to **Shortcut Input**.
   This handles Safari pages, direct URLs, and common apps sharing text with a URL.
3. Add **Set Variable**: name it `SharedURLs`, value the preceding **URLs** output.
4. Add **If** `SharedURLs` **does not have any value**:
   - **Ask for Input**, type **URL**, prompt `Paste the link to save`.
   - **Get URLs from Input**, input **Provided Input** from that question.
   - **Set Variable** `SharedURLs` to these **URLs**.
   End If.
5. Add **If** `SharedURLs` **does not have any value**:
   - **Show Alert**: `No link found. Share a web URL or paste one.`
   - **Stop This Shortcut** (called **Stop and Output** on some versions; leave
     output empty).
   End If.
6. Add **Count**, count **Items** in `SharedURLs`. Add **If** count **is greater
   than** `1`: **Choose from List**, list `SharedURLs`, prompt `Which link?`,
   **Select Multiple** off; **Set Variable** `SourceURL` to **Chosen Item**.
   In **Otherwise**: **Get Item from List**, **First Item** from `SharedURLs`;
   **Set Variable** `SourceURL` to that item. End If.
7. Add **Get Component of URL**, component **Scheme**, URL `SourceURL`;
   **Change Case** to **lowercase**. Add nested **If** checks: if result **is not**
   `https`, and inside that if result **is not** `http`, **Show Alert** `Only web
   links can be saved` and **Stop This Shortcut**. End both If blocks.
8. Add **Choose from Menu**, prompt `Save to my site`, with exactly two options:
   **Save link** and **Add a thought**.
   - Under **Save link**: add a **Dictionary** with Text fields `kind` = `link`,
     `url` = variable `SourceURL`, and `text` with an empty value. **Set Variable**
     `Payload` to this dictionary.
     There is no question or title lookup in this branch.
   - Under **Add a thought**: **Ask for Input**, type **Text**, prompt
     `Your thought (optional)`, default empty, **Allow Multiple Lines** on if
     available. Type or use the normal keyboard microphone. Add a **Dictionary**
     with Text fields `kind` = `link`, `url` = `SourceURL`, and `text` = the
     **Provided Input** from this question. **Set Variable** `Payload` to it.
     Empty text is accepted by the API; Cancel stops the shortcut. On iOS versions
     that won't submit an empty answer, use **Save link** to omit the comment.
   End Menu.

The Shortcut intentionally omits `title`. The Worker supplies the domain when the
app exposes no reliable title, so a missing title never blocks saving. Apps that
share proprietary deep links instead of web URLs need their “Copy link”/“Share
link” option or a pasted browser URL; the Worker does not resolve app deep links.

### Send it (actions after End Menu)

9. Add **Text** containing the Worker HTTPS URL including `/publish`.
   **Set Variable** `Endpoint` to this text.
10. Add **Text** containing your publishing secret (not the GitHub token).
    **Set Variable** `PublishSecret` to it.
11. Add **Get Dictionary Value**, key `kind`, dictionary `Payload`;
    **Set Variable** `EntryKind`. Repeat for key `url` → `EntryURL` and
    key `text` → `EntryText`. The Save link branch supplies an empty value, which
    is valid; both branches contain all three keys.
12. Add **Get Contents of URL**, URL `Endpoint`. Expand its options:
    - Method: **POST**.
    - Headers: **Authorization** = `Bearer ` followed by the `PublishSecret`
      variable (include the space); **Content-Type** = `application/json`.
    - Request Body: **JSON**. Add **Text** fields:

      | Key | Value |
      | --- | --- |
      | `kind` | variable `EntryKind` |
      | `url` | variable `EntryURL` |
      | `text` | variable `EntryText` |

    Do not use Form, a manually concatenated JSON Text action, or query parameters
    for the secret. Native JSON serialization handles quotes and newlines.
13. Add **Get Dictionary from Input**, input the **Contents of URL** result;
    **Set Variable** `Response` to that dictionary.
14. Add **Get Dictionary Value** `ok` from `Response`. **If** this Boolean **is
    true** (some versions show **is 1**), get `status` from `Response`, and add
    another **If** it **is** `committed`:
    - Get `url` from `Response`; **Set Variable** `NoteURL`.
    - Add **Text** with the following HTML, inserting `NoteURL` using the variable
      picker in the `href` and link text. The URL comes from your fixed server-side
      site configuration, not from shared content:

      ```html
      <p>Saved to your notebook repository.</p>
      <p>The site will update after deployment; this link may briefly show 404.</p>
      <p><a href="[NoteURL variable]">[NoteURL variable]</a></p>
      ```

    - **Make Rich Text from HTML**, input that Text; **Quick Look**, input that
      Rich Text. This presents confirmation and a clickable permanent link.
    - **Stop This Shortcut**.
    End inner If and outer If.
15. All remaining execution is a failure: **Get Dictionary Value** `error` from
    `Response`, then **Get Dictionary Value** `message` from that error dictionary.
    **If** message **has any value**, **Show Alert** `Could not confirm publishing`
    with that message; **Otherwise**, **Show Alert** `Unexpected publisher response.
    Check Notes before retrying.` End If. **Stop This Shortcut**.

On some iOS versions, a non-2xx response or a network failure makes **Get Contents
of URL** stop with its own error before returning a dictionary. That is a visible
failure, not success; the confirmation actions will never run. Do not add an
unconditional “Saved” notification, a Repeat retry, or an error handler that
continues into success. After a timeout or `commit_unknown`, check Notes/the
repository once before re-running to avoid duplicate entries.

The first invocation may ask permission to connect to your workers.dev host.
Allow it. Add this Shortcut to Share Sheet favorites via **Edit Actions**. Later,
a shared single URL takes **Share → Save to my site → Save link** to commit.
Apple documents [native JSON requests in Get Contents of URL](https://support.apple.com/guide/shortcuts/request-your-first-api-apd58d46713f/ios).

## 5. Build “New thought”

1. Create a new shortcut named **New thought**. Share Sheet access is unnecessary.
2. **Ask for Input**, type **Text**, prompt `What do you want to remember?`,
   **Allow Multiple Lines** on if offered. Use keyboard dictation as usual.
3. **Set Variable** `Thought` to **Provided Input**. **If** `Thought` **does not
   have any value**, **Stop This Shortcut**. End If. Whitespace-only text also
   fails visibly at the API rather than publishing an empty note.
4. Add the **Text → Set Variable Endpoint** and **Text → Set Variable
   PublishSecret** actions from steps 9–10 above with the same values.
5. Add **Get Contents of URL** with the same POST and headers. Request Body:
   **JSON**, Text fields **`kind` = `note`** and **`text` = variable `Thought`**.
   Do not add `url` or `title`.
6. Copy steps 13–15 above exactly: parse the response, require `ok` and
   `status: committed`, display confirmation with the link, and handle errors.
7. Open shortcut details → **Add to Home Screen**. Choose an icon and tap **Add**.

Normal use is **New thought → type/dictate → Done**. There is no title, tag,
category, GitHub app, or Markdown step.

## 6. Automatic deployment and first real post

Inspected on 2026-10-15: `main` is the default branch, is unprotected, has no
applicable repository rules, and is allowed by the `github-pages` environment.
Pages uses `build_type: workflow` and the custom domain `yasharma.com`. The last
three inspected push-triggered Hugo workflow runs succeeded. No required
environment reviewers were configured. No workflow modification was needed.

`.github/workflows/hugo.yaml` runs on every push to `main` with no path filters.
A fine-grained PAT commit through Contents API triggers that push event. Do not
substitute Actions' built-in `GITHUB_TOKEN`, whose generated pushes generally
don't start another workflow. See [GitHub's workflow trigger rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

To recheck settings/runs (GitHub CLI authenticated as the repository owner):

```sh
gh api repos/yashrmaa/yasharma/pages --jq '{build_type,cname}'
gh api repos/yashrmaa/yasharma/branches/main --jq '{name,protected}'
gh api repos/yashrmaa/yasharma/rules/branches/main
gh api repos/yashrmaa/yasharma/environments/github-pages --jq '.protection_rules'
gh api repos/yashrmaa/yasharma/environments/github-pages/deployment-branch-policies
gh run list --repo yashrmaa/yasharma --workflow hugo.yaml --limit 5
```

For the first end-to-end check, save **a real link you want to keep** from Safari.
Expect a committed confirmation, a new Markdown file on `main`, and a new Pages
workflow run. After that run succeeds, open the returned permalink, `/notes/`,
the homepage, and `/notes/index.xml`. Then publish a genuine thought without a
title from the Home Screen. Verify its Unicode/dictated text. A live authenticated
publish and iPhone run cannot be verified until the Worker secrets and Shortcuts
are configured; the implementation tests use mocked GitHub responses.

If settings change later, a required PR/review or status check can block direct
API commits; the Worker will report the failure. The smallest fix is to allow the
token's owner to write `main` through the applicable rule's supported bypass, or
remove that direct-write restriction for this personal repository if appropriate.
A PAT cannot override branch rules by itself. A required Pages environment
approval would add a manual deployment step: remove the required reviewer for
the publishing environment and keep `main` permitted. Keep Pages configured for
**GitHub Actions**, and the Hugo workflow enabled. Do not grant extra token
permissions merely to work around these settings.

## 7. Local checks

Use **Hugo 0.115.1 extended**, the version pinned in the existing deployment
workflow. The installed latest Hugo may be incompatible with the older bundled
PaperMod; this task does not upgrade the site's toolchain.

```sh
npm test --prefix tools/note-publisher
HUGO_BIN=/path/to/hugo-0.115.1 npm run test:site --prefix tools/note-publisher
/path/to/hugo-0.115.1 --minify --printPathWarnings --destination /tmp/yasharma-notes-build
```

The site integration test also needs Python 3 (standard-library XML parser).
It copies the site into an OS temporary directory, creates 25 mixed fixture
entries plus excluded draft/future entries, runs Hugo, checks ordering,
pagination, permalinks, source links, literal escaping, metadata, RSS, the four
homepage previews, and preservation of existing pages. It never writes fixtures
to the real `content/notes/`. Set `KEEP_SITE_TEST=1` to retain the temporary output
for visual inspection. Hugo alone does not generate Pagefind search assets; the
existing deployment workflow still runs Pagefind after Hugo.

For a Worker bundle check without publishing:

```sh
cd tools/note-publisher
npx wrangler@4 deploy --dry-run --outdir /tmp/yasharma-note-worker
```

Implementation verification: 47 endpoint tests passed; the Hugo 0.115.1
integration build passed; all existing HTML URLs were retained and 42 existing
non-homepage page bodies matched the pre-change build. Headless Chrome checked
the feed, a permalink, and homepage at 320, 390, and 1280 pixels in light and dark
mode (18 views), including link navigation and no horizontal overflow. The
Wrangler bundle dry run passed. This does not substitute for the first real
iPhone-to-GitHub-to-Pages publish after setup.

## 8. Rotate credentials

- **GitHub token leaked/expired:** revoke it immediately in GitHub, create a new
  repository-only token with the same minimal permissions, then run
  `npx wrangler@4 secret put GITHUB_TOKEN` in `tools/note-publisher`. The Shortcuts
  do not change. Review recent repository commits if it was compromised.
- **Publishing secret leaked:** generate a fresh secret, run
  `npx wrangler@4 secret put PUBLISH_SECRET`, then replace `PublishSecret` in both
  Shortcuts. Old copies immediately stop authenticating. Inspect recent notes.
- **Need to disable publishing immediately:** run
  `npx wrangler@4 secret delete PUBLISH_SECRET`; missing secrets fail closed.

## 9. Edit or remove an entry

Edit the matching `content/notes/YYYY-MM-DD-UUID.md` in the repository and push
`main`; the next build updates it. Keep the filename to preserve its permalink.
You may add/change `title`, `source_url`, text, or date. `kind` must be `link` or
`note`; do not set Hugo's special `type`. Links need `source_url`; notes don't
need titles. The publisher intentionally has no remote edit/delete endpoint.

To unpublish, set `draft: true`, or delete the file and push. A removed URL becomes
404 after deployment. Git history retains earlier contents; feeds and external
caches may also have retained copies. Manual entries follow this format:

```yaml
---
date: 2026-10-15T16:05:00Z
kind: note
draft: false
---

Your actual thought goes here.
```

This example is documentation only. Keep your data as ordinary Markdown; the
Worker is replaceable and all existing entries remain usable without it.
