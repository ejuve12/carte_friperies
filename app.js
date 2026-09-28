// Carte des friperies — données OpenStreetMap.
// France (et zones frontalières) : fichier data/friperies.json préchargé, recherche instantanée.
// Ailleurs : interrogation en direct de l'API Overpass.

const DATASET_URL = "data/friperies.json"; // généré par tools/update-data.js
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass-api.de/api/interpreter", // serveur parfois surchargé (504) : un second essai
];
const REQUEST_TIMEOUT_MS = 20000;
const LIVE_SEARCH_DELAY_MS = 600; // attente après un déplacement avant d'interroger Overpass
const LIVE_PADDING = 0.3;         // marge chargée autour de l'écran (30 %)
const MIN_ZOOM_FOR_LIVE = 11;
const LIST_LIMIT = 100;           // nombre max de boutiques dans la liste (les plus proches)

const CATEGORIES = {
  friperie: "Friperie / dépôt-vente",
  solidaire: "Boutique solidaire",
  vetements: "Vêtements d'occasion",
};
const COMPACT_CATEGORIES = { f: "friperie", s: "solidaire", v: "vetements" };
const OSM_TYPES = { n: "node", w: "way", r: "relation" };

const DAYS = { Mo: "lun", Tu: "mar", We: "mer", Th: "jeu", Fr: "ven", Sa: "sam", Su: "dim", PH: "jours fériés" };

// ---------- État ----------
const store = new Map();   // id → boutique (toutes les boutiques connues)
const covered = [];        // zones où les données sont complètes (L.LatLngBounds)
const markersById = new Map();
const favorites = loadFavorites();
const savedView = loadView();
let datasetReady = false;

// ---------- Carte ----------
const map = L.map("map", { zoomControl: true })
  .setView(savedView ? savedView.center : [48.8566, 2.3522], savedView ? savedView.zoom : 13);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const cluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 45, chunkedLoading: true });
map.addLayer(cluster);

// ---------- Éléments ----------
const $ = (sel) => document.querySelector(sel);
const statusEl = $("#status");
const resultsEl = $("#results");

// ---------- Utilitaires ----------
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function safeUrl(url) {
  if (!url) return null;
  const u = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try { return new URL(u).href; } catch { return null; }
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

function setLoading(on) {
  document.body.classList.toggle("loading", on);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function loadFavorites() {
  try { return new Set(JSON.parse(localStorage.getItem("friperies:favs") || "[]")); }
  catch { return new Set(); }
}
function saveFavorites() {
  try { localStorage.setItem("friperies:favs", JSON.stringify([...favorites])); } catch { /* stockage indisponible */ }
}

// Dernière position de la carte, pour rouvrir l'app au même endroit.
function loadView() {
  try { return JSON.parse(localStorage.getItem("friperies:view") || "null"); }
  catch { return null; }
}
function saveView() {
  try {
    const c = map.getCenter();
    localStorage.setItem("friperies:view", JSON.stringify({ center: [c.lat, c.lng], zoom: map.getZoom() }));
  } catch { /* stockage indisponible */ }
}
try { localStorage.removeItem("friperies:last"); } catch { /* ancienne clé, remplacée par le fichier de données */ }

function formatHours(oh) {
  if (!oh) return null;
  return oh.replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH)\b/g, (d) => DAYS[d]).replace(/;\s*/g, "<br>");
}

function formatDistance(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

// ---------- Données ----------
function makeShop({ type, id, lat, lon, name, category, address, hours, phone, website, instagram }) {
  return {
    id: `${type}/${id}`,
    lat, lon,
    name: name || "Friperie sans nom",
    category,
    address: address || "",
    hours, phone, website, instagram,
    osmUrl: `https://www.openstreetmap.org/${type}/${id}`,
  };
}

// Ligne compacte du fichier de données : [id, lat, lon, nom, catégorie, adresse, horaires, tél, site, instagram]
function fromCompact([key, lat, lon, name, cat, address, hours, phone, website, instagram]) {
  return makeShop({
    type: OSM_TYPES[key[0]], id: key.slice(1), lat, lon, name,
    category: COMPACT_CATEGORIES[cat], address, hours, phone, website, instagram,
  });
}

// Élément brut renvoyé par Overpass.
function fromOverpass(el) {
  const t = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null || lon == null) return null;
  return makeShop({
    type: el.type, id: el.id, lat, lon,
    name: t.name || t.brand,
    category: t.shop === "charity" ? "solidaire" : t.shop === "clothes" ? "vetements" : "friperie",
    address: [
      [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" "),
      [t["addr:postcode"], t["addr:city"]].filter(Boolean).join(" "),
    ].filter(Boolean).join(", "),
    hours: t.opening_hours,
    phone: t.phone || t["contact:phone"],
    website: t.website || t["contact:website"],
    instagram: t["contact:instagram"],
  });
}

function addShops(shops) {
  for (const s of shops) store.set(s.id, s);
}

async function loadDataset() {
  const res = await fetch(DATASET_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  addShops(data.shops.map(fromCompact));
  const [s, w, n, e] = data.bbox;
  covered.push(L.latLngBounds([s, w], [n, e]));
  return data;
}

async function fetchOverpass(bounds, signal) {
  const bbox = [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()].map((n) => n.toFixed(5)).join(",");
  const query = `[out:json][timeout:25][bbox:${bbox}];
(
  nwr["shop"="second_hand"];
  nwr["shop"="charity"];
  nwr["shop"="vintage"];
  nwr["shop"="clothes"]["second_hand"~"^(yes|only)$"];
);
out center tags;`;

  let lastError;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.any ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return json.elements.map(fromOverpass).filter(Boolean);
    } catch (err) {
      if (signal.aborted) throw err; // recherche remplacée par une plus récente : on arrête là
      lastError = err;
    }
  }
  throw lastError;
}

// ---------- Filtres ----------
function activeCategories() {
  return new Set([...document.querySelectorAll(".filters input[value]:checked")].map((i) => i.value));
}

// Renvoie une fonction de test, construite une fois par rendu (plus rapide sur des milliers de boutiques).
function shopFilter() {
  const cats = activeCategories();
  const favOnly = $("#fav-only").checked;
  const text = $("#list-filter").value.trim().toLowerCase();
  return (s) =>
    cats.has(s.category) &&
    (!favOnly || favorites.has(s.id)) &&
    (!text || s.name.toLowerCase().includes(text) || s.address.toLowerCase().includes(text));
}

// ---------- Marqueurs ----------
function makeIcon(shop) {
  return L.divIcon({
    className: "",
    html: `<div class="pin ${shop.category}${favorites.has(shop.id) ? " is-fav" : ""}"></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 22],
    popupAnchor: [0, -22],
  });
}

function popupHtml(shop) {
  const website = safeUrl(shop.website);
  const insta = shop.instagram ? safeUrl(shop.instagram.startsWith("http") ? shop.instagram : `instagram.com/${shop.instagram.replace(/^@/, "")}`) : null;
  const directions = `https://www.google.com/maps/dir/?api=1&destination=${shop.lat},${shop.lon}`;
  const isFav = favorites.has(shop.id);
  return `<div class="popup">
    <h3>${escapeHtml(shop.name)}</h3>
    <div class="type">${CATEGORIES[shop.category]}</div>
    ${shop.address ? `<p>📍 ${escapeHtml(shop.address)}</p>` : ""}
    ${shop.hours ? `<p>🕒 ${formatHours(escapeHtml(shop.hours))}</p>` : ""}
    ${shop.phone ? `<p>📞 <a href="tel:${escapeHtml(shop.phone.replace(/\s/g, ""))}">${escapeHtml(shop.phone)}</a></p>` : ""}
    <div class="links">
      ${website ? `<a href="${escapeHtml(website)}" target="_blank" rel="noopener">Site web</a>` : ""}
      ${insta ? `<a href="${escapeHtml(insta)}" target="_blank" rel="noopener">Instagram</a>` : ""}
      <a href="${directions}" target="_blank" rel="noopener">Itinéraire</a>
      <a href="${shop.osmUrl}" target="_blank" rel="noopener">Modifier</a>
    </div>
    <p><button class="fav-btn" data-fav="${escapeHtml(shop.id)}">${isFav ? "★ Retirer des favoris" : "☆ Ajouter aux favoris"}</button></p>
  </div>`;
}

// Chaque marqueur n'est créé qu'une fois, puis réutilisé.
function markerFor(shop) {
  let marker = markersById.get(shop.id);
  if (!marker) {
    marker = L.marker([shop.lat, shop.lon], { icon: makeIcon(shop), title: shop.name });
    marker.bindPopup(() => popupHtml(shop));
    markersById.set(shop.id, marker);
  }
  return marker;
}

// Recalcule les marqueurs affichés — uniquement quand les filtres ou les données changent,
// jamais lors d'un simple déplacement de la carte.
function refreshMarkers() {
  const keep = shopFilter();
  const layers = [];
  for (const shop of store.values()) if (keep(shop)) layers.push(markerFor(shop));
  cluster.clearLayers();
  cluster.addLayers(layers);
  renderList();
}

// ---------- Liste ----------
// Boutiques visibles à l'écran, triées par distance : un simple filtre en mémoire, instantané.
function renderList() {
  const keep = shopFilter();
  const view = map.getBounds();
  const center = map.getCenter();
  const inView = [];
  for (const shop of store.values()) {
    if (view.contains([shop.lat, shop.lon]) && keep(shop)) {
      inView.push({ shop, dist: center.distanceTo([shop.lat, shop.lon]) });
    }
  }
  inView.sort((a, b) => a.dist - b.dist);

  const frag = document.createDocumentFragment();
  for (const { shop, dist } of inView.slice(0, LIST_LIMIT)) {
    const li = document.createElement("li");
    li.dataset.id = shop.id;
    li.style.setProperty("--c", `var(--${shop.category})`);
    li.innerHTML = `<div>
        <div class="name">${escapeHtml(shop.name)}</div>
        <div class="meta">${CATEGORIES[shop.category]} · ${formatDistance(dist)}</div>
        ${shop.address ? `<div class="meta">${escapeHtml(shop.address)}</div>` : ""}
      </div>
      <button class="fav" data-fav="${escapeHtml(shop.id)}" title="Favori">${favorites.has(shop.id) ? "★" : "☆"}</button>`;
    frag.appendChild(li);
  }
  resultsEl.replaceChildren(frag);

  const n = inView.length;
  $("#count").textContent = n || "";
  if (!datasetReady && !store.size) return;
  if (n === 0) {
    setStatus(isCovered(view) || map.getZoom() >= MIN_ZOOM_FOR_LIVE
      ? "Aucune friperie dans cette zone."
      : "Zoomez sur la carte pour voir les friperies de cette zone.");
  } else {
    setStatus(`${n} boutique${n > 1 ? "s" : ""} dans cette zone${n > LIST_LIMIT ? ` (les ${LIST_LIMIT} plus proches sont listées)` : ""}.`);
  }
}

// Un seul écouteur pour toute la liste (plutôt qu'un par ligne).
resultsEl.addEventListener("click", (e) => {
  if (e.target.closest("[data-fav]")) return;
  const li = e.target.closest("li[data-id]");
  const marker = li && markersById.get(li.dataset.id);
  if (!marker) return;
  document.body.classList.remove("sidebar-open");
  cluster.zoomToShowLayer(marker, () => marker.openPopup());
});

function toggleFavorite(id) {
  favorites.has(id) ? favorites.delete(id) : favorites.add(id);
  saveFavorites();
  const shop = store.get(id);
  const marker = markersById.get(id);
  if ($("#fav-only").checked) return refreshMarkers();
  if (marker && shop) {
    marker.setIcon(makeIcon(shop));
    if (marker.isPopupOpen()) marker.setPopupContent(popupHtml(shop));
  }
  const btn = resultsEl.querySelector(`li[data-id="${CSS.escape(id)}"] .fav`);
  if (btn) btn.textContent = favorites.has(id) ? "★" : "☆";
}

// ---------- Recherche en direct (hors zone couverte par le fichier) ----------
function isCovered(bounds) {
  return covered.some((b) => b.contains(bounds));
}

let currentSearch = null;

async function liveSearch() {
  // Carte pas encore affichée (onglet en arrière-plan) : sa zone serait vide.
  if (!map.getSize().x || !map.getSize().y || !datasetReady) return;
  const view = map.getBounds();
  if (isCovered(view) || map.getZoom() < MIN_ZOOM_FOR_LIVE) return;
  if (navigator.onLine === false) return setStatus("Hors ligne : cette zone n'est pas disponible.", true);

  const bounds = view.pad(LIVE_PADDING);
  currentSearch?.abort();
  const controller = currentSearch = new AbortController();
  setStatus("Recherche des friperies en cours…");
  setLoading(true);
  try {
    const result = await fetchOverpass(bounds, controller.signal);
    if (controller !== currentSearch) return;
    addShops(result);
    covered.push(bounds);
    refreshMarkers();
  } catch (err) {
    if (controller.signal.aborted) return;
    console.error(err);
    setStatus("Impossible de récupérer les données (serveur Overpass indisponible). Déplacez la carte pour réessayer.", true);
  } finally {
    if (controller === currentSearch) {
      currentSearch = null;
      setLoading(false);
    }
  }
}
const scheduleLiveSearch = debounce(liveSearch, LIVE_SEARCH_DELAY_MS);

// ---------- Recherche de lieu ----------
async function geocode(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=fr&q=${encodeURIComponent(q)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const [place] = await res.json();
  return place;
}

$("#search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#search-input").value.trim();
  if (!q) return;
  setStatus(`Recherche de « ${q} »…`);
  setLoading(true);
  try {
    const place = await geocode(q);
    if (!place) return setStatus(`Lieu « ${q} » introuvable.`, true);
    const [s, n, w, e2] = place.boundingbox.map(Number);
    document.body.classList.remove("sidebar-open");
    // Le déplacement de la carte met la liste à jour automatiquement.
    map.fitBounds([[s, w], [n, e2]], { maxZoom: 14 });
  } catch (err) {
    console.error(err);
    setStatus("La recherche de lieu a échoué.", true);
  } finally {
    if (!currentSearch) setLoading(false);
  }
});

let userMarker = null;
$("#locate-btn").addEventListener("click", () => {
  if (!navigator.geolocation) return setStatus("La géolocalisation n'est pas disponible.", true);
  setStatus("Localisation en cours…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const here = [pos.coords.latitude, pos.coords.longitude];
      map.setView(here, 14);
      if (userMarker) userMarker.setLatLng(here);
      else userMarker = L.circleMarker(here, { radius: 7, color: "#1a73e8", fillOpacity: .8 }).addTo(map);
      document.body.classList.remove("sidebar-open");
    },
    () => setStatus("Impossible d'obtenir votre position.", true),
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

// ---------- Événements ----------
map.on("moveend", () => {
  renderList();
  saveView();
  scheduleLiveSearch();
});
map.on("resize", scheduleLiveSearch);
document.querySelectorAll(".filters input").forEach((i) => i.addEventListener("change", refreshMarkers));
$("#list-filter").addEventListener("input", debounce(refreshMarkers, 200));
$("#toggle-sidebar").addEventListener("click", () => document.body.classList.toggle("sidebar-open"));
// Icône ☰ / ✕ selon l'état de la liste (elle se ferme aussi depuis d'autres actions).
new MutationObserver(() => {
  const open = document.body.classList.contains("sidebar-open");
  $("#toggle-icon").textContent = open ? "✕" : "☰";
  $("#toggle-sidebar").setAttribute("aria-label", open ? "Fermer la liste" : "Afficher la liste");
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });

// Boutons favoris (liste et popups)
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-fav]");
  if (btn) { e.stopPropagation(); toggleFavorite(btn.dataset.fav); }
});

// ---------- Application installable (PWA) ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(console.error));
}

const installBox = $("#install-box");
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
let installPrompt = null;

// Android / Chrome / Edge : le navigateur fournit sa propre invite d'installation.
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  installBox.hidden = false;
});
$("#install-btn").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  installBox.hidden = true;
});
window.addEventListener("appinstalled", () => { installBox.hidden = true; });

// iPhone / iPad : pas d'invite automatique, on affiche la marche à suivre.
if (!isStandalone && /iphone|ipad|ipod/i.test(navigator.userAgent)) {
  installBox.hidden = false;
  $("#install-btn").hidden = true;
  $("#ios-hint").hidden = false;
}

// ---------- Démarrage ----------
(async () => {
  setStatus("Chargement des friperies…");
  setLoading(true);
  try {
    await loadDataset();
  } catch (err) {
    console.error(err); // sans le fichier, l'app bascule entièrement sur la recherche en direct
  }
  datasetReady = true;
  setLoading(false);
  refreshMarkers();
  liveSearch();
})();
