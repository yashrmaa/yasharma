// Build real Hugo pages in isolation, including preview-only content.
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../../", import.meta.url);
const temp = await mkdtemp(join(tmpdir(), "places-site-test-"));
try {
  for (const name of ["content", "layouts", "assets", "data"]) await cp(new URL(name, root), join(temp, name), { recursive: true });
  for (const name of ["static", "themes"]) await symlink(new URL(name, root).pathname, join(temp, name), "dir");
  await cp(new URL("config.yml", root), join(temp, "config.yml"));
  const catalog = JSON.parse(await readFile(join(temp, "data/places.json"), "utf8"));
  const expectedPublicPlaces = catalog.filter(place => !place.draft).length + 1;
  catalog.push(
    { id: "fixture-saved", name: "A saved restaurant", city: "San Francisco", category: "Restaurants", status: "saved", address: "San Francisco", coordinates: [37.77, -122.42], precision: "city", comment: "Cheesecake & tea — <script>not markup</script>", mapsURL: "https://maps.app.goo.gl/fixture-literal-map" },
    { id: "fixture-hidden", name: "PRIVATE_PLACE_FIXTURE", city: "San Francisco", category: "Coffee", status: "saved", coordinates: [37.77, -122.42], draft: true },
  );
  await writeFile(join(temp, "data/places.json"), JSON.stringify(catalog));
  const note = (metadata, text) => `---\ndate: 2020-01-02T12:00:00Z\nkind: note\n${metadata}\n---\n${text}\n`;
  await writeFile(join(temp, "content/notes/fixture-place-explicit.md"), note('places: ["bello-coffee"]', 'Coffee 日本語 — "one more".\n\n![My own photo](https://yasharma.com/notes-media/fixture.jpg)'));
  await writeFile(join(temp, "content/notes/fixture-place-alias.md"), note('places: ["bello-coffee"]', "BELLO COFFEE has a new light roast."));
  await writeFile(join(temp, "content/notes/fixture-place-draft.md"), note('draft: true\nplaces: ["bello-coffee"]', "DRAFT_PLACE_NOTE_FIXTURE"));
  await writeFile(join(temp, "content/notes/fixture-place-scheduled.md"), note('publishDate: 2999-01-01\nplaces: ["bello-coffee"]', "SCHEDULED_PLACE_NOTE_FIXTURE"));
  await writeFile(join(temp, "content/notes/fixture-place-expired.md"), note('expiryDate: 2020-02-01\nplaces: ["bello-coffee"]', "EXPIRED_PLACE_NOTE_FIXTURE"));
  await writeFile(join(temp, "content/notes/fixture-place-automatic.md"), note('places: ["fixture-hidden"]', "I went to Fellini Coffee again."));

  const build = flags => execFileSync(process.env.HUGO_BIN || "hugo", ["--source", temp, "--destination", join(temp, "public"), "--cacheDir", join(temp, "cache"), "--minify", "--printPathWarnings", ...flags], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  for (const flags of [[], ["--buildDrafts", "--buildFuture", "--buildExpired"]]) {
    build(flags);
    const json = await readFile(join(temp, "public/places/index.json"), "utf8");
    const html = await readFile(join(temp, "public/places/index.html"), "utf8");
    const data = JSON.parse(json);
    assert.equal(data.length, expectedPublicPlaces, "draft places must stay out of the public map, even in a preview");
    assert.ok(!/PRIVATE_PLACE_FIXTURE|DRAFT_PLACE_NOTE_FIXTURE|SCHEDULED_PLACE_NOTE_FIXTURE|EXPIRED_PLACE_NOTE_FIXTURE/.test(json + html));
    const bello = data.find(place => place.id === "bello-coffee");
    assert.equal(bello.notes.filter(note => note.url.includes("fixture-place-alias")).length, 1, "explicit ID plus matching alias must not duplicate notes");
    const explicit = bello.notes.find(note => note.url.includes("fixture-place-explicit"));
    assert.match(explicit.text, /Coffee 日本語 — ["“]one more["”]/);
    assert.equal(explicit.photos[0].url, "/notes-media/fixture.jpg", "own photos should load from the same site in previews and production");
    assert.match(explicit.label, /Jan 2, 2020/);
    assert.ok(data.find(place => place.id === "fellini-coffee").notes.some(note => note.url.includes("fixture-place-automatic")), "known place mentions should attach without composer changes");
    assert.deepEqual(data.find(place => place.id === "fixture-saved").notes, [], "saved places must work without a published note");
    const saved = data.find(place => place.id === "fixture-saved");
    assert.equal(saved.comment, "Cheesecake & tea — <script>not markup</script>");
    assert.equal(saved.mapsURL, "https://maps.app.goo.gl/fixture-literal-map", "curated Maps links should keep the exact venue");
    assert.ok(/Cheesecake (?:&amp;|&) tea/.test(html), "standalone comments should render on place cards");
    assert.ok(!html.includes("<script>not markup</script>"), "place comments must render as text");
    const maps = new URL(bello.mapsURL);
    assert.equal(maps.origin, "https://www.google.com");
    assert.equal(maps.searchParams.get("api"), "1");
    assert.match(maps.searchParams.get("query"), /Bello Coffee & Tea 2885 Diamond/);
    assert.match(html, /Open in Google Maps/);
    assert.match(html, /fantastic light roast/);
    assert.match(html, /<noscript>/);
    assert.match(html, /vendor\/leaflet\/leaflet.js/);
    assert.ok(!/vendor\/leaflet/.test(await readFile(join(temp, "public/index.html"), "utf8")), "map assets must be loaded only on the places page");
    const noteHTML = await readFile(join(temp, "public/notes/fixture-place-automatic/index.html"), "utf8");
    assert.match(noteHTML, /places\/\?place=fellini-coffee/);
    assert.ok(!noteHTML.includes("?place=fixture-hidden"), "hidden catalog entries must not create public backlinks");
  }
  console.log("PASS: note matching, deduplication, real text/photos, saved places, Maps URLs, backlinks, progressive rendering, scoped assets, and private/scheduled/expired content in production and preview builds.");
} finally {
  await rm(temp, { recursive: true, force: true });
}
