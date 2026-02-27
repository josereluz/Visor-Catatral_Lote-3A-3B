/* MINI_LEAFLET_PATTERN: soporte de hachurado (StripePattern) sin depender de CDN */
(function () {
  if (!window.L || window.L.StripePattern) return;

  function ensureDefs(renderer) {
    const svg = renderer && renderer._container;
    if (!svg) return null;
    let defs = svg.querySelector("defs");
    if (!defs) {
      defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      svg.insertBefore(defs, svg.firstChild);
    }
    return defs;
  }

  const Pattern = L.Class.extend({
    initialize: function (options) {
      this.options = options || {};
      this._id = "pat_" + Math.random().toString(16).slice(2);
      this._map = null;
      this._pattern = null;
    },
    addTo: function (map) {
      this._map = map;
      // Obtener un renderer SVG válido (del mapa o el default) y asegurar que exista su <svg>
let renderer = map._renderer;
try {
  if (!renderer) renderer = map.getRenderer(L.polyline([[0, 0], [0, 0]], { opacity: 0, interactive: false }));
} catch (e) {}
if (renderer && !renderer._container) {
  try {
    const warm = L.polyline([[0,0],[0,0]], { renderer: renderer, opacity: 0, interactive: false });
    warm.addTo(map);
    warm.remove();
  } catch (e) {}
}
      const defs = ensureDefs(renderer);
      if (!defs) return this;

      if (!this._pattern) {
        this._pattern = document.createElementNS("http://www.w3.org/2000/svg", "pattern");
        this._pattern.setAttribute("id", this._id);
        this._pattern.setAttribute("patternUnits", "userSpaceOnUse");
        defs.appendChild(this._pattern);
      }
      this._build();
      return this;
    },
    _build: function () {},
  });

  const StripePattern = Pattern.extend({
    _build: function () {
      if (!this._pattern) return;
      const o = this.options || {};
      const w = Math.max(1, Number(o.weight || 3));
      const s = Math.max(1, Number(o.spaceWeight || 7));
      const size = w + s;

      // limpiar contenido
      while (this._pattern.firstChild) this._pattern.removeChild(this._pattern.firstChild);

      this._pattern.setAttribute("width", String(size));
      this._pattern.setAttribute("height", String(size));

      const angle = Number(o.angle || 45);
      this._pattern.setAttribute("patternTransform", "rotate(" + angle + ")");

      // Fondo (space)
      const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      bg.setAttribute("x", "0");
      bg.setAttribute("y", "0");
      bg.setAttribute("width", String(size));
      bg.setAttribute("height", String(size));
      bg.setAttribute("fill", o.spaceColor || "transparent");
      bg.setAttribute("fill-opacity", String(o.spaceOpacity == null ? 0.15 : o.spaceOpacity));
      this._pattern.appendChild(bg);

      // Línea diagonal (stripe)
      const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
      // Dibuja una banda vertical; la rotación del pattern la vuelve diagonal
      line.setAttribute("d", "M 0 0 L 0 " + size);
      line.setAttribute("stroke", o.color || "#000000");
      line.setAttribute("stroke-opacity", String(o.opacity == null ? 1 : o.opacity));
      line.setAttribute("stroke-width", String(w));
      line.setAttribute("shape-rendering", "crispEdges");
      this._pattern.appendChild(line);
    },
  });

  L.Pattern = Pattern;
  L.StripePattern = StripePattern;

  // Hook SVG renderer to accept fillPattern
  const orig = L.SVG.prototype._updateStyle;
  L.SVG.include({
    _updateStyle: function (layer) {
      orig.call(this, layer);
      if (layer && layer.options && layer.options.fillPattern && layer._path) {
        const pat = layer.options.fillPattern;
        const id = pat && (pat._id || (pat._pattern && pat._pattern.getAttribute("id")));
        if (id) layer._path.setAttribute("fill", "url(#" + id + ")");
      }
    },
  });
})();

// ===== Visor Catastral – WFS (GeoJSON) =====

const GEO = {
  workspace: "Supabase_Catastro",
  wfsBase: "https://exp-visorcatastral-josereluz.publicvm.com/geoserver/Supabase_Catastro/ows",
  wfsVersion: "1.0.0",
  srsName: "EPSG:4326",

  layers: {
    manzana: "tg_manzana",
    lote: "tg_lote",
    edifica: "tg_edifica",
    construccion: "tg_construccion_2",
    puerta: "tg_puerta",
    uca: "uca",
    obra1: "obras_complementarias_1",
    obra2: "obras_complementarias_2",
    obra3: "obras_complementarias_3"
  },

  fields: {
    cod_mzna: "cod_mzna",
    cod_lote: "cod_lote",
    cod_sector: "cod_sector",
    ubigeo: "ubigeo",
    cod_piso: "cod_piso",
    puerta_visor: "visor"
  }


};

// ===== Cache (memoria + persistente) para respuestas WFS =====
// Objetivo: reducir llamadas repetidas al GeoServer (menos saturación) manteniendo WFS.
const CACHE = {
  enabled: true,
  version: "v2", // cambia si quieres invalidar toda la caché del navegador
  memoryMax: 25, // entradas
  defaultTtlMs: 24 * 60 * 60 * 1000, // 24 h
  baseTtlMs: 24 * 60 * 60 * 1000,    // capas base por distrito (24 h)
  queryTtlMs: 24 * 60 * 60 * 1000,   // consultas puntuales (24 h)
  maxEntries: 60,                    // en IndexedDB
  maxLocalBytes: 650000,             // fallback localStorage (≈0.65MB)
  maxRawBytes: 8 * 1024 * 1024,      // no persistir respuestas > 8MB (evita llenar disco)
  dbName: "visor-catastral-cache",
  storeName: "http"
};

const _memCache = new Map();   // key -> { exp:number, value:object }
const _inflight = new Map();   // key -> Promise
let _dbPromise = null;

function _now() { return Date.now(); }

// Hash corto para keys de localStorage
function _fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ("0000000" + h.toString(16)).slice(-8);
}
function _lsKey(key) { return `vcache:${CACHE.version}:${_fnv1a(key)}`; }

function cacheKey(url) {
  try {
    const u = new URL(url, location.href);
    u.searchParams.delete("_t"); // por si alguien activa nocache
    return `${CACHE.version}|${u.toString()}`;
  } catch(e) {
    return `${CACHE.version}|${url}`;
  }
}

function memCacheGet(key) {
  const it = _memCache.get(key);
  if (!it) return null;
  if (it.exp && it.exp < _now()) { _memCache.delete(key); return null; }
  // refresca orden LRU
  _memCache.delete(key); _memCache.set(key, it);
  return it.value;
}

function memCacheSet(key, value, ttlMs = CACHE.defaultTtlMs) {
  const exp = _now() + Math.max(1, ttlMs);
  _memCache.set(key, { exp, value });
  // LRU simple
  while (_memCache.size > CACHE.memoryMax) {
    const first = _memCache.keys().next().value;
    _memCache.delete(first);
  }
}

function inflightGet(key) { return _inflight.get(key) || null; }
function inflightSet(key, promise) { _inflight.set(key, promise); }
function inflightDel(key) { _inflight.delete(key); }

// --- IndexedDB (persistente) ---
function _openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("IndexedDB no disponible"));
    const req = indexedDB.open(CACHE.dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CACHE.storeName)) {
        const store = db.createObjectStore(CACHE.storeName, { keyPath: "k" });
        store.createIndex("ts", "ts", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("No se pudo abrir IndexedDB"));
  });
  return _dbPromise;
}

async function _idbGet(key) {
  const db = await _openDB();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(CACHE.storeName, "readonly");
    const st = tx.objectStore(CACHE.storeName);
    const req = st.get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function _idbSet(rec) {
  const db = await _openDB();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(CACHE.storeName, "readwrite");
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.objectStore(CACHE.storeName).put(rec);
  });
}

async function _idbDelete(key) {
  const db = await _openDB();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(CACHE.storeName, "readwrite");
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.objectStore(CACHE.storeName).delete(key);
  });
}

async function _idbPrune(maxEntries = CACHE.maxEntries) {
  const db = await _openDB();
  const now = _now();

  // Mantener los *más nuevos* (ts más alto) y borrar expirados / antiguos.
  await new Promise((resolve, reject) => {
    const tx = db.transaction(CACHE.storeName, "readwrite");
    const st = tx.objectStore(CACHE.storeName);
    const idx = st.index("ts");

    // Cursor en orden DESC (más nuevo -> más viejo)
    const req = idx.openCursor(null, "prev");
    let kept = 0;

    req.onsuccess = (ev) => {
      const cur = ev.target.result;
      if (!cur) { resolve(true); return; }

      const val = cur.value;

      // borrar expirados siempre
      if (val && val.exp && val.exp < now) {
        cur.delete();
        cur.continue();
        return;
      }

      // mantener los N más nuevos; borrar el resto (más viejos)
      kept++;
      if (kept > maxEntries) {
        cur.delete();
      }
      cur.continue();
    };

    req.onerror = () => reject(req.error);
    tx.onerror = () => reject(tx.error);
  });
}


// --- LocalStorage fallback (solo respuestas pequeñas) ---
function _lsGet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.exp || !obj.raw) return null;
    if (obj.exp < _now()) { localStorage.removeItem(key); return null; }
    return obj.raw;
  } catch(e) { return null; }
}

function _lsSet(key, raw, ttlMs) {
  try {
    if (raw.length > CACHE.maxLocalBytes) return false;
    const exp = _now() + Math.max(1, ttlMs);
    localStorage.setItem(key, JSON.stringify({ exp, raw }));
    return true;
  } catch(e) { return false; }
}

async function cacheGetPersistent(key) {
  // 1) IndexedDB
  try {
    const rec = await _idbGet(key);
    if (rec && rec.exp && rec.exp >= _now() && rec.raw) return JSON.parse(rec.raw);
    if (rec && rec.exp && rec.exp < _now()) { try { await _idbDelete(key); } catch(e) {} }
  } catch(e) {
    // 2) localStorage fallback
    const ls = _lsGet(_lsKey(key));
    if (ls) return JSON.parse(ls);
  }
  return null;
}

async function cacheSetPersistent(key, raw, ttlMs) {
  if (raw && raw.length > CACHE.maxRawBytes) return false;
  const rec = { k: key, ts: _now(), exp: _now() + Math.max(1, ttlMs), raw };
  // Intento IndexedDB
  try {
    await _idbSet(rec);
    await _idbPrune();
    return true;
  } catch(e) {
    // fallback localStorage (solo pequeño)
    _lsSet(_lsKey(key), raw, ttlMs);
    return false;
  }
}

async function cacheClearAll() {
  _memCache.clear();
  _inflight.clear();
  try {
    const db = await _openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE.storeName, "readwrite");
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.objectStore(CACHE.storeName).clear();
    });
  } catch(e) {}
  try {
    const prefix = `vcache:${CACHE.version}:`;
    Object.keys(localStorage).forEach((k) => { if (k.startsWith(prefix)) localStorage.removeItem(k); });
  } catch(e) {}
}

// Útil para depurar: en consola ejecuta window.__visorClearCache()
window.__visorClearCache = cacheClearAll;

// ===== Patrones para obras complementarias (Leaflet.Pattern) =====
// Se crean bajo demanda y se cachean por color.
const OBRA_PATTERN_CACHE = {
  stripes: new Map()
};

function mirrorPatternToOverlaySvg(pat) {
  // Asegura que el <pattern> exista dentro del SVG del renderer overlaySvg,
  // porque el relleno url(#id) solo funciona si el patrón está en el mismo <svg>.
  try {
    if (!pat || !pat._id || !pat._pattern) return;
    if (typeof RENDERERS === "undefined" || !RENDERERS.overlaySvg || !RENDERERS.overlaySvg._container) return;

    const svg = RENDERERS.overlaySvg._container;
    let defs = svg.querySelector("defs");
    if (!defs) {
      defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      svg.insertBefore(defs, svg.firstChild);
    }

    const existing = defs.querySelector("#" + pat._id);
    if (existing) existing.remove();

    // Clonar el patrón generado y meterlo al defs del overlaySvg
    const cloned = pat._pattern.cloneNode(true);
    cloned.setAttribute("id", pat._id);
    defs.appendChild(cloned);
  } catch (e) {}
}

function ensureSvgReady() {
  // Fuerza la creación del SVG interno para patrones (sin afectar visualmente)
  if (ensureSvgReady._done) return;
  try {
    const warm = L.polyline([[0,0],[0,0]], { renderer: RENDERERS.overlaySvg, opacity: 0, interactive: false, pane: "extrasPane" });
    warm.addTo(map);
    warm.remove();
  } catch (e) {}
  ensureSvgReady._done = true;
}

function getStripePattern(color, bgOpacity = 0.18) {
  // Devuelve un patrón de franjas (leaflet.pattern) o null si el plugin no está disponible
  if (!color) color = "#6a5acd";
  const key = String(color).toLowerCase() + "|" + String(bgOpacity);

  if (OBRA_PATTERN_CACHE.stripes.has(key)) return OBRA_PATTERN_CACHE.stripes.get(key);

  // Si el plugin no cargó, no lanzar error: usar estilo normal
  if (typeof L === "undefined" || typeof L.StripePattern !== "function") {
    OBRA_PATTERN_CACHE.stripes.set(key, null);
    return null;
  }

  ensureSvgReady();

  const pat = new L.StripePattern({
    // Líneas diagonales como detalle, manteniendo "fondo" (tinte) del mismo color
    weight: 3,
    spaceWeight: 7,
    color: darkenHex(color, 0.35),
    opacity: 1,
    spaceColor: color,
    spaceOpacity: bgOpacity,
    angle: 45
  });
try { pat.addTo(map); } catch (e) {}
  mirrorPatternToOverlaySvg(pat);
  OBRA_PATTERN_CACHE.stripes.set(key, pat);
  return pat;
}

// ===== Reglas de visibilidad por zoom =====
const MANZANA_LABEL_MIN_ZOOM = 16; // Mostrar etiqueta de manzana desde este zoom // Mostrar etiqueta de manzana desde este zoom
const LOTE_LABEL_MIN_ZOOM = 19;    // Mostrar etiqueta de lote desde este zoom
const DOOR_MIN_ZOOM = 20;          // Mostrar/cargar puertas desde este zoom

// ===== Estado para Leyenda y Resaltado =====
let obrasGeoJSON = { 1: null, 2: null, 3: null };
let obrasLegend = { 1: null, 2: null, 3: null };

// ===== Helpers =====
function openPopupAt(html, latlng) {
  const ll = latlng || map.getCenter();
  L.popup({ maxWidth: 340 }).setLatLng(ll).setContent(html).openOn(map);
}

function escapeCql(s) { return String(s).replaceAll("'", "''"); }
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function wfsUrl(typeName, opts = {}) {
  const p = new URLSearchParams({
    service: "WFS",
    version: GEO.wfsVersion,
    request: "GetFeature",
    typeName: `${GEO.workspace}:${typeName}`,
    outputFormat: "application/json",
    srsName: GEO.srsName
  });
  if (opts.maxFeatures) p.set("maxFeatures", String(opts.maxFeatures));
  if (opts.cql) p.set("CQL_FILTER", opts.cql);
  if (opts.bbox) p.set("bbox", `${opts.bbox.join(",")},${GEO.srsName}`);
  if (opts.nocache) p.set("_t", String(Date.now()));
  return `${GEO.wfsBase}?${p.toString()}`;
}
async function fetchGeoJSON(url, options = {}) {
  const ttlMs =
    typeof options.ttlMs === "number" ? options.ttlMs : CACHE.defaultTtlMs;
  const force = !!options.force;
  const signal = options.signal;

  // Cache key: versioned + URL (sin parámetros volátiles)
  const key = cacheKey(url);

  // 1) Memoria
  if (CACHE.enabled && !force) {
    const mem = memCacheGet(key);
    if (mem) return mem;
  }

  // 2) Persistente (IndexedDB -> localStorage fallback)
  if (CACHE.enabled && !force) {
    try {
      const hit = await cacheGetPersistent(key);
      if (hit) {
        // Guardar también en memoria para la sesión
        memCacheSet(key, hit, ttlMs);
        return hit;
      }
    } catch (e) {
      // Si falla la caché persistente, seguimos normal
    }
  }

  // 3) Dedupe de requests en vuelo
  if (CACHE.enabled && !force) {
    const inflight = inflightGet(key);
    if (inflight) return inflight;
  }

  const task = (async () => {
    const r = await fetch(url, {
      cache: "no-store",
      signal,
      headers: { Accept: "application/json" }
    });

    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    const raw = await r.text();
    if (!ct.includes("json")) {
      throw new Error(`No JSON: ${raw.slice(0, 120)}`);
    }

    let gj;
    try {
      gj = JSON.parse(raw);
    } catch (e) {
      throw new Error(`JSON inválido: ${raw.slice(0, 120)}`);
    }
    if (!gj || !Array.isArray(gj.features)) throw new Error("GeoJSON inválido");

    // Persistir (best-effort)
    if (CACHE.enabled && !force) {
      try {
        await cacheSetPersistent(key, raw, ttlMs);
      } catch (e) {
        // ignorar
      }
      memCacheSet(key, gj, ttlMs);
    }

    return gj;
  })();

  if (CACHE.enabled && !force) inflightSet(key, task);

  try {
    return await task;
  } finally {
    inflightDel(key);
  }
}
function popupHtml(title, props) {
  const keys = Object.keys(props || {}).slice(0, 40);
  let html = `<div class="popup-attrs"><h4 style="text-align:center;">${escapeHtml(title)}</h4><table>`;
  keys.forEach(k => {
    const v = props[k];
    if (v === null || v === undefined || String(v) === "") return;
    html += `<tr><td class="key">${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`;
  });
  html += "</table></div>";
  return html;
}

// ===== Map init =====
const map = L.map("map", {
  center: [-11.979215012270718, -77.06288307210372],
  zoom: 16,
  preferCanvas: true,
  boxZoom: false,
  zoomControl: false
});

// Base maps
const baseOSM = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 22,
  attribution: "© OpenStreetMap contributors"
});

const baseGoogleSat = L.tileLayer("https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}", {
  maxZoom: 22,
  attribution: "Imagery © Google"
});

// Mapa base claro (similar al estilo "gris" de la captura)
// CARTO Positron (light_all)
const baseCartoLight = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  maxZoom: 22,
  subdomains: "abcd",
  attribution: "© OpenStreetMap contributors, © CARTO"
});

// Base inicial predeterminada
baseCartoLight.addTo(map);


// Basemap control (colapsable hacia la derecha)
const BasemapBox = L.Control.extend({
  options: { position: "topright" },
  onAdd: function () {
    const div = L.DomUtil.create("div", "leaflet-control basemap-box");
    div.innerHTML = `
      <div class="basemap-header">
        <div class="title">Mapa base</div>
        <button type="button" class="basemap-toggle" aria-expanded="true" title="Contraer">▸</button>
      </div>
      <div class="basemap-options">
        <label><input type="radio" name="basemap" value="osm"> OSM</label>
        <label><input type="radio" name="basemap" value="light" checked> Mapa claro</label>
        <label><input type="radio" name="basemap" value="sat"> Google satelital</label>
      </div>
    `;
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);

    // Toggle contraer / expandir
    const btn = div.querySelector(".basemap-toggle");
    if (btn) {
      btn.addEventListener("click", (e) => {
        L.DomEvent.stop(e);
        div.classList.toggle("collapsed");
        const collapsed = div.classList.contains("collapsed");
        btn.textContent = collapsed ? "◂" : "▸";
        btn.title = collapsed ? "Expandir" : "Contraer";
        btn.setAttribute("aria-expanded", String(!collapsed));
      });
    }

    return div;
  }
});
map.addControl(new BasemapBox());

// ===== Leyenda (dinámica) =====
let _legendDiv = null;

function legendItemSwatch(color, kind = "line") {
  const safe = escapeHtml(color);
  if (kind === "point") return `<span class="lg-swatch lg-point" style="background:${safe};border-color:${safe};"></span>`;
  if (kind === "poly") return `<span class="lg-swatch lg-poly" style="background:${safe};border-color:${safe};"></span>`;
  return `<span class="lg-swatch lg-line" style="border-color:${safe};"></span>`;
}

function updateLegend() {
  if (!_legendDiv) return;
  const body = _legendDiv.querySelector(".legend-body");
  if (!body) return;

  const isOn = (id) => {
    const el = document.getElementById(id);
    return !!(el && el.checked);
  };

  const parts = [];

  // ===== Capas base (solo si están activas) =====
  const baseRows = [];
  if (isOn("layer-base-manzana")) {
    baseRows.push(`<div class="legend-row">${legendItemSwatch("#ff00ff","line")}<span>Manzana</span></div>`);
  }
  if (isOn("layer-base-lote")) {
    baseRows.push(`<div class="legend-row">${legendItemSwatch("#ffd400","line")}<span>Lote</span></div>`);
  }
  if (isOn("layer-base-edifica")) {
    baseRows.push(`<div class="legend-row">${legendItemSwatch("#cc0000","line")}<span>Edifica</span></div>`);
  }
  if (baseRows.length) {
    parts.push(`<div class="legend-section">
      <div class="legend-sec-title">Capas base</div>
      ${baseRows.join("")}
    </div>`);
  }

  // ===== Obras complementarias (solo si están activas) =====
  for (const which of [1, 2, 3]) {
    if (!isOn(`layer-obra-${which}`)) continue;

    const meta = obrasLegend[which];
    const title = meta?.title || `Obra complementaria ${which}`;
    const tf = meta?.typeField || null;
    const colors = meta?.typeColors || null;
    const defaultColor = meta?.defaultColor || (which === 1 ? "#6a5acd" : which === 2 ? "#009688" : "#f39c12");

    let html = `<div class="legend-section">
      <div class="legend-sec-title">${escapeHtml(title)}</div>`;

    // Si aún no cargó la metadata (está “encendida” pero en carga)
    if (!meta) {
      const kind = (which === 3) ? "point" : (which === 2 ? "line" : "poly");
      html += `<div class="legend-row">${legendItemSwatch(defaultColor, kind)}<span>${escapeHtml(title)} <span class="muted">(cargando…)</span></span></div>`;
      html += `</div>`;
      parts.push(html);
      continue;
    }

    if (tf && colors && colors.size) {
      const entries = Array.from(colors.entries());
      // Mostrar hasta 12 para no hacer gigante
      const shown = entries.slice(0, 12);
      const kind = (which === 3) ? "point" : (which === 2 ? "line" : "poly");
      shown.forEach(([k, c]) => {
        html += `<div class="legend-row">${legendItemSwatch(c, kind)}<span>${escapeHtml(formatObraType(which, k))}</span></div>`;
      });
      if (entries.length > shown.length) {
        html += `<div class="legend-row legend-more">… ${entries.length - shown.length} más</div>`;
      }    } else {
      const kind = (which === 3) ? "point" : (which === 2 ? "line" : "poly");
      html += `<div class="legend-row">${legendItemSwatch(defaultColor, kind)}<span>${escapeHtml(title)}</span></div>`;
    }

    html += `</div>`;
    parts.push(html);
  }

  if (!parts.length) {
    body.innerHTML = `<div class="legend-empty">Activa una capa para ver la leyenda.</div>`;
    return;
  }

  body.innerHTML = parts.join("");
}

const LegendBox = L.Control.extend({
  options: { position: "bottomright" },
  onAdd: function () {
    const div = L.DomUtil.create("div", "leaflet-control legend-box");
    div.innerHTML = `
      <div class="legend-header">
        <div class="title">Leyenda</div>
        <button type="button" class="legend-toggle" aria-expanded="true" title="Contraer">▾</button>
      </div>
      <div class="legend-body"></div>
    `;

    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);

    const btn = div.querySelector(".legend-toggle");
    btn?.addEventListener("click", (e) => {
      L.DomEvent.stop(e);
      div.classList.toggle("collapsed");
      const collapsed = div.classList.contains("collapsed");
      btn.textContent = collapsed ? "▸" : "▾";
      btn.title = collapsed ? "Expandir" : "Contraer";
      btn.setAttribute("aria-expanded", String(!collapsed));
    });

    _legendDiv = div;
    updateLegend();
    return div;
  }
});
map.addControl(new LegendBox());


// Controles esquina superior izquierda: Zoom + Norte (a la derecha) + Ayuda (debajo)
const CornerControl = L.Control.extend({
  options: { position: "topleft" },
  onAdd: function () {
    const container = L.DomUtil.create("div", "leaflet-control corner-control");
    container.innerHTML = `
      <div class="leaflet-bar corner-zoom" aria-label="Zoom">
        <a class="corner-zoom-in" href="#" title="Acercar" role="button" aria-label="Acercar">+</a>
        <a class="corner-zoom-out" href="#" title="Alejar" role="button" aria-label="Alejar">−</a>
      </div>
      <div class="leaflet-bar corner-north" title="Norte" aria-label="Norte">
        <svg class="corner-north-svg" width="28" height="28" viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r="46" fill="white" opacity="0.92"/>
          <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" stroke-width="6"/>
          <path d="M50 12 L62 52 L50 44 L38 52 Z" fill="currentColor"/>
          <path d="M50 88 L38 48 L50 56 L62 48 Z" fill="currentColor" opacity="0.18"/>
          <text x="50" y="78" text-anchor="middle" font-size="26" font-family="system-ui,Segoe UI,Arial" font-weight="800" fill="currentColor">N</text>
        </svg>
      </div>
      <div class="leaflet-bar corner-help" aria-label="Información">
        <a class="corner-help-btn" href="#" title="Información" role="button" aria-label="Información">?</a>
        <div class="help-popover" hidden>
          <div class="help-title">Información:</div>
          <div class="help-line">Visor Catastral creado en marco del Proyecto Catastro Urbano Nacional, Lote 3A-3B - Exp Consorcio Canadience.</div>
          <div class="help-line"><strong>Creado por:</strong> Jose Antonio Reluz Tenazoa</div>
          <div class="help-line"><strong>Dudas o sugerencia:</strong> 990045316</div>
        </div>
      </div>
      <div class="leaflet-bar corner-refresh" aria-label="Actualizar capas">
        <a class="corner-refresh-btn" href="#" title="Actualizar capas" role="button" aria-label="Actualizar capas">⟳</a>
      </div>
      <div class="leaflet-bar corner-locate" aria-label="Mi ubicación">
        <a class="corner-locate-btn" href="#" title="Ir a mi ubicación" role="button" aria-label="Ir a mi ubicación">📍</a>
      </div>
    `;

    L.DomEvent.disableClickPropagation(container);

    const zoomIn = container.querySelector(".corner-zoom-in");
    const zoomOut = container.querySelector(".corner-zoom-out");
    const helpBtn = container.querySelector(".corner-help-btn");
    const helpPopover = container.querySelector(".help-popover");
    const refreshBtn = container.querySelector(".corner-refresh-btn");
    const locateBtn = container.querySelector(".corner-locate-btn");

    if (zoomIn) {
      zoomIn.addEventListener("click", (e) => {
        L.DomEvent.stop(e);
        map.zoomIn();
      });
    }
    if (zoomOut) {
      zoomOut.addEventListener("click", (e) => {
        L.DomEvent.stop(e);
        map.zoomOut();
      });
    }

    // Ayuda: abre/cierra panel
    const closeHelp = () => {
      if (helpPopover) helpPopover.hidden = true;
    };
    if (helpBtn && helpPopover) {
      helpBtn.addEventListener("click", (e) => {
        L.DomEvent.stop(e);
        helpPopover.hidden = !helpPopover.hidden;
      });
      // Cerrar al hacer click en el mapa
      map.on("click", closeHelp);
      map.on("movestart", closeHelp);
    }


    // Actualizar capas: limpia caché y recarga el distrito actual
    if (refreshBtn) {
      refreshBtn.addEventListener("click", async (e) => {
        L.DomEvent.stop(e);

        const ub = (searchDistrito && searchDistrito.value) || _currentUbigeo || "";

        // Si justo se está cargando, abortamos y recargamos (evita estados intermedios)
        if (typeof _baseLoading !== "undefined" && _baseLoading) {
          try { if (_baseAbort) _baseAbort.abort(); } catch(_) {}
          try { if (typeof cacheClearAll === "function") await cacheClearAll(); } catch(_) {}
          location.reload();
          return;
        }

        try { if (typeof cacheClearAll === "function") await cacheClearAll(); } catch(_) {}

        // Fuerza recarga aunque sea el mismo distrito
        try { _baseLoaded = false; } catch(_) {}
        try { _currentUbigeo = null; } catch(_) {}

        if (ub) {
          try { await loadBaseForUbigeo(ub); } catch(_) { location.reload(); return; }
          try { focusDistrict(ub); } catch(_) {}
        } else {
          location.reload();
        }
      });
    }

// Mi ubicación: centra el mapa en tu posición actual
let _locMarker = null;
let _locCircle = null;

function _clearLoc() {
  if (_locMarker) { map.removeLayer(_locMarker); _locMarker = null; }
  if (_locCircle) { map.removeLayer(_locCircle); _locCircle = null; }
}

map.on("locationfound", (ev) => {
  _clearLoc();
  _locCircle = L.circle(ev.latlng, { radius: ev.accuracy, color: "#2563eb", weight: 2, fillColor: "#60a5fa", fillOpacity: 0.15 }).addTo(map);
  _locMarker = L.circleMarker(ev.latlng, { radius: 6, color: "#2563eb", weight: 2, fillColor: "#2563eb", fillOpacity: 1 }).addTo(map);
});

map.on("locationerror", (ev) => {
  _clearLoc();
  alert("No se pudo obtener tu ubicación. Verifica permisos de ubicación en el navegador.");
});

if (locateBtn) {
  locateBtn.addEventListener("click", (e) => {
    L.DomEvent.stop(e);
    map.locate({ setView: true, maxZoom: Math.max(map.getZoom(), 18), enableHighAccuracy: true, timeout: 10000 });
  });
}

return container;
  }
});
map.addControl(new CornerControl());




// Scale
L.control.scale({ position: "bottomleft", imperial: false }).addTo(map);

// Control de medición personalizado
const MeasureControl = L.Control.extend({
  options: { position: "bottomleft" },
  onAdd: function() {
    const container = L.DomUtil.create("div", "leaflet-control measure-control");
    container.innerHTML = `
      <button class="measure-btn measure-btn-distance" data-mode="distance" title="Medir distancia">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 6L3 6M3 6L3 18M3 18L21 18M21 18L21 6M7 10L7 14M11 10L11 14M15 10L15 14M19 10L19 14"/>
        </svg>
        <span class="measure-text">Medir distancia</span>
      </button>
      <button class="measure-btn measure-btn-area" data-mode="area" title="Medir área">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M4 4h16v16H4z"/>
          <path d="M8 8h8v8H8z" opacity="0.25"/>
        </svg>
        <span class="measure-text">Medir área</span>
      </button>
    `;
    
    L.DomEvent.disableClickPropagation(container);
    
    return container;
  }
});

map.addControl(new MeasureControl());

// Variables para medición
let measuring = false;
let measureMode = "distance"; // "distance" | "area"
let measureLine = null;
let measurePolygon = null;
let measureMarkers = [];
let measurePoints = [];
// Función para formatear distancia
function formatDistance(meters) {
  if (meters < 1000) {
    return meters.toFixed(2) + " m";
  }
  return (meters / 1000).toFixed(2) + " km";
}


// Función para formatear área
function formatArea(m2) {
  if (m2 < 10000) return m2.toFixed(2) + " m²";
  if (m2 < 1000000) return (m2 / 10000).toFixed(2) + " ha";
  return (m2 / 1000000).toFixed(4) + " km²";
}

// Área geodésica (adaptado de Leaflet.Draw)
function geodesicArea(latLngs) {
  const d2r = Math.PI / 180;
  const radius = 6378137;
  let area = 0.0;
  const len = latLngs.length;
  if (len < 3) return 0;
  for (let i = 0; i < len; i++) {
    const p1 = latLngs[i];
    const p2 = latLngs[(i + 1) % len];
    area += ((p2.lng - p1.lng) * d2r) * (2 + Math.sin(p1.lat * d2r) + Math.sin(p2.lat * d2r));
  }
  area = area * radius * radius / 2.0;
  return Math.abs(area);
}


// Click en botones de medición (distancia / área)
document.addEventListener("click", (e) => {
  const btn = (e.target && (e.target.classList.contains("measure-btn") || e.target.closest(".measure-btn")))
    ? (e.target.classList.contains("measure-btn") ? e.target : e.target.closest(".measure-btn"))
    : null;
  if (!btn) return;

  const mode = btn.getAttribute("data-mode") || "distance";

  // Si está activo y vuelves a hacer click en el mismo modo -> apagar
  if (measuring && measureMode === mode) {
    measuring = false;
  } else {
    measuring = true;
    measureMode = mode;
  }

  const distBtn = document.querySelector(".measure-btn-distance");
  const areaBtn = document.querySelector(".measure-btn-area");

  const setActive = (el, active) => {
    if (!el) return;
    if (active) {
      el.classList.add("is-active");
    } else {
      el.classList.remove("is-active");
    }
  };

  setActive(distBtn, measuring && measureMode === "distance");
  setActive(areaBtn, measuring && measureMode === "area");

  if (measuring) {
    map.getContainer().style.cursor = "crosshair";
    try { map.doubleClickZoom.disable(); } catch(_) {}
  } else {
    map.getContainer().style.cursor = "";
    try { map.doubleClickZoom.enable(); } catch(_) {}

    // Limpiar mediciones
    if (measureLine) map.removeLayer(measureLine);
    if (measurePolygon) map.removeLayer(measurePolygon);
    measureMarkers.forEach(m => map.removeLayer(m));
    measureLine = null;
    measurePolygon = null;
    measureMarkers = [];
    measurePoints = [];
    map.closePopup();
  }
});

// Click en el mapa para medir
map.on("click", function(e) {
  if (!measuring) return;

  // En modo área, no queremos que el doble click haga zoom mientras medimos
  if (measureMode === "area") {
    try { map.doubleClickZoom.disable(); } catch(_) {}
  }

  measurePoints.push(e.latlng);

  // Agregar marcador
  const marker = L.circleMarker(e.latlng, {
    radius: 5,
    color: "#e74c3c",
    fillColor: "#e74c3c",
    fillOpacity: 1,
    weight: 2
  }).addTo(map);
  measureMarkers.push(marker);

  // Distancia
  if (measureMode === "distance") {
    if (measurePoints.length >= 2) {
      if (measureLine) map.removeLayer(measureLine);

      let totalDistance = 0;
      for (let i = 0; i < measurePoints.length - 1; i++) {
        totalDistance += measurePoints[i].distanceTo(measurePoints[i + 1]);
      }

      measureLine = L.polyline(measurePoints, {
        color: "#e74c3c",
        weight: 3,
        dashArray: "10, 10"
      }).addTo(map);

      const lastPoint = measurePoints[measurePoints.length - 1];
      L.popup({
        closeButton: true,
        autoClose: false,
        closeOnClick: false,
        className: "measure-popup"
      })
        .setLatLng(lastPoint)
        .setContent(`<div class="measure-card"><div class="measure-label">Distancia</div><div class="measure-value">${formatDistance(totalDistance)}</div></div>`)
        .openOn(map);
    }
    return;
  }

  // Área (preview): solo dibuja/actualiza el polígono, sin cerrar la medición
  if (measureMode === "area") {
    if (measurePoints.length >= 2) {
      if (measureLine) map.removeLayer(measureLine);
      measureLine = L.polyline(measurePoints, {
        color: "#e74c3c",
        weight: 2.5,
        dashArray: "8, 8"
      }).addTo(map);
    }

    if (measurePoints.length >= 3) {
      if (measurePolygon) map.removeLayer(measurePolygon);
      measurePolygon = L.polygon(measurePoints, {
        color: "#e74c3c",
        weight: 2.5,
        dashArray: "8, 8",
        fillColor: "#e74c3c",
        fillOpacity: 0.08
      }).addTo(map);
    }
  }
});

// Doble click: cierra la medición de área y muestra el resultado
map.on("dblclick", function(e) {
  if (!measuring) return;
  if (measureMode !== "area") return;

  // Evitar zoom por doble click
  if (e && e.originalEvent) {
    try { L.DomEvent.stop(e.originalEvent); } catch(_) {}
  }
  try { map.doubleClickZoom.disable(); } catch(_) {}

  if (measurePoints.length < 3) return;

  const area = geodesicArea(measurePoints);

  // Asegurar polígono final
  if (measurePolygon) map.removeLayer(measurePolygon);
  measurePolygon = L.polygon(measurePoints, {
    color: "#e74c3c",
    weight: 2.5,
    dashArray: "8, 8",
    fillColor: "#e74c3c",
    fillOpacity: 0.10
  }).addTo(map);

  const lastPoint = measurePoints[measurePoints.length - 1];
  L.popup({
    closeButton: true,
    autoClose: false,
    closeOnClick: false,
    className: "measure-popup"
  })
    .setLatLng(lastPoint)
    .setContent(`<div class="measure-card"><div class="measure-label">Área</div><div class="measure-value">${formatArea(area)}</div></div>`)
    .openOn(map);

  // Finalizar modo medición (limpieza se hará al cerrar popup)
  measuring = false;
  const distBtn = document.querySelector(".measure-btn-distance");
  const areaBtn = document.querySelector(".measure-btn-area");
  if (distBtn) distBtn.classList.remove("is-active");
  if (areaBtn) areaBtn.classList.remove("is-active");
  map.getContainer().style.cursor = "";
});


// Limpiar mediciones al cerrar popup
map.on("popupclose", function(e) {
  if (e.popup && e.popup.getElement && e.popup.getElement().classList.contains("measure-popup")) {
    if (measureLine) map.removeLayer(measureLine);
    if (measurePolygon) map.removeLayer(measurePolygon);
    measureMarkers.forEach(m => map.removeLayer(m));
    measureLine = null;
    measurePolygon = null;
    measureMarkers = [];
    measurePoints = [];
    measuring = false;

    // Rehabilitar doble click zoom
    try { map.doubleClickZoom.enable(); } catch(_) {}

    const distBtn = document.querySelector(".measure-btn-distance");
    const areaBtn = document.querySelector(".measure-btn-area");
    if (distBtn) distBtn.classList.remove("is-active");
    if (areaBtn) areaBtn.classList.remove("is-active");
    map.getContainer().style.cursor = "";
  }
});
// ===== Geometría: punto-en-polígono (para clicks precisos) =====
function _normPolys(latlngs) {
  if (!Array.isArray(latlngs) || latlngs.length === 0) return [];
  const a0 = latlngs[0];
  // Ring: [LatLng, LatLng, ...]
  if (a0 && typeof a0.lat === "number" && typeof a0.lng === "number") {
    return [{ outer: latlngs, holes: [] }];
  }
  // Polygon: [ringOuter, hole1, hole2...]
  if (Array.isArray(a0) && a0.length && a0[0] && typeof a0[0].lat === "number") {
    return [{ outer: latlngs[0], holes: latlngs.slice(1) }];
  }
  // MultiPolygon
  let out = [];
  latlngs.forEach(p => { out = out.concat(_normPolys(p)); });
  return out;
}

function _pointInRing(pt, ring) {
  const x = pt.lng, y = pt.lat;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lng, yi = ring[i].lat;
    const xj = ring[j].lng, yj = ring[j].lat;
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-16) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function _ringArea(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lng, yi = ring[i].lat;
    const xj = ring[j].lng, yj = ring[j].lat;
    area += (xj * yi - xi * yj);
  }
  return area / 2;
}

function _polygonArea(latlngs) {
  const polys = _normPolys(latlngs);
  let total = 0;
  for (const poly of polys) {
    let a = Math.abs(_ringArea(poly.outer));
    for (const h of poly.holes) a -= Math.abs(_ringArea(h));
    total += Math.max(a, 0);
  }
  return total;
}

function _pointInPolygon(pt, latlngs) {
  const polys = _normPolys(latlngs);
  for (const poly of polys) {
    if (!_pointInRing(pt, poly.outer)) continue;
    let inHole = false;
    for (const h of poly.holes) {
      if (_pointInRing(pt, h)) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}


// Event handler global para clicks en capas interactivas
map.on("click", function(e) {

  // --- Helpers de "hit test" (prioridad por capa y precisión geométrica) ---
  function _flattenLatLngs(latlngs) {
    // Devuelve un arreglo de "rings" (cada ring: [LatLng, LatLng, ...])
    // Soporta Polygon/MultiPolygon (anidación variable)
    const rings = [];
    (function walk(x) {
      if (!x) return;
      if (Array.isArray(x) && x.length && x[0] && typeof x[0].lat === "number") {
        rings.push(x);
      } else if (Array.isArray(x)) {
        x.forEach(walk);
      }
    })(latlngs);
    return rings;
  }

  function _distPointToSegment(p, a, b) {
    // Distancia punto-segmento en pixeles (p, a, b son L.Point)
    const vx = b.x - a.x, vy = b.y - a.y;
    const wx = p.x - a.x, wy = p.y - a.y;
    const c1 = vx * wx + vy * wy;
    if (c1 <= 0) return Math.hypot(p.x - a.x, p.y - a.y);
    const c2 = vx * vx + vy * vy;
    if (c2 <= c1) return Math.hypot(p.x - b.x, p.y - b.y);
    const t = c1 / c2;
    const px = a.x + t * vx, py = a.y + t * vy;
    return Math.hypot(p.x - px, p.y - py);
  }

  function _hitPolyline(latlngs, latlng, pxTol) {
    const p = map.latLngToLayerPoint(latlng);
    const rings = _flattenLatLngs(latlngs);
    let best = Infinity;
    for (const ring of rings) {
      for (let i = 0; i < ring.length - 1; i++) {
        const a = map.latLngToLayerPoint(ring[i]);
        const b = map.latLngToLayerPoint(ring[i + 1]);
        best = Math.min(best, _distPointToSegment(p, a, b));
        if (best <= pxTol) return true;
      }
    }
    return best <= pxTol;
  }

  function _pickBestFromLayerGroup(layerGroup, getPayload) {
    if (!layerGroup || !map.hasLayer(layerGroup) || !layerGroup.eachLayer) return null;

    let best = null;
    let bestArea = Infinity;

    layerGroup.eachLayer((lyr) => {
      if (!lyr) return;

      // 1) Puntos (Markers/CircleMarkers)
      if (lyr.getLatLng && typeof lyr.getLatLng === "function") {
        const d = lyr.getLatLng().distanceTo(e.latlng); // metros
        if (d <= 8) {
          const payload = getPayload(lyr);
          if (payload) best = { lyr, payload, area: 0 };
        }
        return;
      }

      // 2) Polígonos/Líneas
      if (lyr.getBounds && !lyr.getBounds().contains(e.latlng)) return;
      if (!lyr.getLatLngs) return;

      const latlngs = lyr.getLatLngs();

      // Polígono: punto-en-polígono real
      if (lyr instanceof L.Polygon) {
        if (_pointInPolygon(e.latlng, latlngs)) {
          const a = _polygonArea(latlngs);
          const payload = getPayload(lyr);
          if (payload && a < bestArea) {
            bestArea = a;
            best = { lyr, payload, area: a };
          }
        }
        return;
      }

      // Línea: distancia en pixeles al segmento
      if (lyr instanceof L.Polyline) {
        if (_hitPolyline(latlngs, e.latlng, 6)) {
          const payload = getPayload(lyr);
          if (payload) best = { lyr, payload, area: bestArea };
        }
      }
    });

    return best;
  }

  // --- PRIORIDAD 1: Obras complementarias (si están activas) ---
  const pickObra = (layer) =>
    _pickBestFromLayerGroup(layer, (lyr) => {
      const layerId = L.Util.stamp(lyr);
      const data = obrasData.get(layerId);
      return data ? { title: data.title, properties: data.properties } : null;
    });

  let obraHit = pickObra(obras1Layer) || pickObra(obras2Layer) || pickObra(obras3Layer);
  if (obraHit) {
    try { selectGeoJSON(obraHit.lyr && obraHit.lyr.toGeoJSON ? obraHit.lyr.toGeoJSON() : null); } catch(e) {}
    const html = popupHtml(obraHit.payload.title, obraHit.payload.properties);
    L.popup({ maxWidth: 340 })
      .setLatLng(e.latlng)
      .setContent(html)
      .openOn(map);
    return;
  }

  // --- PRIORIDAD 2: UCA (si está activa) ---
  const ucaHit = _pickBestFromLayerGroup(ucaLayer, (lyr) => {
    const layerId = L.Util.stamp(lyr);
    const props = ucaData.get(layerId);
    return props ? { title: "UCA", properties: props } : null;
  });

  if (ucaHit) {
    const html = popupHtml(ucaHit.payload.title, ucaHit.payload.properties);
    L.popup({ maxWidth: 340 })
      .setLatLng(e.latlng)
      .setContent(html)
      .openOn(map);
    return;
  }

  // --- PRIORIDAD 3: Construcción (pisos) ---
  // Detección precisa por punto-en-polígono para evitar errores por "bounds".
  if (construccionLoaded && construccionByFloor && construccionByFloor.size) {
    let bestLayer = null;
    let bestArea = Infinity;

    construccionByFloor.forEach((floorLayer) => {
      if (!floorLayer || !map.hasLayer(floorLayer) || !floorLayer.eachLayer) return;

      floorLayer.eachLayer((lyr) => {
        if (!lyr || !lyr.getBounds || !lyr.getBounds().contains(e.latlng)) return;
        if (!lyr.getLatLngs) return;

        const latlngs = lyr.getLatLngs();
        if (_pointInPolygon(e.latlng, latlngs)) {
          const a = _polygonArea(latlngs);
          if (a < bestArea) {
            bestArea = a;
            bestLayer = lyr;
          }
        }
      });
    });

    if (bestLayer) {
      const layerId = L.Util.stamp(bestLayer);
      const props = (bestLayer.feature && bestLayer.feature.properties)
        ? bestLayer.feature.properties
        : (construccionData.get(layerId) || {});
      const html = popupHtml("Construcción", props);
      L.popup({ maxWidth: 340 })
        .setLatLng(e.latlng)
        .setContent(html)
        .openOn(map);
      return;
    }
  }


  // --- PRIORIDAD 4: Edifica (solo si "Ver atributos" está activo) ---
  const _attrEdificaOn = (() => {
    const a = document.getElementById("attr-base-edifica");
    const b = document.getElementById("layer-base-edifica");
    return !!(a && a.checked && b && b.checked);
  })();

  if (_attrEdificaOn) {
    const edHit = _pickBestFromLayerGroup(layerEdifica, (lyr) => {
      const props = (lyr && lyr.feature && lyr.feature.properties) ? lyr.feature.properties : null;
      return props ? { title: "Edifica", properties: props } : null;
    });

    if (edHit) {
      try { selectGeoJSON(edHit.lyr && edHit.lyr.toGeoJSON ? edHit.lyr.toGeoJSON() : null); } catch(e) {}
      const html = popupHtml(edHit.payload.title, edHit.payload.properties);
      L.popup({ maxWidth: 340 })
        .setLatLng(e.latlng)
        .setContent(html)
        .openOn(map);
      return;
    }
  }

  // --- PRIORIDAD 5: Lote (solo si "Ver atributos" está activo) ---
  const _attrLoteOn = (() => {
    const a = document.getElementById("attr-base-lote");
    const b = document.getElementById("layer-base-lote");
    return !!(a && a.checked && b && b.checked);
  })();

  if (_attrLoteOn) {
    const ltHit = _pickBestFromLayerGroup(layerLote, (lyr) => {
      const props = (lyr && lyr.feature && lyr.feature.properties) ? lyr.feature.properties : null;
      if (!props) return null;
      const v = props[GEO.fields.cod_lote];
      const title = (v !== undefined && v !== null && String(v).trim() !== "") ? `Lote ${v}` : "Lote";
      return { title, properties: props };
    });

    if (ltHit) {
      try { selectGeoJSON(ltHit.lyr && ltHit.lyr.toGeoJSON ? ltHit.lyr.toGeoJSON() : null); } catch(e) {}
      const html = popupHtml(ltHit.payload.title, ltHit.payload.properties);
      L.popup({ maxWidth: 340 })
        .setLatLng(e.latlng)
        .setContent(html)
        .openOn(map);
      return;
    }
  }

});

document.addEventListener("change", (e) => {
  if (e.target && e.target.name === "basemap") {
    const v = e.target.value;

    // Apagar todos
    if (map.hasLayer(baseOSM)) map.removeLayer(baseOSM);
    if (map.hasLayer(baseGoogleSat)) map.removeLayer(baseGoogleSat);
    if (map.hasLayer(baseCartoLight)) map.removeLayer(baseCartoLight);

    // Encender el elegido
    if (v === "sat") {
      baseGoogleSat.addTo(map);
    } else if (v === "light") {
      baseCartoLight.addTo(map);
    } else {
      baseOSM.addTo(map);
    }
  }
});

// ===== Panes (orden) =====
function makePane(name, z) {
  const p = map.createPane(name);
  p.style.zIndex = String(z);
  return p;
}
makePane("construccionPane", 350);
makePane("edificaPane", 450);
makePane("lotePane", 520);
makePane("manzanaPane", 580);
makePane("extrasPane", 610);
makePane("highlightPane", 620);
// Nota: No compartimos un único renderer entre panes, porque eso ignora el zIndex de los panes.
// Creamos un renderer por pane para que el orden visual sea SIEMPRE:
// manzana (arriba) > lote > edifica > construcción (abajo).
const RENDERERS = {
  construccion: L.canvas({ pane: "construccionPane", padding: 0.5, tolerance: 10 }),
  edifica: L.canvas({ pane: "edificaPane", padding: 0.5, tolerance: 10 }),
  lote: L.canvas({ pane: "lotePane", padding: 0.5, tolerance: 10 }),
  manzana: L.canvas({ pane: "manzanaPane", padding: 0.5, tolerance: 10 }),
  overlay: L.canvas({ pane: "extrasPane", padding: 0.5, tolerance: 10 }),
  overlaySvg: L.svg({ pane: "extrasPane", padding: 0.5 }),
  highlight: L.svg({ pane: "highlightPane" })
};

// ===== Asegurar orden visual (independiente del orden de encendido) =====
function ensureLayerOrder() {
  try {
    // Reafirmar z-index (por si el navegador/Leaflet reordena)
    const zi = {
      construccionPane: "350",
      edificaPane: "450",
      lotePane: "520",
      manzanaPane: "580",
      extrasPane: "610",
      highlightPane: "950"
    };
    Object.keys(zi).forEach(k => {
      const p = map.getPane(k);
      if (p) p.style.zIndex = zi[k];
    });
  } catch (e) {}

  // Dentro de cada pane/canvas, forzamos el orden de dibujo
  const bringGroupFront = (g) => {
    try { g?.eachLayer?.(l => l?.bringToFront?.()); } catch (e) {}
  };
  const bringGroupBack = (g) => {
    try { g?.eachLayer?.(l => l?.bringToBack?.()); } catch (e) {}
  };

  // Construcción al fondo (sin depender de variables aún no inicializadas)
  try {
    map.eachLayer((lyr) => {
      // GeoJSON/FeatureGroup de construcción
      if (lyr?.options?.pane === "construccionPane") {
        bringGroupBack(lyr);
      }
    });
  } catch (e) {}

  // Edifica, Lote, Manzana al frente (en ese orden)
  if (map.hasLayer(layerEdifica)) bringGroupFront(layerEdifica);
  if (map.hasLayer(layerLote)) bringGroupFront(layerLote);
  if (map.hasLayer(layerManzana)) bringGroupFront(layerManzana);
}



// ===== Base layers (siempre activas) =====
const manzanaTooltips = [];
const loteTooltips = [];
// ===== Load base WFS layers (por distrito) =====
function _cqlUbigeo(ub) {
  const f = GEO.fields.ubigeo;
  const u = String(ub || "").trim();
  if (!u) return "";
  // CQL robusto si el campo viene como texto o número
  if (/^\d+$/.test(u)) {
    const n = String(parseInt(u, 10));
    return (n && n !== u) ? `(${f}='${u}' OR ${f}=${n})` : `(${f}='${u}' OR ${f}=${u})`;
  }
  return `${f}='${u}'`;
}

async function loadBaseForUbigeo(ubigeo) {
  const requested = String(ubigeo || "").trim();
  if (!requested) return;

  // Evita recargas innecesarias
  if (_baseLoaded && _currentUbigeo === requested) return;

  // Si ya está cargando, deja pendiente el nuevo ubigeo y sal
  if (_baseLoading) {
    _pendingUbigeo = requested;
    return;
  }

  _baseLoading = true;
  _baseLoaded = false;
  _currentUbigeo = null;

  // Limpia pendiente (se volverá a setear si el usuario cambia durante la carga)
  _pendingUbigeo = null;

  try {
    // Cancela solicitudes anteriores (evita saturación en cambios rápidos)
    try { if (_baseAbort) _baseAbort.abort(); } catch(e) {}
    _baseAbort = new AbortController();
    if (searchResult) searchResult.textContent = "Cargando capas del distrito…";

    // Limpiar capas y tooltips antes de recargar (evita acumulación y lag)
    try { manzanaTooltips.length = 0; } catch(e) {}
    try { loteTooltips.length = 0; } catch(e) {}
    layerEdifica.clearLayers();
    layerLote.clearLayers();
    layerManzana.clearLayers();

    const cql = _cqlUbigeo(requested);

    const [gjE, gjL, gjM] = await Promise.all([
      fetchGeoJSON(wfsUrl(GEO.layers.edifica, { maxFeatures: 200000, cql }), { ttlMs: CACHE.baseTtlMs, signal: _baseAbort.signal }),
      fetchGeoJSON(wfsUrl(GEO.layers.lote, { maxFeatures: 200000, cql }), { ttlMs: CACHE.baseTtlMs, signal: _baseAbort.signal }),
      fetchGeoJSON(wfsUrl(GEO.layers.manzana, { maxFeatures: 200000, cql }), { ttlMs: CACHE.baseTtlMs, signal: _baseAbort.signal })
    ]);

    layerEdifica.addData(gjE);
    layerLote.addData(gjL);
    layerManzana.addData(gjM);

    // Bounds por distrito (ubigeo) para dirigir la vista
    try { _districtBounds = _computeDistrictBounds(gjM, GEO.fields.ubigeo); } catch(e) { _districtBounds = null; }

    _baseLoaded = true;
    _currentUbigeo = requested;

    updateLegend();
    ensureLayerOrder();
    updateLabelOpacity();

    if (searchResult) searchResult.textContent = "";

    // Si durante la carga pidieron otro distrito, recargamos automáticamente
    const queued = String(_pendingUbigeo || "").trim();
    if (queued && queued !== requested) {
      _pendingUbigeo = null;
      // recarga en micro-tarea
      setTimeout(() => { loadBaseForUbigeo(queued).catch((e)=>console.warn(e)); }, 0);
      return;
    }

    // Enfocar el distrito cargado
    focusDistrict(requested);

  } catch (e) {
    console.warn(e);
    if (searchResult) searchResult.textContent = "⚠️ No se pudieron cargar capas base (WFS/CORS).";
  } finally {
    _baseLoading = false;
  }
}
;

const layerEdifica = L.geoJSON(null, {
  pane: "edificaPane",
  interactive: false,
  renderer: RENDERERS.edifica,
  style: {
    fill: false,
    color: "#cc0000",
    weight: 2.4,
    fillColor: "#cc0000",
    fillOpacity: 0.0
  }
});

const layerLote = L.geoJSON(null, {
  pane: "lotePane",
  interactive: false,
  renderer: RENDERERS.lote,
  style: {
    fill: false,
    color: "#ffd400",
    weight: 2.2,
    fillColor: "#ffd400",
    fillOpacity: 0.0
  },
  onEachFeature: (ft, lyr) => {
    const v = ft?.properties?.[GEO.fields.cod_lote];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      lyr.bindTooltip(String(v), {
        permanent: true,
        direction: "center",
        className: "lbl-lote",
        opacity: 0
      });
      loteTooltips.push(lyr.getTooltip());
    }
  }
});

const layerManzana = L.geoJSON(null, {
  pane: "manzanaPane",
  interactive: false,
  renderer: RENDERERS.manzana,
  style: {
    fill: false,
    color: "#ff00ff",
    weight: 2.2,
    fillColor: "#ff00ff",
    fillOpacity: 0.0
  },
  onEachFeature: (ft, lyr) => {
    const v = ft?.properties?.[GEO.fields.cod_mzna];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      lyr.bindTooltip(String(v), {
        permanent: true,
        direction: "center",
        className: "lbl-manzana",
        opacity: 0.9
      });
      manzanaTooltips.push(lyr.getTooltip());
    }
  }
});

layerEdifica.addTo(map);
layerLote.addTo(map);
layerManzana.addTo(map);
ensureLayerOrder();

function updateLabelOpacity() {
  const z = map.getZoom();

  const mzOp = (z >= MANZANA_LABEL_MIN_ZOOM) ? 1 : 0;
  manzanaTooltips.forEach(t => t && t.setOpacity(mzOp));

  const lotOp = (z >= LOTE_LABEL_MIN_ZOOM) ? 1 : 0;
  loteTooltips.forEach(t => t && t.setOpacity(lotOp));
  // Puertas se controla aparte
}
map.on("zoomend", updateLabelOpacity);
updateLabelOpacity();

// ===== Flash highlight (amarillo ~5s) =====
let flashLayer = null;
let flashTimer = null;

function clearFlash() {
  if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
  if (flashLayer) { try { map.removeLayer(flashLayer); } catch(e) {} flashLayer = null; }
}

function flashGeoJSON(gj, opts = {}) {
  if (!gj || !Array.isArray(gj.features) || gj.features.length === 0) return;

  clearFlash();

  const duration = Number.isFinite(opts.duration) ? opts.duration : 3000;
  const lineColor = opts.color || "#ffd400";
  const style = opts.style || { color: lineColor, weight: 6, fillColor: lineColor, fillOpacity: 0.14, opacity: 1 };
  const pt = opts.pointStyle || { radius: 8, color: lineColor, weight: 3, fillColor: lineColor, fillOpacity: 0.9 };

  flashLayer = L.geoJSON(gj, {
    pane: "highlightPane",
    renderer: RENDERERS.highlight,
    interactive: false,
    style: () => style,
    pointToLayer: (_, latlng) => L.circleMarker(latlng, pt)
  }).addTo(map);

  // Auto retirar
  flashTimer = setTimeout(() => {
    if (flashLayer) {
      try { map.removeLayer(flashLayer); } catch(e) {}
      flashLayer = null;
    }
    flashTimer = null;
  }, duration);
}


// ===== Selección (amarillo) al hacer click en una entidad =====
let selectLayer = null;

function clearSelection() {
  if (selectLayer) {
    try { map.removeLayer(selectLayer); } catch(e) {}
    selectLayer = null;
  }
}

// Al cerrar cualquier popup, quitamos el resaltado de selección
map.on("popupclose", clearSelection);

function selectGeoJSON(gj) {
  if (!gj) return;
  clearSelection();

  const lineColor = "#ffd400";

  // Detecta tipo de geometría para no “engordar” demasiado líneas largas
  const gtype = (gj.type === "Feature") ? (gj.geometry && gj.geometry.type) : gj.type;
  const isLine = /LineString/i.test(gtype || "");
  const isPoint = /Point/i.test(gtype || "");

  const style = isLine
    ? { color: lineColor, weight: 4, opacity: 1, lineCap: "round", lineJoin: "round", dashArray: "6 6" }
    : { color: lineColor, weight: 4, opacity: 1, fillColor: lineColor, fillOpacity: 0.12, lineCap: "round", lineJoin: "round" };

  const pt = { radius: 8, color: lineColor, weight: 3, fillColor: lineColor, fillOpacity: 0.9 };

  selectLayer = L.geoJSON(gj, {
    pane: "highlightPane",
    renderer: RENDERERS.highlight,
    interactive: false,
    style: () => style,
    pointToLayer: (_, latlng) => L.circleMarker(latlng, pt)
  }).addTo(map);
}
const searchMz = document.getElementById("search-manzana");
const searchLt = document.getElementById("search-lote");
const searchSector = document.getElementById("search-sector");
const searchDistrito = document.getElementById("search-distrito");
const btnSearch = document.getElementById("btn-search");
const searchResult = document.getElementById("search-result");




async function doSearch() {
  clearFlash();

  // Normaliza códigos: tolera "33" vs "033", "1" vs "01", etc.
  const clean = (v) => (v === undefined || v === null) ? "" : String(v).trim();
  const strip0 = (s) => {
    const t = clean(s);
    if (!t) return "";
    const u = t.replace(/^0+/, "");
    return u === "" ? "0" : u;
  };
  const eqCode = (a, b) => {
    const A = clean(a), B = clean(b);
    if (!A || !B) return false;
    return (A === B) || (strip0(A) === strip0(B));
  };
  const pad = (v, n) => {
    const s = clean(v);
    if (!s) return "";
    return (/^\d+$/.test(s) && n) ? s.padStart(n, "0") : s;
  };

  const ubigeo = clean(searchDistrito?.value);
  const sector = pad(searchSector?.value, 2);
  const mz = pad(searchMz?.value, 3);
  const lt = pad(searchLt?.value, 3);

  // Validaciones
  if (!ubigeo && !sector && !mz) {
    if (searchResult) searchResult.textContent = "⚠️ Selecciona Distrito o ingresa Sector o Manzana.";
    return;
  }
  if (lt && !mz) {
    if (searchResult) searchResult.textContent = "⚠️ Para buscar un lote, ingresa también la Manzana.";
    return;
  }

  try {
    if (searchResult) searchResult.textContent = "Buscando…";

    // Preferimos buscar localmente (ya que las capas base se cargan al inicio),
    // así evitamos problemas de tipos (número vs texto) en CQL.
    const hasBaseMz = layerManzana && layerManzana.getLayers && layerManzana.getLayers().length > 0;
    const hasBaseLt = layerLote && layerLote.getLayers && layerLote.getLayers().length > 0;

    // ======= Búsqueda por Lote (usa capa lote cargada) =======
    if (lt) {
      if (!hasBaseLt) {
        if (searchResult) searchResult.textContent = "⏳ Cargando capa Lote… intenta de nuevo en unos segundos.";
        return;
      }
      const matches = [];
      layerLote.eachLayer((lyr) => {
        const p = lyr?.feature?.properties || {};
        if (eqCode(p[GEO.fields.cod_mzna], mz) && eqCode(p[GEO.fields.cod_lote], lt)) {
          matches.push(lyr.feature);
        }
      });

      if (!matches.length) {
        if (searchResult) searchResult.textContent = "❌ No se encontró el lote.";
        return;
      }

      const gj = { type: "FeatureCollection", features: matches };
      flashGeoJSON(gj, { color: "#ffd400", duration: 3000 });

      try {
        const b = flashLayer ? flashLayer.getBounds() : L.geoJSON(gj).getBounds();
        if (b && b.isValid()) map.fitBounds(b, { padding: [30, 30] });
      } catch(e) {}

      if (searchResult) searchResult.textContent = `✓ Lote ${lt} (Mz ${mz}) encontrado`;
      return;
    }

    // ======= Búsqueda por Manzana / Sector / Distrito (usa capa manzana cargada) =======
    if (!hasBaseMz) {
      if (searchResult) searchResult.textContent = "⏳ Cargando capa Manzana… intenta de nuevo en unos segundos.";
      return;
    }

    const matches = [];
    layerManzana.eachLayer((lyr) => {
      const p = lyr?.feature?.properties || {};

      if (mz && !eqCode(p[GEO.fields.cod_mzna], mz)) return;
      if (sector && !eqCode(p[GEO.fields.cod_sector], sector)) return;
      if (ubigeo && !eqCode(p[GEO.fields.ubigeo], ubigeo)) return;

      matches.push(lyr.feature);
    });

    if (!matches.length) {
      if (mz && !sector && !ubigeo) {
        if (searchResult) searchResult.textContent = "❌ No se encontró la manzana.";
      } else {
        if (searchResult) searchResult.textContent = "❌ No se encontraron resultados con esos filtros.";
      }
      return;
    }

    const gj = { type: "FeatureCollection", features: matches };
    flashGeoJSON(gj, { color: "#ffd400", duration: 3000 });

    // Zoom
    try {
      const b = flashLayer ? flashLayer.getBounds() : L.geoJSON(gj).getBounds();
      if (b && b.isValid()) map.fitBounds(b, { padding: [30, 30] });
    } catch(e) {}

    // Mensaje
    const n = matches.length;
    const distritoName = ubigeo === "150112" ? "Independencia" : (ubigeo === "150110" ? "Comas" : ubigeo);
    if (mz && !sector && !ubigeo) {
      if (searchResult) searchResult.textContent = `✓ Manzana ${mz} encontrada`;
      return;
    }
    const tags = [];
    if (ubigeo) tags.push(`Distrito ${distritoName}`);
    if (sector) tags.push(`Sector ${sector}`);
    if (mz) tags.push(`Mz ${mz}`);

    if (searchResult) searchResult.textContent = `✓ ${n} manzana(s) encontrada(s) — ${tags.join(" · ")}`;
  } catch (err) {
    console.error(err);
    if (searchResult) searchResult.textContent = "⚠️ Error al buscar. Revisa la consola.";
  }
}




btnSearch?.addEventListener("click", doSearch);
searchMz?.addEventListener("keypress", (e) => { if (e.key === "Enter") doSearch(); });
searchLt?.addEventListener("keypress", (e) => { if (e.key === "Enter") doSearch(); });


// ===== Modal selector de distrito (Comas / Independencia) =====
let _baseLoaded = false;
let _baseLoading = false;
let _currentUbigeo = null;
let _pendingUbigeo = null;
let _districtBounds = null;
let _baseAbort = null; // AbortController para cancelar WFS al cambiar distrito rápido

function openDistrictModal() {
  const modal = document.getElementById("district-modal");
  if (!modal) return;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
}
function closeDistrictModal() {
  const modal = document.getElementById("district-modal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

function ensureManzanaVisible() {
  // Asegura que la capa de manzana esté activa
  try {
    const cb = document.getElementById("layer-base-manzana");
    if (cb) cb.checked = true;
  } catch(e) {}
  try {
    if (!map.hasLayer(layerManzana)) layerManzana.addTo(map);
    updateLegend();
    ensureLayerOrder();
  } catch(e) {}
}

function focusDistrict(ubigeo) {
  if (!ubigeo) return;

  // Preferimos usar bounds precalculados (rápido)
  try {
    const b = _districtBounds && _districtBounds[ubigeo];
    if (b && b.isValid && b.isValid()) {
      map.fitBounds(b, { padding: [30, 30] });
      return;
    }
  } catch(e) {}

  // Fallback: calcula bounds desde la capa de manzana ya cargada
  try {
    const b = L.latLngBounds([]);
    layerManzana.eachLayer((lyr) => {
      const p = lyr?.feature?.properties || {};
      if (String(p?.[GEO.fields.ubigeo] ?? "").trim() === String(ubigeo).trim()) {
        const bb = lyr.getBounds && lyr.getBounds();
        if (bb && bb.isValid && bb.isValid()) b.extend(bb);
      }
    });
    if (b && b.isValid && b.isValid()) map.fitBounds(b, { padding: [30, 30] });
  } catch(e) {}
}

async function setDistrict(ubigeo) {
  const ub = String(ubigeo || "").trim();
  if (!ub) return;

  if (searchDistrito) searchDistrito.value = ub;
  ensureManzanaVisible();

  // Si ya está cargado ese distrito, solo enfocamos
  if (_baseLoaded && _currentUbigeo === ub) {
    focusDistrict(ub);
    return;
  }

  // Carga/recarga por distrito (y enfoca al terminar)
  _pendingUbigeo = ub;
  await loadBaseForUbigeo(ub);
}

function bindDistrictModal() {
  const modal = document.getElementById("district-modal");
  if (!modal) return;

  modal.querySelectorAll(".district-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ub = btn.getAttribute("data-ubigeo");
      closeDistrictModal();
      try { await setDistrict(ub); } catch(e) { console.warn(e); }
    });
});
}

// Mostrar modal al ingresar
document.addEventListener("DOMContentLoaded", () => {
  bindDistrictModal();
  openDistrictModal();

  // Si el usuario cambia distrito desde el buscador, hacemos zoom al distrito elegido
  if (searchDistrito) {
    searchDistrito.addEventListener("change", () => {
      const ub = String(searchDistrito.value || "").trim();
      if (ub) {
        // Cambiar de distrito recarga y oculta automáticamente el otro
        setDistrict(ub).catch((e)=>console.warn(e));
      }
    });
  }
});

// Calcula bounds por distrito desde GeoJSON (rápido y sin cargar L.geoJSON por feature)
function _computeDistrictBounds(gj, ubigeoField) {
  const out = {};
  const acc = {}; // ubigeo -> {minLng,minLat,maxLng,maxLat}

  const extend = (u, lng, lat) => {
    if (!isFinite(lng) || !isFinite(lat)) return;
    if (!acc[u]) acc[u] = { minLng: lng, minLat: lat, maxLng: lng, maxLat: lat };
    const b = acc[u];
    if (lng < b.minLng) b.minLng = lng;
    if (lat < b.minLat) b.minLat = lat;
    if (lng > b.maxLng) b.maxLng = lng;
    if (lat > b.maxLat) b.maxLat = lat;
  };

  const walk = (u, coords) => {
    if (!coords) return;
    // Si es un par [lng,lat]
    if (Array.isArray(coords) && coords.length === 2 && typeof coords[0] === "number" && typeof coords[1] === "number") {
      extend(u, coords[0], coords[1]);
      return;
    }
    if (Array.isArray(coords)) coords.forEach((c) => walk(u, c));
  };

  const feats = (gj && gj.features) ? gj.features : [];
  feats.forEach((ft) => {
    const u = String(ft?.properties?.[ubigeoField] ?? "").trim();
    if (!u) return;
    const g = ft && ft.geometry;
    if (!g) return;
    walk(u, g.coordinates);
  });

  Object.keys(acc).forEach((u) => {
    const b = acc[u];
    out[u] = L.latLngBounds([b.minLat, b.minLng], [b.maxLat, b.maxLng]);
  });
  return out;
}


// ===== Panel collapse =====
const panelCapas = document.getElementById("panelCapas");
const toggleBtn  = document.getElementById("toggleBtn");

if (toggleBtn && panelCapas) {
  toggleBtn.addEventListener("click", () => {
    panelCapas.classList.toggle("collapsed");
    toggleBtn.textContent = panelCapas.classList.contains("collapsed") ? "▶" : "◀";    setTimeout(() => { try { map.invalidateSize(); } catch(e){} }, 320);  });
}

// ===== Responsive (mobile) =====
(function(){
  try{
    const mq = window.matchMedia && window.matchMedia("(max-width: 768px)");
    const isMobile = mq ? mq.matches : (window.innerWidth <= 768);
    if (isMobile && panelCapas) {
      // Arrancar con el panel colapsado en móvil para que el mapa tenga más espacio
      if (!panelCapas.classList.contains("collapsed")) {
        panelCapas.classList.add("collapsed");
        if (toggleBtn) toggleBtn.textContent = "▶";
        setTimeout(() => { try { map.invalidateSize(); } catch(e){} }, 350);
      }
    } else {
      // En PC / pantallas grandes arrancar desplegado
      if (panelCapas && panelCapas.classList.contains("collapsed")) {
        panelCapas.classList.remove("collapsed");
        if (toggleBtn) toggleBtn.textContent = "◀";
        setTimeout(() => { try { map.invalidateSize(); } catch(e){} }, 250);
      }
    }

    // Recalcular mapa al rotar o cambiar tamaño
    let t=null;
    const bump = () => {
      clearTimeout(t);
      t = setTimeout(() => { try { map.invalidateSize(); } catch(e){} }, 250);
    };
    window.addEventListener("orientationchange", bump);
    window.addEventListener("resize", bump);
  }catch(e){}
})();

// ===== Accordion groups =====
document.querySelectorAll(".grupo-header").forEach((hdr) => {
  hdr.addEventListener("click", (ev) => {
    // Evitar que el click del checkbox/label del header abra/cierre el grupo
    if (ev && ev.target && ev.target.closest && ev.target.closest("input, label")) return;
    const targetId = hdr.getAttribute("data-target");
    const body = document.getElementById(targetId);
    if (!body) return;

    body.classList.toggle("closed");
    const arrow = hdr.querySelector(".arrow");
    if (arrow) arrow.textContent = body.classList.contains("closed") ? "▸" : "▾";

    // Si abren Construcción, cargamos pisos una sola vez
    if (targetId === "grupo-const" && !construccionLoaded) {
      loadConstruccion().catch((e)=>console.warn(e));
    }
  });
});

// ===== Lazy optional layers =====
let obras1Layer = null;
let obras2Layer = null;
let obras3Layer = null;
let ucaLayer = null;

// Puertas (carga por bbox de cerca)
let puertaLayer = null;
let puertaActive = false;
const doorTooltips = [];

function updateDoorLabelOpacity() {
  const z = map.getZoom();
  const op = (z >= DOOR_MIN_ZOOM) ? 1 : 0;
  doorTooltips.forEach(t => t && t.setOpacity(op));
}

// Construcción por pisos
let construccionLoaded = false;
const construccionByFloor = new Map(); // floorValue -> Layer
const construccionFCByFloor = new Map(); // floorValue -> FeatureCollection (cache)
let construccionFloorsList = []; // lista de pisos (cache)
const construccionData = new Map(); // layer._leaflet_id -> feature properties
const floorColors = [
  "#1f77b4","#ff7f0e","#2ca02c","#d62728","#9467bd",
  "#8c564b","#e377c2","#7f7f7f","#bcbd22","#17becf",
  "#00a8ff","#f368e0","#ff6b6b","#1dd1a1","#576574"
];

function formatPisoLabel(raw) {
  const s = String(raw);
  const n = Number(s);
  if (Number.isFinite(n)) return `Piso ${String(n).padStart(2, "0")}`;
  return `Piso ${s}`;
}

function renderFloorCheckboxes(floors) {
  const cont = document.getElementById("pisos-container");
  if (!cont) return;

  cont.innerHTML = "";

  if (!floors || floors.length === 0) {
    cont.innerHTML = '<div class="pisos-hint">No se encontraron pisos.</div>';
    return;
  }

  const firstKey = String(floors[0]);

  floors.forEach((fv, idx) => {
    const key = String(fv);
    const color = floorColors[idx % floorColors.length];

    const lab = document.createElement("label");
    lab.className = "piso-pill";

    const checked = (key === firstKey) ? "checked" : "";
    lab.innerHTML = `<input type="checkbox" ${checked}>
      <span style="display:inline-flex;align-items:center;gap:8px;">
        <span style="width:10px;height:10px;border-radius:3px;background:${color};display:inline-block;"></span>
        ${escapeHtml(formatPisoLabel(fv))}
      </span>`;

    const cb = lab.querySelector("input");
    cb.addEventListener("change", () => {
  const lyr = construccionByFloor.get(key);
  if (!lyr) return;
  if (cb.checked) {
    if (!map.hasLayer(lyr)) lyr.addTo(map);
  } else {
    if (map.hasLayer(lyr)) map.removeLayer(lyr);
  }
  updateLegend();
  ensureLayerOrder();
});

    cont.appendChild(lab);
  });

  // Predeterminado: SOLO primer piso encendido
  for (const lyr of construccionByFloor.values()) {
    if (map.hasLayer(lyr)) map.removeLayer(lyr);
  }
  const firstLayer = construccionByFloor.get(firstKey);
  if (firstLayer && !map.hasLayer(firstLayer)) firstLayer.addTo(map);
  updateLegend();
  ensureLayerOrder();
}

async function loadConstruccion() {
  const cont = document.getElementById("pisos-container");
  if (cont) cont.innerHTML = '<div class="pisos-hint">Cargando pisos…</div>';

  const url = wfsUrl(GEO.layers.construccion, { maxFeatures: 300000 });
  const gj = await fetchGeoJSON(url);

  const field = GEO.fields.cod_piso;
  const by = new Map(); // floor -> features[]
  gj.features.forEach((ft) => {
    const fv = ft?.properties?.[field];
    if (fv === undefined || fv === null || String(fv).trim() === "") return;
    const key = String(fv);
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(ft);
  });

  const floors = Array.from(by.keys());
  construccionFloorsList = floors.slice();
  floors.sort((a,b) => (Number.isFinite(+a) && Number.isFinite(+b)) ? (+a - +b) : a.localeCompare(b));

  floors.forEach((fv, idx) => {
    const color = floorColors[idx % floorColors.length];
    const fc = { type: "FeatureCollection", features: by.get(String(fv)) };

    // Guardar para resaltar por selección
    construccionFCByFloor.set(String(fv), fc);

    const layer = L.geoJSON(fc, {
      pane: "construccionPane",
      renderer: RENDERERS.construccion,
      interactive: true,
      style: { color: darkenHex(color, 0.50), weight: 2.4, opacity: 1, fillColor: color, fillOpacity: 0.42 },
      onEachFeature: (ft, lyr) => {
        // Guardar referencia a las properties
        const layerId = L.Util.stamp(lyr);
        construccionData.set(layerId, ft.properties);

        // Popup preciso: solo se activa si realmente haces click sobre el polígono
        lyr.on("click", (ev) => {
          const props = (ft && ft.properties) ? ft.properties : ((lyr.feature && lyr.feature.properties) ? lyr.feature.properties : {});
          const html = popupHtml("Construcción", props);
          L.popup({ maxWidth: 340 })
            .setLatLng(ev.latlng)
            .setContent(html)
            .openOn(map);
          if (ev.originalEvent) L.DomEvent.stop(ev.originalEvent);
        });
      }
    });

    construccionByFloor.set(String(fv), layer);
  });

  construccionLoaded = true;
  renderFloorCheckboxes(floors);
  updateLegend();
}

// Obras
let obrasData = new Map(); // layer._leaflet_id -> {title, properties}

const OBRA_TYPE_FIELDS = ["tipo","TIPO","tipo_obra","tipoobra","tipologia","tipo_comp","tipo_compl","tipo_complementaria","clase","categoria","cat","descripcion","desc","nombre"];
const OBRA_PALETTES = {
  1: ["#6a5acd","#3949ab","#1e88e5","#00897b","#43a047","#7cb342","#f9a825","#fb8c00","#f4511e","#8e44ad"],
  2: ["#e6194b","#3cb44b","#ffe119","#4363d8","#f58231","#911eb4","#46f0f0","#f032e6","#bcf60c","#fabebe","#008080","#e6beff"],
  3: makeGoldenPalette(40, 88, 50, 13)
};

function detectTypeField(features) {
  if (!Array.isArray(features) || features.length === 0) return null;
  let best = null;
  let bestCount = 0;
  for (const f of OBRA_TYPE_FIELDS) {
    let c = 0;
    for (const ft of features) {
      const v = ft?.properties?.[f];
      if (v !== undefined && v !== null && String(v).trim() !== "") c++;
    }
    if (c > bestCount) { bestCount = c; best = f; }
  }
  return bestCount > 0 ? best : null;
}

function normalizeTypeValue(v) {
  if (v === undefined || v === null) return "";
  return String(v).trim().replace(/\s+/g, " ").toUpperCase();
}

function darkenHex(hex, amount = 0.35) {
  // amount: 0..1 (más alto = más oscuro)
  if (!hex) return "#000000";
  const h = String(hex).trim();
  const m = /^#?([0-9a-f]{6})$/i.exec(h);
  if (!m) return h;
  const n = parseInt(m[1], 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  r = Math.max(0, Math.floor(r * (1 - amount)));
  g = Math.max(0, Math.floor(g * (1 - amount)));
  b = Math.max(0, Math.floor(b * (1 - amount)));
  const out = (r << 16) | (g << 8) | b;
  return "#" + out.toString(16).padStart(6, "0");
}

function hslToHex(h, s, l) {
  // h:0..360, s/l:0..100
  h = ((h % 360) + 360) % 360;
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2*l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c/2;
  let r=0,g=0,b=0;
  if (h < 60) { r=c; g=x; b=0; }
  else if (h < 120) { r=x; g=c; b=0; }
  else if (h < 180) { r=0; g=c; b=x; }
  else if (h < 240) { r=0; g=x; b=c; }
  else if (h < 300) { r=x; g=0; b=c; }
  else { r=c; g=0; b=x; }
  const toHex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return "#" + toHex(r) + toHex(g) + toHex(b);
}

function makeGoldenPalette(n, s=85, l=50, seed=17) {
  // Usa el ángulo áureo para repartir tonos bien separados (evita "variantes" seguidas del mismo color)
  const out = [];
  const golden = 137.508; // grados
  for (let i=0; i<n; i++) {
    const h = (seed + i * golden) % 360;
    out.push(hslToHex(h, s, l));
  }
  return out;
}


const OBRA2_TYPE_COLOR_OVERRIDES = {};
const OBRA2_TYPE_LABEL_OVERRIDES = {
  "MURO PERIMETRICO": "MURO PERIMÉTRICO",
  "PORTON": "PORTÓN"
};

function formatObraType(which, key) {
  if (which === 2) return OBRA2_TYPE_LABEL_OVERRIDES[key] || key;
  return key;
}



function buildTypeColorMap(features, field, palette) {
  const m = new Map();
  if (!field) return m;
  const seen = new Set();
  const vals = [];
  for (const ft of features) {
    const v = ft?.properties?.[field];
    const s = normalizeTypeValue(v);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    vals.push(s);
  }
  vals.sort((a,b) => a.localeCompare(b, "es", { numeric: true, sensitivity: "base" }));
  vals.forEach((v, i) => m.set(v, palette[i % palette.length]));
  return m;
}



async function loadObra(which) {
  const layerName = which === 1 ? GEO.layers.obra1 : which === 2 ? GEO.layers.obra2 : GEO.layers.obra3;
  const defaultColor = which === 1 ? "#005F73" : which === 2 ? "#2D6A4F" : "#1E88E5";
  const title = which === 1 ? "Obra complementaria 1" : which === 2 ? "Obra complementaria 2" : "Obra complementaria 3";
  const url = wfsUrl(layerName, { maxFeatures: 200000 });
  const gj = await fetchGeoJSON(url);

  // Guardar para resaltar y leyenda
  obrasGeoJSON[which] = gj;

  const features = gj.features || [];
  const typeField = detectTypeField(features);
  const palette = OBRA_PALETTES[which] || [defaultColor];
  const typeColors = buildTypeColorMap(features, typeField, palette);
  
  if (which === 2 && typeField && typeColors) {
    for (const [k, v] of Object.entries(OBRA2_TYPE_COLOR_OVERRIDES)) {
      typeColors.set(k, v);
    }
  }
obrasLegend[which] = { title, defaultColor, typeField, typeColors };

  const pickColor = (ft) => {
    if (!typeField) return defaultColor;
    const v = ft?.properties?.[typeField];
    const key = normalizeTypeValue(v);
    return typeColors.get(key) || defaultColor;
  };

  // Obra 3: solo un punto por entidad
  if (which === 3) {
    const group = L.layerGroup();
    (gj.features || []).forEach((ft) => {
      let ll = null;
      try {
        if (ft?.geometry?.type === "Point") {
          const [x, y] = ft.geometry.coordinates;
          ll = L.latLng(y, x);
        } else {
          const b = L.geoJSON(ft).getBounds();
          if (b && b.isValid()) ll = b.getCenter();
        }
      } catch (e) {}
      if (!ll) return;

      const c = pickColor(ft);

      const mkr = L.circleMarker(ll, {
        pane: "extrasPane",
        radius: 6,
        color: c,
        weight: 2,
        fillColor: c,
        fillOpacity: 0.9
      });

      const layerId = L.Util.stamp(mkr);
      obrasData.set(layerId, { title, properties: ft.properties });

      group.addLayer(mkr);
    });
    return group;
  }

  
  // Obra 1 y 2: estilos
const styleFn = (ft) => {
  const c = pickColor(ft);

  // Obra complementaria 1: mantener fondo sólido (sin hachurado)
  if (which === 1) {
    const border = darkenHex(c, 0.45);
    return {
      color: border,
      weight: 3.2,
      opacity: 1,
      fillColor: c,
      fillOpacity: 0.50
    };
  }

  // Obra complementaria 2: trazo punteado (sin relleno)
  return {
    color: c,
    weight: 5.0,
    opacity: 1,
    fill: false,
    dashArray: "6 6",
    lineCap: "round",
    lineJoin: "round"
  };
};


  const geo =
 L.geoJSON(gj, {
    pane: "extrasPane",
    renderer: (which === 1 ? RENDERERS.overlaySvg : RENDERERS.overlay),
    interactive: true,
    style: styleFn,
    onEachFeature: (ft, lyr) => {
      const layerId = L.Util.stamp(lyr);
      obrasData.set(layerId, { title, properties: ft.properties });
    }
  });
  return geo;
}

// UCA
let ucaData = new Map(); // layer._leaflet_id -> properties
let ucaGeoJSON = null;

async function loadUca() {
  const url = wfsUrl(GEO.layers.uca, { maxFeatures: 200000 });
  const gj = await fetchGeoJSON(url);

  // Guardar para resaltar y leyenda
  ucaGeoJSON = gj;

  const layer = L.geoJSON(gj, {
    pane: "extrasPane",
    interactive: true,
    pointToLayer: (_, latlng) => L.circleMarker(latlng, {
      radius: 7,
      color: "#ff0000",
      weight: 2,
      fillColor: "#ff0000",
      fillOpacity: 0.9
    }),
    style: { color: "#ff0000", weight: 2.2, fillColor: "#ff0000", fillOpacity: 0.50 },
    onEachFeature: (ft, lyr) => {
      const layerId = L.Util.stamp(lyr);
      ucaData.set(layerId, ft.properties);
    }
  });

  return layer;
}

// Puertas: layer vacío, se rellena por bbox
function makePuertaLayer() {
  const empty = { type: "FeatureCollection", features: [] };
  return L.geoJSON(empty, {
    pane: "extrasPane",
    pointToLayer: (ft, latlng) => L.circleMarker(latlng, {
      radius: 4,
      color: "#e74c3c",
      weight: 2,
      fillColor: "#e74c3c",
      fillOpacity: 0.85
    }),
    onEachFeature: (ft, lyr) => {
      const v = ft?.properties?.[GEO.fields.puerta_visor];
      if (v !== undefined && v !== null && String(v).trim() !== "") {
        lyr.bindTooltip(String(v), {
          permanent: true,
          direction: "top",
          className: "lbl-puerta",
          opacity: 0.0 // se controla por zoom
        });
        doorTooltips.push(lyr.getTooltip());
      }
    }
  });
}

async function refreshPuertas() {
  if (!puertaActive) return;

  if (map.getZoom() < DOOR_MIN_ZOOM) {
    if (puertaLayer) map.removeLayer(puertaLayer);
    return;
  }

  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const url = wfsUrl(GEO.layers.puerta, { maxFeatures: 8000, bbox });

  try {
    const gj = await fetchGeoJSON(url);
    if (!puertaLayer) {
      puertaLayer = makePuertaLayer();
    }
    if (!map.hasLayer(puertaLayer)) puertaLayer.addTo(map);

    // reset tooltips cache
    doorTooltips.length = 0;
    puertaLayer.clearLayers();
    puertaLayer.addData(gj);
    updateDoorLabelOpacity();
  } catch (e) {
    console.warn(e);
  }
}

// ===== Toggle helpers =====
function bindToggle(id, onEnable, onDisable) {
  const el = document.getElementById(id);
  if (!el) return;
  // Respetar el estado inicial (por defecto en HTML)
  el.addEventListener("change", async () => {
    try {
      if (el.checked) await onEnable();
      else await onDisable();
    } catch (e) {
      console.warn(e);
      el.checked = false;
    }
  });
}
// Capas base (siempre cargadas, se pueden ocultar/mostrar)
bindToggle("layer-base-manzana",
  async () => { if (!map.hasLayer(layerManzana)) layerManzana.addTo(map); updateLegend(); ensureLayerOrder(); },
  async () => { if (map.hasLayer(layerManzana)) map.removeLayer(layerManzana); updateLegend(); ensureLayerOrder(); }
);
bindToggle("layer-base-lote",
  async () => { if (!map.hasLayer(layerLote)) layerLote.addTo(map); updateLegend(); ensureLayerOrder(); },
  async () => { if (map.hasLayer(layerLote)) map.removeLayer(layerLote); updateLegend(); ensureLayerOrder(); }
);
bindToggle("layer-base-edifica",
  async () => { if (!map.hasLayer(layerEdifica)) layerEdifica.addTo(map); updateLegend(); ensureLayerOrder(); },
  async () => { if (map.hasLayer(layerEdifica)) map.removeLayer(layerEdifica); updateLegend(); ensureLayerOrder(); }
);





// Sub-opciones: "Ver atributos" para capas base (se habilitan solo si la capa está visible)
(function () {
  function sync(attrId, baseId) {
    const attr = document.getElementById(attrId);
    const base = document.getElementById(baseId);
    if (!attr || !base) return;

    const apply = () => {
      if (!base.checked) {
        attr.checked = false;
        attr.disabled = true;
      } else {
        attr.disabled = false;
      }
    };

    base.addEventListener("change", apply);
    apply();
  }

  sync("attr-base-lote", "layer-base-lote");
  sync("attr-base-edifica", "layer-base-edifica");
})();

bindToggle("layer-obra-1",
  async () => {  if (!obras1Layer) obras1Layer = await loadObra(1);
    if (obras1Layer) obras1Layer.addTo(map);
    updateLegend();  },
  async () => {  if (obras1Layer) map.removeLayer(obras1Layer);
    updateLegend();  }
);
bindToggle("layer-obra-2",
  async () => {  if (!obras2Layer) obras2Layer = await loadObra(2); obras2Layer.addTo(map);
    updateLegend();  },
  async () => {  if (obras2Layer) map.removeLayer(obras2Layer);
    updateLegend();  }
);
bindToggle("layer-obra-3",
  async () => {  if (!obras3Layer) obras3Layer = await loadObra(3); obras3Layer.addTo(map);
    updateLegend();  },
  async () => {  if (obras3Layer) map.removeLayer(obras3Layer);
    updateLegend();  }
);

bindToggle("layer-uca",
  async () => {  if (!ucaLayer) ucaLayer = await loadUca(); ucaLayer.addTo(map);
    updateLegend();  },
  async () => {  if (ucaLayer) map.removeLayer(ucaLayer);
    updateLegend();  }
);

bindToggle("layer-puerta",
  async () => {
    puertaActive = true;
    // No forzamos zoom: solo cargamos si el usuario está en zoom 21+
    await refreshPuertas();
  },
  async () => {
    puertaActive = false;
    if (puertaLayer) map.removeLayer(puertaLayer);
  }
);

// Debounce para puertas
let _doorT = null;
map.on("moveend zoomend", () => {
  updateLabelOpacity();
  updateDoorLabelOpacity();
  if (!puertaActive) return;
  if (_doorT) clearTimeout(_doorT);
  _doorT = setTimeout(() => refreshPuertas(), 220);
});

// ===== Load base WFS layers =====
async function loadBase() {
  try {
    const [gjE, gjL, gjM] = await Promise.all([
      fetchGeoJSON(wfsUrl(GEO.layers.edifica, { maxFeatures: 200000 })),
      fetchGeoJSON(wfsUrl(GEO.layers.lote, { maxFeatures: 200000 })),
      fetchGeoJSON(wfsUrl(GEO.layers.manzana, { maxFeatures: 200000 }))
    ]);

    layerEdifica.addData(gjE);
    layerLote.addData(gjL);
    layerManzana.addData(gjM);

    // Bounds por distrito (ubigeo) para dirigir la vista tras elegir en el modal
    try { _districtBounds = _computeDistrictBounds(gjM, GEO.fields.ubigeo); } catch(e) { _districtBounds = null; }

    _baseLoaded = true;

    // Si ya eligieron distrito antes de que termine la carga, enfocamos aquí
    if (_pendingUbigeo) {
      focusDistrict(_pendingUbigeo);
      _pendingUbigeo = null;
    } else {
      // Con modal de distrito, mantenemos la vista inicial hasta que el usuario elija.
      // (Si no hay modal, conservamos el comportamiento anterior.)
      const hasModal = !!document.getElementById("district-modal");
      if (!hasModal) {
        const b = layerManzana.getBounds();
        if (b && b.isValid()) map.fitBounds(b, { padding: [30, 30] });
      }
    }

    updateLabelOpacity();
  } catch (e) {
    console.warn(e);
    if (searchResult) searchResult.textContent = "⚠️ No se pudieron cargar capas base (WFS/CORS).";
  }
}