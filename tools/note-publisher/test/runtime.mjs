// Exercise native workerd fetch, not a JavaScript fetch mock. All outbound
// requests terminate in the local stub below: no real credentials or writes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

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
const options = {
  modules: ["worker.mjs", "session.mjs", "photos.mjs"].map(file => ({
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
    assert.equal(url.origin, "https://api.github.com", "Never forward credentials to redirects");
    assert.equal(request.headers.get("Authorization"), "Bearer fake-runtime-token");
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
  console.log("workerd runtime passed: cookie auth, note/link/photo publishing, categories, Unicode, redirect refusal, collision recovery; no real GitHub writes.");
} finally {
  await runtime.dispose();
}
