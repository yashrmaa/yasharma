import { cookie, newSession, hasSession, sameOrigin, SECURITY_HEADERS } from "./session.mjs";
import { validatePhotos } from "./photos.mjs";

const ASSET_PATHS = new Set(["/", "/composer.js", "/photo-input.js", "/composer.css", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"]);
const MAX_BYTES = 32 * 1024;
const encoder = new TextEncoder();

class PublishError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}

function json(status, value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

async function authorized(request, secret) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ") || header.length > 1024) return false;
  const hashes = await Promise.all([header.slice(7), secret].map(async (value) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))));
  let difference = 0;
  for (let i = 0; i < 32; i++) difference |= hashes[0][i] ^ hashes[1][i];
  return difference === 0;
}

async function readJSON(request, maxBytes = MAX_BYTES) {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new PublishError(415, "invalid_content_type", "Use Content-Type: application/json.");
  }
  if (Number(request.headers.get("Content-Length")) > maxBytes) {
    throw new PublishError(413, "request_too_large", "Request exceeds the upload limit.");
  }
  // Bound actual bytes even when Content-Length is absent or dishonest.
  const reader = request.body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new PublishError(413, "request_too_large", "Request exceeds the upload limit.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PublishError(400, "invalid_json", "Send a valid UTF-8 JSON object.");
  }
  if (encoder.encode(JSON.stringify({ ...value, photos: undefined })).length > MAX_BYTES) throw new PublishError(413, "request_too_large", "Text and metadata exceed 32 KiB.");
  return value;
}

function field(input, name, max) {
  const value = input[name] === undefined ? "" : input[name];
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF]/u.test(value)) {
    throw new PublishError(400, "invalid_field", `${name} must be text of at most ${max} characters, without invalid control characters.`);
  }
  return value.replace(/\r\n?/g, "\n").trim();
}

function validate(input, siteURL) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PublishError(400, "invalid_input", "Send a JSON object.");
  }
  if (Object.keys(input).some(key => !["kind", "url", "title", "text", "categories", "photos"].includes(key))) {
    throw new PublishError(400, "unknown_field", "Only kind, url, title, text, categories, and photos are accepted.");
  }
  if (!["link", "note"].includes(input.kind)) {
    throw new PublishError(400, "invalid_kind", "kind must be link or note.");
  }
  const text = field(input, "text", 10000);
  let title = field(input, "title", 300);
  const rawURL = field(input, "url", 4096);
  const categories = input.categories === undefined ? [] : input.categories;
  if (!Array.isArray(categories) || categories.length > 8 || categories.some(category => typeof category !== "string" || !/^[\p{L}\p{N}][\p{L}\p{M}\p{N} &+_-]{0,39}$/u.test(category.trim()))) {
    throw new PublishError(400, "invalid_categories", "Use up to 8 categories, each 1–40 letters/numbers, spaces, &, +, underscores or hyphens.");
  }
  let photos;
  try { photos = validatePhotos(input.photos); } catch (error) { throw new PublishError(400, "invalid_photos", error.message); }
  let url;
  if (input.kind === "link") {
    try {
      // Require an explicit scheme; reject credentials and links back to this site.
      if (!/^https?:\/\//i.test(rawURL) || /\s/.test(rawURL)) throw new Error();
      url = new URL(rawURL);
      const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
      const ownHost = new URL(siteURL).hostname.replace(/^www\./, "");
      if (!url.hostname || url.username || url.password || host === ownHost || host === "localhost" || host.endsWith(".localhost")) throw new Error();
    } catch {
      throw new PublishError(400, "invalid_url", "Supply an external http:// or https:// URL without credentials or spaces.");
    }
    title ||= url.hostname;
  } else if ((!text && !photos.length) || rawURL) {
    throw new PublishError(400, "invalid_note", "A note needs text or a photo and must not include a URL field. Put any links in the text.");
  }
  return { kind: input.kind, text, title, url: url?.href, photos, categories: [...new Set(categories.map(value => value.trim().toLowerCase()))] };
}

// JSON strings are valid YAML quoted scalars. Escape YAML's extra line breaks too.
function yamlString(value) {
  return JSON.stringify(value).replace(/[\u0085\u2028\u2029]/g, char =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function markdown(entry, date) {
  const lines = ["---", `date: ${yamlString(date)}`, `kind: ${entry.kind}`];
  if (entry.title) lines.push(`title: ${yamlString(entry.title)}`);
  if (entry.url) lines.push(`source_url: ${yamlString(entry.url)}`);
  if (entry.categories?.length) lines.push(`categories: [${entry.categories.map(yamlString).join(", ")}]`);
  lines.push("draft: false", "---", "");
  // Hugo's safe Markdown renderer handles raw HTML and unsafe URLs. Keep the
  // Markdown source intact, but never let API text invoke trusted shortcodes.
  const text = entry.text.replace(/{{(?=[<%])/g, "&#123;&#123;");
  const photos = (entry.photos || []).filter(photo => photo.url).map(photo => {
    const alt = (photo.alt || "").replace(/[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/g, "\\$&");
    return `![${alt}](${photo.url})`;
  }).join("\n\n");
  return `${lines.join("\n")}\n${text}\n${photos ? `\n${photos}\n` : ""}`;
}

function config(env) {
  if (!env.GITHUB_TOKEN || !/^[A-Za-z0-9_-]{32,256}$/.test(env.PUBLISH_SECRET || "") ||
      !/^[A-Za-z0-9_-]+$/.test(env.GITHUB_OWNER || "") ||
      !/^[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPO || "") || !env.GITHUB_BRANCH) {
    throw new PublishError(503, "not_configured", "Publisher secrets or repository settings are missing or invalid.");
  }
  let site;
  try { site = new URL(env.SITE_URL); } catch { /* checked below */ }
  if (!site || site.protocol !== "https:" || site.username || site.password || site.pathname !== "/" || site.search || site.hash) {
    throw new PublishError(503, "not_configured", "SITE_URL must be an HTTPS site origin.");
  }
  return site.origin;
}

// workerd requires the global receiver for fetch; an extracted, unbound reference
// throws "Illegal invocation" before sending anything to GitHub.
export function createPublisher({ fetch: githubFetch = (url, options) => globalThis.fetch(url, options), now = () => new Date(), uuid = () => crypto.randomUUID(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  return {
    async fetch(request, env) {
      try {
        const endpoint = new URL(request.url);
        if (endpoint.protocol !== "https:") throw new PublishError(400, "https_required", "Use HTTPS.");
        if (ASSET_PATHS.has(endpoint.pathname) && ["GET", "HEAD"].includes(request.method)) {
          if (!env.ASSETS) throw new PublishError(503, "not_configured", "Composer assets have not been deployed.");
          const asset = await env.ASSETS.fetch(request);
          const response = new Response(asset.body, asset);
          for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
          return response;
        }
        if (endpoint.pathname === "/session" && !endpoint.search) {
          const site = config(env);
          if (request.method === "GET") {
            return json(200, {
              ok: true, authenticated: await hasSession(request, env.PUBLISH_SECRET, now()),
              site_url: site,
              actions_url: `https://github.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/hugo.yaml`,
            });
          }
          if (!["POST", "DELETE"].includes(request.method)) return json(405, { ok: false, error: { code: "method_not_allowed", message: "Use GET, POST, or DELETE." } }, { Allow: "GET, POST, DELETE" });
          if (!sameOrigin(request)) throw new PublishError(403, "invalid_origin", "Open the composer directly to sign in or out.");
          if (request.method === "DELETE") return json(200, { ok: true }, { "Set-Cookie": cookie("", 0) });
          if (!await authorized(request, env.PUBLISH_SECRET)) throw new PublishError(401, "unauthorized", "Incorrect publishing secret.");
          await readJSON(request);
          return json(200, { ok: true }, { "Set-Cookie": await newSession(env.PUBLISH_SECRET, endpoint.origin, now()) });
        }
        if (endpoint.pathname !== "/publish" || endpoint.search) throw new PublishError(404, "not_found", "Use /publish.");
        if (request.method !== "POST") return json(405, { ok: false, error: { code: "method_not_allowed", message: "Use POST." } }, { Allow: "POST" });
        const site = config(env);
        // Cookie-authenticated writes need an exact Origin match. Existing bearer
        // API clients remain supported, without adding cross-origin browser access.
        if (request.headers.has("Origin") && !sameOrigin(request)) throw new PublishError(403, "invalid_origin", "Publish from the composer on this site.");
        if (request.headers.has("Authorization")) {
          if (!await authorized(request, env.PUBLISH_SECRET)) throw new PublishError(401, "unauthorized", "Invalid publishing secret.");
        } else {
          if (!await hasSession(request, env.PUBLISH_SECRET, now())) throw new PublishError(401, "unauthorized", "Sign in again to publish. Your draft is kept on this device.");
          if (!sameOrigin(request)) throw new PublishError(403, "invalid_origin", "Publish from the composer on this site.");
        }
        const entry = validate(await readJSON(request, 2 * 1024 * 1024), site);
        const date = now().toISOString();
        const headers = {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2026-03-10",
          "User-Agent": "yasharma-note-publisher",
        };
        // Upload photos before creating the note. Failures can leave unreferenced
        // photos, but never a published note pointing to a missing upload.
        for (const photo of entry.photos) {
          const path = `static/notes-media/${date.slice(0, 10)}-${uuid()}.jpg`;
          let confirmed = false;
          try {
            const uploaded = await githubFetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`, {
              method: "PUT", headers, redirect: "manual", signal: AbortSignal.timeout(15000),
              body: JSON.stringify({ message: "Add notebook photo [skip ci]", content: photo.data, branch: env.GITHUB_BRANCH }),
            });
            if (uploaded.status === 201) {
              const result = await uploaded.json();
              confirmed = !!result?.commit?.sha && result?.content?.path === path;
            }
          } catch { /* No note write has been attempted yet. */ }
          if (!confirmed) throw new PublishError(502, "photo_upload_failed", "Photo upload failed. No note was created. Your draft is safe to retry; an unused photo may remain in the repository.");
          photo.url = `${site}/${path.slice("static/".length)}`;
        }
        const document = markdown(entry, date);
        const content = btoa(String.fromCharCode(...encoder.encode(document)));
        for (let attempt = 0; attempt < 3; attempt++) {
          const id = `${date.slice(0, 10)}-${uuid()}`;
          const path = `content/notes/${id}.md`;
          const websiteURL = `${site}/notes/${id}/`;
          const api = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
          let response;
          try {
            response = await githubFetch(api, {
              // workerd supports manual/follow, not the browser's "error" mode.
              // Manual mode keeps the token on api.github.com; 3xx is a failure.
              method: "PUT", headers, redirect: "manual", signal: AbortSignal.timeout(15000),
              // Omitting sha makes this create-only: existing files cannot be overwritten.
              body: JSON.stringify({ message: `Add ${entry.kind} ${id}`, content, branch: env.GITHUB_BRANCH }),
            });
          } catch {
            // A lost response can follow a successful commit. Never retry blindly.
            throw new PublishError(502, "commit_unknown", "GitHub did not confirm the write. Check the repository or Notes before trying again; it may have committed.", { status: "unknown", path, url: websiteURL });
          }
          if (response.status === 201) {
            let result;
            try { result = await response.json(); } catch { /* unconfirmed below */ }
            if (!result?.commit?.sha || result?.content?.path !== path) {
              throw new PublishError(502, "commit_unknown", "GitHub returned an incomplete confirmation. Check Notes before retrying.", { status: "unknown", path, url: websiteURL });
            }
            return json(201, {
              ok: true, status: "committed", live: false,
              message: "Saved to your repository. The site will update after deployment.",
              url: websiteURL, path, commit_sha: result.commit.sha,
            });
          }
          if (response.status === 409 || response.status === 422) {
            // Determine whether this is a filename collision (422 also means
            // validation/rate limits). Only retry 422 when the file exists.
            let existing;
            try {
              existing = await githubFetch(`${api}?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`, {
                headers, redirect: "manual", signal: AbortSignal.timeout(10000),
              });
            } catch { /* fall through to visible GitHub failure */ }
            if (attempt < 2 && (existing?.status === 200 || (response.status === 409 && existing?.status === 404))) {
              await sleep(150 * (attempt + 1));
              continue;
            }
          }
          // No upstream response bodies or authorization values are exposed/logged.
          throw new PublishError(502, "github_error", "GitHub rejected the write. Check token permissions, expiry, branch rules, and API limits.", { github_status: response.status });
        }
      } catch (error) {
        if (error instanceof PublishError) {
          return json(error.status, { ok: false, error: { code: error.code, message: error.message }, ...error.details });
        }
        return json(500, { ok: false, error: { code: "internal_error", message: "Publishing failed unexpectedly. Check Notes before retrying." } });
      }
    },
  };
}

export default createPublisher();
