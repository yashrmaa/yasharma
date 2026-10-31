import test from "node:test";
import assert from "node:assert/strict";
import { createPublisher } from "../src/worker.mjs";
import { googleMapsURL, googleMapsPin, resolveGoogleMaps, validatePlace } from "../src/places.mjs";
import { googleMapsLink, googleMapsKey } from "../public/place-input.js";
import { placeRepository } from "./places-repository.mjs";

const short = "https://maps.app.goo.gl/6tkYdRQhpNqzxMXJ9";
const full = "https://www.google.com/maps/place/Kenyan+Shibuya/@35.6638151,67.9811653,3z/data=!8m2!3d35.6638151!4d139.6999153";
const geo = async () => Response.json({ features: [{ properties: { name: "A different nearby venue", city: "Tokyo", locality: "Shibuya", street: "Jinnan", housenumber: "1-14-8", country: "Japan" }, geometry: { coordinates: [139, 36] } }] });
const env = { GITHUB_TOKEN: "fake-token", PUBLISH_SECRET: "p".repeat(64), GITHUB_OWNER: "owner", GITHUB_REPO: "repo", GITHUB_BRANCH: "main", SITE_URL: "https://yasharma.com" };

test("link comparison preserves the place query while ignoring tracking parameters", () => {
  assert.notEqual(googleMapsKey("https://maps.google.com/?q=35,139"), googleMapsKey("https://maps.google.com/?q=36,140"));
  assert.equal(googleMapsKey(short + "?g_st=share&utm_source=phone"), googleMapsKey(short));
});

test("shared links use the venue pin rather than the map viewport or a nearby search result", async () => {
  const calls = [];
  const place = await resolveGoogleMaps(short, async (url, options) => { calls.push({ url, options }); return new Response(null, { status: 302, headers: { Location: full } }); }, geo);
  assert.deepEqual(place.coordinates, [35.6638151, 139.6999153]);
  assert.equal(place.name, "Kenyan Shibuya");
  assert.equal(place.city, "Tokyo");
  assert.equal(place.mapsURL, short);
  assert.equal(place.locationSource, short);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "HEAD");
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[0].options.headers.Authorization, undefined);
});

test("full and regional Maps links plus coordinate-pin URLs work without fetching Google", async () => {
  const neverFetch = () => { throw new Error("Full pin links don't need a Google request"); };
  for (const url of [full, full.replace("www.google.com", "www.google.co.jp")]) {
    assert.equal(googleMapsURL(url).href, googleMapsLink(url));
    const place = await resolveGoogleMaps(url, neverFetch, geo);
    assert.deepEqual(place.coordinates, [35.6638151, 139.6999153]);
  }
  assert.deepEqual(googleMapsPin("https://maps.google.ca/?q=45.4866737,-73.6268795").coordinates, [45.4866737, -73.6268795]);
  assert.equal(googleMapsPin("https://www.google.com/maps/@35,139,15z"), null);
});

test("address-service failure preserves the exact Google pin for manual city/address entry", async () => {
  const place = await resolveGoogleMaps(full, () => {}, async () => { throw new Error("Unavailable"); });
  assert.deepEqual(place.coordinates, [35.6638151, 139.6999153]);
  assert.equal(place.name, "Kenyan Shibuya");
  assert.equal(place.city, "");
  assert.equal(place.address, "");
});

test("unsafe URLs, credential URLs, other Google services, and redirects outside Maps are rejected", async () => {
  for (const url of ["http://maps.app.goo.gl/abc", "https://maps.app.goo.gl.evil.test/abc", "https://www.google.com.evil.test/maps/place/A", "https://www.google.com/url?q=https://evil.test", "https://localhost/maps/place/A", "https://www.google.com:8443/maps/place/A", "https://user:password@www.google.com/maps/place/A", "javascript:alert(1)"]) {
    assert.throws(() => googleMapsURL(url), url);
    assert.equal(googleMapsLink(url), "", url);
  }
  const calls = [];
  await assert.rejects(resolveGoogleMaps(short, async url => { calls.push(url); return new Response(null, { status: 302, headers: { Location: "https://127.0.0.1/private" } }); }, geo), error => error.code === "invalid_maps_link");
  assert.deepEqual(calls, [short]);
});

test("redirect loops and view-only links fail clearly instead of inventing a location", async () => {
  let count = 0;
  await assert.rejects(resolveGoogleMaps(short, async () => { count++; return new Response(null, { status: 302, headers: { Location: short } }); }, geo), error => error.code === "maps_unresolved");
  assert.equal(count, 1);
  await assert.rejects(resolveGoogleMaps("https://www.google.com/maps/@35,139,15z", async () => new Response("<html>No selected venue</html>"), geo), error => error.code === "maps_unresolved");
});

test("a canonical Maps pin in page metadata is accepted, but unrelated body coordinates are ignored", async () => {
  const place = await resolveGoogleMaps(short, async (url, options) => options.method === "HEAD" ? new Response(null) : new Response(`<link rel="canonical" href="${full}">unrelated !3d0!4d0`), geo);
  assert.deepEqual(place.coordinates, [35.6638151, 139.6999153]);
});

test("the resolve API requires authentication and never passes GitHub credentials to Google or Photon", async () => {
  const calls = [];
  const worker = createPublisher({ mapsFetch: async (url, options) => { calls.push(options); return new Response(null, { status: 302, headers: { Location: full } }); }, geocodeFetch: geo, fetch: () => { throw new Error("GitHub must not be used for resolution"); } });
  const url = `https://notebook.test/places/resolve?url=${encodeURIComponent(short)}`;
  assert.equal((await worker.fetch(new Request(url), env)).status, 401);
  assert.equal(calls.length, 0);
  assert.equal((await worker.fetch(new Request(url, { headers: { Authorization: `Bearer ${env.PUBLISH_SECRET}`, Origin: "https://evil.test" } }), env)).status, 403);
  const response = await worker.fetch(new Request(url, { headers: { Authorization: `Bearer ${env.PUBLISH_SECRET}` } }), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).place.mapsURL, short);
  assert.ok(calls.every(options => !options.headers.Authorization));
});

test("saving imported places keeps their original Maps URL, including regional links", async () => {
  const repo = placeRepository();
  const worker = createPublisher({ fetch: repo.fetch });
  const place = { name: "Kenyan Shibuya", city: "Tokyo", category: "Tea", status: "saved", address: "Jinnan, Shibuya, Tokyo", coordinates: [35.6638151, 139.6999153], precision: "address", mapsURL: short };
  const response = await worker.fetch(new Request("https://notebook.test/publish", { method: "POST", headers: { Authorization: `Bearer ${env.PUBLISH_SECRET}`, "Content-Type": "application/json" }, body: JSON.stringify({ kind: "place", place }) }), env);
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal(repo.catalog()[0].mapsURL, short);
  assert.equal(validatePlace({ ...place, mapsURL: "HTTPS://MAPS.GOOGLE.CO.JP/?q=35,139" }).mapsURL, "https://maps.google.co.jp/?q=35,139");
});
