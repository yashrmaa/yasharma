import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validatePhotos } from "../src/photos.mjs";
import { createPublisher } from "../src/worker.mjs";

const env = {
  GITHUB_TOKEN: "test-github-credential", PUBLISH_SECRET: "a".repeat(64),
  GITHUB_OWNER: "yashrmaa", GITHUB_REPO: "yasharma", GITHUB_BRANCH: "main",
  SITE_URL: "https://yasharma.com",
};
const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
const date = "2026-10-15T16:05:00.000Z";
const photo = { data: readFileSync(new URL("./fixtures/photo.jpg", import.meta.url)).toString("base64"), alt: "Trees — 🪴" };
const created = url => Response.json({ commit: { sha: "abc123" }, content: { path: new URL(url).pathname.split("/contents/")[1] } }, { status: 201 });

test("production fetch preserves the global receiver required by Cloudflare workerd", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async function (url, options) {
    assert.equal(this, globalThis, "unbound native fetch throws Illegal invocation in workerd");
    assert.equal(options.redirect, "manual", "workerd rejects redirect: error");
    calls++;
    return created(url);
  };
  try {
    // Deliberately do not inject fetch, unlike the other endpoint tests.
    const worker = createPublisher();
    const response = await worker.fetch(new Request("https://publisher.example/publish", {
      method: "POST", headers: { Authorization: `Bearer ${env.PUBLISH_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "note", text: "Runtime regression test" }),
    }), env);
    assert.equal(response.status, 201);
    assert.equal((await response.json()).status, "committed");
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

function harness(responder = created) {
  const calls = [];
  let index = 0;
  const worker = createPublisher({
    now: () => new Date(date), uuid: () => ids[index++], sleep: async () => {},
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      return responder(url, options, calls.length);
    },
  });
  async function send(body, options = {}, bindings = env) {
    const { url = "https://publisher.example/publish", headers = {}, ...rest } = options;
    const response = await worker.fetch(new Request(url, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.PUBLISH_SECRET}`, ...headers },
      body: JSON.stringify(body), ...rest,
    }), bindings);
    return { response, data: await response.json() };
  }
  const document = (i = 0) => Buffer.from(JSON.parse(calls[i].body).content, "base64").toString("utf8");
  return { send, calls, document };
}

test("link commits to the fixed repository/branch/path and returns committed, not live", async () => {
  const h = harness();
  const { response, data } = await h.send({ kind: "link", url: "https://example.com/article?a=1&b=2", title: "Cities", text: "A useful essay." });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(data.ok, true);
  assert.equal(data.status, "committed");
  assert.equal(data.live, false);
  assert.equal(data.url, `https://yasharma.com/notes/2026-10-15-${ids[0]}/`);
  assert.equal(data.path, `content/notes/2026-10-15-${ids[0]}.md`);
  assert.equal(data.commit_sha, "abc123");
  const call = h.calls[0];
  assert.equal(call.url, `https://api.github.com/repos/yashrmaa/yasharma/contents/${data.path}`);
  assert.equal(call.method, "PUT");
  assert.equal(call.redirect, "manual");
  assert.equal(call.headers.Authorization, `Bearer ${env.GITHUB_TOKEN}`);
  const payload = JSON.parse(call.body);
  assert.equal(payload.branch, "main");
  assert.equal(payload.sha, undefined, "must never overwrite files");
  assert.match(h.document(), /title: "Cities"/);
  assert.match(h.document(), /source_url: "https:\/\/example.com\/article\?a=1&b=2"/);
  assert.match(h.document(), /draft: false/);
  assert.match(h.document(), /A useful essay\\\./);
  assert.ok(!JSON.stringify(data).includes(env.GITHUB_TOKEN));
});

test("URL alone is sufficient; title falls back to domain", async () => {
  const h = harness();
  const { data } = await h.send({ kind: "link", url: "https://example.com" });
  assert.equal(data.ok, true);
  assert.match(h.document(), /title: "example.com"/);
});

test("categories are optional, normalized, deduplicated, and safely serialized", async () => {
  const h = harness();
  assert.equal((await h.send({ kind: "note", text: "Hello", categories: [" Life ", "life", "Places", "सोच"] })).response.status, 201);
  assert.match(h.document(), /categories: \["life", "places", "सोच"\]/);
});

test("invalid categories and injection never reach GitHub", async () => {
  for (const categories of [null, "Life", [""], ["../escape"], ["x\n---"], ["<script>"], [1], ["x".repeat(41)], Array(9).fill("life")]) {
    const h = harness();
    assert.equal((await h.send({ kind: "note", text: "Hello", categories })).response.status, 400);
    assert.equal(h.calls.length, 0);
  }
});

test("photo-only note uploads JPEG first then portable Markdown with escaped description", async () => {
  const h = harness();
  const result = await h.send({ kind: "note", photos: [{ ...photo, alt: "A [photo](bad) <script> {{< x >}}" }], categories: ["Places"] });
  assert.equal(result.response.status, 201);
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[0].url, /\/contents\/static\/notes-media\/2026-10-15-[a-f0-9-]+\.jpg$/);
  assert.equal(JSON.parse(h.calls[0].body).content, validatePhotos([photo])[0].data);
  assert.equal(JSON.parse(h.calls[0].body).sha, undefined);
  assert.equal(h.calls[0].redirect, "manual");
  assert.match(h.document(1), /!\[A \\\[photo\\\]/);
  assert.match(h.document(1), /\]\(https:\/\/yasharma.com\/notes-media\/2026-10-15-/);
  assert.match(h.document(1), /categories: \["places"\]/);
  assert.ok(!h.document(1).includes("<script>"));
});

test("photo rejection, collision, redirect, lost response or partial success never create a note", async () => {
  for (const status of [401, 403, 409, 422, 302, 500, "timeout", "partial"]) {
    const h = harness(() => {
      if (status === "timeout") throw new Error("Lost response");
      if (status === "partial") return Response.json({ commit: { sha: "abc" } }, { status: 201 });
      return new Response(null, { status });
    });
    const result = await h.send({ kind: "note", text: "Photo", photos: [photo] });
    assert.equal(result.response.status, 502);
    assert.equal(result.data.error.code, "photo_upload_failed");
    assert.equal(h.calls.length, 1);
    assert.ok(!h.calls[0].url.includes("content/notes"));
  }
});

test("failed second photo never publishes the note or silently drops photos", async () => {
  const h = harness((url, options, count) => count === 1 ? created(url) : new Response(null, { status: 403 }));
  assert.equal((await h.send({ kind: "note", photos: [photo, photo] })).data.error.code, "photo_upload_failed");
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(call => call.url.includes("static/notes-media/")));
});

test("invalid photos, oversized uploads, and caller paths cannot be published", async () => {
  for (const photos of [null, {}, Array(4).fill(photo), [{ ...photo, path: "../../x" }], [{ data: btoa("<svg></svg>") }], [{ ...photo, data: "!bad" }], [{ ...photo, alt: "x\n---" }], [{ ...photo, data: "A".repeat(700000) }]]) {
    const h = harness();
    assert.equal((await h.send({ kind: "note", text: "Photo", photos })).response.status, 400);
    assert.equal(h.calls.length, 0);
  }
  const h = harness();
  assert.equal((await h.send({ kind: "note", photos: [{ data: "A".repeat(2100000) }] })).response.status, 413);
  assert.equal(h.calls.length, 0);
});

test("photo publishing still requires authentication and preserves unknown note commits", async () => {
  const h = harness((url, options, count) => { if (count === 1) return created(url); throw new Error("Lost note confirmation"); });
  assert.equal((await h.send({ kind: "note", photos: [photo] }, { headers: { Authorization: "" } })).response.status, 401);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.send({ kind: "note", photos: [photo] })).data.error.code, "commit_unknown");
  assert.equal(h.calls.length, 2);
});

test("three maximum-sized photos stay within the bounded request and upload serially", async () => {
  const bytes = Buffer.from(photo.data, "base64");
  const large = Buffer.concat([bytes.subarray(0, -2), Buffer.alloc(500 * 1024 - bytes.length), bytes.subarray(-2)]).toString("base64");
  let writes = 0;
  const worker = createPublisher({ fetch: async (url, options) => {
    writes++;
    assert.equal(options.redirect, "manual");
    return created(url);
  } });
  const response = await worker.fetch(new Request("https://publisher.example/publish", {
    method: "POST", headers: { Authorization: `Bearer ${env.PUBLISH_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "note", photos: Array(3).fill({ data: large, alt: "" }) }),
  }), env);
  assert.equal(response.status, 201, await response.text());
  assert.equal(writes, 4);
});

test("plain-text note needs no title; Unicode survives UTF-8/base64", async () => {
  const h = harness();
  const { data } = await h.send({ kind: "note", text: "सोच रहा हूँ — café 🪴 日本語\n\nPay attention" });
  assert.equal(data.ok, true);
  assert.ok(!h.document().includes("title:"));
  assert.ok(!h.document().includes("source_url:"));
  assert.ok(h.document().includes("सोच रहा हूँ — café 🪴 日本語\n\nPay attention"));
});

test("rejects null optional fields instead of silently coercing them", async () => {
  const h = harness();
  for (const field of ["title", "text", "url"]) {
    assert.equal((await h.send({ kind: "note", text: "Hello", [field]: null })).response.status, 400);
  }
  assert.equal(h.calls.length, 0);
});

test("indented text stays literal without becoming a Markdown code block", async () => {
  const h = harness();
  assert.equal((await h.send({ kind: "note", text: "A thought\n\n    **indented**\n\t<text>" })).data.ok, true);
  assert.ok(h.document().includes("&#32;&#32;&#32;&#32;\\*\\*indented"));
  assert.ok(h.document().includes("&#9;\\<text\\>"));
});

test("YAML quoted values and literal text cannot inject front matter, HTML, or shortcodes", async () => {
  const h = harness();
  const title = '"quoted": yes\n---\ndraft: true\\x\u0085\u2028\u2029';
  const { data } = await h.send({ kind: "link", url: "https://example.com", title, text: '---\ndraft: true\n<script>alert(1)</script>\n{{< missing >}}\n# Heading\n**bold**' });
  assert.equal(data.ok, true);
  const doc = h.document();
  const front = doc.split("\n---\n")[0];
  assert.equal(JSON.parse(front.split("\n").find(line => line.startsWith("title: ")).slice(7)), title.trim());
  assert.equal((doc.match(/^---$/gm) || []).length, 2);
  assert.ok(!doc.includes("<script>"));
  assert.ok(!doc.includes("{{<"));
  assert.ok(doc.includes("\\# Heading"));
});

for (const url of ["javascript:alert(1)", "data:text/html,test", "file:///tmp/test", "ftp://example.com", "example.com", "//example.com", "", "https://user:pass@example.com", "https://yasharma.com/a", "https://www.yasharma.com/a", "http://localhost", "https://example.com/a b"]) {
  test(`rejects invalid/external URL: ${url}`, async () => {
    const h = harness();
    const { response, data } = await h.send({ kind: "link", url });
    assert.equal(response.status, 400);
    assert.equal(data.error.code, "invalid_url");
    assert.equal(h.calls.length, 0);
  });
}

for (const input of [{ kind: "note" }, { kind: "note", text: " \n " }, { kind: "other" }, { kind: "note", text: 42 }, { kind: "link", url: ["https://example.com"] }, { kind: "note", text: "ok", path: "../../config.yml" }, { kind: "note", text: "x", draft: true }, { kind: "note", text: "x", url: "https://example.com" }, { kind: "note", text: "\u0000" }, { kind: "note", text: "\ud800" }, [], null]) {
  test(`rejects invalid input: ${JSON.stringify(input)}`, async () => {
    const h = harness();
    assert.equal((await h.send(input)).response.status, 400);
    assert.equal(h.calls.length, 0);
  });
}

for (const header of ["", "Bearer wrong", `Basic ${env.PUBLISH_SECRET}`]) {
  test(`invalid authentication (${header.split(" ")[0]}) never writes`, async () => {
    const h = harness();
    const { response } = await h.send({ kind: "note", text: "Hello" }, { headers: { Authorization: header } });
    assert.equal(response.status, 401);
    assert.equal(h.calls.length, 0);
  });
}

test("rejects oversized actual body, announced size, and individual fields", async () => {
  for (const options of [{}, { headers: { "Content-Length": "40000" } }]) {
    const h = harness();
    assert.equal((await h.send({ kind: "note", text: "x".repeat(40000) }, options)).response.status, 413);
    assert.equal(h.calls.length, 0);
  }
  for (const input of [{ kind: "note", text: "x".repeat(10001) }, { kind: "note", text: "x", title: "x".repeat(301) }, { kind: "link", url: `https://example.com/${"x".repeat(4096)}` }]) {
    assert.equal((await harness().send(input)).response.status, 400);
  }
});

test("rejects malformed JSON, non-JSON, HTTP, wrong path, and wrong method", async () => {
  const h = harness();
  assert.equal((await h.send({}, { body: "{" })).response.status, 400);
  assert.equal((await h.send({}, { headers: { "Content-Type": "text/plain" } })).response.status, 415);
  assert.equal((await h.send({}, { url: "http://publisher.example/publish" })).response.status, 400);
  assert.equal((await h.send({}, { url: "https://publisher.example/admin" })).response.status, 404);
  assert.equal((await h.send({}, { method: "GET", body: undefined })).response.status, 405);
  assert.equal(h.calls.length, 0);
});

test("missing/weak secrets fail closed", async () => {
  for (const bindings of [{ ...env, GITHUB_TOKEN: "" }, { ...env, PUBLISH_SECRET: "short" }, { ...env, SITE_URL: "http://example.com" }]) {
    const h = harness();
    assert.equal((await h.send({ kind: "note", text: "Hello" }, {}, bindings)).response.status, 503);
    assert.equal(h.calls.length, 0);
  }
});

for (const status of [301, 302, 307, 308, 401, 403, 404, 422, 429, 500]) {
  test(`GitHub ${status} is a visible failure without upstream secrets`, async () => {
    const h = harness((url, options) => new Response(env.GITHUB_TOKEN, { status: options.method === "PUT" ? status : 404 }));
    const { response, data } = await h.send({ kind: "note", text: "Hello" });
    assert.equal(response.status, 502);
    assert.equal(data.ok, false);
    assert.equal(data.github_status, status);
    assert.ok(!JSON.stringify(data).includes(env.GITHUB_TOKEN));
  });
}

for (const status of [409, 422]) {
  test(`filename collision (${status}) generates a new path without overwriting`, async () => {
    const h = harness((url, options, count) => count === 1 ? new Response("collision", { status }) : options.method === "PUT" ? created(url) : Response.json({ sha: "existing" }));
    const { data } = await h.send({ kind: "note", text: "Hello" });
    assert.equal(data.ok, true);
    assert.ok(data.path.includes(ids[1]));
    assert.equal(h.calls.length, 3);
    assert.ok(h.calls[1].url.endsWith("?ref=main"));
    assert.equal(JSON.parse(h.calls[2].body).sha, undefined);
  });
}

test("concurrent branch update retries with bounded backoff", async () => {
  const h = harness((url, options, count) => count === 1 ? new Response("conflict", { status: 409 }) : options.method === "PUT" ? created(url) : new Response("missing", { status: 404 }));
  assert.equal((await h.send({ kind: "note", text: "Hello" })).data.ok, true);
});

test("repeated collisions fail after three attempts", async () => {
  const h = harness((url, options) => options.method === "PUT" ? new Response("collision", { status: 422 }) : Response.json({ sha: "existing" }));
  assert.equal((await h.send({ kind: "note", text: "Hello" })).response.status, 502);
  assert.equal(h.calls.filter(call => call.method === "PUT").length, 3);
});

test("network timeouts and malformed success are unknown, never false success or automatic retries", async () => {
  for (const responder of [() => { throw new Error("timeout"); }, () => new Response("not JSON", { status: 201 }), () => Response.json({}, { status: 201 })]) {
    const h = harness(responder);
    const { response, data } = await h.send({ kind: "note", text: "Hello" });
    assert.equal(response.status, 502);
    assert.equal(data.error.code, "commit_unknown");
    assert.equal(data.status, "unknown");
    assert.equal(h.calls.length, 1);
  }
});


test("strips metadata before storage, including between scans and after EOI", async () => {
  const original = Buffer.from(photo.data, "base64");
  const segments = [];
  for (const marker of [224, 225, 226, 237, 239, 254]) {
    const payload = Buffer.from("Exif\0\0GPS XMP IPTC PRIVATE_LOCATION");
    const header = Buffer.from([255, marker, 0, payload.length + 2]);
    segments.push(header, payload);
  }
  const metadata = Buffer.concat(segments);
  const dirty = Buffer.concat([original.subarray(0, 2), metadata, original.subarray(2, -2), metadata, original.subarray(-2), Buffer.from("PRIVATE_TRAILER")]);
  const h = harness();
  assert.equal((await h.send({ kind: "note", photos: [{ ...photo, data: dirty.toString("base64") }] })).response.status, 201);
  const stored = JSON.parse(h.calls[0].body).content;
  assert.equal(stored, validatePhotos([photo])[0].data, "encoded image bytes are preserved");
  assert.ok(!Buffer.from(stored, "base64").includes(Buffer.from("PRIVATE_")));
  assert.equal(validatePhotos([{ data: stored }])[0].data, stored);
});

test("rejects truncated JPEG metadata and missing end markers before storage", async () => {
  const bytes = Buffer.from(photo.data, "base64");
  for (const invalid of [bytes.subarray(0, -2), Buffer.concat([bytes.subarray(0, 2), Buffer.from([255, 225, 255, 255]), bytes.subarray(2)])]) {
    const h = harness();
    assert.equal((await h.send({ kind: "note", photos: [{ data: invalid.toString("base64") }] })).response.status, 400);
    assert.equal(h.calls.length, 0);
  }
});
