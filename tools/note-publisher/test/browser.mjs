// Real browser UI + real Worker/session code, with only GitHub writes mocked.
// Install Playwright as a development tool or set PLAYWRIGHT_MODULE to its path.
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { createPublisher } from "../src/worker.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const origin = "https://notebook.test";
const secret = "p".repeat(64);
const commits = [];
let githubMode = "success";
let delay = 0;
const worker = createPublisher({ fetch: async (url, options) => {
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  if (githubMode === "error") return new Response("Rejected", { status: 403 });
  if (githubMode === "unknown") throw new Error("Lost response");
  commits.push(JSON.parse(options.body));
  return Response.json({ commit: { sha: "abc" }, content: { path: new URL(url).pathname.split("/contents/")[1] } }, { status: 201 });
} });
const env = {
  GITHUB_TOKEN: "fake-token", PUBLISH_SECRET: secret, GITHUB_OWNER: "yashrmaa", GITHUB_REPO: "yasharma", GITHUB_BRANCH: "main", SITE_URL: "https://yasharma.com",
  ASSETS: { fetch: async request => {
    const path = new URL(request.url).pathname;
    const file = path === "/" ? "index.html" : path.slice(1);
    const type = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" }[extname(file)];
    return new Response(await readFile(new URL(`../public/${file}`, import.meta.url)), { headers: { "Content-Type": type } });
  } },
};

async function context(options = {}) {
  const ctx = await browser.newContext(options);
  await ctx.route("**/*", async route => {
    const req = route.request();
    if (!req.url().startsWith(origin)) return route.abort();
    const response = await worker.fetch(new Request(req.url(), { method: req.method(), headers: req.headers(), ...(!["GET", "HEAD"].includes(req.method()) ? { body: req.postData() } : {}) }), env);
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  return ctx;
}
async function signIn(page) {
  await page.locator("#secret").fill(secret);
  await page.locator("#sign-in-button").click();
  await page.locator("#composer").waitFor({ state: "visible" });
}
async function waitMessage(page, text) { await page.waitForFunction(text => document.getElementById("message").textContent.includes(text), text); }

try {
  const ctx = await context({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.locator("#sign-in").waitFor({ state: "visible" });
  await page.locator("#secret").fill("wrong");
  await page.locator("#sign-in-button").click();
  await waitMessage(page, "Incorrect publishing secret");
  assert.equal(await page.locator("#secret").inputValue(), "");
  await signIn(page);
  const cookies = await ctx.cookies();
  assert.ok(cookies.some(cookie => cookie.name === "__Host-notebook" && cookie.httpOnly && cookie.secure && cookie.sameSite === "Strict"));
  assert.equal(await page.evaluate(() => document.cookie), "");
  await page.locator("#thought").fill("A thought — café 🪴\n\nSecond paragraph");
  await page.reload();
  await page.locator("#composer").waitFor({ state: "visible" });
  assert.equal(await page.locator("#thought").inputValue(), "A thought — café 🪴\n\nSecond paragraph");
  assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes(secret));
  assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes("fake-token"));
  delay = 300;
  await page.locator("#publish").click();
  assert.equal(await page.locator("#publish").isDisabled(), true);
  assert.equal(await page.locator("#thought").getAttribute("readonly"), "");
  await waitMessage(page, "Saved.");
  delay = 0;
  assert.equal(commits.length, 1);
  assert.equal(commits[0].branch, "main");
  assert.match(Buffer.from(commits[0].content, "base64").toString(), /kind: note/);
  assert.equal(await page.locator("#thought").inputValue(), "");
  assert.match(await page.locator("#note-link").getAttribute("href"), /^https:\/\/yasharma.com\/notes\//);
  assert.equal(await page.locator("#deployment-link").getAttribute("href"), "https://github.com/yashrmaa/yasharma/actions/workflows/hugo.yaml");
  await page.reload();
  await page.locator("#composer").waitFor({ state: "visible" });
  assert.equal(await page.locator("#thought").inputValue(), "");

  await page.locator("#thought").fill("https://example.com/article\n\nAn interesting argument");
  await page.locator("#publish").click();
  await waitMessage(page, "Saved.");
  const link = Buffer.from(commits[1].content, "base64").toString();
  assert.match(link, /kind: link/);
  assert.match(link, /source_url: "https:\/\/example.com\/article"/);
  assert.match(link, /An interesting argument/);

  await page.locator("#thought").fill("Keep this draft");
  githubMode = "error";
  await page.locator("#publish").click();
  await waitMessage(page, "GitHub rejected");
  assert.equal(await page.locator("#thought").inputValue(), "Keep this draft");
  assert.equal(await page.locator("#result-links").isVisible(), false);
  githubMode = "unknown";
  await page.locator("#publish").click();
  await waitMessage(page, "wasn’t confirmed");
  await page.reload();
  await page.locator("#composer").waitFor({ state: "visible" });
  await waitMessage(page, "previous publish was not confirmed");
  assert.equal(await page.locator("#thought").inputValue(), "Keep this draft");
  assert.equal(commits.length, 2, "no automatic retries on reload");

  // Expired session prompts sign-in while keeping the draft.
  githubMode = "success";
  await ctx.clearCookies();
  await page.locator("#publish").click();
  await page.locator("#sign-in").waitFor({ state: "visible" });
  await waitMessage(page, "Sign in again");
  await signIn(page);
  assert.equal(await page.locator("#thought").inputValue(), "Keep this draft");
  await page.evaluate(() => { Object.defineProperty(navigator, "onLine", { configurable: true, value: false }); window.dispatchEvent(new Event("offline")); });
  await page.locator("#thought").fill("Offline draft 🪴");
  assert.equal(await page.locator("#publish").isDisabled(), true);
  await page.reload();
  await page.locator("#composer").waitFor({ state: "visible" });
  assert.equal(await page.locator("#thought").inputValue(), "Offline draft 🪴");
  await page.locator("#sign-out").click();
  await page.locator("#sign-in").waitFor({ state: "visible" });
  assert.equal((await ctx.cookies()).filter(cookie => cookie.name === "__Host-notebook").length, 0);
  await signIn(page);
  assert.equal(await page.locator("#thought").inputValue(), "Offline draft 🪴");

  // Actual browser image decoding/canvas normalization, draft recovery and upload.
  await page.locator("#extras").evaluate(element => { element.open = true; });
  await page.locator("#categories").fill("Places, Life");
  const photoBytes = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 2400; canvas.height = 1200;
    const context = canvas.getContext("2d");
    context.fillStyle = "#557766"; context.fillRect(0, 0, 2400, 1200);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator("#photo-picker").setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: Buffer.from(photoBytes, "base64") });
  await page.locator("#photo-alt-0").waitFor();
  await page.locator("#photo-alt-0").fill("Trees — café 🪴");
  assert.equal(await page.locator(".photo-preview img").evaluate(image => image.naturalWidth), 1600);
  await page.reload();
  await page.locator("#composer").waitFor({ state: "visible" });
  assert.equal(await page.locator("#categories").inputValue(), "Places, Life");
  assert.equal(await page.locator("#photo-alt-0").inputValue(), "Trees — café 🪴");
  await page.locator("#thought").fill("");
  githubMode = "error";
  await page.locator("#publish").click();
  await waitMessage(page, "No note was created");
  assert.equal(await page.locator(".photo-preview img").count(), 1);
  githubMode = "success";
  await page.locator("#publish").click();
  await waitMessage(page, "Saved.");
  assert.equal(await page.locator(".photo-preview img").count(), 0);
  assert.equal(await page.locator("#categories").inputValue(), "");
  const photoNote = Buffer.from(commits.at(-1).content, "base64").toString();
  assert.match(photoNote, /categories: \["places", "life"\]/);
  assert.match(photoNote, /!\[Trees — café 🪴\]\(https:\/\/yasharma.com\/notes-media\//);
  assert.equal(Buffer.from(commits.at(-2).content, "base64")[0], 255);

  // Keep a draft preview visible during narrow-screen and dark-mode checks.
  await page.locator("#photo-picker").setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: Buffer.from(photoBytes, "base64") });
  await page.locator("#photo-alt-0").waitFor();

  for (const width of [320, 390, 1280]) for (const colorScheme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme });
    await page.locator("#thought").fill("A small thing I want to remember.\n\nPay attention to what makes you curious.");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}/${colorScheme}`);
    assert.ok(await page.locator("#publish").isVisible());
    if (process.env.SCREENSHOT_DIR) {
      await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/composer-${width}-${colorScheme}.png`, fullPage: true });
    }
  }
  assert.deepEqual(errors, []);
  await ctx.close();

  const restricted = await context();
  await restricted.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException("blocked", "SecurityError"); }; });
  const other = await restricted.newPage();
  await other.goto(origin);
  await signIn(other);
  await other.locator("#thought").fill("A draft in memory");
  assert.match(await other.locator("#draft-status").textContent(), /saving is unavailable/);
  await other.locator("#publish").click();
  await waitMessage(other, "Saved.");
  await restricted.close();
  if (process.env.SITE_PREVIEW_DIR) {
    const site = await browser.newContext();
    await site.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== "https://yasharma.com") return route.abort();
      const file = join(process.env.SITE_PREVIEW_DIR, url.pathname + (url.pathname.endsWith("/") ? "index.html" : ""));
      try {
        await route.fulfill({ body: await readFile(file), contentType: { ".html": "text/html", ".css": "text/css", ".jpg": "image/jpeg", ".png": "image/png" }[extname(file)] || "application/octet-stream" });
      } catch { await route.fulfill({ status: 404, body: "Missing fixture file" }); }
    });
    const feed = await site.newPage();
    for (const width of [320, 1280]) for (const colorScheme of ["light", "dark"]) {
      await feed.setViewportSize({ width, height: 900 });
      await feed.emulateMedia({ colorScheme });
      await feed.goto("https://yasharma.com/notes/");
      assert.ok(await feed.locator(".notes-day").count());
      assert.equal(await feed.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await feed.goto("https://yasharma.com/categories/fixture-places/");
      await feed.locator(".note-content img").scrollIntoViewIfNeeded();
      await feed.waitForFunction(() => { const image = document.querySelector(".note-content img"); return image.complete && image.naturalWidth > 0; });
      assert.equal(await feed.locator(".note-content img").evaluate(image => image.complete && image.naturalWidth > 0), true);
      assert.equal(await feed.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (process.env.SCREENSHOT_DIR) await feed.screenshot({ path: `${process.env.SCREENSHOT_DIR}/feed-${width}-${colorScheme}.png`, fullPage: true });
    }
    await site.close();
  }
  console.log("PASS: sign-in/out, HttpOnly sessions, text/photo/category draft reload, Unicode, note/link/photo publishing, resizing, upload failure/expiry recovery, no duplicate submits, offline draft, storage failure, and 6 light/dark viewport checks. No real GitHub writes.");
} finally { await browser.close(); }
