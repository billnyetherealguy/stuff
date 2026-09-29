// OpenStreetMap lookups through the Overpass API.
//
// A building's identity is its OSM element ("w123" / "r456"). Map tiles can't
// tell us that reliably (OpenFreeMap merges same-height buildings into one
// feature, and includes building:part pieces), so the building under a click is
// resolved here: fetch nearby `building=*` outlines and keep the smallest one
// that contains the point.

import { distanceM, interiorPoint, maxVertexDistanceM, pointInPolygon, pointInRing, polygonAreaM2 } from './geo.js';

const CACHE_KEY = 'solworld:osm:v1';
const CACHE_LIMIT = 300;
const KEEP_TAGS = /^(name(:en)?|building(:levels|:min_level|:height|:min_height)?|height|min_height|levels|min_level|addr:.*|wikidata|wikipedia|wikimedia_commons|image|start_date|architect|operator|tourism|amenity|historic|aeroway)$/;

const same = (a, b) => a[0] === b[0] && a[1] === b[1];
const closed = (r) => r.length > 3 && same(r[0], r[r.length - 1]);

/** Joins way segments (arrays of [lng, lat]) into closed rings. */
export function assembleRings(segments) {
  const pool = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  const rings = [];
  while (pool.length) {
    let ring = pool.shift();
    for (let guard = 0; !closed(ring) && guard < 500; guard++) {
      const tail = ring[ring.length - 1];
      const i = pool.findIndex((w) => same(w[0], tail) || same(w[w.length - 1], tail));
      if (i < 0) break;
      const [w] = pool.splice(i, 1);
      ring = ring.concat(same(w[0], tail) ? w.slice(1) : w.slice(0, -1).reverse());
    }
    if (closed(ring)) rings.push(ring);
  }
  return rings;
}

const toCoords = (geometry) => (geometry || []).filter(Boolean).map((p) => [p.lon, p.lat]);

/** Converts an Overpass element (with `out geom`) to polygons, or [] if it isn't an area. */
export function elementPolygons(el) {
  if (el.type === 'way') {
    const ring = toCoords(el.geometry);
    return closed(ring) ? [[ring]] : [];
  }
  if (el.type === 'relation') {
    const outers = assembleRings((el.members || []).filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => toCoords(m.geometry)));
    const inners = assembleRings((el.members || []).filter((m) => m.type === 'way' && m.role === 'inner').map((m) => toCoords(m.geometry)));
    const polys = outers.map((o) => [o]);
    for (const inner of inners) {
      const host = polys.find((p) => pointInRing(inner[0], p[0]));
      if (host) host.push(inner);
    }
    return polys;
  }
  return [];
}

function toBuilding(el) {
  const polygons = elementPolygons(el);
  if (!polygons.length) return null;
  const tags = {};
  for (const [k, v] of Object.entries(el.tags || {})) if (KEEP_TAGS.test(k)) tags[k] = v;
  let largest = polygons[0];
  let area = 0;
  for (const p of polygons) {
    const a = polygonAreaM2(p);
    area += a;
    if (a > polygonAreaM2(largest)) largest = p;
  }
  return {
    key: `${el.type === 'way' ? 'w' : 'r'}${el.id}`,
    type: el.type,
    id: el.id,
    tags,
    polygons,
    center: interiorPoint(largest),
    area,
  };
}

const round7 = (n) => Math.round(n * 1e7) / 1e7;

function parseMeters(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  const ft = /(ft|feet|')\s*$/.test(s);
  const n = parseFloat(s.replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return ft ? n * 0.3048 : n;
}

/** Same height rules as the OpenMapTiles building layer. */
export function buildingHeights(tags = {}) {
  const height = parseMeters(tags.height ?? tags['building:height']);
  const minHeight = parseMeters(tags.min_height ?? tags['building:min_height']);
  const levels = parseFloat(tags['building:levels'] ?? tags.levels);
  const minLevels = parseFloat(tags['building:min_level'] ?? tags.min_level);
  return {
    top: Math.ceil(height ?? (Number.isFinite(levels) ? levels * 3.66 : 5)),
    base: Math.floor(minHeight ?? (Number.isFinite(minLevels) ? minLevels * 3.66 : 0)),
    height,
    levels: Number.isFinite(levels) ? levels : null,
  };
}

/**
 * A building key from its footprint location, for buildings we can see in the
 * map tiles but couldn't look up: "g" + the footprint's center rounded to
 * ~1 m. Everyone sees the same tiles, so everyone derives the same key.
 */
export function geoKey([lng, lat]) {
  const latI = Math.round((lat + 90) * 1e5);
  const lngI = Math.round((lng + 180) * 1e5);
  return `g${latI * 1e8 + lngI}`;
}

export function geoKeyCenter(key) {
  const n = Number(String(key).slice(1));
  return [((n % 1e8) - 18_000_000) / 1e5, (Math.floor(n / 1e8) - 9_000_000) / 1e5];
}

export const isOsmKey = (key) => /^[wr]/.test(key || '');

export class OsmClient {
  constructor({ endpoints, storage, timeoutMs = 12_000 }) {
    this.endpoints = endpoints;
    this.storage = storage;
    this.timeoutMs = timeoutMs;
    this.cursor = 0;
    this.byKey = new Map();
    this.coverage = [];
    this.inflight = new Map();
    const saved = storage?.get(CACHE_KEY);
    if (Array.isArray(saved)) for (const b of saved) if (b?.key) this.byKey.set(b.key, b);
  }

  remember(building) {
    this.byKey.delete(building.key);
    this.byKey.set(building.key, building);
    while (this.byKey.size > CACHE_LIMIT * 2) this.byKey.delete(this.byKey.keys().next().value);
    clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => this.persist(), 1500);
    return building;
  }

  persist() {
    const slim = [...this.byKey.values()].slice(-CACHE_LIMIT).map((b) => ({
      ...b,
      polygons: b.polygons.map((p) => p.map((r) => r.map(([x, y]) => [round7(x), round7(y)]))),
    }));
    this.storage?.set(CACHE_KEY, slim);
  }

  /**
   * Runs an Overpass query. Public Overpass servers are often busy, so the
   * request is hedged: the next server is tried in parallel if the first is
   * slow, and the first good answer wins (the others are cancelled).
   */
  async query(ql, { hedgeMs = 1200, deadlineMs = 0 } = {}) {
    if (this.inflight.has(ql)) return this.inflight.get(ql);
    const run = new Promise((resolve, reject) => {
      const n = this.endpoints.length;
      const controllers = [];
      const timers = [];
      let failed = 0;
      let started = 0;
      let done = false;
      let lastError;
      const finish = () => {
        done = true;
        timers.forEach(clearTimeout);
        controllers.forEach((c) => c.abort());
      };
      const launch = () => {
        if (done || started >= n) return;
        const index = (this.cursor + started++) % n;
        const controller = new AbortController();
        controllers.push(controller);
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        timers.push(timeout);
        fetch(this.endpoints[index], { method: 'POST', body: new URLSearchParams({ data: ql }), signal: controller.signal })
          .then(async (res) => {
            if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
            const json = await res.json();
            if (done) return;
            this.cursor = index; // remember the server that answered
            finish();
            resolve(json);
          })
          .catch((err) => {
            if (done) return;
            lastError = err;
            failed++;
            if (failed >= n) {
              finish();
              reject(lastError || new Error('Overpass unavailable'));
            } else launch(); // failed fast: try the next server right away
          })
          .finally(() => clearTimeout(timeout));
      };
      launch();
      for (let i = 1; i < n; i++) timers.push(setTimeout(launch, hedgeMs * i));
      if (deadlineMs) {
        timers.push(
          setTimeout(() => {
            if (done) return;
            finish();
            reject(new Error('Overpass timed out'));
          }, deadlineMs),
        );
      }
    });
    this.inflight.set(ql, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(ql);
    }
  }

  _ingest(json, point) {
    let best = null;
    for (const el of json.elements || []) {
      if (el.tags?.building === 'no') continue;
      const building = toBuilding(el);
      if (!building) continue;
      this.remember(building);
      if (point && building.polygons.some((p) => pointInPolygon(point, p)) && (!best || building.area < best.area)) best = building;
    }
    return best;
  }

  /**
   * Loads every building around `center` in the background, so clicks nearby
   * resolve instantly from memory. Skips areas already covered.
   */
  async prefetchArea(center, radius = 250) {
    if (this.inflight.size) return; // never compete with a lookup someone is waiting for
    if (this.coverage.some((c) => distanceM(center, c.center) <= c.radius - radius * 0.6)) return;
    const key = `${center[0].toFixed(3)},${center[1].toFixed(3)}`;
    if (this._prefetching === key) return;
    this._prefetching = key;
    try {
      const [lng, lat] = center.map((n) => n.toFixed(6));
      const around = `(around:${radius},${lat},${lng})`;
      const json = await this.query(`[out:json][timeout:25];(way[building]${around};relation[building][type=multipolygon]${around};);out tags geom;`, { hedgeMs: 4000 });
      this._ingest(json);
      this.coverage.push({ center, radius });
      if (this.coverage.length > 200) this.coverage.shift();
    } catch {
      // best effort; clicks fall back to a direct lookup
    } finally {
      if (this._prefetching === key) this._prefetching = null;
    }
  }

  /**
   * Smallest cached building containing the point. Only trusted inside an area
   * we have fully searched, so a small building inside a large one is never
   * mistaken for its neighbour.
   */
  cachedAt(point) {
    if (!this.coverage.some((c) => distanceM(point, c.center) <= c.radius - 5)) return null;
    let best = null;
    for (const b of this.byKey.values()) {
      if (b.polygons.some((p) => pointInPolygon(point, p)) && (!best || b.area < best.area)) best = b;
    }
    return best;
  }

  /**
   * Resolves the OSM building that contains `point` ([lng, lat]). `hint` is the
   * footprint seen in the map tile, used to size the search radius.
   */
  async buildingAt(point, hint) {
    const cached = this.cachedAt(point);
    if (cached) return cached;
    const reach = hint ? maxVertexDistanceM(point, hint) : 40;
    let radius = Math.min(260, Math.max(20, Math.ceil(reach + 12)));
    for (let pass = 0; pass < 2; pass++) {
      const [lng, lat] = point.map((n) => n.toFixed(7));
      const around = `(around:${radius},${lat},${lng})`;
      const ql =
        `[out:json][timeout:12];(way[building]${around};relation[building][type=multipolygon]${around};` +
        `way[aeroway~"^(terminal|hangar)$"]${around};);out tags geom;`;
      const json = await this.query(ql, { deadlineMs: 7000 });
      this.coverage.push({ center: point, radius });
      if (this.coverage.length > 200) this.coverage.shift();
      const best = this._ingest(json, point);
      if (best) return best;
      radius = Math.min(600, radius * 3);
    }
    return null;
  }

  /** Batched buildingAt for several points in one Overpass request. */
  async buildingsAtMany(items) {
    const clauses = items
      .map(({ point: [lng, lat], radius }) => {
        const a = `(around:${Math.round(radius)},${lat.toFixed(6)},${lng.toFixed(6)})`;
        return `way[building]${a};relation[building][type=multipolygon]${a};`;
      })
      .join('');
    const json = await this.query(`[out:json][timeout:40];(${clauses});out tags geom;`);
    const found = [];
    for (const el of json.elements || []) {
      if (el.tags?.building === 'no') continue;
      const building = toBuilding(el);
      if (building) found.push(this.remember(building));
    }
    for (const { point, radius } of items) this.coverage.push({ center: point, radius });
    return items.map(({ point }) => {
      let best = null;
      for (const b of found) if (b.polygons.some((p) => pointInPolygon(point, p)) && (!best || b.area < best.area)) best = b;
      return best;
    });
  }

  /** Fetches buildings by key ("w123", "r456"). Returns a Map of key -> building. */
  async buildingsByKeys(keys, { deadlineMs = 0 } = {}) {
    const out = new Map();
    const missing = [];
    for (const key of new Set(keys)) {
      if (!isOsmKey(key)) continue;
      if (this.byKey.has(key)) out.set(key, this.byKey.get(key));
      else missing.push(key);
    }
    for (let i = 0; i < missing.length; i += 150) {
      const chunk = missing.slice(i, i + 150);
      const ways = chunk.filter((k) => k[0] === 'w').map((k) => k.slice(1));
      const rels = chunk.filter((k) => k[0] === 'r').map((k) => k.slice(1));
      const parts = [];
      if (ways.length) parts.push(`way(id:${ways.join(',')});`);
      if (rels.length) parts.push(`relation(id:${rels.join(',')});`);
      const json = await this.query(`[out:json][timeout:25];(${parts.join('')});out tags geom;`, { deadlineMs });
      for (const el of json.elements || []) {
        const building = toBuilding(el);
        if (building) out.set(building.key, this.remember(building));
      }
    }
    return out;
  }
}
