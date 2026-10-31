/* The notebook is rendered by Hugo; JavaScript adds the map and exploration. */
(async () => {
  const root = document.querySelector("[data-places-page]");
  if (!root) return;
  const get = id => root.querySelector(`#${id}`);
  const message = get("places-map-message");
  const announce = text => { get("places-announcement").textContent = text; };
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let places;
  try {
    const response = await fetch(root.querySelector("[data-source]").dataset.source);
    if (!response.ok) throw new Error("Places unavailable");
    places = await response.json();
    if (!Array.isArray(places)) throw new Error("Invalid places");
  } catch {
    message.querySelector("p").textContent = "The map couldn't open this time.";
    message.querySelector("span").textContent = "You can still explore my notes, photos, and Google Maps links in the list.";
    return;
  }

  const byId = new Map(places.map(place => [place.id, place]));
  const cards = new Map([...root.querySelectorAll("[data-place]")].map(card => [card.dataset.place, card]));
  const search = get("places-search");
  const category = get("places-category");
  const status = get("places-status");
  const detail = get("place-map-detail");
  const dialog = get("places-photo-dialog");
  const markers = new Map();
  let map;
  let markerLayer;
  let visible = places;
  let state = { city: "", category: "", status: "", q: "", place: "" };
  let gallery = [];
  let galleryIndex = 0;
  let searchTimer;
  let approximateArea;

  // All dynamic note text enters the DOM as text, never as HTML.
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function link(text, href, external = false) {
    const node = element("a", "", text);
    const url = new URL(href, location.href);
    if (!["https:", "http:"].includes(url.protocol)) return node;
    node.href = url.href;
    if (external) { node.target = "_blank"; node.rel = "noopener noreferrer"; }
    return node;
  }

  function readURL() {
    const params = new URL(location.href).searchParams;
    state = { city: params.get("city") || "", category: params.get("category") || "", status: params.get("status") || "", q: params.get("q") || "", place: params.get("place") || "" };
    if (!places.some(place => place.city === state.city)) state.city = "";
    if (!places.some(place => place.category === state.category)) state.category = "";
    if (!["liked", "saved", "mentioned"].includes(state.status)) state.status = "";
    if (!byId.has(state.place)) state.place = "";
  }

  function writeURL(replace = false) {
    const url = new URL(location.href);
    for (const [key, value] of Object.entries(state)) {
      if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    }
    url.hash = "";
    if (url.href !== location.href) history[replace ? "replaceState" : "pushState"](null, "", url);
  }

  function matchingPlaces() {
    const words = state.q.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return places.filter(place => {
      if (state.city && place.city !== state.city) return false;
      if (state.category && place.category !== state.category) return false;
      if (state.status && place.status !== state.status) return false;
      const text = [place.name, place.city, place.neighborhood, place.address, place.category, ...(place.aliases || []), ...place.notes.map(note => note.text)].join(" ").toLocaleLowerCase();
      return words.every(word => text.includes(word));
    });
  }

  function fitPlaces(animate = true) {
    if (!map || !visible.length) return;
    const approximate = visible.length === 1 && visible[0].precision === "city";
    map.fitBounds(visible.map(place => place.coordinates), { padding: [65, 100], maxZoom: approximate ? 11 : 14, animate: animate && !reducedMotion, duration: .6 });
  }

  function clearSelection() {
    detail.hidden = true;
    detail.replaceChildren();
    if (approximateArea) { approximateArea.remove(); approximateArea = undefined; }
    for (const [id, card] of cards) {
      delete card.dataset.selected;
      card.querySelector(".place-select").setAttribute("aria-pressed", "false");
      const marker = markers.get(id);
      if (marker) {
        marker.setZIndexOffset(0);
        marker.getElement()?.setAttribute("data-selected", "false");
      }
    }
    get("places-map-label").textContent = state.city || "A few good places";
  }

  function renderDetail(place) {
    const imageBox = element("div", "place-detail-image");
    const firstPhoto = place.notes.flatMap(note => note.photos)[0];
    if (firstPhoto) {
      const image = element("img");
      image.src = firstPhoto.url;
      image.alt = firstPhoto.alt;
      imageBox.append(image);
    }
    const info = element("div", "place-detail-info");
    info.append(element("p", "", `${place.category} · ${place.neighborhood ? `${place.neighborhood}, ` : ""}${place.city}`));
    info.append(element("h3", "", place.name));
    if (place.notes[0]?.text) info.append(element("p", "place-detail-text", place.notes[0].text));
    if (place.locationNote) info.append(element("p", "place-detail-approximate", place.locationNote));
    const links = element("div", "place-detail-links");
    links.append(link("Open in Google Maps ↗", place.mapsURL, true));
    if (place.notes[0]) links.append(link("Read my note ↗", place.notes[0].url));
    const share = element("button", "", "Share place ↗");
    share.type = "button";
    share.addEventListener("click", () => void shareURL(share));
    links.append(share);
    info.append(links);
    if (place.notes.length > 1) {
      const more = element("details", "place-detail-notes");
      more.append(element("summary", "", `${place.notes.length - 1} more from my notebook`));
      for (const note of place.notes.slice(1)) {
        more.append(element("p", "", note.text), link(`Read note · ${note.label} ↗`, note.url));
      }
      info.append(more);
    }
    const close = element("button", "place-detail-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close place details");
    close.addEventListener("click", () => {
      const card = cards.get(state.place);
      state.place = "";
      clearSelection();
      writeURL();
      card?.querySelector(".place-select").focus({ preventScroll: true });
    });
    detail.replaceChildren(imageBox, info, close);
    detail.hidden = false;
  }

  function selectPlace(id, { updateURL = true, pan = true, scroll = false } = {}) {
    const place = byId.get(id);
    if (!place || !visible.includes(place)) return;
    clearSelection();
    state.place = id;
    const card = cards.get(id);
    card.dataset.selected = "true";
    card.querySelector(".place-select").setAttribute("aria-pressed", "true");
    const marker = markers.get(id);
    if (marker) {
      marker.setZIndexOffset(1000);
      marker.getElement()?.setAttribute("data-selected", "true");
    }
    if (map && pan) {
      map.stop();
      // Keep the pin above the note card, including on a narrow screen.
      const zoom = place.precision === "city" ? 11 : 14;
      const offset = map.getSize().y < 450 ? 35 : 70;
      const center = map.unproject(map.project(place.coordinates, zoom).add([0, offset]), zoom);
      map.setView(center, zoom, { animate: !reducedMotion, duration: .6 });
      if (place.precision === "city") approximateArea = L.circle(place.coordinates, { radius: 3500, color: "#798064", weight: 1, dashArray: "4 6", fillOpacity: .07, interactive: false }).addTo(map);
    }
    get("places-map-label").textContent = place.precision === "city" ? `${place.city} · approximate location` : `${place.neighborhood || place.city} · ${place.name}`;
    renderDetail(place);
    if (scroll) {
      if (matchMedia("(max-width: 800px)").matches) root.querySelector(".places-map-pane").scrollIntoView({ behavior: reducedMotion ? "instant" : "smooth", block: "center" });
      else root.querySelector(".places-sidebar").scrollTo({ top: card.offsetTop - root.querySelector(".places-search-area").offsetTop - 12, behavior: reducedMotion ? "instant" : "smooth" });
    }
    if (updateURL) writeURL();
    announce(`Selected ${place.name} in ${place.city}${place.precision === "city" ? ". Approximate location" : ""}.`);
  }

  function applyFilters({ updateURL = true, replace = false, fit = true } = {}) {
    visible = matchingPlaces();
    search.value = state.q;
    category.value = state.category;
    status.value = state.status;
    for (const button of root.querySelectorAll("[data-city]")) button.setAttribute("aria-pressed", String(button.dataset.city === state.city));
    for (const [id, card] of cards) card.hidden = !visible.some(place => place.id === id);
    get("places-count").textContent = `${visible.length} ${visible.length === 1 ? "place" : "places"}${visible.length !== places.length ? ` of ${places.length}` : ""}`;
    get("places-empty").hidden = visible.length > 0;
    root.querySelector("[data-random]").disabled = !visible.length;
    root.querySelector("[data-fit]").disabled = !visible.length;
    if (markerLayer) {
      markerLayer.clearLayers();
      for (const place of visible) {
        const marker = markers.get(place.id);
        markerLayer.addLayer(marker);
        marker.getElement()?.setAttribute("data-precision", place.precision);
      }
    }
    clearSelection();
    if (state.place && visible.some(place => place.id === state.place)) selectPlace(state.place, { updateURL: false, pan: fit });
    else { state.place = ""; if (fit) fitPlaces(); }
    if (updateURL) writeURL(replace);
  }

  async function shareURL(button) {
    const label = button.textContent;
    writeURL(true);
    try {
      await navigator.clipboard.writeText(location.href);
      button.textContent = "Link copied ✓";
      announce("Link copied. It includes the selected place and filters.");
      setTimeout(() => { button.textContent = label; }, 2200);
    } catch {
      // Selecting the address still works on browsers that disallow clipboard access.
      window.prompt("Copy this link to share this view:", location.href);
    }
  }

  function showPhoto() {
    const item = gallery[galleryIndex];
    get("places-dialog-image").src = item.photo.url;
    get("places-dialog-image").alt = item.photo.alt;
    get("places-photo-title").textContent = item.place.name;
    get("places-photo-caption").textContent = `My photo · ${item.place.city} · ${item.note.label}`;
    get("places-photo-counter").textContent = `${galleryIndex + 1} / ${gallery.length}`;
    get("places-photo-source").href = item.note.url;
    root.querySelector("[data-previous-photo]").disabled = galleryIndex === 0;
    root.querySelector("[data-next-photo]").disabled = galleryIndex === gallery.length - 1;
  }

  root.querySelectorAll("[data-js-control]").forEach(control => { control.hidden = false; });
  root.querySelectorAll("[data-select], [data-photo]").forEach(button => { button.disabled = false; });
  root.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.hasAttribute("data-select")) selectPlace(button.dataset.select, { scroll: true });
    if (button.hasAttribute("data-city")) {
      state.city = button.dataset.city;
      state.place = "";
      applyFilters();
    }
    if (button.hasAttribute("data-reset")) {
      state = { city: "", category: "", status: "", q: "", place: "" };
      applyFilters();
      search.focus({ preventScroll: true });
    }
    if (button.hasAttribute("data-fit")) { state.place = ""; clearSelection(); fitPlaces(); writeURL(); }
    if (button.hasAttribute("data-random") && visible.length) {
      const choices = visible.length > 1 ? visible.filter(place => place.id !== state.place) : visible;
      const index = crypto.getRandomValues(new Uint32Array(1))[0] % choices.length;
      selectPlace(choices[index].id, { scroll: true });
    }
    if (button.hasAttribute("data-share")) void shareURL(button);
    if (button.hasAttribute("data-photo")) {
      const place = byId.get(button.dataset.photo);
      gallery = place.notes.flatMap(note => note.photos.map(photo => ({ photo, note, place })));
      if (gallery.length) { galleryIndex = 0; showPhoto(); dialog.showModal(); }
    }
    if (button.hasAttribute("data-close-photo")) dialog.close();
    if (button.hasAttribute("data-previous-photo") && galleryIndex > 0) { galleryIndex--; showPhoto(); }
    if (button.hasAttribute("data-next-photo") && galleryIndex < gallery.length - 1) { galleryIndex++; showPhoto(); }
  });
  dialog.addEventListener("click", event => {
    if (event.target === dialog) {
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    }
  });
  dialog.addEventListener("keydown", event => {
    if (event.key === "ArrowLeft" && galleryIndex > 0) { galleryIndex--; showPhoto(); }
    if (event.key === "ArrowRight" && galleryIndex < gallery.length - 1) { galleryIndex++; showPhoto(); }
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !dialog.open && state.place) {
      const card = cards.get(state.place);
      state.place = "";
      clearSelection();
      writeURL();
      card.querySelector(".place-select").focus({ preventScroll: true });
    }
  });
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = search.value; state.place = ""; applyFilters({ replace: true }); }, 130);
  });
  category.addEventListener("change", () => { state.category = category.value; state.place = ""; applyFilters(); });
  status.addEventListener("change", () => { state.status = status.value; state.place = ""; applyFilters(); });
  window.addEventListener("popstate", () => { clearTimeout(searchTimer); readURL(); applyFilters({ updateURL: false }); });

  if (window.L) {
    map = L.map(get("places-map"), { zoomControl: false, scrollWheelZoom: false, minZoom: 2, maxZoom: 19 });
    L.control.zoom({ position: "topright" }).addTo(map);
    L.control.scale({ position: "bottomleft", imperial: false }).addTo(map);
    let loadedTiles = 0;
    const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    tiles.on("tileload", () => { loadedTiles++; message.hidden = true; });
    tiles.on("tileerror", () => {
      if (loadedTiles) return;
      message.dataset.error = "true";
      message.hidden = false;
      message.querySelector("p").textContent = "The map background is unavailable.";
      message.querySelector("span").textContent = "Pins and Google Maps links still work. Try again when you're online.";
    });
    markerLayer = L.layerGroup().addTo(map);
    places.forEach((place, index) => {
      const marker = L.marker(place.coordinates, {
        icon: L.divIcon({ className: "place-map-marker", html: `<span class="place-pin"><span>${String(index + 1).padStart(2, "0")}</span></span>`, iconSize: [37, 45], iconAnchor: [18, 42], tooltipAnchor: [0, -45] }),
        title: `${place.name}${place.precision === "city" ? " (approximate city-level location)" : ""}`,
        alt: place.name,
        keyboard: true,
        riseOnHover: true,
      });
      marker.bindTooltip(element("span", "", place.name), { direction: "top" });
      marker.on("click", () => selectPlace(place.id, { scroll: !matchMedia("(max-width: 800px)").matches }));
      markers.set(place.id, marker);
    });
    message.hidden = true;
    new ResizeObserver(() => { map.invalidateSize({ pan: false }); }).observe(get("places-map"));
    map.on("click", () => { if (state.place) { state.place = ""; clearSelection(); writeURL(); } });
    map.setView([39.5, -98.5], 4);
  } else {
    message.querySelector("p").textContent = "The map couldn't open this time.";
    message.querySelector("span").textContent = "My photos, notes, and Google Maps links are still in the list.";
    root.querySelector(".places-map-top").hidden = true;
    root.querySelector(".places-map-bottom").hidden = true;
  }
  readURL();
  applyFilters({ updateURL: false });
})();
