import { mountPlaceInput } from "./place-input.js";

const DRAFT_KEY = "notebook.places.draft.v1";

export function mountPlaceEditor({ api, validateEntry, onPlacesChange, onStateChange, onUnauthorized }) {
  const get = id => document.getElementById(id);
  let authenticated = false;
  let busy = false;
  let pending = false;
  let storageWorks = true;
  let siteURL = "https://yasharma.com";
  const input = mountPlaceInput({ api, onPlacesChange, onChange: () => {
    if (!pending) get("place-feedback").hidden = true;
    saveDraft(); controls();
  } });

  function feedback(message, state = "error", url = "") {
    get("place-feedback").hidden = false;
    get("place-feedback").dataset.state = state;
    get("place-message").textContent = message;
    get("place-result-links").hidden = !url;
    if (url) get("place-result-link").href = url;
  }
  function readDraft() {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); }
    catch { storageWorks = false; return null; }
  }
  function saveDraft() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...input.draft(), pending })); storageWorks = true; }
    catch { storageWorks = false; }
    get("place-draft-status").textContent = !storageWorks ? "Place draft saving is unavailable. Keep this window open." : input.value().name || input.value().mapsURL ? "Place draft saved on this device." : "Place drafts stay on this device.";
  }
  function controls() {
    get("place-save").disabled = busy || !authenticated || !navigator.onLine || input.pending || input.needsResolution;
    get("place-save").textContent = busy ? "Saving…" : input.value().id ? "Save changes" : "Save place";
    get("place-save-help").hidden = !input.pending && !input.needsResolution;
    get("place-save-help").textContent = input.pending ? "Loading the location before saving…" : "Choose Use link to confirm this pin before saving. If the link fails, try again, use name search, or enter the pin manually under Edit address & pin.";
    get("place-composer").setAttribute("aria-busy", String(busy));
    input.setBusy(busy);
  }

  let draft = readDraft();
  if (!draft) {
    // Keep place edits from the earlier shared composer. Its text and photos
    // remain in the independent note draft and are never submitted here.
    try {
      const legacy = JSON.parse(localStorage.getItem("notebook.draft.v1") || "null");
      if (legacy?.location) draft = { ...legacy.location, pending: legacy.location.mode === "place" && legacy.pending === true };
    } catch { /* A corrupt legacy draft must not prevent opening Places. */ }
  }
  input.restore(draft);
  pending = draft?.pending === true;
  saveDraft();
  if (pending) feedback("Your previous place save was not confirmed. Check your map before saving again.");
  controls();

  get("place-composer").addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || !authenticated || input.pending || input.needsResolution) return;
    if (!navigator.onLine) { feedback("You’re offline. Reconnect before saving; your place draft is kept."); return; }
    const entry = { kind: "place", place: input.value(), text: "" };
    const error = validateEntry(entry);
    if (error) { feedback(error); return; }
    const outgoing = JSON.stringify(input.draft());
    busy = true; pending = true;
    saveDraft(); controls(); onStateChange();
    get("place-feedback").hidden = true;
    try {
      // Only place fields are sent. Note text, photos, and categories belong to
      // the Notes form, even when it has an unfinished draft.
      const result = await api("/publish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "place", place: entry.place }) });
      const url = new URL(result.url);
      if (result.status !== "committed" || result.has_note !== false || url.origin !== siteURL || url.pathname !== "/places/" || url.searchParams.get("place") !== result.place_id || result.place?.id !== result.place_id || !/^[a-f0-9]{64}$/.test(result.place.revision)) throw new Error("The publisher returned an incomplete confirmation.");
      pending = false;
      const saved = readDraft();
      const newer = saved && JSON.stringify({ query: saved.query, resolvedURL: saved.resolvedURL, place: saved.place }) !== outgoing;
      input.saved(result.place);
      if (newer) input.restore(saved);
      saveDraft();
      feedback("Place saved. Your map will update after deployment.", "success", url.href);
    } catch (error) {
      pending = !error.known;
      saveDraft();
      if (error.status === 401) onUnauthorized();
      feedback(error.known ? `${error.message} Your place draft is kept.` : "The place save wasn’t confirmed. Your draft is kept. Check your map before trying again.");
    } finally { busy = false; controls(); onStateChange(); }
  });
  window.addEventListener("pagehide", saveDraft);
  document.addEventListener("visibilitychange", () => { if (document.hidden) saveDraft(); });
  window.addEventListener("offline", controls);
  window.addEventListener("online", controls);
  return {
    get busy() { return busy; },
    setSession(value, url) { authenticated = value; siteURL = url; input.setAuthenticated(value); controls(); },
    useLink(url) { return input.useLink(url); },
  };
}
