# yasharma.com

A Hugo site using the bundled PaperMod theme. The homepage stays focused on work,
research, and selected writing; the complete blog lives at `/blog/`.

## Write a post

```sh
hugo new posts/a-small-observation.md
hugo server -D
```

Open the new file in `content/posts/`, write a title and a few sentences, and preview
at `http://localhost:1313/blog/`. The post archetype supplies the current date and
starts as a draft. For a daily post, add the optional `daily` field:

```yaml
---
title: "A small observation"
date: 2026-09-10T09:00:00-07:00
draft: true
daily: 1
categories:
  - Life
---
```

Set `daily` explicitly to the number you want displayed, such as `daily: 12`.
It appears as ordinary metadata: `September 10, 2026 · 3 min · 600 words · Day 12 · Life`.
The number is never calculated from dates. Keep the title normal; regular essays
simply omit `daily`. The same metadata appears on posts, the Blog index, category
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
hugo new --kind posts posts/a-day-out/index.md
```

Set its title, put images alongside `index.md`, and reference them with Markdown
such as `![A view from the trail](trail.jpg)`.

When ready, set `draft: false` and check that the date is not in the future. Run
`hugo --minify --printPathWarnings`, then commit the post (and any images) and push
to `main` through your usual Git workflow. The existing GitHub Pages action
publishes the site. Drafts and future-dated posts are excluded from production.

## Browsing and maintenance

- `/blog/` shows newest posts first, 20 per page, with dates, category links, and
  short excerpts. Post URLs use `/blog/<slug>/`, while source files stay in
  `content/posts/`. Hugo aliases redirect existing `/posts/` URLs to `/blog/`.
- `/categories/` lists the categories in use, linked from the Blog page and post
  metadata. Categories stay out of the top navigation; tags are disabled.
- `/archives/` uses PaperMod's compact year/month archive with post counts.
- Individual posts show categories near the date and PaperMod's
  previous/next links within the blog.
- `/blog/index.xml` is the blog RSS feed, linked from navigation, the homepage,
  and the blog index. The existing `/posts/index.xml` feed serves the same blog
  content for existing subscribers; `/index.xml` remains the site feed.

The homepage uses `layout: single` in `content/_index.md`; keep that setting so
it doesn't become a post stream. `params.mainSections: [posts]` enables the
archive and previous/next links. The post metadata partial and a small stylesheet
add accessible category links. A one-line RSS template reuses PaperMod's feed at
the legacy URL. Keep customizations outside `themes/PaperMod/`.

Verified with Hugo 0.123.8 extended and the deployment version, 0.115.1 extended
(configured in `.github/workflows/hugo.yaml`). No additional dependencies are
needed for the blog features. The existing search page also needs the deployment
workflow's Pagefind step; a standalone Hugo build does not generate its assets.
