import { mountPlaceInput } from "./place-input.js";
import { preparePhoto } from "./photo-input.js";

const DRAFT_KEY = "notebook.places.draft.v1";

export function mountPlaceEditor({ api, validateEntry, onPlacesChange, onStateChange, onUnauthorized }) {
  const get = id => document.getElementById(id);
  let authenticated = false;
  let busy = false;
  let pending = false;
  let storageWorks = true;
  let siteURL = "https://yasharma.com";
  let photos = [];
  let savedPhotos = [];
  let savedPlaces = [];
  let preparing = false;
  let contentInitialized = false;
  const comment = get("place-comment");
  const picker = get("place-photo-picker");
  const input = mountPlaceInput({ api, onPlacesChange: values => {
    savedPlaces = values;
    onPlacesChange(values);
    const selected = values.find(place => place.id === input.value().id);
    savedPhotos = selected?.photos || [];
    if (!contentInitialized && selected) { comment.value = selected.comment || ""; contentInitialized = true; saveDraft(); }
    renderSavedPhotos();
    controls();
  }, onSelectionChange: (place, { preserve = false, lookup = false } = {}) => {
    if (!preserve) {
      if (!lookup || !comment.value.trim()) comment.value = place?.comment || "";
      if (!lookup) photos = [];
    }
    savedPhotos = place?.photos || [];
    contentInitialized = true;
    renderPhotos(); renderSavedPhotos();
  }, onChange: () => {
    if (!pending) get("place-feedback").hidden = true;
    saveDraft(); controls();
  } });
  const draftValue = () => ({ ...input.draft(), comment: comment.value, photos, contentInitialized });

  function renderSavedPhotos() {
    const container = get("place-saved-photos");
    container.replaceChildren();
    for (const photo of savedPhotos) {
      try {
        const url = new URL(photo.url, siteURL);
        if (!["https:", "http:"].includes(url.protocol)) continue;
        const image = document.createElement("img");
        image.src = url.href; image.alt = photo.alt || "My saved place photo";
        container.append(image);
      } catch { /* Ignore invalid saved image metadata. */ }
    }
  }
  function renderPhotos() {
    const container = get("place-photo-previews");
    container.replaceChildren();
    photos.forEach((photo, index) => {
      const preview = document.createElement("div"); preview.className = "place-photo-preview";
      const image = document.createElement("img"); image.src = `data:image/jpeg;base64,${photo.data}`; image.alt = photo.alt || `Place photo ${index + 1}`;
      const label = document.createElement("label"); label.htmlFor = `place-photo-alt-${index}`; label.textContent = `Photo ${index + 1} description (optional)`;
      const description = document.createElement("input"); description.id = label.htmlFor; description.maxLength = 300; description.value = photo.alt;
      description.addEventListener("input", () => { photo.alt = description.value; image.alt = photo.alt; saveDraft(); });
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "quiet"; remove.textContent = `Remove photo ${index + 1}`;
      remove.addEventListener("click", () => { photos.splice(index, 1); renderPhotos(); saveDraft(); controls(); });
      preview.append(image, label, description, remove); container.append(preview);
    });
  }

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
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draftValue(), pending })); storageWorks = true; }
    catch { storageWorks = false; }
    get("place-draft-status").textContent = !storageWorks ? "Place draft saving is unavailable. Keep this window open." : input.value().name || input.value().mapsURL || comment.value || photos.length ? "Place draft saved on this device." : "Place drafts stay on this device.";
  }
  function controls() {
    get("place-save").disabled = busy || preparing || !authenticated || !navigator.onLine || input.pending || input.needsResolution || (input.value().id && !contentInitialized);
    get("place-save").textContent = busy ? "Saving…" : preparing ? "Preparing photos…" : input.value().id ? "Save changes" : "Save place";
    get("place-save-help").hidden = !input.pending && !input.needsResolution;
    get("place-save-help").textContent = input.pending ? "Loading the location before saving…" : "Choose Use link to confirm this pin before saving. If the link fails, try again, use name search, or enter the pin manually under Edit address & pin.";
    get("place-composer").setAttribute("aria-busy", String(busy));
    input.setBusy(busy || preparing);
    comment.readOnly = busy || input.pending;
    picker.disabled = busy || preparing || input.pending;
    get("place-photo-previews").querySelectorAll("input, button").forEach(control => { control.disabled = busy || preparing; });
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
  if (typeof draft?.comment === "string" && draft.contentInitialized !== false) { comment.value = draft.comment; contentInitialized = true; }
  photos = Array.isArray(draft?.photos) ? draft.photos.filter(photo => typeof photo?.data === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(photo.data) && photo.data.length < 683000 && typeof photo.alt === "string").slice(0, 3) : [];
  renderPhotos();
  pending = draft?.pending === true;
  saveDraft();
  if (pending) feedback("Your previous place save was not confirmed. Check your map before saving again.");
  controls();
  comment.addEventListener("input", () => { contentInitialized = true; saveDraft(); controls(); });
  picker.addEventListener("change", async () => {
    if (busy || preparing) return;
    const files = [...picker.files];
    if (files.length + photos.length > 3) { feedback("Choose up to 3 new photos per save."); picker.value = ""; return; }
    preparing = true; controls(); onStateChange();
    try {
      for (const file of files) { photos.push(await preparePhoto(file)); saveDraft(); }
      get("place-feedback").hidden = true;
    } catch (error) { feedback(error.message); }
    finally { preparing = false; picker.value = ""; renderPhotos(); controls(); onStateChange(); }
  });

  get("place-composer").addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || preparing || !authenticated || input.pending || input.needsResolution) return;
    if (!navigator.onLine) { feedback("You’re offline. Reconnect before saving; your place draft is kept."); return; }
    const entry = { kind: "place", place: { ...input.value(), comment: comment.value.trim() }, text: "", photos };
    const error = validateEntry(entry);
    if (error) { feedback(error); return; }
    const outgoing = JSON.stringify(draftValue());
    busy = true; pending = true;
    saveDraft(); controls(); onStateChange();
    get("place-feedback").hidden = true;
    try {
      const result = await api("/publish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "place", place: entry.place, photos }) });
      const url = new URL(result.url);
      if (result.status !== "committed" || result.has_note !== false || url.origin !== siteURL || url.pathname !== "/places/" || url.searchParams.get("place") !== result.place_id || result.place?.id !== result.place_id || !/^[a-f0-9]{64}$/.test(result.place.revision)) throw new Error("The publisher returned an incomplete confirmation.");
      pending = false;
      const saved = readDraft();
      const newer = saved && JSON.stringify({ query: saved.query, resolvedURL: saved.resolvedURL, place: saved.place, comment: saved.comment || "", photos: saved.photos || [], contentInitialized: saved.contentInitialized === true }) !== outgoing;
      input.saved(result.place);
      if (newer) { input.restore(saved); comment.value = saved.comment || ""; photos = saved.photos || []; contentInitialized = saved.contentInitialized !== false; savedPhotos = savedPlaces.find(place => place.id === saved.place?.id)?.photos || []; }
      else { comment.value = result.place.comment || ""; photos = []; contentInitialized = true; savedPhotos = result.place.photos || []; }
      renderPhotos(); renderSavedPhotos();
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
    get busy() { return busy || preparing; },
    setSession(value, url) { authenticated = value; siteURL = url; input.setAuthenticated(value); controls(); },
    useLink(url) { comment.value = ""; photos = []; savedPhotos = []; contentInitialized = true; renderPhotos(); renderSavedPhotos(); return input.useLink(url); },
  };
}
