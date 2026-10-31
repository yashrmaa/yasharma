import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { createPublisher } from "../src/worker.mjs";
import { placeRepository } from "./places-repository.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const origin = "https://notebook.test";
const secret = "p".repeat(64);
const repo = placeRepository(JSON.parse(await readFile(new URL("../../../data/places.json", import.meta.url))));
const initialPlaceCount = repo.catalog().length;
let reverseAvailable = true;
const mapsLink = "https://maps.app.goo.gl/notebook-direct-fixture";
const sightglassPinLink = "https://maps.app.goo.gl/AsBLaAHwNQwsBbgn7";
const sightglassFeatureLink = "https://maps.app.goo.gl/UvZMHdUqm4BCy2eYA";
const sightglassCID = "2733781384327450309";
const worker = createPublisher({ fetch: repo.fetch, mapsFetch: async (url, options) => {
  if (url.includes("offline-fixture")) throw new Error("Offline");
  await new Promise(resolve => setTimeout(resolve, 80));
  if (url === sightglassPinLink) return new Response(null, { status: 302, headers: { Location: "https://www.google.com/maps/place/Sightglass+Coffee/@37.7770356,-122.4084543,17z/data=!8m2!3d37.7770356!4d-122.4084543" } });
  if (url === sightglassFeatureLink) return new Response(null, { status: 302, headers: { Location: "https://maps.google.com/maps?q=Sightglass+Coffee,+3014+20th+St,+San+Francisco,+CA+94110&ftid=0x808f7e373f977f1f:0x25f057af5269cec5" } });
  if (url === `https://www.google.com/maps?cid=${sightglassCID}&output=embed`) return new Response(options.method === "HEAD" ? null : `<script>initEmbed(${JSON.stringify([[[0, 0, 0]], [["0x808f7e373f977f1f:0x25f057af5269cec5", "Sightglass Coffee, 3014 20th St", [37.7592345, -122.4113171], sightglassCID], "Sightglass Coffee", ["3014 20th St", "San Francisco, CA 94110"]]])});</script>`);
  return new Response(null, { status: 302, headers: { Location: "https://www.google.com/maps/place/Maps+Link+Cafe/@0,0,2z/data=!8m2!3d37.782!4d-122.412" } });
}, geocodeFetch: async url => {
  if (new URL(url).pathname.includes("reverse") && !reverseAvailable) throw new Error("Address service unavailable");
  const updating = (new URL(url).searchParams.get("q") || "").includes("confirmed Fellini");
  return Response.json({ features: [{ properties: { name: updating ? "Fellini Coffee" : "Browser Cafe", city: updating ? "New York" : "San Francisco", street: updating ? "Waverly Place" : "Market Street", housenumber: "100", osm_type: "N", osm_id: updating ? 100000002 : 100000001, osm_key: "amenity", osm_value: "cafe" }, geometry: { coordinates: updating ? [-74.0012, 40.7347] : [-122.4, 37.79] } }] });
} });
const env = { GITHUB_TOKEN: "fake-token", PUBLISH_SECRET: secret, GITHUB_OWNER: "preview", GITHUB_REPO: "preview", GITHUB_BRANCH: "main", SITE_URL: "https://yasharma.com", ASSETS: { fetch: async request => {
  const path = new URL(request.url).pathname;
  const file = path === "/" ? "index.html" : path.slice(1);
  const type = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" }[extname(file)];
  return new Response(await readFile(new URL(`../public/${file}`, import.meta.url)), { headers: { "Content-Type": type } });
} } };
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await ctx.route("**/*", async route => {
  const req = route.request();
  if (!req.url().startsWith(origin)) return route.abort();
  const response = await worker.fetch(new Request(req.url(), { method: req.method(), headers: req.headers(), ...(!["GET", "HEAD"].includes(req.method()) ? { body: req.postData() } : {}) }), env);
  await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
});
const noteFiles = () => [...repo.files().keys()].filter(path => path.startsWith("content/notes/"));
const success = page => page.waitForFunction(() => !document.querySelector("#place-feedback").hidden && document.querySelector("#place-feedback").dataset.state === "success" && document.querySelector("#place-composer").getAttribute("aria-busy") === "false");
const noteSuccess = page => page.waitForFunction(() => !document.querySelector("#feedback").hidden && document.querySelector("#feedback").dataset.state === "success" && document.querySelector("#composer").getAttribute("aria-busy") === "false");
const show = (page, mode) => page.locator(`[data-compose-mode="${mode}"]`).click();
const openExtras = page => page.locator("#extras").evaluate(node => { node.open = true; });
try {
  const page = await ctx.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.locator("#secret").fill(secret);
  await page.locator("#sign-in-button").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page.waitForFunction(count => document.querySelector("#place-existing").options.length === count + 1, initialPlaceCount);
  assert.equal(await page.locator("#composer").isVisible(), true);
  assert.equal(await page.locator("#place-composer").isHidden(), true);

  // A real note draft (including photo, categories, and association) must never
  // hitch a ride on a place save, and a place save must not clear that draft.
  await page.locator("#thought").fill("Keep this note draft and my photo 🪴");
  await openExtras(page);
  await page.locator("#categories").fill("Places, Life");
  await page.locator("#note-place").selectOption("bello-coffee");
  await page.locator("#photo-picker").setInputFiles(new URL("./fixtures/photo.jpg", import.meta.url).pathname);
  await page.waitForFunction(() => document.querySelectorAll(".photo-preview").length === 1 && !document.querySelector("#publish").disabled);
  await show(page, "place");
  assert.equal(await page.locator("#composer").isHidden(), true);
  assert.equal(await page.locator("#place-composer textarea, #place-composer input[type=file]").count(), 2);
  await page.locator("#place-existing").selectOption("bello-coffee");
  await page.locator("#place-status").selectOption("saved");
  assert.equal(await page.locator("#place-save").textContent(), "Save changes");
  await page.locator("#place-save").click();
  await success(page);
  assert.equal(repo.catalog().find(place => place.id === "bello-coffee").status, "saved");
  assert.equal(noteFiles().length, 0, "place save must never publish the note draft");
  assert.equal([...repo.files().keys()].some(path => path.startsWith("static/notes-media/")), false);
  const firstSave = repo.calls.find(call => call.path === "/git/trees" && call.method === "POST");
  assert.deepEqual(firstSave.body.tree.map(item => item.path), ["data/places.json"]);
  await show(page, "note");
  assert.equal(await page.locator("#thought").inputValue(), "Keep this note draft and my photo 🪴");
  assert.equal(await page.locator("#categories").inputValue(), "Places, Life");
  assert.equal(await page.locator("#note-place").inputValue(), "bello-coffee");
  assert.equal(await page.locator(".photo-preview").count(), 1);

  // Keep an unsaved place edit alongside the note. Publishing the associated
  // note writes only note/photo files and leaves both the catalog and place draft.
  await show(page, "place");
  await page.locator("#place-existing").selectOption("fellini-coffee");
  await page.locator("#place-location-details").evaluate(node => { node.open = true; });
  await page.locator("#place-city").fill("An unsaved city edit");
  await page.reload();
  await page.locator("#place-composer").waitFor({ state: "visible" });
  assert.equal(await page.locator("#place-city").inputValue(), "An unsaved city edit");

  assert.equal(await page.locator("#thought").inputValue(), "Keep this note draft and my photo 🪴");
  const beforeNote = JSON.stringify(repo.catalog());
  await show(page, "note");
  await page.locator("#publish").click();
  await noteSuccess(page);
  assert.equal(noteFiles().length, 1);
  assert.equal(JSON.stringify(repo.catalog()), beforeNote, "publishing a note never updates a place");
  assert.match(String(repo.file(noteFiles()[0])), /places: \["bello-coffee"\]/);
  assert.match(String(repo.file(noteFiles()[0])), /Keep this note draft and my photo 🪴/);
  assert.match(String(repo.file(noteFiles()[0])), /!\[/);
  assert.equal(await page.locator("#thought").inputValue(), "");
  await show(page, "place");
  assert.equal(await page.locator("#place-city").inputValue(), "An unsaved city edit");

  // Place text and photos have their own draft and publish on the place only.
  await page.locator("#place-comment").fill("A place-only remark — great espresso 🪴");
  await page.locator("#place-photo-picker").setInputFiles(new URL("./fixtures/photo.jpg", import.meta.url).pathname);
  await page.waitForFunction(() => document.querySelectorAll(".place-photo-preview").length === 1 && !document.querySelector("#place-save").disabled);
  await page.locator("#place-photo-alt-0").fill("My place photo");
  await show(page, "note");
  await page.locator("#thought").fill("Another notebook draft that must stay here");
  await show(page, "place");
  await page.reload();
  await page.locator("#place-composer").waitFor({ state: "visible" });
  assert.equal(await page.locator("#place-comment").inputValue(), "A place-only remark — great espresso 🪴");
  assert.equal(await page.locator("#place-photo-alt-0").inputValue(), "My place photo");
  await page.locator("#place-save").click();
  await success(page);
  const placeWithPhoto = repo.catalog().find(place => place.id === "fellini-coffee");
  assert.equal(placeWithPhoto.comment, "A place-only remark — great espresso 🪴");
  assert.equal(placeWithPhoto.photos.at(-1).alt, "My place photo");
  assert.equal(noteFiles().length, 1, "place text/photos must never create a notebook post");
  assert.equal(await page.locator(".place-photo-preview").count(), 0, "confirmed uploads must clear from the pending queue");
  assert.ok(await page.locator("#place-saved-photos img").count());
  await show(page, "note");
  assert.equal(await page.locator("#thought").inputValue(), "Another notebook draft that must stay here");
  await page.locator("#thought").fill("");
  await show(page, "place");
  await page.locator("#place-existing").selectOption("fellini-coffee");
  assert.equal(await page.locator("#place-comment").inputValue(), placeWithPhoto.comment);
  await page.locator("#place-save").click();
  await success(page);
  assert.equal(repo.catalog().find(place => place.id === "fellini-coffee").photos.length, placeWithPhoto.photos.length, "saving metadata must not upload the same photos twice");


  await page.locator("#place-existing").selectOption("");
  await page.locator("#place-lookup").evaluate(node => { node.open = true; });
  await page.locator("#place-query").fill("Browser Cafe San Francisco");
  await page.locator("#place-search-button").click();
  await page.locator("#place-results button").first().click();
  await page.locator("#place-save").click();
  await success(page);
  assert.equal(repo.catalog().length, initialPlaceCount + 1);
  assert.equal(noteFiles().length, 1);

  // Pasting a link in Notes offers a separate place save. The entire note and
  // photo remain untouched; saving the place cannot turn them into a post.
  await show(page, "note");
  const linkDraft = `${mapsLink}\n\nGood espresso.`;
  await page.locator("#thought").fill(linkDraft);
  await openExtras(page);
  await page.locator("#photo-picker").setInputFiles(new URL("./fixtures/photo.jpg", import.meta.url).pathname);
  await page.waitForFunction(() => document.querySelectorAll(".photo-preview").length === 1 && !document.querySelector("#publish").disabled);
  await page.locator("#save-link-as-place").click();
  await page.locator("#place-composer").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#place-name").value === "Maps Link Cafe" && !document.querySelector("#place-save").disabled);
  assert.equal(await page.locator("#place-existing").inputValue(), "");
  assert.equal(await page.locator("#thought").inputValue(), linkDraft);
  await page.locator("#place-save").click();
  await success(page);
  const imported = repo.catalog().find(place => place.name === "Maps Link Cafe");
  assert.equal(imported.mapsURL, mapsLink);
  assert.deepEqual(imported.coordinates, [37.782, -122.412]);
  assert.equal(noteFiles().length, 1);
  await show(page, "note");
  assert.equal(await page.locator("#thought").inputValue(), linkDraft);
  assert.equal(await page.locator(".photo-preview").count(), 1);
  await page.locator("#note-place").selectOption(imported.id);
  await page.locator("#publish").click();
  await noteSuccess(page);
  assert.equal(noteFiles().length, 2);
  assert.ok(noteFiles().some(path => String(repo.file(path)).includes(`places: ["${imported.id}"]`)));

  // Both reported share-link formats still enable Save changes and survive a
  // draft reload now that Places has its own button and local-storage entry.
  await show(page, "place");
  const sightglass = repo.catalog().find(place => place.name === "Sightglass Coffee");
  for (const [url, latitude] of [[sightglassPinLink, "37.7770356"], [sightglassFeatureLink, "37.7592345"]]) {
    await page.locator("#place-existing").selectOption(sightglass.id);
    await page.locator("#place-maps-url").fill(url);
    assert.equal(await page.locator("#place-save").isDisabled(), true);
    await page.locator("#place-resolve").click();
    await page.waitForFunction(lat => document.querySelector("#place-latitude").value === lat && !document.querySelector("#place-save").disabled, latitude);
    assert.equal(await page.locator("#place-save").textContent(), "Save changes");
    assert.equal(await page.locator("#place-save-help").isHidden(), true);
    await page.reload();
    await page.locator("#place-composer").waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector("#place-save").disabled);
    await page.locator("#place-save").click();
    await success(page);
    assert.equal(repo.catalog().find(place => place.id === sightglass.id).coordinates[0], Number(latitude));
    assert.equal(repo.catalog().find(place => place.id === sightglass.id).mapsURL, url);
  }
  assert.equal(noteFiles().length, 2);

  await page.locator("#place-existing").selectOption("");
  await page.locator("#place-comment").fill("A remark entered before opening the Maps link");
  await page.locator("#place-photo-picker").setInputFiles(new URL("./fixtures/photo.jpg", import.meta.url).pathname);
  await page.waitForFunction(() => document.querySelectorAll(".place-photo-preview").length === 1 && !document.querySelector("#place-save").disabled);
  await page.locator("#place-maps-url").fill(mapsLink);
  await page.locator("#place-resolve").click();
  await page.waitForFunction(id => document.querySelector("#place-existing").value === id && !document.querySelector("#place-save").disabled, imported.id);
  await page.locator("#place-save").click();
  await success(page);
  assert.equal(repo.catalog().filter(place => place.name === "Maps Link Cafe").length, 1);
  assert.equal(repo.catalog().find(place => place.id === imported.id).comment, "A remark entered before opening the Maps link");
  assert.equal(repo.catalog().find(place => place.id === imported.id).photos.length, 1);

  // A bad link blocks only the Places save. Notes remains usable, and publishing
  // a note must not erase or resolve the unfinished place draft.
  await page.locator("#place-existing").selectOption("");
  await page.locator("#place-maps-url").fill("https://maps.app.goo.gl/offline-fixture");
  await page.locator("#place-resolve").click();
  await page.waitForFunction(() => document.querySelector("#place-load-status").textContent.includes("couldn't be reached"));
  assert.equal(await page.locator("#place-save").isDisabled(), true);
  assert.equal(await page.locator("#place-save-help").isVisible(), true);
  await show(page, "note");
  await page.locator("#thought").fill("A completely unrelated note");
  await page.locator("#publish").click();
  await noteSuccess(page);
  assert.equal(noteFiles().length, 3);
  await show(page, "place");
  await page.reload();
  await page.locator("#place-composer").waitFor({ state: "visible" });
  assert.equal(await page.locator("#place-maps-url").inputValue(), "https://maps.app.goo.gl/offline-fixture");
  assert.equal(await page.locator("#place-save").isDisabled(), true);

  reverseAvailable = false;
  const manualLink = "https://www.google.com/maps/place/Manual+Address+Cafe/data=!8m2!3d37.8!4d-122.3";
  await page.locator("#place-maps-url").fill(manualLink);
  await page.locator("#place-resolve").click();
  await page.waitForFunction(() => document.querySelector("#place-name").value === "Manual Address Cafe");
  assert.equal(await page.locator("#place-location-details").evaluate(node => node.open), true);
  await page.locator("#place-city").fill("San Francisco");
  await page.locator("#place-address").fill("An address I entered");
  await page.locator("#place-save").click();
  await success(page);
  assert.equal(repo.catalog().find(place => place.name === "Manual Address Cafe").mapsURL, manualLink);

  // Stale place edits still cannot overwrite a newer save in another tab.
  await page.locator("#place-existing").selectOption("fellini-coffee");
  await page.locator("#place-name").fill("My unsaved Fellini edit");
  const other = await ctx.newPage();
  await other.goto(origin);
  await other.locator("#place-composer").waitFor({ state: "visible" });
  await other.waitForFunction(() => document.querySelector("#place-existing").options.length > 1);
  await other.locator("#place-existing").selectOption("fellini-coffee");
  await other.locator("#place-status").selectOption("saved");
  await other.locator("#place-save").click();
  await success(other);
  await page.locator("#place-save").click();
  await page.waitForFunction(() => document.querySelector("#place-message").textContent.includes("changed in another window"));
  assert.equal(await page.locator("#place-name").inputValue(), "My unsaved Fellini edit");
  await page.locator("#place-refresh").click();
  await page.waitForFunction(() => document.querySelector("#place-name").value !== "My unsaved Fellini edit");
  await other.close();
  for (const mode of ["note", "place"]) {
    await show(page, mode);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${mode} overflow at ${width}px`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `/private/tmp/notebook-separate-${mode}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: "/private/tmp/notebook-separate-places-dark.png", fullPage: true });

  // Upgrade an old shared draft without publishing, deleting, or transferring
  // its text/photos into the place editor.
  const legacyContext = await browser.newContext({ storageState: { cookies: await ctx.cookies(), origins: [{ origin, localStorage: [{ name: "notebook.draft.v1", value: JSON.stringify({ text: "My old draft stays a note", categories: "Life", photos: [], location: { mode: "place", query: "", resolvedURL: "", place: { name: "An old place draft", city: "Tokyo", coordinates: [35, 139], category: "Coffee", status: "saved", address: "An old address", precision: "address" } } }) }] }] } });
  await legacyContext.route("**/*", async route => {
    const req = route.request();
    const response = await worker.fetch(new Request(req.url(), { method: req.method(), headers: req.headers() }), env);
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const legacy = await legacyContext.newPage();
  await legacy.goto(origin);
  await legacy.locator("#place-composer").waitFor({ state: "visible" });
  assert.equal(await legacy.locator("#place-name").inputValue(), "An old place draft");
  await show(legacy, "note");
  assert.equal(await legacy.locator("#thought").inputValue(), "My old draft stays a note");
  assert.equal(await legacy.locator("#categories").inputValue(), "Life");
  assert.equal(noteFiles().length, 3);
  await legacyContext.close();
  assert.deepEqual(errors, []);
  console.log("PASS: independent place/note forms, buttons, drafts, photos, and saves; optional note-place association; link-copy shortcut keeps the note; legacy-draft migration; unresolved link never blocks Notes.");
  console.log("PASS: both reported Maps links, place-only saves, deduplication, stale-edit protection, manual address fallback, draft reload, and four responsive widths. No real GitHub writes.");
} finally { await browser.close(); }
