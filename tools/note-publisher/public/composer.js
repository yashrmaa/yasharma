import { preparePhoto } from "./photo-input.js";
const DRAFT_KEY = "notebook.draft.v1";

export function entryFromText(value) {
  const text = value.replace(/\r\n?/g, "\n").trim();
  const [first, ...rest] = text.split("\n");
  if (/^https?:\/\/\S+$/i.test(first)) {
    try {
      const url = new URL(first);
      if (["http:", "https:"].includes(url.protocol)) return { kind: "link", url: first, text: rest.join("\n").trim() };
    } catch { /* A malformed URL-like thought is still ordinary text. */ }
  }
  return { kind: "note", text };
}

export function entryError(entry) {
  if (entry.kind === "note" && !entry.text && !entry.photos?.length) return "Write something or add a photo before publishing.";
  if (entry.text.length > 10000) return "Keep your thought under 10,000 characters.";
  if ((entry.url || "").length > 4096) return "This link is too long (maximum 4,096 characters).";
  if (new TextEncoder().encode(JSON.stringify({ ...entry, photos: undefined })).length > 32768) return "This entry is too large. Shorten it before publishing.";
  if (entry.categories?.length > 8 || entry.categories?.some(value => !/^[\p{L}\p{N}][\p{L}\p{M}\p{N} &+_-]{0,39}$/u.test(value))) return "Use up to 8 categories of 1–40 letters/numbers, spaces, &, +, underscores or hyphens.";
  return "";
}

export function mount() {
  const get = id => document.getElementById(id);
  const thought = get("thought");
  const publish = get("publish");
  const secret = get("secret");
  const categories = get("categories");
  const picker = get("photo-picker");
  let photos = [];
  let preparing = false;
  let signedIn = false;
  let busy = false;
  let pending = false;
  let storageWorks = true;
  let siteURL = "https://yasharma.com";

  function feedback(message, state = "error", url = "") {
    get("feedback").hidden = false;
    get("feedback").dataset.state = state;
    get("message").textContent = message;
    get("result-links").hidden = !url;
    if (url) get("note-link").href = url;
  }

  function readDraft() {
    try {
      const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
      return typeof draft?.text === "string" ? draft : null;
    } catch { storageWorks = false; return null; }
  }

  function draftStatus() {
    get("draft-status").textContent = !storageWorks
      ? "Draft saving is unavailable. Keep this window open or copy your text."
      : thought.value || photos.length || categories.value ? "Draft saved on this device." : "Drafts stay on this device.";
  }

  function saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ text: thought.value, categories: categories.value, photos, pending }));
      storageWorks = true;
    } catch { storageWorks = false; }
    draftStatus();
  }

  function controls() {
    publish.disabled = busy || preparing || !signedIn || !navigator.onLine || (!thought.value.trim() && !photos.length);
    publish.textContent = busy ? "Publishing…" : preparing ? "Preparing photos…" : "Publish";
    thought.readOnly = busy;
    categories.readOnly = busy;
    picker.disabled = busy || preparing;
    get("photo-previews").querySelectorAll("input, button").forEach(control => { control.disabled = busy || preparing; });
    get("sign-out").disabled = busy;
    get("composer").setAttribute("aria-busy", String(busy));
  }

  function auth(authenticated) {
    signedIn = authenticated;
    get("sign-in").hidden = authenticated;
    get("composer").hidden = !authenticated;
    get("sign-out").hidden = !authenticated;
    controls();
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(120000), ...options,
    });
    let data;
    try { data = await response.json(); } catch { throw new Error("Unexpected response from the publisher."); }
    if (!response.ok || data.ok !== true) {
      const error = new Error(data.error?.message || "The publisher could not complete this request.");
      Object.assign(error, { status: response.status, code: data.error?.code, known: data.ok === false && response.status < 500 });
      // GitHub rejections are explicit failures; missing confirmations are not.
      if (["github_error", "photo_upload_failed"].includes(data.error?.code)) error.known = true;
      throw error;
    }
    return data;
  }

  async function checkSession() {
    try {
      const data = await api("/session");
      siteURL = new URL(data.site_url).origin;
      get("notebook-link").href = `${siteURL}/notes/`;
      get("deployment-link").href = data.actions_url;
      auth(data.authenticated === true);
      get("connection").hidden = true;
    } catch (error) {
      get("connection").hidden = false;
      get("connection").textContent = navigator.onLine ? "Could not check sign-in. Try signing in below." : "You’re offline. Your saved draft is kept on this device.";
      auth(false);
      if (navigator.onLine) feedback(error.message);
    }
  }

  const draft = readDraft();
  thought.value = draft?.text || "";
  categories.value = typeof draft?.categories === "string" ? draft.categories : "";
  photos = Array.isArray(draft?.photos) ? draft.photos.filter(photo => typeof photo?.data === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(photo.data) && photo.data.length < 683000 && typeof photo.alt === "string").slice(0, 3) : [];
  if (photos.length || categories.value) get("extras").open = true;
  renderPhotos();
  pending = draft?.pending === true;
  saveDraft(); // Also detects browsers that prohibit local storage.
  if (pending) feedback("Your previous publish was not confirmed. Check your notes before publishing this draft again.");
  void checkSession();

  thought.addEventListener("input", () => { saveDraft(); controls(); });
  categories.addEventListener("input", () => { saveDraft(); renderCount(); });
  function renderCount() {
    const count = categories.value.split(",").filter(value => value.trim()).length;
    const labels = [];
    if (count) labels.push(`${count} ${count === 1 ? "category" : "categories"}`);
    if (photos.length) labels.push(`${photos.length} ${photos.length === 1 ? "photo" : "photos"}`);
    get("extras-count").textContent = labels.length ? `(${labels.join(", ")})` : "";
  }
  function renderPhotos() {
    const container = get("photo-previews");
    container.replaceChildren();
    photos.forEach((photo, index) => {
      const figure = document.createElement("div");
      figure.className = "photo-preview";
      const image = document.createElement("img");
      image.src = `data:image/jpeg;base64,${photo.data}`;
      image.alt = photo.alt || `Selected photo ${index + 1}`;
      const label = document.createElement("label");
      label.htmlFor = `photo-alt-${index}`;
      label.textContent = `Photo ${index + 1} description (optional)`;
      const description = document.createElement("input");
      description.id = label.htmlFor;
      description.maxLength = 300;
      description.value = photo.alt;
      description.addEventListener("input", () => { photo.alt = description.value; image.alt = photo.alt; saveDraft(); });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "quiet";
      remove.textContent = `Remove photo ${index + 1}`;
      remove.addEventListener("click", () => { photos.splice(index, 1); renderPhotos(); saveDraft(); controls(); });
      figure.append(image, label, description, remove);
      container.append(figure);
    });
    renderCount();
  }
  picker.addEventListener("change", async () => {
    if (busy || preparing) return;
    const files = [...picker.files];
    if (files.length + photos.length > 3) { feedback("Choose up to 3 photos per post."); picker.value = ""; return; }
    preparing = true;
    controls();
    try {
      for (const file of files) { photos.push(await preparePhoto(file)); saveDraft(); }
      get("feedback").hidden = true;
    } catch (error) { feedback(error.message); }
    finally { preparing = false; picker.value = ""; renderPhotos(); controls(); }
  });
  window.addEventListener("pagehide", saveDraft);
  document.addEventListener("visibilitychange", () => { if (document.hidden) saveDraft(); });

  get("sign-in").addEventListener("submit", async event => {
    event.preventDefault();
    const button = get("sign-in-button");
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = "Signing in…";
    try {
      await api("/session", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret.value.trim()}` }, body: "{}" });
      await checkSession();
      if (signedIn) {
        if (!pending) get("feedback").hidden = true;
        thought.focus();
      }
    } catch (error) { feedback(error.message); }
    finally {
      secret.value = "";
      button.disabled = false;
      button.textContent = "Sign in";
    }
  });

  get("sign-out").addEventListener("click", async () => {
    if (busy) return;
    try {
      await api("/session", { method: "DELETE" });
      auth(false);
      feedback("Signed out. Any unfinished draft is still on this device.", "info");
    } catch (error) { feedback(`Could not sign out. ${error.message}`); }
  });

  get("composer").addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || preparing || !signedIn) return;
    if (!navigator.onLine) { feedback("You’re offline. Reconnect before publishing; your draft is kept here."); return; }
    const entry = entryFromText(thought.value);
    entry.categories = categories.value.split(",").map(value => value.trim()).filter(Boolean);
    entry.photos = photos;
    const validation = entryError(entry);
    if (validation) { feedback(validation); return; }
    const outgoing = JSON.stringify({ text: thought.value, categories: categories.value, photos });
    busy = true;
    pending = true;
    saveDraft();
    controls();
    get("feedback").hidden = true;
    try {
      const data = await api("/publish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry) });
      const url = new URL(data.url);
      if (data.status !== "committed" || url.origin !== siteURL || !/^\/notes\/[^/]+\/$/.test(url.pathname)) throw new Error("The publisher returned an incomplete confirmation.");
      pending = false;
      // Preserve a newer draft written by another window while the request ran.
      const saved = readDraft();
      const newer = saved && JSON.stringify({ text: saved.text, categories: saved.categories || "", photos: saved.photos || [] }) !== outgoing;
      thought.value = newer ? saved.text : "";
      categories.value = newer ? saved.categories || "" : "";
      photos = newer ? saved.photos || [] : [];
      renderPhotos();
      saveDraft();
      feedback("Saved. Your note will appear after the site finishes deploying. The link may briefly show 404.", "success", url.href);
    } catch (error) {
      pending = !error.known;
      saveDraft();
      if (error.status === 401) auth(false);
      feedback(error.known ? `${error.message} Your draft has been kept.` : "Publishing wasn’t confirmed. Your draft is kept. Check your notes and deployment status before trying again; the save may have succeeded.");
    } finally { busy = false; controls(); }
  });

  window.addEventListener("offline", () => {
    get("connection").hidden = false;
    get("connection").textContent = "You’re offline. Keep writing; publish when you reconnect.";
    controls();
  });
  window.addEventListener("online", () => {
    get("connection").hidden = true;
    controls();
    if (!signedIn) void checkSession();
  });
}

if (typeof document !== "undefined") mount();
