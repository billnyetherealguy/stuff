// Stand-ins for the public services Solworld calls, answering with the same
// response shapes as the real APIs, backed by the synthetic world.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pointInRing } from './world.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, '..', 'artifacts', 'cache');

const M_LAT = 110_574;
const mLng = (lat) => 111_320 * Math.cos((lat * Math.PI) / 180);

function segDistM(p, a, b) {
  const kx = mLng(p[1]);
  const ax = (a[0] - p[0]) * kx;
  const ay = (a[1] - p[1]) * M_LAT;
  const bx = (b[0] - p[0]) * kx;
  const by = (b[1] - p[1]) * M_LAT;
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function ringDistM(p, ring) {
  let d = Infinity;
  for (let i = 1; i < ring.length; i++) d = Math.min(d, segDistM(p, ring[i - 1], ring[i]));
  return d;
}

function element(b) {
  const lats = b.ring.map((c) => c[1]);
  const lons = b.ring.map((c) => c[0]);
  return {
    type: 'way',
    id: b.id,
    bounds: { minlat: Math.min(...lats), minlon: Math.min(...lons), maxlat: Math.max(...lats), maxlon: Math.max(...lons) },
    geometry: b.ring.map(([lon, lat]) => ({ lat, lon })),
    tags: b.tags,
  };
}

export function createServices(world) {
  const stats = { overpass: 0, photon: 0, wiki: 0, esri: 0 };

  function overpass(ql) {
    stats.overpass++;
    const out = new Map();
    const around = /(way|relation)((?:\[[^\]]*\])*)\(around:(\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\)/g;
    let m;
    while ((m = around.exec(ql))) {
      const [, type, filters, r, lat, lng] = m;
      if (type !== 'way' || !/\[building\]/.test(filters)) continue;
      const p = [Number(lng), Number(lat)];
      for (const b of world.buildings) {
        if (!b.tags.building) continue; // building:part pieces are not buildings
        if (ringDistM(p, b.ring) <= Number(r)) out.set(b.id, b);
      }
    }
    const byId = /way\(id:([\d,]+)\)/.exec(ql);
    if (byId) for (const id of byId[1].split(',')) if (world.ways.has(Number(id))) out.set(Number(id), world.ways.get(Number(id)));
    return { version: 0.6, generator: 'Overpass API (harness)', elements: [...out.values()].map(element) };
  }

  function nearestBuilding([lng, lat]) {
    let best = null;
    for (const b of world.buildings) {
      if (!b.tags.building) continue;
      const d = pointInRing([lng, lat], b.ring) ? 0 : ringDistM([lng, lat], b.ring);
      if (!best || d < best.d) best = { d, b };
    }
    return best?.b;
  }

  function photonSearch(q) {
    stats.photon++;
    const s = q.toLowerCase();
    const features = [];
    if (s.includes('empire')) {
      const b = world.buildings.find((x) => x.tags.name === 'Empire State Building');
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-73.985664, 40.74844] },
        properties: { osm_type: 'W', osm_id: b.id, osm_key: 'building', osm_value: 'office', type: 'house', name: 'Empire State Building', housenumber: '350', street: '5th Avenue', city: 'New York', state: 'New York', country: 'United States', countrycode: 'US' },
      });
    }
    if (s.includes('tok')) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [139.6917, 35.6895] },
        properties: { osm_type: 'R', osm_id: 1543125, osm_key: 'place', osm_value: 'city', type: 'city', name: 'Tokyo', country: 'Japan', countrycode: 'JP', extent: [139.56, 35.82, 139.92, 35.52] },
      });
    }
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-73.9772, 40.7527] },
      properties: { osm_type: 'N', osm_id: 42, osm_key: 'railway', osm_value: 'station', type: 'house', name: `${q} Station`, city: 'New York', country: 'United States' },
    });
    return { type: 'FeatureCollection', features };
  }

  function photonReverse(lng, lat) {
    stats.photon++;
    const b = nearestBuilding([lng, lat]);
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lng, lat] },
          properties: {
            osm_type: 'W',
            osm_id: b?.id,
            name: b?.tags.name,
            housenumber: b?.tags['addr:housenumber'] || String(100 + ((b?.id || 0) % 300)),
            street: b?.tags['addr:street'] || '5th Avenue',
            city: lng < -60 ? 'New York' : undefined,
            state: lng < -60 ? 'New York' : undefined,
            country: lng < -60 ? 'United States' : 'Earth',
            countrycode: 'US',
          },
        },
      ],
    };
  }

  const photoFiles = { Q9188: 'Empire State Building (aerial view).jpg', Q11274: 'Chrysler Building by David Shankbone.jpg', Q12495: 'Burj Khalifa.jpg' };

  function wikidata(entity, property = 'P18') {
    stats.wiki++;
    let file = photoFiles[entity];
    if (file && property === 'P3451') file = file.replace(/\.jpg$/i, ' at night.jpg'); // every landmark has a night view here
    else if (property !== 'P18') file = null;
    return { claims: file ? { [property]: [{ mainsnak: { snaktype: 'value', property, datavalue: { value: file, type: 'string' }, datatype: 'commonsMedia' } }] } : {} };
  }

  function photoSvg(name) {
    const label = decodeURIComponent(name).replace(/_/g, ' ').replace(/\.jpg$/i, '').replace(/[<&>]/g, '');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600">
      <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2a4a"/><stop offset=".55" stop-color="#e59a5a"/><stop offset="1" stop-color="#2a1a14"/></linearGradient>
      <linearGradient id="b" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3a3f4a"/><stop offset=".5" stop-color="#8b8f99"/><stop offset="1" stop-color="#2c3038"/></linearGradient></defs>
      <rect width="960" height="600" fill="url(#s)"/>
      <g fill="#171a20">${Array.from({ length: 22 }, (_, i) => `<rect x="${i * 46}" y="${360 + ((i * 37) % 90)}" width="40" height="300"/>`).join('')}</g>
      <path d="M455 40h8v60h14v40h10v40h16v420h-86V180h16v-40h10v-40h12z" fill="url(#b)"/>
      <g fill="#ffd79a" opacity=".55">${Array.from({ length: 60 }, (_, i) => `<rect x="${428 + (i % 6) * 16}" y="${200 + Math.floor(i / 6) * 34}" width="6" height="12"/>`).join('')}</g>
      <text x="32" y="566" fill="#fff" font-family="sans-serif" font-size="22" opacity=".7">${label} (harness photo)</text>
    </svg>`;
  }

  function esriTile(z, y, x) {
    stats.esri++;
    const n = 2 ** z;
    const lon = (px) => (px / 256 / n) * 360 - 180;
    const lat = (py) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / 256 / n))) * 180) / Math.PI;
    const west = lon(x * 256);
    const east = lon((x + 1) * 256);
    const north = lat(y * 256);
    const south = lat((y + 1) * 256);
    const px = ([lng, la]) => {
      const s = Math.sin((la * Math.PI) / 180);
      const wx = ((lng + 180) / 360) * 256 * n - x * 256;
      const wy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * n - y * 256;
      return `${wx.toFixed(1)},${wy.toFixed(1)}`;
    };
    const inView = (ring) => ring.some(([lng, la]) => lng >= west - 0.002 && lng <= east + 0.002 && la <= north + 0.002 && la >= south - 0.002);
    const roofs = world.buildings
      .filter((b) => b.tags.building && inView(b.ring))
      .map((b) => {
        const h = parseFloat(b.tags.height) || 5;
        const shade = Math.min(200, 110 + h / 3);
        return `<polygon points="${b.ring.map(px).join(' ')}" fill="rgb(${shade},${shade - 4},${shade - 10})" stroke="#2a2a2a" stroke-width="1"/>`;
      })
      .join('');
    const roads = world.roads
      .filter((r) => inView(r.coords))
      .map((r) => `<polyline points="${r.coords.map(px).join(' ')}" fill="none" stroke="#5b5b58" stroke-width="${r.class === 'motorway' ? 14 : r.class === 'primary' ? 11 : 7}"/>`)
      .join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" fill="#3b3d36"/><rect width="256" height="256" fill="#2e3a2c" opacity="${(x * 7 + y * 3) % 5 === 0 ? 0.4 : 0}"/>${roads}${roofs}</svg>`;
  }

  async function glyph(stack, range) {
    const file = /italic/i.test(stack) ? 'Noto Sans Italic' : /bold|medium/i.test(stack) ? 'Noto Sans Medium' : 'Noto Sans Regular';
    const dir = path.join(CACHE, 'fonts', file);
    const target = path.join(dir, `${range}.pbf`);
    if (fs.existsSync(target)) return fs.readFileSync(target);
    const url = `https://raw.githubusercontent.com/protomaps/basemaps-assets/main/fonts/${encodeURIComponent(file)}/${range}.pbf`;
    const res = await fetch(url).catch(() => null);
    if (!res?.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, buf);
    return buf;
  }

  return { stats, overpass, photonSearch, photonReverse, wikidata, photoSvg, esriTile, glyph };
}
