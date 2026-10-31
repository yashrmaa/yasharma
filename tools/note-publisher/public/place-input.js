export function googleMapsLink(value) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.port) return "";
    if (url.hostname === "maps.app.goo.gl" && /^\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)) return url.href;
    if (url.hostname === "goo.gl" && url.pathname.startsWith("/maps/")) return url.href;
    if (/^(?:(?:www|maps)\.)?google\.(?:com|ca|co\.jp|co\.uk|com\.tr|fr|de|co\.in|com\.au)$/.test(url.hostname) && (url.pathname === "/maps" || url.pathname.startsWith("/maps/") || (url.hostname.startsWith("maps.") && url.pathname === "/"))) return url.href;
  } catch { /* Ordinary notes and links keep their existing behavior. */ }
  return "";
}

export function googleMapsKey(value) {
  const normalized = googleMapsLink(value || "");
  if (!normalized) return "";
  const url = new URL(normalized);
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || ["g_st", "g_ep", "entry", "skid"].includes(key)) url.searchParams.delete(key);
  }
  url.hash = "";
  return url.href;
}

export function mountPlaceInput({ api, onChange }) {
  const get = id => document.getElementById(id);
  const fields = ["name", "city", "neighborhood", "address", "category", "status", "latitude", "longitude", "precision"];
  let enabled = false;
  let authenticated = false;
  let busy = false;
  let loading = false;
  let searching = false;
  let resolving = false;
  let resolvedURL = "";
  let loaded = false;
  let saved = [];
  let id = "";
  let revision = "";
  let locationSource = "";
  let searchVersion = 0;
  let cooldown = 0;

  function status(message) { get("place-load-status").textContent = message; }
  function renderLocation() {
    const value = get("place-address").value;
    get("place-location").textContent = value ? `${get("place-precision").value === "city" ? "Approximate area: " : ""}${value}` : "Choose a search result, or enter the location details below.";
    const lat = get("place-latitude").value;
    const lon = get("place-longitude").value;
    get("place-map-check").hidden = !lat || !lon;
    if (lat && lon) get("place-map-check").href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lon}`)}`;
  }
  function options() {
    const select = get("place-existing");
    select.replaceChildren(new Option("Add a new place…", ""));
    for (const place of [...saved].sort((a, b) => a.name.localeCompare(b.name))) select.add(new Option(`${place.name} · ${place.city}`, place.id));
    select.value = id;
  }
  function fill(place = {}) {
    id = place.id || "";
    revision = place.revision || "";
    locationSource = place.locationSource || "";
    get("place-maps-url").value = place.mapsURL || "";
    resolvedURL = place.mapsURL || "";
    for (const key of fields) {
      const value = key === "latitude" ? place.coordinates?.[0] : key === "longitude" ? place.coordinates?.[1] : place[key];
      get(`place-${key}`).value = value ?? (key === "status" ? "saved" : key === "category" ? "Coffee" : key === "precision" ? "address" : "");
    }
    get("place-existing").value = id;
    get("place-results").replaceChildren();
    renderLocation();
  }
  function controls() {
    get("place-fields").querySelectorAll("input, select, button").forEach(control => { control.disabled = busy || resolving || !enabled; });
    get("place-existing").disabled = busy || resolving || loading || !enabled;
    get("place-refresh").disabled = busy || resolving || loading || !enabled;
    get("place-search-button").disabled = busy || resolving || searching || !enabled || Date.now() < cooldown;
    get("place-search-button").textContent = searching ? "Searching…" : "Search";
    get("place-resolve").textContent = resolving ? "Opening…" : "Use link";
    document.querySelectorAll("[data-compose-mode]").forEach(button => { button.disabled = busy; });
  }
  async function load(replaceSelection = false) {
    if (loading || !authenticated) return;
    loading = true;
    status("Loading your saved places…");
    controls();
    try {
      const result = await api("/places");
      if (!Array.isArray(result.places)) throw new Error("Your saved places couldn't be read.");
      saved = result.places;
      loaded = true;
      options();
      if (replaceSelection && id) { fill(saved.find(place => place.id === id)); onChange(); }
      if (!resolving && !searching) status(`${saved.length} saved ${saved.length === 1 ? "place" : "places"}. Choose one, paste a Maps link, or use name search.`);
    } catch (error) { status(error.message); }
    finally { loading = false; controls(); }
  }
  function mode(value, notify = true) {
    searchVersion++;
    enabled = value === "place";
    get("composer").dataset.mode = enabled ? "place" : "note";
    get("place-fields").hidden = !enabled;
    document.querySelectorAll("[data-compose-mode]").forEach(button => button.setAttribute("aria-pressed", String((button.dataset.composeMode === "place") === enabled)));
    get("thought-label").textContent = enabled ? "A note about this place (optional)" : "What do you want to remember?";
    get("thought").placeholder = enabled ? "What did you like? What should I order? Or just save the place for later…" : "A thought, a quote, something you learned…";
    get("thought").rows = enabled ? 4 : 10;
    get("writing-help").hidden = enabled;
    get("day-help").textContent = enabled ? "Save just the place, or add a note and photos. A place-only save won't add an empty note." : "Each publish adds a new timed entry under today’s date.";
    if (enabled && authenticated && !loaded) void load();
    controls();
    if (notify) onChange();
  }
  document.querySelectorAll("[data-compose-mode]").forEach(button => button.addEventListener("click", () => mode(button.dataset.composeMode)));
  get("place-existing").addEventListener("change", () => { searchVersion++; fill(saved.find(place => place.id === get("place-existing").value)); onChange(); });
  get("place-refresh").addEventListener("click", () => void load(true));
  for (const key of fields) get(`place-${key}`).addEventListener("input", () => {
    if (["latitude", "longitude"].includes(key)) { locationSource = ""; get("place-maps-url").value = ""; resolvedURL = ""; }
    renderLocation(); onChange();
  });
  function choose(place) {
    const existing = saved.find(item => (place.mapsURL && googleMapsKey(item.mapsURL) && googleMapsKey(item.mapsURL) === googleMapsKey(place.mapsURL)) || (place.locationSource && item.locationSource === place.locationSource) || (item.name.toLocaleLowerCase() === place.name.toLocaleLowerCase() && item.coordinates?.every((value, index) => Math.abs(value - place.coordinates[index]) < .0001)));
    const editing = id ? { id, revision } : {};
    fill(existing || { ...place, ...editing, status: get("place-status").value, category: get("place-category").value });
    return existing;
  }
  get("place-maps-url").addEventListener("input", () => {
    searchVersion++;
    status(get("place-maps-url").value.trim() ? "Choose Use link to load this place's pin before saving." : "Paste a Maps link or use name search below.");
    onChange();
  });
  get("place-maps-url").addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); get("place-resolve").click(); }
  });
  async function resolveLink() {
    if (busy || resolving) return;
    const url = googleMapsLink(get("place-maps-url").value);
    if (!url) { status("Paste a Google Maps place link, such as maps.app.goo.gl/… or google.com/maps/…."); get("place-maps-url").focus(); return; }
    const version = ++searchVersion;
    resolving = true;
    status("Opening the Google Maps place…");
    controls(); onChange();
    try {
      const result = await api(`/places/resolve?url=${encodeURIComponent(url)}`);
      if (version !== searchVersion || !enabled) return;
      if (!result.place?.coordinates) throw new Error("This link did not return a place pin.");
      const existing = choose(result.place);
      const incomplete = !get("place-name").value || !get("place-city").value || !get("place-address").value;
      get("place-location-details").open = incomplete;
      get("place-lookup").open = false;
      status(incomplete ? "Exact pin loaded. Add the missing name, city, or address below, then save." : existing ? "Already in your collection. Review its details below to update it." : "Exact pin loaded from your link. Review the details below, then save.");
    } catch (error) { if (version === searchVersion) status(error.message); }
    finally { resolving = false; controls(); onChange(); }
  }
  get("place-resolve").addEventListener("click", () => void resolveLink());
  get("place-query").addEventListener("input", () => { searchVersion++; get("place-results").replaceChildren(); onChange(); });
  get("place-query").addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); get("place-search-button").click(); }
  });
  get("place-search-button").addEventListener("click", async () => {
    if (busy || searching || Date.now() < cooldown) return;
    const query = get("place-query").value.trim();
    if (query.length < 3) { status("Enter a place name and city, at least 3 characters."); get("place-query").focus(); return; }
    const version = ++searchVersion;
    searching = true;
    cooldown = Date.now() + 1500;
    status("Looking for that place…");
    controls(); onChange();
    try {
      const result = await api(`/places/search?q=${encodeURIComponent(query)}`);
      if (version !== searchVersion) return;
      get("place-results").replaceChildren();
      for (const place of result.places || []) {
        const button = document.createElement("button");
        button.type = "button";
        const name = document.createElement("strong"); name.textContent = place.name;
        const address = document.createElement("span"); address.textContent = place.address;
        button.append(name, address);
        button.addEventListener("click", () => {
          if (busy) return;
          searchVersion++;
          const existing = choose(place);
          status(existing ? "Already in your collection. You can update it below." : "Location selected. Check the details below, then save.");
          onChange();
        });
        get("place-results").append(button);
      }
      status(result.places?.length ? "Choose the right location below." : "No matches. Try the street address or a nearby landmark, or add location details manually.");
    } catch (error) { if (version === searchVersion) status(error.message); }
    finally { searching = false; controls(); onChange(); setTimeout(controls, Math.max(0, cooldown - Date.now()) + 20); }
  });
  fill();
  mode("note", false);
  return {
    get enabled() { return enabled; },
    get pending() { return resolving || searching; },
    get needsResolution() { const url = get("place-maps-url").value.trim(); return Boolean(url && url !== resolvedURL); },
    value() {
      const place = { id, revision, locationSource, mapsURL: get("place-maps-url").value.trim() };
      for (const key of fields.filter(key => !["latitude", "longitude"].includes(key))) place[key] = get(`place-${key}`).value.trim();
      const lat = get("place-latitude").value.trim();
      const lon = get("place-longitude").value.trim();
      place.coordinates = [lat === "" ? null : Number(lat), lon === "" ? null : Number(lon)];
      return place;
    },
    draft() { return { mode: enabled ? "place" : "note", query: get("place-query").value, resolvedURL, place: this.value() }; },
    restore(draft) {
      fill(draft?.place || {});
      get("place-query").value = typeof draft?.query === "string" ? draft.query : "";
      resolvedURL = typeof draft?.resolvedURL === "string" ? draft.resolvedURL : "";
      get("place-lookup").open = Boolean(get("place-query").value);
      mode(draft?.mode === "place" ? "place" : "note", false);
    },
    setAuthenticated(value) { authenticated = value; if (authenticated && enabled && !loaded) void load(); },
    setBusy(value) { busy = value; controls(); },
    useLink(url) { fill(); get("place-query").value = ""; mode("place", false); get("place-maps-url").value = url; resolvedURL = ""; onChange(); return resolveLink(); },
    saved(place) {
      if (!place) return;
      saved = saved.filter(item => item.id !== place.id).concat(place);
      options(); fill(place);
      get("place-query").value = "";
      status("Saved. You can add another note here, update this place, or choose somewhere new.");
    },
  };
}
