import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPublisher } from "../src/worker.mjs";
import { entryFromText, entryError } from "../public/composer.js";

const origin = "https://notebook.test";
const env = { GITHUB_TOKEN: "fake-github-token", PUBLISH_SECRET: "s".repeat(64), GITHUB_OWNER: "yashrmaa", GITHUB_REPO: "yasharma", GITHUB_BRANCH: "main", SITE_URL: "https://yasharma.com" };
const at = new Date("2026-10-15T16:00:00Z");

function setup() {
  const calls = [];
  let time = at;
  const worker = createPublisher({ now: () => time, fetch: async (url, options) => {
    calls.push({ url, ...options });
    return Response.json({ commit: { sha: "abc" }, content: { path: new URL(url).pathname.split("/contents/")[1] } }, { status: 201 });
  } });
  const send = (path, options = {}, bindings = env) => worker.fetch(new Request(`${origin}${path}`, options), bindings);
  async function login() {
    return send("/session", { method: "POST", headers: { Origin: origin, Authorization: `Bearer ${env.PUBLISH_SECRET}`, "Content-Type": "application/json" }, body: "{}" });
  }
  const publish = (cookie, extra = {}, bindings = env) => send("/publish", { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json", ...extra }, body: JSON.stringify({ kind: "note", text: "A real thought" }) }, bindings);
  return { worker, send, login, publish, calls, advance: date => { time = date; } };
}

test("sign-in sets a secure HttpOnly host-only cookie and never returns either secret", async () => {
  const h = setup();
  const response = await h.login();
  assert.equal(response.status, 200);
  const cookie = response.headers.get("Set-Cookie");
  assert.match(cookie, /^__Host-notebook=/);
  for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=2592000"]) assert.ok(cookie.includes(flag));
  assert.ok(!cookie.includes("Domain="));
  assert.ok(!cookie.includes(env.PUBLISH_SECRET));
  const body = await response.text();
  assert.ok(!body.includes(env.PUBLISH_SECRET));
  assert.ok(!body.includes(env.GITHUB_TOKEN));
  assert.equal(h.calls.length, 0);
});

test("session cookie publishes through the existing Contents API and reports committed", async () => {
  const h = setup();
  const cookie = (await h.login()).headers.get("Set-Cookie").split(";")[0];
  assert.equal((await (await h.send("/session", { headers: { Cookie: cookie } })).json()).authenticated, true);
  const response = await h.publish(cookie);
  assert.equal(response.status, 201);
  const data = await response.json();
  assert.equal(data.status, "committed");
  assert.equal(data.live, false);
  assert.equal(h.calls.length, 1);
  const payload = JSON.parse(h.calls[0].body);
  assert.equal(payload.branch, "main");
  assert.equal(payload.sha, undefined);
  assert.match(data.path, /^content\/notes\/2026-10-15-[a-f0-9-]+\.md$/);
  assert.equal(h.calls[0].headers.Authorization, `Bearer ${env.GITHUB_TOKEN}`);
});

test("unauthenticated, tampered, expired, rotated, and different-origin sessions cannot publish", async () => {
  const h = setup();
  const cookie = (await h.login()).headers.get("Set-Cookie").split(";")[0];
  for (const value of ["", "__Host-notebook=broken", cookie.replace(/.$/, x => x === "0" ? "1" : "0"), cookie.replace(/=\d+/, value => `=${Number(value.slice(1)) + 1}`)]) {
    assert.equal((await h.publish(value)).status, 401);
  }
  assert.equal((await h.publish(cookie, {}, { ...env, PUBLISH_SECRET: "t".repeat(64) })).status, 401);
  const otherHost = new Request("https://other.test/publish", { method: "POST", headers: { Cookie: cookie, Origin: "https://other.test", "Content-Type": "application/json" }, body: '{"kind":"note","text":"test"}' });
  assert.equal((await h.worker.fetch(otherHost, env)).status, 401);
  h.advance(new Date(at.getTime() + 31 * 86400000));
  assert.equal((await h.publish(cookie)).status, 401);
  assert.equal(h.calls.length, 0);
});

test("cross-site or absent Origin cannot use cookies or sign-in/logout, even with a valid secret", async () => {
  const h = setup();
  const cookie = (await h.login()).headers.get("Set-Cookie").split(";")[0];
  for (const site of ["https://evil.test", "null", ""]) {
    for (const method of ["POST", "DELETE"]) {
      assert.equal((await h.send("/session", { method, headers: { Origin: site, Authorization: `Bearer ${env.PUBLISH_SECRET}`, "Content-Type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) })).status, 403);
    }
    assert.equal((await h.publish(cookie, { Origin: site })).status, 403);
  }
  assert.equal((await h.publish(cookie, { Origin: "https://evil.test", Authorization: `Bearer ${env.PUBLISH_SECRET}` })).status, 403);
  assert.equal(h.calls.length, 0);
});

test("wrong secret never creates a cookie, logout expires the current cookie", async () => {
  const h = setup();
  const response = await h.send("/session", { method: "POST", headers: { Origin: origin, Authorization: "Bearer wrong", "Content-Type": "application/json" }, body: "{}" });
  assert.equal(response.status, 401);
  assert.equal(response.headers.has("Set-Cookie"), false);
  const out = await h.send("/session", { method: "DELETE", headers: { Origin: origin } });
  assert.match(out.headers.get("Set-Cookie"), /Max-Age=0/);
  assert.equal((await (await h.send("/session")).json()).authenticated, false);
});

test("composer assets get CSP and privacy headers; unknown routes never serve the app", async () => {
  const h = setup();
  let assetCalls = 0;
  const bindings = { ...env, ASSETS: { fetch: async () => { assetCalls++; return new Response("static app", { headers: { "Content-Type": "text/html" } }); } } };
  for (const path of ["/", "/composer.js", "/composer.css", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"]) {
    const response = await h.send(path, {}, bindings);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
    assert.ok(!response.headers.get("Content-Security-Policy").includes("unsafe-inline"));
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.has("Access-Control-Allow-Origin"), false);
  }
  assert.equal(assetCalls, 8);
  assert.equal((await h.send("/admin", {}, bindings)).status, 404);
  assert.equal((await h.send("/publish", {}, bindings)).status, 405);
  assert.equal((await h.worker.fetch(new Request("http://notebook.test/"), bindings)).status, 400);
  assert.equal(assetCalls, 8);
});

test("one-field composer preserves note/link models without fetching URLs", () => {
  assert.deepEqual(entryFromText("  A thought 🪴\r\n\r\nSecond paragraph  "), { kind: "note", text: "A thought 🪴\n\nSecond paragraph" });
  assert.deepEqual(entryFromText("https://example.com/article?a=1&b=2"), { kind: "link", url: "https://example.com/article?a=1&b=2", text: "" });
  assert.deepEqual(entryFromText("https://example.com\n\nSomething to remember"), { kind: "link", url: "https://example.com", text: "Something to remember" });
  assert.equal(entryFromText("A thought\nhttps://example.com").kind, "note");
  assert.equal(entryFromText("javascript:alert(1)").kind, "note");
  assert.equal(entryFromText("https://example.com a thought").kind, "note");
});

test("client validation matches server text, URL and UTF-8 byte limits", () => {
  assert.ok(entryError(entryFromText(" \n ")));
  assert.ok(entryError(entryFromText("x".repeat(10001))));
  assert.ok(entryError({ kind: "link", url: "x".repeat(4097), text: "" }));
  assert.ok(entryError({ kind: "note", text: "\u0085".repeat(10000) + "x" }));
  assert.ok(entryError({ kind: "note", text: "\u0001".repeat(9000) }));
  assert.equal(entryError(entryFromText("https://example.com")), "");
  assert.equal(entryError(entryFromText("Hello 🪴")), "");
});

test("manifest and Apple icon are ready for standalone installation", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/manifest.webmanifest", import.meta.url)));
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.share_target, undefined);
  for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
    const png = await readFile(new URL(`../public/${name}`, import.meta.url));
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});
