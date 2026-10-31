const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const CATALOG = "data/places.json";

export class PublishError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}

function text(input, key, max, required = false) {
  const value = input[key] ?? "";
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value) || (required && !value.trim())) {
    throw new PublishError(400, "invalid_place", `Enter a valid ${key} for the place.`);
  }
  return value.trim();
}

export function validatePlace(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PublishError(400, "invalid_place", "Choose a place or add its location first.");
  const allowed = ["id", "revision", "name", "category", "status", "city", "neighborhood", "address", "coordinates", "precision", "locationSource"];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new PublishError(400, "invalid_place", "Unknown place field.");
  const id = text(input, "id", 100);
  const revision = text(input, "revision", 64);
  if ((id && !/^[a-z0-9][a-z0-9-]*$/.test(id)) || (id && !/^[a-f0-9]{64}$/.test(revision)) || (!id && revision)) throw new PublishError(400, "invalid_place", "Reload your places before editing this entry.");
  if (!["liked", "saved", "mentioned"].includes(input.status)) throw new PublishError(400, "invalid_place", "Choose liked, saved for later, or mentioned.");
  if (!Array.isArray(input.coordinates) || input.coordinates.length !== 2 || !input.coordinates.every(Number.isFinite) || Math.abs(input.coordinates[0]) > 90 || Math.abs(input.coordinates[1]) > 180) throw new PublishError(400, "invalid_place", "Choose a location from search or enter valid latitude and longitude.");
  if (!["address", "city"].includes(input.precision)) throw new PublishError(400, "invalid_place", "Choose an exact or approximate location.");
  const locationSource = text(input, "locationSource", 2048);
  if (locationSource) {
    try { const source = new URL(locationSource); if (source.protocol !== "https:" || source.username || source.password) throw new Error(); }
    catch { throw new PublishError(400, "invalid_place", "Use a valid HTTPS location source."); }
  }
  return { id, revision, name: text(input, "name", 200, true), category: text(input, "category", 60, true), status: input.status, city: text(input, "city", 120, true), neighborhood: text(input, "neighborhood", 120), address: text(input, "address", 400, true), coordinates: input.coordinates, precision: input.precision, locationSource };
}

// Bound upstream bodies as well as browser inputs; never expose their contents
// or GitHub authorization values in errors or logs.
async function readResponse(response) {
  if (Number(response.headers.get("Content-Length")) > 2 * 1024 * 1024) throw new PublishError(502, "upstream_error", "The places response was too large.");
  const reader = response.body?.getReader();
  if (!reader) throw new PublishError(502, "upstream_error", "Places could not be loaded.");
  const chunks = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 2 * 1024 * 1024) { await reader.cancel(); throw new PublishError(502, "upstream_error", "The places response was too large."); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(decoder.decode(bytes)); }
  catch { throw new PublishError(502, "upstream_error", "Places could not be read. Try again shortly."); }
}

export function githubHeaders(env) {
  return { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "yasharma-note-publisher" };
}

function githubAPI(env, githubFetch) {
  const base = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  return async (path, { method = "GET", body, allowMissing = false, allowConflict = false, committing = false } = {}) => {
    let response;
    try {
      response = await githubFetch(base + path, { method, headers: githubHeaders(env), redirect: "manual", signal: AbortSignal.timeout(15000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch {
      throw new PublishError(502, committing ? "commit_unknown" : "github_error", committing ? "The save wasn't confirmed. Check your places before trying again." : "GitHub could not be reached. No place was saved.", committing ? { status: "unknown" } : {});
    }
    if (allowMissing && response.status === 404) return null;
    if (allowConflict && [409, 422].includes(response.status)) return null;
    if (!response.ok) {
      if (committing && response.status >= 500) throw new PublishError(502, "commit_unknown", "The save wasn't confirmed. Check your places before trying again.", { status: "unknown" });
      throw new PublishError(502, "github_error", "GitHub rejected the request. Check your connection and publishing access.", { github_status: response.status });
    }
    try { return await readResponse(response); }
    catch (error) {
      if (committing) throw new PublishError(502, "commit_unknown", "The save wasn't confirmed. Check your places before trying again.", { status: "unknown" });
      throw error;
    }
  };
}

async function catalogAt(api, ref) {
  const result = await api(`/contents/${CATALOG}?ref=${encodeURIComponent(ref)}`, { allowMissing: true });
  if (!result) return [];
  try {
    if (result.encoding !== "base64" || typeof result.content !== "string") throw new Error();
    const bytes = Uint8Array.from(atob(result.content.replace(/\s/g, "")), char => char.charCodeAt(0));
    const catalog = JSON.parse(decoder.decode(bytes));
    if (!Array.isArray(catalog) || catalog.length > 2000 || catalog.some(place => !place || typeof place.id !== "string") || new Set(catalog.map(place => place.id)).size !== catalog.length) throw new Error();
    return catalog;
  } catch { throw new PublishError(502, "catalog_invalid", "Your places file couldn't be read safely. It has not been changed."); }
}

export async function placeRevision(place) {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(place)));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function listPlaces(env, githubFetch) {
  const catalog = await catalogAt(githubAPI(env, githubFetch), env.GITHUB_BRANCH);
  return Promise.all(catalog.filter(place => !place.draft).map(async place => ({ ...place, revision: await placeRevision(place) })));
}

export async function searchPlaces(query, geocodeFetch, endpoint = "https://photon.komoot.io/api/") {
  if (typeof query !== "string" || query.trim().length < 3 || query.length > 200 || /[\u0000-\u001f\u007f]/.test(query)) throw new PublishError(400, "invalid_search", "Search for a place name and city (at least 3 characters).");
  let url;
  try { url = new URL(endpoint); if (url.protocol !== "https:" || url.username || url.password) throw new Error(); }
  catch { throw new PublishError(503, "not_configured", "Place search is unavailable. You can still edit saved places or add a location manually."); }
  url.searchParams.set("q", query.trim());
  url.searchParams.set("limit", "6");
  url.searchParams.set("lang", "en");
  let result;
  try {
    const response = await geocodeFetch(url.href, { redirect: "manual", headers: { Accept: "application/json", "User-Agent": "YasharmaNotebook/1.0 (+https://yasharma.com/places/)" }, signal: AbortSignal.timeout(10000), cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!response.ok) throw new Error();
    result = await readResponse(response);
  } catch { throw new PublishError(502, "search_unavailable", "Place search is unavailable. Try again, choose a saved place, or add its location manually."); }
  if (!Array.isArray(result.features)) throw new PublishError(502, "search_unavailable", "Place search returned no usable results. Try a more specific name or add the location manually.");
  return result.features.slice(0, 6).flatMap(feature => {
    const p = feature.properties || {};
    const coordinates = feature.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length !== 2 || !coordinates.every(Number.isFinite) || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) return [];
    const city = p.city || p.town || p.village || p.district || p.state || p.country || "";
    const address = [p.housenumber, p.street, p.postcode, city, p.country].filter(Boolean).join(" ");
    const type = { N: "node", W: "way", R: "relation" }[p.osm_type];
    return [{ name: String(p.name || p.street || city).slice(0, 200), city: String(city).slice(0, 120), neighborhood: String(p.suburb || p.locality || "").slice(0, 120), address: String(address || p.name || city).slice(0, 400), coordinates: [coordinates[1], coordinates[0]], precision: p.osm_key === "place" && p.osm_value !== "house" ? "city" : "address", locationSource: type && /^\d+$/.test(String(p.osm_id)) ? `https://www.openstreetmap.org/${type}/${p.osm_id}` : "" }];
  });
}

export async function savePlace({ entry, env, fetch: githubFetch, date, uuid, sleep, noteDocument }) {
  const api = githubAPI(env, githubFetch);
  const input = entry.place;
  const slug = input.name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "place";
  const id = input.id || `${slug}-${uuid().slice(0, 8)}`;
  const hasNote = Boolean(entry.text || entry.photos.length);
  const noteId = hasNote ? `${date.slice(0, 10)}-${uuid()}` : "";
  const notePath = hasNote ? `content/notes/${noteId}.md` : "";
  const url = hasNote ? `${env.SITE_URL}/notes/${noteId}/` : `${env.SITE_URL}/places/?place=${encodeURIComponent(id)}`;
  const photoTree = [];
  // Blobs don't become public until the final branch update publishes the tree.
  for (const photo of entry.photos) {
    const path = `static/notes-media/${date.slice(0, 10)}-${uuid()}.jpg`;
    const blob = await api("/git/blobs", { method: "POST", body: { content: photo.data, encoding: "base64" } });
    if (!blob.sha) throw new PublishError(502, "github_error", "Photo upload wasn't confirmed. No place or note was saved.");
    photoTree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
    photo.url = `${env.SITE_URL}/${path.slice("static/".length)}`;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await api(`/git/ref/heads/${encodeURIComponent(env.GITHUB_BRANCH)}`);
    if (!head.object?.sha) throw new PublishError(502, "github_error", "The repository branch could not be read.");
    const parent = await api(`/git/commits/${head.object.sha}`);
    if (!parent.tree?.sha) throw new PublishError(502, "github_error", "The repository tree could not be read.");
    const catalog = await catalogAt(api, head.object.sha);
    const existing = catalog.find(place => place.id === id);
    if (input.id && (!existing || existing.draft || await placeRevision(existing) !== input.revision)) throw new PublishError(409, "place_changed", "This place changed in another window. Reload your places and select it again before saving.");
    if ((!input.id && existing) || catalog.some(place => place.id !== id && ((input.locationSource && place.locationSource === input.locationSource) || (place.name?.toLowerCase() === input.name.toLowerCase() && place.coordinates?.every((n, i) => Math.abs(n - input.coordinates[i]) < .0001))))) throw new PublishError(409, "place_exists", "This place is already in your collection. Choose it under Saved places to update it.");
    const { revision, id: ignored, ...fields } = input;
    const place = { ...existing, ...fields, id, aliases: [...new Set([...(existing?.aliases || []), ...(existing ? [existing.name] : []), input.name])], updatedAt: date };
    if (place.precision === "city") place.locationNote = "Approximate location. This pin marks the area, rather than a confirmed street address.";
    else delete place.locationNote;
    if (existing) catalog[catalog.indexOf(existing)] = place; else catalog.push(place);
    const tree = [{ path: CATALOG, mode: "100644", type: "blob", content: `${JSON.stringify(catalog, null, 2)}\n` }, ...photoTree];
    if (hasNote) tree.push({ path: notePath, mode: "100644", type: "blob", content: noteDocument(id) });
    const created = await api("/git/trees", { method: "POST", body: { base_tree: parent.tree.sha, tree } });
    if (!created.sha) throw new PublishError(502, "github_error", "The save could not be prepared. No place was changed.");
    const commit = await api("/git/commits", { method: "POST", body: { message: `${existing ? "Update" : "Save"} place: ${input.name}${hasNote ? " with a note" : ""}`, tree: created.sha, parents: [head.object.sha] } });
    if (!commit.sha) throw new PublishError(502, "github_error", "The save could not be prepared. No place was changed.");
    const updated = await api(`/git/refs/heads/${encodeURIComponent(env.GITHUB_BRANCH)}`, { method: "PATCH", body: { sha: commit.sha, force: false }, allowConflict: true, committing: true });
    if (!updated) { if (attempt < 2) { await sleep(150 * (attempt + 1)); continue; } throw new PublishError(409, "place_changed", "Your collection is busy. Reload your places before saving again."); }
    if (updated.object?.sha !== commit.sha) throw new PublishError(502, "commit_unknown", "The save wasn't confirmed. Check your places before trying again.", { status: "unknown", url });
    return { ok: true, status: "committed", live: false, url, path: notePath || CATALOG, commit_sha: commit.sha, place_id: id, has_note: hasNote, place: { ...place, revision: await placeRevision(place) }, message: "Saved to your repository. Your map will update after deployment." };
  }
}
