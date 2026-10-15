import test from "node:test";
import assert from "node:assert/strict";
import { createPublisher } from "../src/worker.mjs";

const env = {
  GITHUB_TOKEN: "test-github-credential", PUBLISH_SECRET: "a".repeat(64),
  GITHUB_OWNER: "yashrmaa", GITHUB_REPO: "yasharma", GITHUB_BRANCH: "main",
  SITE_URL: "https://yasharma.com",
};
const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
const date = "2026-10-15T16:05:00.000Z";
const created = url => Response.json({ commit: { sha: "abc123" }, content: { path: new URL(url).pathname.split("/contents/")[1] } }, { status: 201 });

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

for (const status of [401, 403, 404, 422, 429, 500]) {
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
