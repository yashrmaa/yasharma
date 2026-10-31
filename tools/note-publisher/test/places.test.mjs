import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublisher } from "../src/worker.mjs";
import { placeRepository } from "./places-repository.mjs";
import { placeRevision } from "../src/places.mjs";
import { entryError } from "../public/composer.js";

const env = { GITHUB_TOKEN: "fake-github-token", PUBLISH_SECRET: "s".repeat(64), GITHUB_OWNER: "owner", GITHUB_REPO: "repo", GITHUB_BRANCH: "main", SITE_URL: "https://yasharma.com" };
const place = { name: "Cafe 日本語", city: "San Francisco", neighborhood: "Glen Park", address: "2885 Diamond Street", category: "Coffee", status: "saved", coordinates: [37.73381, -122.43397], precision: "address", locationSource: "https://www.openstreetmap.org/node/974352510" };
const existing = { ...place, id: "existing-cafe", aliases: ["old name"], status: "liked", website: "https://example.com" };
const photo = { data: readFileSync(new URL("./fixtures/photo.jpg", import.meta.url)).toString("base64"), alt: "My own photo" };
const origin = "https://notebook.test";
function setup(catalog = [], intercept, geocodeFetch) {
  const repo = placeRepository(catalog, intercept);
  const worker = createPublisher({ fetch: repo.fetch, geocodeFetch, sleep: async () => {}, now: () => new Date("2026-10-31T12:00:00Z") });
  const request = (path, options = {}) => worker.fetch(new Request(origin + path, { headers: { Authorization: `Bearer ${env.PUBLISH_SECRET}`, ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }, ...options, ...(options.body ? { body: JSON.stringify(options.body) } : {}) }), env);
  const publish = data => request("/publish", { method: "POST", body: { kind: "place", place, ...data } });
  return { repo, worker, request, publish };
}

test("a place can be saved without text or photos, in one catalog commit and with no empty note", async () => {
  const h = setup();
  const response = await h.publish({});
  const result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  assert.equal(result.has_note, false);
  assert.equal(result.live, false);
  assert.equal(result.path, "data/places.json");
  assert.match(result.url, /\/places\/\?place=/);
  assert.equal(h.repo.catalog()[0].name, place.name);
  assert.equal(h.repo.catalog()[0].status, "saved");
  assert.equal([...h.repo.files().keys()].some(path => path.startsWith("content/notes/")), false);
  assert.equal(h.repo.calls.filter(call => call.method === "PATCH").length, 1);
  assert.equal(entryError({ kind: "place", place, text: "", photos: [] }), "");
});

test("place, original note, and real photo publish atomically with an explicit note association", async () => {
  const h = setup();
  const response = await h.publish({ text: "Wonderful flat white 🪴", photos: [photo] });
  const result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  assert.equal(result.has_note, true);
  const document = String(h.repo.file(result.path));
  assert.ok(document.includes(`places: ["${result.place_id}"]`));
  assert.match(document, /kind: note/);
  assert.match(document, /Wonderful flat white 🪴/);
  assert.match(document, /!\[My own photo\]\(https:\/\/yasharma.com\/notes-media\//);
  assert.ok([...h.repo.files().keys()].some(path => path.startsWith("static/notes-media/")));
  assert.equal(h.repo.calls.filter(call => call.method === "PATCH").length, 1);
  assert.equal(h.repo.calls.some(call => call.method === "PUT"), false);
});

test("existing places keep stable IDs, old aliases, and unrelated metadata while status and location update", async () => {
  const h = setup([existing]);
  const listed = await (await h.request("/places")).json();
  const selected = listed.places[0];
  const update = { ...place, id: selected.id, revision: selected.revision, name: "Renamed Cafe", status: "saved", precision: "city" };
  const response = await h.publish({ place: update });
  assert.equal(response.status, 201, await response.text());
  const result = h.repo.catalog()[0];
  assert.equal(result.id, existing.id);
  assert.equal(result.website, existing.website);
  assert.equal(result.status, "saved");
  assert.ok(result.aliases.includes("old name"));
  assert.ok(result.aliases.includes(existing.name));
  assert.match(result.locationNote, /Approximate/);
});

test("stale edits and duplicate locations are rejected instead of overwriting a saved place", async () => {
  const h = setup([existing]);
  const before = h.repo.head;
  assert.equal((await h.publish({ place: { ...place, id: existing.id, revision: "a".repeat(64) } })).status, 409);
  assert.equal((await h.publish({})).status, 409);
  assert.equal(h.repo.head, before);
});

test("concurrent unrelated commits are preserved when retrying a non-fast-forward branch update", async () => {
  let conflict = true;
  const h = setup([], (call, repo) => {
    if (call.method === "PATCH" && conflict) { conflict = false; repo.commitFiles({ "unrelated.txt": "keep this change" }); return new Response(null, { status: 409 }); }
  });
  assert.equal((await h.publish({})).status, 201);
  assert.equal(h.repo.file("unrelated.txt"), "keep this change");
  assert.equal(h.repo.catalog().length, 1);
});

test("failed preparation leaves the catalog, notes, and photos unpublished", async () => {
  const h = setup([], call => call.path === "/git/trees" ? new Response(null, { status: 403 }) : undefined);
  const before = h.repo.head;
  assert.equal((await h.publish({ text: "A note", photos: [photo] })).status, 502);
  assert.equal(h.repo.head, before);
  assert.equal(h.repo.files().size, 1);
});

test("lost final confirmation is unknown and is never retried after a possibly successful commit", async () => {
  const h = setup([], (call, repo) => {
    if (call.method === "PATCH") { repo.setHead(call.body.sha); throw new Error("Lost acknowledgement"); }
  });
  const response = await h.publish({});
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.code, "commit_unknown");
  assert.equal(body.status, "unknown");
  assert.equal(h.repo.catalog().length, 1);
  assert.equal(h.repo.calls.filter(call => call.method === "PATCH").length, 1);
});

test("malformed catalogs fail closed and draft catalog entries stay out of the editor", async () => {
  const h = setup([{ ...existing, draft: true }]);
  assert.deepEqual((await (await h.request("/places")).json()).places, []);
  assert.equal((await h.publish({ place: { ...place, id: existing.id, revision: await placeRevision({ ...existing, draft: true }) } })).status, 409);
  h.repo.commitFiles({ "data/places.json": "not json" });
  const before = h.repo.head;
  assert.equal((await h.publish({})).status, 502);
  assert.equal(h.repo.head, before);
});

test("invalid coordinates, unsafe metadata, missing names, and caller-controlled fields never reach GitHub", async () => {
  const h = setup();
  for (const bad of [{ coordinates: [91, 0] }, { coordinates: [0, 181] }, { coordinates: [null, 0] }, { coordinates: ["37", 0] }, { name: "" }, { city: "" }, { status: "public" }, { precision: "unknown" }, { locationSource: "javascript:alert(1)" }, { id: "../../secrets" }, { path: "somewhere" }]) {
    assert.equal((await h.publish({ place: { ...place, ...bad } })).status, 400, JSON.stringify(bad));
  }
  assert.equal(h.repo.calls.length, 0);
});

test("all place APIs require sign-in, reject cross-origin requests, and keep geocoder credentials separate", async () => {
  const geocalls = [];
  const h = setup([], undefined, async (url, options) => {
    geocalls.push({ url, options });
    return Response.json({ features: [{ properties: { name: "Bello", city: "San Francisco", osm_type: "N", osm_id: 123, osm_key: "amenity", osm_value: "cafe" }, geometry: { coordinates: [-122.43, 37.73] } }] });
  });
  for (const path of ["/places", "/places/search?q=coffee"]) {
    assert.equal((await h.worker.fetch(new Request(origin + path), env)).status, 401);
    assert.equal((await h.request(path, { headers: { Authorization: `Bearer ${env.PUBLISH_SECRET}`, Origin: "https://evil.test" } })).status, 403);
  }
  assert.equal(geocalls.length, 0);
  const response = await h.request("/places/search?q=Bello%20San%20Francisco");
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.places[0].coordinates, [37.73, -122.43]);
  assert.equal(geocalls[0].options.headers.Authorization, undefined);
  assert.equal(new URL(geocalls[0].url).origin, "https://photon.komoot.io");
  assert.equal(h.repo.calls.length, 0);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});
