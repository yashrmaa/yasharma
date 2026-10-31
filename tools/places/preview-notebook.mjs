// An explicit local-only preview: the real publisher runs against an in-memory
// GitHub fixture, then Hugo renders an isolated temporary copy of the site.
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, extname, resolve } from "node:path";
import { createPublisher } from "../note-publisher/src/worker.mjs";
import { newSession } from "../note-publisher/src/session.mjs";
import { placeRepository } from "../note-publisher/test/places-repository.mjs";

const root = new URL("../../", import.meta.url);
const port = Number(process.env.NOTEBOOK_PREVIEW_PORT || 8788);
const origin = `http://localhost:${port}`;
const workerOrigin = "https://notebook.preview.test";
const temp = await mkdtemp(join(tmpdir(), "notebook-places-preview-"));
const output = join(temp, "public");
for (const name of ["content", "layouts", "assets", "static", "themes", "data"]) await cp(new URL(name, root), join(temp, name), { recursive: true });
await cp(new URL("config.yml", root), join(temp, "config.yml"));
const repo = placeRepository(JSON.parse(await readFile(new URL("data/places.json", root), "utf8")));
const secret = "local-preview-only-".repeat(3);
const session = (await newSession(secret, workerOrigin, new Date())).split(";")[0];
const type = path => ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".xml": "application/xml", ".webmanifest": "application/manifest+json" }[extname(path)] || "application/octet-stream");
function build() { execFileSync(process.env.HUGO_BIN || "hugo", ["--source", temp, "--destination", output, "--baseURL", `${origin}/`, "--cacheDir", join(temp, "cache"), "--minify"], { stdio: "pipe" }); }
build();
const worker = createPublisher({
  fetch: repo.fetch,
  ...(process.env.PREVIEW_FAKE_SEARCH === "1" ? { geocodeFetch: async () => Response.json({ features: [{ properties: { name: "Preview Cafe", city: "San Francisco", street: "Market Street", housenumber: "100", osm_type: "N", osm_id: 100000001, osm_key: "amenity", osm_value: "cafe" }, geometry: { coordinates: [-122.4, 37.79] } }] }) } : {}),
});
const env = {
  PUBLISH_SECRET: secret, GITHUB_TOKEN: "local-preview-no-github-access", GITHUB_OWNER: "preview", GITHUB_REPO: "preview", GITHUB_BRANCH: "main", SITE_URL: "https://yasharma.com",
  ASSETS: { fetch: async request => {
    const file = new URL(request.url).pathname === "/" ? "index.html" : new URL(request.url).pathname.slice(1);
    let body = await readFile(new URL(`tools/note-publisher/public/${file}`, root));
    if (file === "index.html") body = Buffer.from(body.toString().replace("<main>", '<main><p class="preview-notice">Local preview · Try saving a place here. Changes stay in this preview.</p>'));
    return new Response(body, { headers: { "Content-Type": type(file) } });
  } },
};
let sync = Promise.resolve();
const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url, origin);
    const app = ["/", "/session", "/publish", "/places", "/places/search", "/composer.js", "/place-input.js", "/photo-input.js", "/composer.css", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"].includes(url.pathname);
    if (app) {
      const chunks = [];
      let length = 0;
      for await (const chunk of incoming) { length += chunk.length; if (length > 2 * 1024 * 1024) { outgoing.writeHead(413).end(); return; } chunks.push(chunk); }
      const headers = new Headers(incoming.headers);
      headers.set("Cookie", session);
      if (headers.get("Origin") === origin || headers.get("Origin") === `http://127.0.0.1:${port}`) headers.set("Origin", workerOrigin);
      const request = new Request(workerOrigin + url.pathname + url.search, { method: incoming.method, headers, ...(!["GET", "HEAD"].includes(incoming.method) ? { body: Buffer.concat(chunks) } : {}) });
      const response = await worker.fetch(request, env);
      if (url.pathname === "/publish" && response.status === 201) {
        sync = sync.then(async () => {
          for (const [file, content] of repo.files()) {
            if (!["data/places.json"].includes(file) && !file.startsWith("content/notes/") && !file.startsWith("static/notes-media/")) throw new Error("Unexpected preview file");
            const destination = resolve(temp, file);
            if (!destination.startsWith(temp + "/")) throw new Error("Invalid preview path");
            await mkdir(dirname(destination), { recursive: true });
            await writeFile(destination, content);
          }
          build();
        });
        await sync;
      }
      const responseHeaders = Object.fromEntries(response.headers);
      delete responseHeaders["set-cookie"];
      let body = Buffer.from(await response.arrayBuffer());
      if (responseHeaders["content-type"]?.startsWith("application/json")) {
        const json = JSON.parse(body.toString());
        if (json.site_url) json.site_url = origin;
        if (json.url?.startsWith("https://yasharma.com/")) json.url = json.url.replace("https://yasharma.com", origin);
        body = Buffer.from(JSON.stringify(json));
      }
      outgoing.writeHead(response.status, responseHeaders).end(body);
      return;
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") + (url.pathname.endsWith("/") ? "index.html" : "");
    const file = resolve(output, relative);
    if (!file.startsWith(output + "/")) { outgoing.writeHead(403).end(); return; }
    const body = await readFile(file);
    outgoing.writeHead(200, { "Content-Type": type(file), "Cache-Control": "no-store" }).end(body);
  } catch { outgoing.writeHead(500, { "Content-Type": "text/plain" }).end("Preview request failed. No live data was changed."); }
});
server.listen(port, "127.0.0.1", () => console.log(`Notebook preview: ${origin}/\nMap preview: ${origin}/places/\nSaves update only the isolated preview, never GitHub or your working files.`));
async function stop() { server.closeAllConnections(); server.close(); await rm(temp, { recursive: true, force: true }); process.exit(0); }
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
