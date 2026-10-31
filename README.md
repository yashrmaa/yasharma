# yasharma.com

A Hugo site using the bundled PaperMod theme. The homepage stays focused on work,
research, and selected writing; the complete blog lives at `/blog/`.

## Notebook

Use the [notebook composer](https://yasharma-note-publisher.yasharma.workers.dev/)
on iPhone or Mac to publish to [/notes/](https://yasharma.com/notes/). Sign in with
your publishing secret, write a thought or paste a URL on the first line, and
tap **Publish**. Categories and up to three resized photos are optional. Drafts
stay on the device; add the composer to your Home Screen or Dock for quick access.

The Cloudflare Worker in `tools/note-publisher/` saves Markdown to `content/notes/`
and photos to `static/notes-media/` through GitHub's Contents API. The final note
commit triggers GitHub Actions deployment. Entries are grouped by Pacific date,
with posting times, category links, and permanent URLs.

From `tools/note-publisher/`, run `npm test` and `npm run test:runtime` to check the
publisher, and `wrangler deploy` to update the Worker. Use the existing Homebrew
Wrangler directly. Manage server-side credentials with `wrangler secret put
PUBLISH_SECRET` and `wrangler secret put GITHUB_TOKEN`; the GitHub token needs
Contents read/write access to this repository only. Never put credentials in code.

## Places

[/places/](https://yasharma.com/places/) is a personal map with city filters,
searchable notes, my photos, and links to Google Maps. Choose **Save a place** in
the notebook composer, paste a Google Maps link and tap **Use link**, or use
the alternative name-and-city search. Add or update a location, mark it liked or
saved for later, and optionally add a note or photos. Place-only saves don't create empty
notes. Locations live in `data/places.json`; other published notes also connect
through distinctive place aliases or an explicit `places` field.
See [the places guide](docs/places.md) for the data format and browser checks.
Run `npm run test:places` to verify the Hugo integration.
Run `npm run preview:notebook` for a local composer and map with isolated saves.

## Write a post

```sh
hugo new blog/a-small-observation.md
hugo server -D
```

Open the new file in `content/blog/`, write a title and a few sentences, and preview
at `http://localhost:1313/blog/`. The post archetype supplies the current date and
starts as a draft. For a daily post, add the optional `day` field:

```yaml
---
title: "A small observation"
date: 2026-09-10T09:00:00-07:00
draft: true
day: 1
categories:
  - Life
---
```

Set `day` explicitly to the number you want displayed, such as `day: 12`.
It appears as ordinary metadata: `September 10, 2026 · 3 min · 600 words · Day 12 · Life`.
The number is never calculated from dates. Keep the title normal; regular essays
simply omit `day`. The same metadata appears on posts, the Blog index, category
pages, and the archive, including word count but no author name.

Choose one broad category, occasionally two:

| Category | Use for |
| --- | --- |
| Life | Everyday experiences, habits, and personal reflections |
| Technology | Software, AI, and digital life |
| Work | Career, building things, and working with people |
| Places | Travel, cities, and the outdoors |
| Culture | Art, food, music, and society |
| Reading | Books, articles, and reflections on reading |

Keep category names consistent; categories appear automatically when a
published post uses them. Reading is available for future posts without creating
an empty category page now.

No summary is required: Hugo generates an excerpt from the opening text and
PaperMod displays two lines. Optionally add `summary: "A short description."` to
front matter, or insert `<!--more-->` in the body to choose the excerpt cutoff.

For a post with local images, use a page bundle instead:

```sh
hugo new --kind blog blog/a-day-out/index.md
```

Set its title, put images alongside `index.md`, and reference them with Markdown
such as `![A view from the trail](trail.jpg)`.

When ready, set `draft: false` and check that the date is not in the future. Run
`hugo --minify --printPathWarnings`, then commit the post (and any images) and push
to `main` through your usual Git workflow. The existing GitHub Pages action
publishes the site. Drafts and future-dated posts are excluded from production.

## Browsing and maintenance

- `/blog/` shows newest posts first, 20 per page, with dates, category links, and
  short excerpts. Post URLs use `/blog/<slug>/`, and source files live in
  `content/blog/`. Hugo aliases redirect existing `/posts/` URLs to `/blog/`.
- `/categories/` lists the categories in use, linked from the Blog page and post
  metadata. Categories stay out of the top navigation; tags are disabled.
- `/archives/` uses PaperMod's compact year/month archive with post counts.
- Individual posts show categories near the date and PaperMod's
  previous/next links within the blog.
- `/blog/index.xml` is the blog RSS feed, linked from the footer. The existing
  `/posts/index.xml` feed serves the same blog
  content for existing subscribers; `/index.xml` remains the site feed.

The homepage uses `layout: single` in `content/_index.md`; keep that setting so
it doesn't become a post stream. `params.mainSections: [blog]` enables the
archive and previous/next links. The post metadata partial and a small stylesheet
add accessible category links. A one-line RSS template reuses PaperMod's feed at
the legacy URL. Keep customizations outside `themes/PaperMod/`.

Verified with the deployment version, Hugo 0.168.0 extended
(pinned in `tools/hugo-version.json`). No additional dependencies are
needed for the blog features. The existing search page also needs the deployment
workflow's Pagefind step; a standalone Hugo build does not generate its assets.

## Security and build dependencies

The deployment pins Hugo with a verified SHA-256, GitHub Actions by commit,
and Pagefind through `package-lock.json`. Use `npm ci --ignore-scripts` and
`npm audit` for the build dependencies; the publisher has no runtime dependencies.
Daily maintenance checks the latest official stable Hugo release, verifies its
download checksum, and runs the publisher tests, rendered-site security checks,
dependency audit, Hugo build, and search indexing. Only a passing candidate is
committed to `tools/hugo-version.json` on `main`, then deployed automatically.
No unreleased Hugo source is installed. Run it sooner with
`gh workflow run maintenance.yaml --ref main`.

Dependabot checks npm and pinned Actions daily. Successful PR checks trigger a
separate trusted workflow that verifies the bot identity, current tested commit,
current base, and changed files before merging and explicitly deploying. Only
existing package version/lockfile changes and pinned Action references qualify;
new dependencies or workflow behavior changes require review. No PR code runs
with the merge credential. Dependency audits fail on moderate or higher advisories.
Failed updates stay unapplied; keep notifications enabled for failed Actions runs.
Pull requests and non-main manual runs cannot deploy the site.

The Worker currently deploys with Homebrew `wrangler deploy`. To enable automatic
Worker deployments, connect the GitHub repository once in Cloudflare → Workers &
Pages → `yasharma-note-publisher` → Settings → Builds → Connect. Authorize the
Cloudflare GitHub App for **this repository only**, select `main`, set the root to
`tools/note-publisher`, build command `npm test`, deploy command `npx wrangler deploy`,
and build watch path `tools/note-publisher/**`. Disable non-production branch
builds. Cloudflare manages the build token; leave the existing Worker secrets in
place. This `npx` runs on Cloudflare, not on your Mac. The existing Git connection
was unavailable when configuring maintenance, so this one-time account consent is
still required before Worker deployment can be automatic.

Keep two-factor authentication enabled on GitHub and Cloudflare. Keep the
repository-only publishing token and publishing secret in your password manager,
set an expiry reminder for the GitHub token, and replace either if exposed using
`wrangler secret put GITHUB_TOKEN` or `wrangler secret put PUBLISH_SECRET` from
`tools/note-publisher/`. Rotating `PUBLISH_SECRET` signs out existing devices.

Markdown permits formatting but omits raw HTML. Repository-authored HTML embeds
use `trusted-html`; the authenticated publishing API prevents invoking shortcodes.
Keep that boundary intact. Run `npm test --prefix tools/note-publisher` and
`HUGO_BIN=/path/to/hugo npm run test:site --prefix tools/note-publisher` before
deploying. The site checks exercise HTML/URL injection, feeds, layouts, and embeds.
