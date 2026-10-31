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
const worker = createPublisher({ fetch: repo.fetch, geocodeFetch: async url => {
  const updating = new URL(url).searchParams.get("q").includes("confirmed Fellini");
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
const changed = async (page, selector, value) => { await page.locator(selector).fill(value); };
const success = page => page.waitForFunction(() => !document.querySelector("#feedback").hidden && document.querySelector("#feedback").dataset.state === "success" && document.querySelector("#composer").getAttribute("aria-busy") === "false");
try {
  const page = await ctx.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.locator("#secret").fill(secret);
  await page.locator("#sign-in-button").click();
  await page.locator("#composer").waitFor({ state: "visible" });
  await page.locator('[data-compose-mode="place"]').click();
  await page.waitForFunction(count => document.querySelector("#place-existing").options.length === count + 1, initialPlaceCount);
  await page.locator("#place-existing").selectOption("bello-coffee");
  assert.equal(await page.locator("#place-name").inputValue(), "Bello Coffee & Tea");
  await page.locator("#place-status").selectOption("saved");
  await page.locator("#publish").click();
  await success(page);
  assert.equal(repo.catalog().find(place => place.id === "bello-coffee").status, "saved");
  assert.equal(noteFiles().length, 0, "saving only a place must not create an empty note");
  assert.match(await page.locator("#message").textContent(), /No note was created/);
  assert.match(await page.locator("#note-link").getAttribute("href"), /\/places\/\?place=bello-coffee/);

  await changed(page, "#thought", "Great coffee, and my own photo 🪴");
  await page.locator("#extras").evaluate(node => { node.open = true; });
  await page.locator("#photo-picker").setInputFiles(new URL("./fixtures/photo.jpg", import.meta.url).pathname);
  await page.waitForFunction(() => document.querySelectorAll(".photo-preview").length === 1 && !document.querySelector("#publish").disabled);
  await page.locator("#place-status").selectOption("liked");
  await page.locator("#publish").click();
  await success(page);
  assert.equal(noteFiles().length, 1);
  assert.match(String(repo.file(noteFiles()[0])), /places: \["bello-coffee"\]/);
  assert.match(String(repo.file(noteFiles()[0])), /Great coffee, and my own photo 🪴/);
  assert.equal(await page.locator("#thought").inputValue(), "");

  await page.locator("#place-existing").selectOption("");
  await page.locator("#place-query").fill("Browser Cafe San Francisco");
  await page.locator("#place-search-button").click();
  await page.locator("#place-results button").first().click();
  assert.equal(await page.locator("#place-name").inputValue(), "Browser Cafe");
  await page.locator("#publish").click();
  await success(page);
  assert.equal(repo.catalog().length, initialPlaceCount + 1);
  assert.equal(noteFiles().length, 1);
  assert.match(await page.locator("#place-load-status").textContent(), /Saved/);

  // Picking a more precise location updates the existing pin, not a duplicate.
  await page.locator("#place-existing").selectOption("fellini-coffee");
  await page.locator("#place-query").fill("confirmed Fellini location");
  await page.locator("#place-search-button").click();
  await page.locator("#place-results button").first().click();
  assert.equal(await page.locator("#place-existing").inputValue(), "fellini-coffee");
  await page.locator("#publish").click();
  await success(page);
  assert.equal(repo.catalog().length, initialPlaceCount + 1);
  assert.deepEqual(repo.catalog().find(place => place.id === "fellini-coffee").coordinates, [40.7347, -74.0012]);
  assert.equal(repo.catalog().find(place => place.id === "fellini-coffee").locationNote, undefined);

  // In-progress place edits survive reload, including mode and coordinates.
  await page.locator("#place-existing").selectOption("fellini-coffee");
  await changed(page, "#thought", "A draft about Fellini");
  await page.locator("#place-location-details").evaluate(node => { node.open = true; });
  await changed(page, "#place-city", "New York City");
  await page.reload();
  await page.locator("#composer").waitFor({ state: "visible" });
  assert.equal(await page.locator("#place-fields").isVisible(), true);
  assert.equal(await page.locator("#thought").inputValue(), "A draft about Fellini");
  assert.equal(await page.locator("#place-city").inputValue(), "New York City");
  assert.equal(await page.locator("#place-latitude").inputValue(), "40.7347");

  // A stale tab must not overwrite a newer save. Reload explicitly resolves it.
  const other = await ctx.newPage();
  await other.goto(origin);
  await other.locator("#composer").waitFor({ state: "visible" });
  await other.locator("#place-existing").selectOption("fellini-coffee");
  await changed(other, "#thought", "");
  await other.locator("#place-status").selectOption("saved");
  await other.locator("#publish").click();
  await success(other);
  await page.locator("#publish").click();
  await page.waitForFunction(() => document.querySelector("#message").textContent.includes("changed in another window"));
  assert.equal(await page.locator("#thought").inputValue(), "A draft about Fellini");
  await page.locator("#place-refresh").click();
  await page.waitForFunction(() => document.querySelector("#place-city").value === "New York");
  assert.equal(await page.locator("#thought").inputValue(), "A draft about Fellini");
  await page.screenshot({ path: "/private/tmp/notebook-places-mobile.png", fullPage: true });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}px`);
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: "/private/tmp/notebook-places-dark.png", fullPage: true });
  await page.locator('[data-compose-mode="note"]').click();
  assert.equal(await page.locator("#place-fields").isHidden(), true);
  assert.equal(await page.locator("#thought").inputValue(), "A draft about Fellini");
  await page.locator("#place-latitude").evaluate(node => { node.value = "999"; });
  await page.locator("#publish").click();
  await success(page);
  assert.equal(await page.locator("#thought").inputValue(), "", "hidden place fields must not block ordinary notes");
  assert.deepEqual(errors, []);
  console.log("PASS: mobile place-only saves, saved-place edits, note/photo association, location search, draft reload, stale-tab protection/reload, ordinary note mode, and four responsive widths. No real GitHub writes.");
} finally { await browser.close(); }
