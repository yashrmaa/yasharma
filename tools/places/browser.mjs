// Run against a disposable Chrome profile and a running Hugo preview.
// No browser automation package is required: Node speaks Chrome's DevTools API.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const preview = process.env.PLACES_PREVIEW_URL || "http://127.0.0.1:1314/places/";
const debug = process.env.CHROME_DEBUG_URL || "http://127.0.0.1:9233";
const tabs = await (await fetch(`${debug}/json/list`)).json();
const tab = tabs.find(tab => tab.type === "page");
if (!tab) throw new Error("Open a blank tab in a disposable Chrome debugging profile first.");
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
let id = 0;
const pending = new Map();
const runtimeErrors = [];
const networkFailures = [];
const requests = new Map();
ws.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params.exceptionDetails.text);
  if (message.method === "Network.requestWillBeSent") requests.set(message.params.requestId, message.params.request.url);
  if (message.method === "Network.loadingFailed") networkFailures.push({ url: requests.get(message.params.requestId), error: message.params.errorText });
  if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const next = ++id;
  const timer = setTimeout(() => { pending.delete(next); reject(new Error(`Timed out: ${method}`)); }, 15000);
  pending.set(next, result => { clearTimeout(timer); result.error ? reject(new Error(JSON.stringify(result.error))) : resolve(result.result); });
  ws.send(JSON.stringify({ id: next, method, params }));
});
const evaluate = async expression => {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async expression => {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await evaluate(expression)) return;
    await pause(100);
  }
  throw new Error(`Condition did not become true: ${expression}`);
};
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const screenshot = async name => {
  const result = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(tmpdir(), `places-${name}.png`), Buffer.from(result.data, "base64"));
};
const visibleCards = () => evaluate('[...document.querySelectorAll("[data-place]")].filter(card => !card.hidden).map(card => card.dataset.place)');
const key = async value => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: value, code: value, windowsVirtualKeyCode: value === "Escape" ? 27 : 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: value, code: value, windowsVirtualKeyCode: value === "Escape" ? 27 : 13 });
};
const navigate = async url => {
  await send("Page.navigate", { url });
  await until('document.querySelector("[data-js-control]") && !document.querySelector("[data-js-control]").hidden');
};
try {
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await navigate(preview);
  const catalog = await evaluate('fetch(document.querySelector("[data-source]").dataset.source).then(response => response.json())');
  const initialPlaceIDs = catalog.map(place => place.id);
  const sanFranciscoIDs = catalog.filter(place => place.city === "San Francisco").map(place => place.id);
  const newYorkIDs = catalog.filter(place => place.city === "New York").map(place => place.id);
  await until('[...document.querySelectorAll(".place-photo img")].every(image => image.naturalWidth > 0)');
  assert.deepEqual(await visibleCards(), initialPlaceIDs);
  assert.equal(await evaluate('document.querySelectorAll(".place-map-marker").length'), initialPlaceIDs.length);
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  await pause(1200);
  const loadedTiles = await evaluate('document.querySelectorAll(".leaflet-tile-loaded").length');
  await screenshot("desktop");

  await click('[data-city="San Francisco"]');
  assert.deepEqual(await visibleCards(), sanFranciscoIDs);
  assert.equal(await evaluate('document.querySelectorAll(".place-map-marker").length'), sanFranciscoIDs.length);
  await click('[data-city="New York"]');
  assert.deepEqual(await visibleCards(), newYorkIDs);
  await evaluate("history.back()");
  await until(`document.querySelector('[data-city="San Francisco"]').getAttribute("aria-pressed") === "true"`);
  assert.deepEqual(await visibleCards(), sanFranciscoIDs);
  await evaluate('document.querySelector("#places-status").value = "saved"; document.querySelector("#places-status").dispatchEvent(new Event("change", {bubbles:true}))');
  assert.deepEqual(await visibleCards(), catalog.filter(place => place.city === "San Francisco" && place.status === "saved").map(place => place.id));
  await evaluate('document.querySelector("#places-search").value = "no-such-place-browser-fixture"; document.querySelector("#places-search").dispatchEvent(new Event("input", {bubbles:true}))');
  await until('!document.querySelector("#places-empty").hidden');
  assert.deepEqual(await visibleCards(), []);
  assert.equal(await evaluate('document.querySelector("#places-empty").hidden'), false);
  assert.equal(await evaluate('document.querySelector("[data-random]").disabled'), true);
  await click("[data-reset]");
  await evaluate('document.querySelector("#places-search").value = "Another recommendation for the coffee curious"; document.querySelector("#places-search").dispatchEvent(new Event("input", {bubbles:true}))');
  await until(`document.querySelector("#places-count").textContent === "1 place of ${initialPlaceIDs.length}"`);
  assert.deepEqual(await visibleCards(), ["fellini-coffee"]);
  await click('[data-select="fellini-coffee"]');
  assert.match(await evaluate('document.querySelector("#place-map-detail").textContent'), /City-level pin/);
  assert.equal(await evaluate('new URL(location.href).searchParams.get("place")'), "fellini-coffee");
  await screenshot("selected");
  await key("Escape");
  assert.equal(await evaluate('document.querySelector("#place-map-detail").hidden'), true);
  assert.equal(await evaluate('document.activeElement.dataset.select'), "fellini-coffee");
  await click("[data-reset]");
  await click('[data-photo="bello-coffee"]');
  assert.equal(await evaluate('document.querySelector("#places-photo-dialog").open'), true);
  await until('document.querySelector("#places-dialog-image").naturalWidth > 0');
  assert.match(await evaluate('document.querySelector("#places-photo-source").href'), /\/notes\//);
  await key("Escape");
  assert.equal(await evaluate('document.querySelector("#places-photo-dialog").open'), false);

  await click('.place-map-marker');
  assert.match(await evaluate('document.querySelector("#place-map-detail h3").textContent'), /Bello/);
  await send("Browser.grantPermissions", { origin: new URL(preview).origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  await click("[data-share]");
  await until('document.querySelector("[data-share]").textContent.includes("copied")');
  assert.equal(await evaluate("navigator.clipboard.readText()"), await evaluate("location.href"));
  const selectedURL = await evaluate("location.href");
  await navigate(selectedURL);
  await until('!document.querySelector("#place-map-detail").hidden');
  assert.match(await evaluate('document.querySelector("#place-map-detail h3").textContent'), /Bello/);
  await click("[data-random]");
  const randomPlace = await evaluate('new URL(location.href).searchParams.get("place")');
  assert.notEqual(randomPlace, "bello-coffee", "random choice should choose a different result when possible");
  assert.ok(initialPlaceIDs.includes(randomPlace));
  await click("[data-fit]");
  assert.equal(await evaluate('document.querySelector("#place-map-detail").hidden'), true);

  for (const width of [390, 320, 768]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: true });
    await pause(150);
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, `overflow at ${width}px`);
    await click('[data-select="bello-coffee"]');
    assert.equal(await evaluate('document.querySelector("#place-map-detail").hidden'), false);
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
    await click(".place-detail-close");
  }
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await click("[data-fit]");
  await pause(800);
  assert.equal(await evaluate(`(() => {
    const bounds = document.querySelector("#places-map").getBoundingClientRect();
    return [...document.querySelectorAll(".place-map-marker")].every(marker => {
      const pin = marker.getBoundingClientRect();
      return pin.left >= bounds.left && pin.right <= bounds.right && pin.top >= bounds.top && pin.bottom <= bounds.bottom;
    });
  })()`), true, "the mobile overview should fit every pin across all cities");
  await evaluate('document.body.classList.remove("dark"); window.scrollTo(0,0)');
  await screenshot("mobile");
  await evaluate('document.body.classList.add("dark"); window.scrollTo(0,0)');
  await screenshot("dark-mobile");

  await send("Network.setBlockedURLs", { urls: ["*tile.openstreetmap.org*"] });
  await navigate(preview);
  await until('document.querySelector("#places-map-message").hasAttribute("data-error")');
  await click('[data-select="bello-coffee"]');
  assert.equal(await evaluate('document.querySelector("#place-map-detail").hidden'), false, "selection works without map tiles");
  await send("Network.setBlockedURLs", { urls: [] });

  await send("Emulation.setScriptExecutionDisabled", { value: true });
  await send("Page.navigate", { url: preview });
  await pause(600);
  const withoutJS = await send("DOM.getDocument", { depth: 0 });
  const html = await send("DOM.getOuterHTML", { nodeId: withoutJS.root.nodeId });
  assert.match(html.outerHTML, /fantastic light roast/);
  assert.match(html.outerHTML, /Open in Google Maps/);
  assert.match(html.outerHTML, /Turn on JavaScript/);
  await send("Emulation.setScriptExecutionDisabled", { value: false });
  await navigate(preview);
  assert.deepEqual(runtimeErrors, []);
  console.log(JSON.stringify({ result: "PASS", checks: ["city and note search", "empty state", "markers and cards", "approximate locations", "Escape and photo viewer", "share clipboard", "direct links and Back", "random pick", "320/390/768px layouts", "dark theme", "tile failure", "no JavaScript"], loadedTiles, networkFailures: networkFailures.slice(0, 3), screenshots: join(tmpdir(), "places-*.png") }, null, 2));
} finally {
  await send("Emulation.setScriptExecutionDisabled", { value: false }).catch(() => {});
  await send("Network.setBlockedURLs", { urls: [] }).catch(() => {});
  ws.close();
}
