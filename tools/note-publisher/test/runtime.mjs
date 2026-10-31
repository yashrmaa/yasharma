// Exercise native workerd fetch, not a JavaScript fetch mock. All outbound
// requests terminate in the local stub below: no real credentials or writes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { placeRepository } from "./places-repository.mjs";

let modulePath = process.env.MINIFLARE_MODULE;
if (!modulePath) {
  // Reuse Miniflare shipped with the existing Wrangler installation.
  const wrangler = realpathSync(execFileSync("which", ["wrangler"], { encoding: "utf8" }).trim());
  modulePath = createRequire(wrangler).resolve("miniflare");
}
const { Miniflare, convertV4MiniflareOptions } = await import(modulePath);
const origin = "https://notebook.test";
const secret = "p".repeat(64);
let mode = "success";
let calls = [];
let placesMode = false;
const repository = placeRepository();
const options = {
  modules: ["worker.mjs", "session.mjs", "photos.mjs", "places.mjs"].map(file => ({
    type: "ESModule", path: fileURLToPath(new URL(`../src/${file}`, import.meta.url)),
  })),
  compatibilityDate: "2026-10-01",
  bindings: {
    GITHUB_TOKEN: "fake-runtime-token", PUBLISH_SECRET: secret,
    GITHUB_OWNER: "test-owner", GITHUB_REPO: "test-repo",
    GITHUB_BRANCH: "main", SITE_URL: "https://yasharma.com",
  },
  outboundService: async request => {
    const url = new URL(request.url);
    if (url.hostname === "maps.app.goo.gl") {
      assert.equal(request.headers.has("Authorization"), false);
      if (url.pathname === "/feature-id-fixture") return new Response(null, { status: 302, headers: { Location: "https://maps.google.com/?q=Sightglass+Coffee,+3014+20th+St&ftid=0x808f7e373f977f1f:0x25f057af5269cec5" } });
      return new Response(null, { status: 302, headers: { Location: "https://www.google.com/maps/place/Runtime+Maps+Cafe/@0,0,2z/data=!8m2!3d35.6638151!4d139.6999153" } });
    }
    if (url.hostname === "www.google.com") {
      assert.equal(request.headers.has("Authorization"), false);
      assert.equal(request.method, "GET", "Google rejects HEAD on embed URLs");
      assert.equal(url.searchParams.get("cid"), "2733781384327450309");
      return new Response(`<script>initEmbed(${JSON.stringify([[["0x808f7e373f977f1f:0x25f057af5269cec5", "Sightglass Coffee, 3014 20th St", [37.7592345, -122.4113171], "2733781384327450309"], "Sightglass Coffee", ["3014 20th St", "San Francisco, CA 94110"]]])});</script>`);
    }
    if (url.hostname === "photon.komoot.io") {
      assert.equal(request.headers.has("Authorization"), false);
      return Response.json({ features: [{ properties: { city: "Tokyo", street: "Jinnan", country: "Japan" } }] });
    }
    assert.equal(url.origin, "https://api.github.com", "Never forward credentials to redirects");
    assert.equal(request.headers.get("Authorization"), "Bearer fake-runtime-token");
    if (placesMode) return repository.fetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), ...(!["GET", "HEAD"].includes(request.method) ? { body: await request.text() } : {}) });
    calls.push({ method: request.method, url: request.url, body: request.method === "PUT" ? await request.json() : null });
    if (mode === "redirect") return new Response(null, { status: 302, headers: { Location: "https://redirect.invalid/" } });
    if (mode === "collision" && calls.length === 1) return new Response(null, { status: 409 });
    if (request.method === "GET") return new Response(null, { status: 404 });
    return Response.json({ commit: { sha: "test-commit" }, content: { path: url.pathname.split("/contents/")[1] } }, { status: 201 });
  },
};
const runtime = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);

try {
  const login = await runtime.dispatchFetch(`${origin}/session`, {
    method: "POST", headers: { Origin: origin, Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("Set-Cookie").split(";")[0];
  const publish = body => runtime.dispatchFetch(`${origin}/publish`, {
    method: "POST", headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  for (const entry of [{ kind: "note", text: "Unicode café 🌱" }, { kind: "link", url: "https://example.com/" }, { kind: "note", text: "", categories: ["Places"], photos: [{ data: readFileSync(new URL("./fixtures/photo.jpg", import.meta.url)).toString("base64"), alt: "Photo" }] }]) {
    calls = [];
    const response = await publish(entry);
    const result = await response.json();
    assert.equal(response.status, 201, JSON.stringify(result));
    assert.equal(result.status, "committed");
    assert.equal(result.live, false);
    assert.equal(calls.length, entry.photos ? 2 : 1);
    assert.match(result.path, /^content\/notes\/\d{4}-\d{2}-\d{2}-[a-f0-9-]+\.md$/);
    const markdown = Buffer.from(calls.at(-1).body.content, "base64").toString("utf8");
    assert.ok(markdown.includes(entry.text || entry.url || "![Photo](https://yasharma.com/notes-media/"));
    if (entry.photos) assert.match(markdown, /categories: \["places"\]/);
  }
  mode = "redirect";
  calls = [];
  const redirect = await publish({ kind: "note", text: "Redirect test" });
  assert.equal(redirect.status, 502);
  assert.equal((await redirect.json()).github_status, 302);
  assert.equal(calls.length, 1);

  mode = "collision";
  calls = [];
  const collision = await publish({ kind: "note", text: "Collision test" });
  assert.equal(collision.status, 201, await collision.text());
  assert.deepEqual(calls.map(call => call.method), ["PUT", "GET", "PUT"]);
  assert.notEqual(calls[0].url, calls[2].url);
  placesMode = true;
  const location = { name: "Runtime Cafe", city: "San Francisco", category: "Coffee", status: "saved", address: "100 Market Street", coordinates: [37.79, -122.4], precision: "address" };
  const savedPlace = await publish({ kind: "place", place: location });
  assert.equal(savedPlace.status, 201, await savedPlace.clone().text());
  const saved = await savedPlace.json();
  assert.equal(saved.has_note, false);
  const savedNote = await publish({ kind: "place", place: { ...location, id: saved.place.id, revision: saved.place.revision, status: "liked" }, text: "Great coffee 🪴", photos: [{ data: readFileSync(new URL("./fixtures/photo.jpg", import.meta.url)).toString("base64"), alt: "Coffee" }] });
  assert.equal(savedNote.status, 201, await savedNote.clone().text());
  const noted = await savedNote.json();
  assert.equal(noted.has_note, false);
  assert.equal(noted.place.comment, "Great coffee 🪴");
  assert.equal(noted.place.photos.length, 1);
  assert.equal([...repository.files().keys()].some(path => path.startsWith("content/notes/")), false);
  assert.equal(repository.catalog()[0].status, "liked");
  const catalogBeforeNote = repository.file("data/places.json");
  const independentNote = await publish({ kind: "note", text: "A note linked to an existing place", places: [saved.place.id] });
  assert.equal(independentNote.status, 201, await independentNote.clone().text());
  const independentResult = await independentNote.json();
  assert.ok(String(repository.file(independentResult.path)).includes(`places: ["${saved.place.id}"]`));
  assert.equal(repository.file("data/places.json"), catalogBeforeNote, "notes must not update a place");
  const mapsURL = "https://maps.app.goo.gl/runtime-fixture";
  const imported = await runtime.dispatchFetch(`${origin}/places/resolve?url=${encodeURIComponent(mapsURL)}`, { headers: { Cookie: cookie } });
  assert.equal(imported.status, 200, await imported.clone().text());
  const importedPlace = (await imported.json()).place;
  assert.deepEqual(importedPlace.coordinates, [35.6638151, 139.6999153]);
  assert.equal(importedPlace.name, "Runtime Maps Cafe");
  const importedSave = await publish({ kind: "place", place: { ...importedPlace, category: "Coffee", status: "saved" } });
  assert.equal(importedSave.status, 201, await importedSave.clone().text());
  assert.equal(repository.catalog().at(-1).mapsURL, mapsURL);
  const featureURL = "https://maps.app.goo.gl/feature-id-fixture";
  const featureResponse = await runtime.dispatchFetch(`${origin}/places/resolve?url=${encodeURIComponent(featureURL)}`, { headers: { Cookie: cookie } });
  assert.equal(featureResponse.status, 200, await featureResponse.clone().text());
  const featurePlace = (await featureResponse.json()).place;
  assert.deepEqual(featurePlace.coordinates, [37.7592345, -122.4113171]);
  assert.equal(featurePlace.address, "3014 20th St, San Francisco, CA 94110");
  assert.equal(featurePlace.mapsURL, featureURL);
  console.log("workerd runtime passed: cookie auth, note/link/photo publishing, categories, Unicode, redirect refusal, collision recovery; no real GitHub writes.");
  console.log("workerd runtime passed: place remarks and photos save atomically without notebook posts.");
  console.log("workerd runtime passed: authenticated Google Maps redirects, exact pin import, address enrichment, and original-link saving.");
  console.log("workerd runtime passed: note-place association publishes only the note, preserving the place catalog.");
} finally {
  await runtime.dispose();
}
