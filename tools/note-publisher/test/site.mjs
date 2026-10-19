// Integration fixtures only ever exist in a temporary checkout, never content/.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { markdown } from "../src/worker.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const temp = await mkdtemp(join(tmpdir(), "notes-site-test-"));
const output = join(temp, "public");
const hugo = process.env.HUGO_BIN || "hugo";
const read = path => readFile(join(output, path), "utf8");
try {
  for (const name of ["content", "layouts", "assets", "static", "archetypes"]) {
    await cp(join(root, name), join(temp, name), { recursive: true });
  }
  await cp(join(root, "config.yml"), join(temp, "config.yml"));
  await symlink(join(root, "themes"), join(temp, "themes"), "dir");
  // Isolate from any real notes already in the working tree.
  for (const name of await readdir(join(temp, "content/notes"))) {
    if (name !== "_index.md") await rm(join(temp, "content/notes", name), { recursive: true, force: true });
  }
  const build = () => execFileSync(hugo, ["--source", temp, "--destination", output, "--cacheDir", join(temp, "cache"), "--minify", "--printPathWarnings"], { encoding: "utf8" });
  build();
  assert.match(await read("notes/index.html"), /Nothing noted yet/);
  const existingPaths = ["blog/index.html", "archives/index.html", "reading/index.html", "blog/rainier/index.html", "posts/rainier/index.html", "search/index.html", "blog/index.xml", "posts/index.xml"];
  const before = new Map(await Promise.all(existingPaths.map(async path => [path, await read(path)])));
  for (let i = 1; i <= 22; i++) {
    await writeFile(join(temp, `content/notes/fixture-${i}.md`), markdown({ kind: "note", text: `Fixture observation ${i}`, title: "" }, `2020-01-${String(i).padStart(2, "0")}T12:00:00Z`));
  }
  const literal = 'Literal # heading **bold**\n\nसोच — café 🪴 日本語\n\n---\ndraft: true\n<script>alert(1)</script>\n{{< missing >}}';
  await writeFile(join(temp, "content/notes/fixture-literal.md"), markdown({ kind: "note", text: literal, title: "" }, "2020-01-23T12:00:00Z"));
  // A hand-written entry with neither title nor comment must work as well.
  await writeFile(join(temp, "content/notes/fixture-url-only.md"), '---\ndate: 2020-01-24T12:00:00Z\nkind: link\nsource_url: "https://example.com/article?a=1&b=2"\ndraft: false\n---\n');
  const trickyTitle = '"Cities": yes\n---\ndraft: true\\road\u0085split\u2028line\u2029end';
  await writeFile(join(temp, "content/notes/fixture-title.md"), markdown({ kind: "link", url: "https://example.org/", title: trickyTitle, text: "A comment" }, "2020-01-25T12:00:00Z"));
  await writeFile(join(temp, "content/notes/fixture-draft.md"), '---\ndate: 2020-02-01\nkind: note\ndraft: true\n---\nDRAFT_SECRET_FIXTURE\n');
  await writeFile(join(temp, "content/notes/fixture-future.md"), '---\ndate: 2999-02-01\nkind: note\n---\nFUTURE_SECRET_FIXTURE\n');
  await mkdir(join(temp, "static/notes-media"), { recursive: true });
  await cp(new URL("./fixtures/photo.jpg", import.meta.url), join(temp, "static/notes-media/fixture.jpg"));
  await writeFile(join(temp, "content/notes/fixture-before-midnight.md"), markdown({ kind: "note", text: "Before Pacific midnight", categories: ["fixture-places"], photos: [{ url: "https://yasharma.com/notes-media/fixture.jpg", alt: "Photo — 🪴" }] }, "2020-01-21T07:59:00Z"));
  await writeFile(join(temp, "content/notes/fixture-after-midnight.md"), markdown({ kind: "note", text: "After Pacific midnight" }, "2020-01-21T08:01:00Z"));
  await writeFile(join(temp, "content/notes/fixture-daylight.md"), markdown({ kind: "note", text: "Summer time" }, "2019-06-20T16:05:00Z"));
  build();
  const feed = await read("notes/index.html");
  assert.equal((feed.match(/class=note-entry/g) || []).length, 20);
  assert.ok(feed.indexOf("fixture-title/") < feed.indexOf("fixture-url-only/"));
  assert.ok(feed.indexOf("fixture-url-only/") < feed.indexOf("fixture-literal/"));
  assert.match(feed, /href="?https:\/\/example.com\/article\?a=1&amp;b=2/);
  assert.match(feed, /Original source/);
  assert.match(feed, /Permalink/);
  assert.match(feed, /Older notes/);
  assert.match(await read("notes/page/2/index.html"), /Newer notes/);
  assert.equal((feed.match(/id=2020-01-21/g) || []).length, 1, "one heading per local day");
  assert.ok(feed.indexOf("fixture-after-midnight/") < feed.indexOf("id=2020-01-20"));
  assert.ok(feed.indexOf("id=2020-01-20") < feed.indexOf("fixture-before-midnight/"));
  assert.match(await read("notes/fixture-before-midnight/index.html"), /Jan 20, 2020 · 11:59 PM PST/);
  assert.match(await read("notes/fixture-after-midnight/index.html"), /Jan 21, 2020 · 12:01 AM PST/);
  assert.match(await read("notes/fixture-daylight/index.html"), /9:05 AM PDT/);
  assert.match(feed, /href=\/?categories\/fixture-places\//);
  const category = await read("categories/fixture-places/index.html");
  assert.match(category, /class=note-entry/);
  assert.match(category, /Before Pacific midnight/);
  assert.match(category, /<img[^>]+src=https:\/\/yasharma.com\/notes-media\/fixture.jpg/);
  assert.ok((await readFile(join(output, "notes-media/fixture.jpg"))).length > 0);
  const single = await read("notes/fixture-literal/index.html");
  assert.match(single, /<title>Note \| Yash Sharma<\/title>/);
  assert.ok(!single.includes("<h1"), "titleless note should not have a headline");
  assert.match(single, /सोच — café 🪴 日本語/);
  const noteBody = single.match(/<div class="post-content note-content">[\s\S]*?<\/div>/)[0];
  assert.ok(!noteBody.includes("<script>"));
  assert.match(single, /Literal # heading <strong>bold<\/strong>/);
  assert.match(single, /missing/); // Literal shortcode did not break Hugo.
  const home = await read("index.html");
  const recent = home.match(/<section class=recent-notes[\s\S]*?<\/section>/)?.[0];
  assert.ok(recent);
  assert.equal((recent.match(/<li>/g) || []).length, 4);
  assert.ok(recent.indexOf("fixture-title/") < recent.indexOf("fixture-url-only/"));
  assert.ok(recent.includes("fixture-22/"));
  assert.ok(!recent.includes("fixture-21/"));
  assert.match(home, /Selected writing/);
  assert.match(home, /Currently/);
  assert.match(home, /More notes/);
  assert.match(await read("index.xml"), /fixture-literal/);
  for (const path of ["index.html", "notes/index.html", "notes/index.xml", "index.xml", "index.json"]) {
    assert.ok(!/DRAFT_SECRET_FIXTURE|FUTURE_SECRET_FIXTURE/.test(await read(path)), `${path} leaked excluded content`);
  }
  // XML parser verifies escaping and source/permalink semantics in real RSS.
  execFileSync("python3", ["-c", `
import sys, xml.etree.ElementTree as E
root = E.parse(sys.argv[1])
items = root.findall('./channel/item')
assert len(items) == 28
assert items[0].findtext('title') == sys.argv[2]
assert items[1].findtext('title') == 'example.com'
assert items[1].findtext('link').endswith('/notes/fixture-url-only/')
assert 'https://example.com/article?a=1&amp;b=2' in items[1].findtext('description')
assert items[2].findtext('title').startswith('Literal # heading bold')
assert 'सोच' in items[2].findtext('description')
photo = next(i for i in items if 'fixture-before-midnight' in i.findtext('link'))
assert photo.findtext('category') == 'fixture-places'
assert 'https://yasharma.com/notes-media/fixture.jpg' in photo.findtext('description')
`, join(output, "notes/index.xml"), trickyTitle]);
  for (const path of existingPaths) assert.equal(await read(path), before.get(path), `${path} changed when notes were published`);
  const attack = `Normal **bold** and [working link](https://example.com/docs).

<img/src=x onerror=alert(1)>
<ScRiPt/src=https://attacker.invalid/script.js></ScRiPt>
<svg onload=alert(1)>

[unsafe](javascript:alert%281%29)

![unsafe image](javascript:alert%281%29)

![unsafe data image](data:image/svg+xml;base64,PHN2Zy8+)

{{< trusted-html >}}<script>alert(1)</script>{{< /trusted-html >}}

\`\`\`html
<img src="example.jpg">
\`\`\`
`;
  await writeFile(join(temp, "content/notes/fixture-security.md"), markdown({ kind: "note", text: attack }, "2018-01-01T12:00:00Z"));
  build();
  const secured = await read("notes/fixture-security/index.html");
  const body = secured.match(/<div class="post-content note-content">([\s\S]*?)<footer class=note-meta/)[1];
  assert.ok(!/<(?:script|svg|img)\b[^>]*(?:onerror|onload|attacker\.invalid)/i.test(body));
  assert.ok(!/(?:href|src)\s*=\s*["']?(?:javascript|data):/i.test(body));
  assert.match(body, /<strong>bold<\/strong>/);
  assert.match(body, /href=https:\/\/example.com\/docs/);
  assert.match(body, /&lt;img/); // HTML code examples remain readable code.
  assert.match(await read("index.html"), /src=about\/photo.jpeg/);
  assert.match(await read("search/index.html"), /src=\/search\/pagefind-ui.js/);
  for (const project of ["datemedir", "oramatch"]) assert.match(await read(`projects/${project}/index.html`), /<iframe/);
  // Confirm generated JSON-LD remains valid, including hostile note text.
  execFileSync("python3", ["-c", `
import json, re, pathlib, sys
for path in pathlib.Path(sys.argv[1]).rglob('*.html'):
    for value in re.findall(r'<script type=["\\\']?application/ld\\+json["\\\']?>(.*?)</script>', path.read_text(), re.S):
        json.loads(value)
`, output]);
  console.log("PASS: raw/malformed HTML, unsafe Markdown URLs, images and shortcode injection blocked; Markdown, code, trusted embeds and JSON-LD preserved.");
  console.log("PASS: 28 mixed entries, Pacific day grouping/midnight/DST, category feed, photos, pagination, metadata, Unicode/YAML, RSS, homepage, draft/future filtering, existing pages.");
  if (process.env.KEEP_SITE_TEST) console.log(`Preview fixture output: ${output}`);
} finally {
  if (!process.env.KEEP_SITE_TEST) await rm(temp, { recursive: true, force: true });
}
