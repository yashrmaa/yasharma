export function mountPlaceInput({ api, onChange }) {
  const get = id => document.getElementById(id);
  const fields = ["name", "city", "neighborhood", "address", "category", "status", "latitude", "longitude", "precision"];
  let enabled = false;
  let authenticated = false;
  let busy = false;
  let loading = false;
  let searching = false;
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
    for (const key of fields) {
      const value = key === "latitude" ? place.coordinates?.[0] : key === "longitude" ? place.coordinates?.[1] : place[key];
      get(`place-${key}`).value = value ?? (key === "status" ? "saved" : key === "category" ? "Coffee" : key === "precision" ? "address" : "");
    }
    get("place-existing").value = id;
    get("place-results").replaceChildren();
    renderLocation();
  }
  function controls() {
    get("place-fields").querySelectorAll("input, select, button").forEach(control => { control.disabled = busy || !enabled; });
    get("place-existing").disabled = busy || loading || !enabled;
    get("place-refresh").disabled = busy || loading || !enabled;
    get("place-search-button").disabled = busy || searching || !enabled || Date.now() < cooldown;
    get("place-search-button").textContent = searching ? "Searching…" : "Search";
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
      status(`${saved.length} saved ${saved.length === 1 ? "place" : "places"}. Select one to update it, or search for somewhere new.`);
    } catch (error) { status(error.message); }
    finally { loading = false; controls(); }
  }
  function mode(value, notify = true) {
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
    if (["latitude", "longitude"].includes(key)) locationSource = "";
    renderLocation(); onChange();
  });
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
    controls();
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
          const existing = saved.find(item => place.locationSource && item.locationSource === place.locationSource);
          const chosenStatus = get("place-status").value;
          const chosenCategory = get("place-category").value;
          const editing = id ? { id, revision } : {};
          fill(existing || { ...place, ...editing, status: chosenStatus, category: chosenCategory });
          status(existing ? "Already in your collection. You can update it below." : "Location selected. Check the details below, then save.");
          onChange();
        });
        get("place-results").append(button);
      }
      status(result.places?.length ? "Choose the right location below." : "No matches. Try the street address or a nearby landmark, or add location details manually.");
    } catch (error) { if (version === searchVersion) status(error.message); }
    finally { searching = false; controls(); setTimeout(controls, Math.max(0, cooldown - Date.now()) + 20); }
  });
  fill();
  mode("note", false);
  return {
    get enabled() { return enabled; },
    value() {
      const place = { id, revision, locationSource };
      for (const key of fields.filter(key => !["latitude", "longitude"].includes(key))) place[key] = get(`place-${key}`).value.trim();
      const lat = get("place-latitude").value.trim();
      const lon = get("place-longitude").value.trim();
      place.coordinates = [lat === "" ? null : Number(lat), lon === "" ? null : Number(lon)];
      return place;
    },
    draft() { return { mode: enabled ? "place" : "note", query: get("place-query").value, place: this.value() }; },
    restore(draft) {
      fill(draft?.place || {});
      get("place-query").value = typeof draft?.query === "string" ? draft.query : "";
      mode(draft?.mode === "place" ? "place" : "note", false);
    },
    setAuthenticated(value) { authenticated = value; if (authenticated && enabled && !loaded) void load(); },
    setBusy(value) { busy = value; controls(); },
    saved(place) {
      if (!place) return;
      saved = saved.filter(item => item.id !== place.id).concat(place);
      options(); fill(place);
      get("place-query").value = "";
      status("Saved. You can add another note here, update this place, or choose somewhere new.");
    },
  };
}
