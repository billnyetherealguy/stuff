// "What does it actually look like?" — addresses, photos, satellite close-ups,
// and the SOL/USD price. Every lookup degrades gracefully: the panel still
// works if any of these services is unreachable.

import { bboxOf, lngLatToWorldPx } from './geo.js';
import { buildingHeights } from './osm.js';
import { fetchJson, h, titleCase } from './util.js';

/* ----------------------------------------------------------- geocoding */

export class Geocoder {
  constructor({ photon }) {
    this.base = photon.replace(/\/$/, '');
    this.reverseCache = new Map();
  }

  async search(q, { near } = {}) {
    const params = new URLSearchParams({ q, limit: '7', lang: 'en' });
    if (near) {
      params.set('lat', near[1].toFixed(4));
      params.set('lon', near[0].toFixed(4));
    }
    const json = await fetchJson(`${this.base}/api/?${params}`, { timeoutMs: 8000 });
    return (json.features || []).map((f) => {
      const p = f.properties || {};
      const context = [p.city || p.town || p.district, p.state, p.country].filter((v, i, a) => v && a.indexOf(v) === i && v !== p.name);
      return {
        name: p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.city || p.country || 'Unnamed place',
        context: context.join(', '),
        kind: p.osm_value || p.type || '',
        center: f.geometry?.coordinates,
        extent: p.extent, // [west, north, east, south]
        osmKey: p.osm_type === 'W' ? `w${p.osm_id}` : p.osm_type === 'R' ? `r${p.osm_id}` : null,
        isBuilding: p.osm_key === 'building' || p.type === 'house',
      };
    });
  }

  async reverse([lng, lat]) {
    const key = `${lng.toFixed(5)},${lat.toFixed(5)}`;
    if (this.reverseCache.has(key)) return this.reverseCache.get(key);
    const run = fetchJson(`${this.base}/reverse?lon=${lng}&lat=${lat}&limit=1&lang=en`, { timeoutMs: 8000 })
      .then((json) => {
        const p = json.features?.[0]?.properties;
        if (!p) return null;
        return {
          name: p.name || null,
          street: [p.housenumber, p.street].filter(Boolean).join(' ') || null,
          city: p.city || p.town || p.village || p.district || p.county || null,
          state: p.state || null,
          country: p.country || null,
          countryCode: p.countrycode || null,
          osmKey: p.osm_type === 'W' ? `w${p.osm_id}` : p.osm_type === 'R' ? `r${p.osm_id}` : null,
        };
      })
      .catch(() => null);
    this.reverseCache.set(key, run);
    return run;
  }
}

/* ------------------------------------------------------------- building */

const KIND_LABELS = {
  yes: 'Building',
  apartments: 'Apartments',
  residential: 'Residential',
  house: 'House',
  detached: 'House',
  terrace: 'Terraced houses',
  commercial: 'Commercial',
  office: 'Office',
  retail: 'Retail',
  industrial: 'Industrial',
  warehouse: 'Warehouse',
  hotel: 'Hotel',
  church: 'Church',
  cathedral: 'Cathedral',
  mosque: 'Mosque',
  temple: 'Temple',
  synagogue: 'Synagogue',
  school: 'School',
  university: 'University',
  hospital: 'Hospital',
  train_station: 'Train station',
  transportation: 'Transit',
  stadium: 'Stadium',
  civic: 'Civic',
  government: 'Government',
  public: 'Public',
  museum: 'Museum',
  garage: 'Garage',
  garages: 'Garages',
  roof: 'Canopy',
  construction: 'Under construction',
  skyscraper: 'Skyscraper',
  tower: 'Tower',
};

export function buildingKind(tags = {}) {
  if (tags.aeroway === 'terminal') return 'Airport terminal';
  if (tags.aeroway === 'hangar') return 'Hangar';
  const b = tags.building;
  return KIND_LABELS[b] || (b ? titleCase(b) : 'Building');
}

export function buildingTitle(tags = {}) {
  const name = tags['name:en'] || tags.name;
  if (name) return name;
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  return street || null;
}

export function buildingFacts(building, tileHeight) {
  const tags = building?.tags || {};
  const heights = buildingHeights(tags);
  const height = heights.height ?? (heights.levels ? heights.levels * 3.66 : tileHeight ?? null);
  return {
    kind: buildingKind(tags),
    height,
    heightExact: heights.height != null,
    levels: heights.levels,
    area: building?.area ?? null,
    built: (tags.start_date || '').match(/\d{4}/)?.[0] || null,
    architect: tags.architect || null,
    operator: tags.operator || null,
  };
}

/* --------------------------------------------------------------- photos */

const COMMONS_HOSTS = /^https:\/\/(upload\.wikimedia\.org|commons\.wikimedia\.org)\//;

export class PhotoFinder {
  constructor({ wikipedia, wikidata, commonsFile }) {
    this.wikipedia = wikipedia;
    this.wikidata = wikidata;
    this.commonsFile = commonsFile;
    this.cache = new Map();
  }

  commonsUrl(file, width = 960) {
    const name = String(file).replace(/^File:/i, '').trim().replace(/ /g, '_');
    return `${this.commonsFile}${encodeURIComponent(name)}?width=${width}`;
  }

  find({ key, tags = {}, center }) {
    if (!this.cache.has(key)) this.cache.set(key, this._find(tags, center).catch(() => null));
    return this.cache.get(key);
  }

  async _find(tags, center) {
    if (/^Q\d+$/.test(tags.wikidata || '')) {
      try {
        const json = await fetchJson(
          `${this.wikidata}?action=wbgetclaims&entity=${tags.wikidata}&property=P18&format=json&origin=*`,
          { timeoutMs: 8000 },
        );
        const file = json.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
        if (file) return { url: this.commonsUrl(file), credit: 'Wikimedia Commons', exact: true, link: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file.replace(/ /g, '_'))}` };
      } catch {
        // fall through to the next source
      }
    }
    if (/^File:/i.test(tags.wikimedia_commons || '')) {
      return { url: this.commonsUrl(tags.wikimedia_commons), credit: 'Wikimedia Commons', exact: true, link: `https://commons.wikimedia.org/wiki/${encodeURIComponent(tags.wikimedia_commons.replace(/ /g, '_'))}` };
    }
    if (COMMONS_HOSTS.test(tags.image || '')) {
      return { url: tags.image, credit: 'Wikimedia Commons', exact: true, link: tags.image };
    }
    const wp = /^([a-z-]{2,12}):(.+)$/.exec(tags.wikipedia || '');
    if (wp) {
      try {
        const api = `https://${wp[1]}.wikipedia.org/w/api.php`;
        const json = await fetchJson(
          `${api}?action=query&format=json&origin=*&prop=pageimages&piprop=thumbnail&pithumbsize=960&titles=${encodeURIComponent(wp[2])}`,
          { timeoutMs: 8000 },
        );
        const page = Object.values(json.query?.pages || {})[0];
        if (page?.thumbnail?.source) {
          return { url: page.thumbnail.source, credit: 'Wikipedia', exact: true, link: `https://${wp[1]}.wikipedia.org/wiki/${encodeURIComponent(wp[2])}` };
        }
      } catch {
        // fall through
      }
    }
    if (!center) return null;
    const [lng, lat] = center;
    const json = await fetchJson(
      `${this.wikipedia}?action=query&format=json&origin=*&generator=geosearch&ggscoord=${lat}%7C${lng}` +
        '&ggsradius=80&ggslimit=8&prop=pageimages%7Ccoordinates&piprop=thumbnail&pithumbsize=960',
      { timeoutMs: 8000 },
    );
    const pages = Object.values(json.query?.pages || {})
      .filter((p) => p.thumbnail?.source && p.coordinates?.[0])
      .map((p) => {
        const c = p.coordinates[0];
        const d = Math.hypot((c.lat - lat) * 111_000, (c.lon - lng) * 111_000 * Math.cos((lat * Math.PI) / 180));
        return { p, d };
      })
      .sort((a, b) => a.d - b.d);
    if (!pages.length) return null;
    const { p, d } = pages[0];
    return {
      url: p.thumbnail.source,
      credit: 'Wikipedia',
      exact: d < 25,
      title: p.title,
      link: `https://en.wikipedia.org/?curid=${p.pageid}`,
    };
  }
}

/* ------------------------------------------------------------- satellite */

/**
 * A satellite close-up of one building: imagery tiles stitched into a frame,
 * with the footprint traced on top. Pure DOM (no second WebGL context).
 */
export function satelliteView({ template, maxZoom = 19, polygons, width, height, attribution }) {
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const all = polygons.flat();
  const [w, s, e, n] = bboxOf(all);

  let z = maxZoom;
  for (; z > 12; z--) {
    const [x0, y0] = lngLatToWorldPx([w, n], z);
    const [x1, y1] = lngLatToWorldPx([e, s], z);
    if (x1 - x0 <= width * 0.56 && y1 - y0 <= height * 0.56) break;
  }
  const tileZ = dpr > 1 && z < maxZoom ? z + 1 : z;
  const scale = 2 ** (tileZ - z); // world px at tileZ per CSS px
  const [cx, cy] = lngLatToWorldPx([(w + e) / 2, (s + n) / 2], tileZ);
  const left = cx - (width / 2) * scale;
  const top = cy - (height / 2) * scale;
  const tileCss = 256 / scale;
  const n2 = 2 ** tileZ;

  const pan = h('div', { class: 'sat-pan' });
  let failures = 0;
  let total = 0;
  const frame = h('div', { class: 'sat', style: { width: '100%', aspectRatio: `${width} / ${height}` } }, pan);
  for (let ty = Math.floor(top / 256); ty <= Math.floor((top + height * scale) / 256); ty++) {
    if (ty < 0 || ty >= n2) continue;
    for (let tx = Math.floor(left / 256); tx <= Math.floor((left + width * scale) / 256); tx++) {
      const wx = ((tx % n2) + n2) % n2;
      const url = template.replace('{z}', tileZ).replace('{x}', wx).replace('{y}', ty);
      total++;
      const img = h('img', {
        src: url,
        alt: '',
        draggable: 'false',
        decoding: 'async',
        referrerpolicy: 'no-referrer',
        style: {
          left: `${((tx * 256 - left) / scale / width) * 100}%`,
          top: `${((ty * 256 - top) / scale / height) * 100}%`,
          width: `${(tileCss / width) * 100}%`,
          height: `${(tileCss / height) * 100}%`,
        },
      });
      img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
      img.addEventListener(
        'error',
        () => {
          failures++;
          if (failures === total) frame.classList.add('sat--failed');
        },
        { once: true },
      );
      pan.append(img);
    }
  }

  // Footprint outline, in the same pixel space as the frame.
  const toSvg = ([lng, lat]) => {
    const [x, y] = lngLatToWorldPx([lng, lat], tileZ);
    return `${(((x - left) / scale) ).toFixed(1)},${(((y - top) / scale)).toFixed(1)}`;
  };
  const d = polygons.map((p) => p.map((ring) => `M${ring.map(toSvg).join('L')}Z`).join('')).join('');
  const svg = h('div', {
    class: 'sat-outline',
    svg: `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs><filter id="satglow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.2"/></filter></defs>
      <path d="${d}" class="sat-glow" filter="url(#satglow)" fill-rule="evenodd"/>
      <path d="${d}" class="sat-fill" fill-rule="evenodd"/>
      <path d="${d}" class="sat-line" pathLength="100" fill-rule="evenodd"/>
    </svg>`,
  });
  pan.append(svg);
  frame.append(
    h('div', { class: 'sat-hud', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i')),
    h('div', { class: 'sat-empty' }, 'Satellite imagery unavailable here'),
    h('div', { class: 'sat-credit' }, attribution),
  );
  return frame;
}

/* ------------------------------------------------------------- SOL price */

export class SolPrice {
  constructor(url) {
    this.url = url;
    this.value = null;
    this.at = 0;
    this.pending = null;
  }

  async get() {
    if (this.value && Date.now() - this.at < 5 * 60_000) return this.value;
    if (!this.url) return null;
    this.pending ||= fetchJson(this.url, { timeoutMs: 6000 })
      .then((json) => {
        const usd = Number(json?.solana?.usd);
        if (Number.isFinite(usd) && usd > 0) {
          this.value = usd;
          this.at = Date.now();
        }
        return this.value;
      })
      .catch(() => this.value)
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
}
