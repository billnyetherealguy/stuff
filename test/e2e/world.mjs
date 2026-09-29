// A small synthetic world in the OpenMapTiles schema, used to exercise the app
// offline: a Manhattan-like grid of buildings (with OSM-style ids and tags),
// streets, a river and a park around Midtown, a few landmarks around the
// globe, and real country outlines for the globe view.
import { createRequire } from 'node:module';
import * as topojson from 'topojson-client';

const require = createRequire(import.meta.url);

const M_LAT = 110_574;
const mLng = (lat) => 111_320 * Math.cos((lat * Math.PI) / 180);

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Counter-clockwise ring (in lng/lat) for a rectangle given in local meters.
function rect(origin, ax, ay, u0, u1, v0, v1) {
  const [lng0, lat0] = origin;
  const kx = mLng(lat0);
  const toLL = (u, v) => [lng0 + (u * ax[0] + v * ay[0]) / kx, lat0 + (u * ax[1] + v * ay[1]) / M_LAT];
  const ring = [toLL(u0, v0), toLL(u1, v0), toLL(u1, v1), toLL(u0, v1)];
  // ensure CCW in lng/lat
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % 4];
    s += a[0] * b[1] - b[0] * a[1];
  }
  if (s < 0) ring.reverse();
  ring.push(ring[0]);
  return ring;
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export const CITY_CENTER = [-73.9855, 40.7484];
const THETA = (29 * Math.PI) / 180;
const ALONG = [Math.sin(THETA), Math.cos(THETA)]; // avenues run NNE
const ACROSS = [Math.cos(THETA), -Math.sin(THETA)]; // streets run ESE

const SPECIAL = [
  { at: [-73.985664, 40.74844], tags: { name: 'Empire State Building', building: 'office', height: '443', 'building:levels': '102', wikidata: 'Q9188', start_date: '1931', architect: 'Shreve, Lamb & Harmon', 'addr:housenumber': '350', 'addr:street': '5th Avenue' } },
  { at: [-73.975311, 40.751652], tags: { name: 'Chrysler Building', building: 'office', height: '319', 'building:levels': '77', wikidata: 'Q11274', start_date: '1930' } },
  { at: [-73.989699, 40.741061], tags: { name: 'Flatiron Building', building: 'office', height: '87', 'building:levels': '22', start_date: '1902' } },
];

// Standalone landmarks elsewhere (so demo seeds resolve and glow on the globe).
const REMOTE = [
  ['Burj Khalifa', 55.274376, 25.197197, 828, 'Q12495'],
  ['Eiffel Tower', 2.294481, 48.85837, 330, 'Q243'],
  ['The Shard', -0.0865, 51.5045, 310, 'Q45797'],
  ['Tokyo Tower', 139.745433, 35.658581, 333, 'Q183432'],
  ['Sydney Opera House', 151.215297, -33.856784, 65, 'Q45178'],
  ['Taipei 101', 121.564468, 25.033964, 508, 'Q66478'],
  ['Colosseum', 12.492231, 41.89021, 48, 'Q10285'],
  ['Petronas Towers', 101.7116, 3.1578, 452, 'Q83063'],
];

export function buildWorld() {
  const rand = rng(7);
  const buildings = [];
  let nextId = 1_000_001;
  const ways = new Map();

  const addBuilding = (ring, tags) => {
    const id = nextId++;
    const b = { type: 'way', id, ring, tags };
    buildings.push(b);
    ways.set(id, b);
    return b;
  };

  // Street grid.
  const avenues = [];
  const streets = [];
  const AVE = 262;
  const ST = 80;
  const nA = 8;
  const nS = 30;
  const [cx, cy] = CITY_CENTER;
  const kx = mLng(cy);
  const toLL = (u, v) => [cx + (u * ACROSS[0] + v * ALONG[0]) / kx, cy + (u * ACROSS[1] + v * ALONG[1]) / M_LAT];
  const aveNames = ['11th Avenue', '10th Avenue', '9th Avenue', '8th Avenue', '7th Avenue', '6th Avenue', '5th Avenue', 'Madison Avenue', 'Park Avenue'];
  for (let i = 0; i <= nA; i++) {
    const u = (i - nA / 2) * AVE;
    avenues.push({ class: i % 4 === 0 ? 'primary' : 'secondary', name: aveNames[i] || `Avenue ${i}`, coords: [toLL(u, -nS / 2 * ST - 60), toLL(u, nS / 2 * ST + 60)] });
  }
  for (let j = 0; j <= nS; j++) {
    const v = (j - nS / 2) * ST;
    streets.push({ class: j % 6 === 0 ? 'secondary' : 'minor', name: `W ${20 + j}th Street`, coords: [toLL(-nA / 2 * AVE - 40, v), toLL(nA / 2 * AVE + 40, v)] });
  }

  // Blocks and lots.
  const parkBlock = { i: 4, j: 17 }; // an open square
  const partsLot = { i: 3, j: 12, k: 2 };
  for (let i = 0; i < nA; i++) {
    for (let j = 0; j < nS; j++) {
      if (i === parkBlock.i && j === parkBlock.j) continue;
      const u0 = (i - nA / 2) * AVE + 15;
      const u1 = u0 + AVE - 30;
      const v0 = (j - nS / 2) * ST + 10;
      const v1 = v0 + ST - 20;
      const lots = 4 + Math.floor(rand() * 4);
      const width = (u1 - u0) / lots;
      for (let k = 0; k < lots; k++) {
        const a = u0 + k * width + 1.5;
        const b = a + width - 3;
        const depthCut = rand() < 0.25 ? (v1 - v0) * 0.45 : 0;
        const ring = rect([cx, cy], ACROSS, ALONG, a, b, v0 + (rand() < 0.5 ? depthCut : 0), v1 - (rand() < 0.5 ? 0 : depthCut));
        const tall = rand();
        const tags = { building: rand() < 0.2 ? 'apartments' : 'yes' };
        if (tall < 0.42) {
          // default height (5 m) -> merged by the tile generator
        } else if (tall < 0.8) tags.height = String(15 + Math.round(rand() * 8) * 5);
        else if (tall < 0.95) tags.height = String(60 + Math.round(rand() * 20) * 7);
        else tags.height = String(160 + Math.round(rand() * 20) * 10);
        if (rand() < 0.3) {
          tags['addr:housenumber'] = String(10 + Math.floor(rand() * 400));
          tags['addr:street'] = streets[j].name;
        }
        if (i === partsLot.i && j === partsLot.j && k === partsLot.k) {
          const outline = addBuilding(ring, { building: 'yes', name: 'Harness Tower', height: '120', 'building:levels': '30' });
          outline.hasParts = true;
          // Two building:part pieces with different heights (not buildings themselves).
          const mid = (a + b) / 2;
          const p1 = rect([cx, cy], ACROSS, ALONG, a, mid, v0, v1);
          const p2 = rect([cx, cy], ACROSS, ALONG, mid, b, v0, v1);
          buildings.push({ type: 'way', id: nextId++, ring: p1, tags: { 'building:part': 'yes', height: '120' }, part: true });
          buildings.push({ type: 'way', id: nextId++, ring: p2, tags: { 'building:part': 'yes', height: '60' }, part: true });
          continue;
        }
        addBuilding(ring, tags);
      }
    }
  }

  // Landmarks: clear whatever stands on the spot and put the building there.
  for (const s of SPECIAL) {
    const footprint = rect(s.at, ACROSS, ALONG, -30, 30, -22, 22);
    for (let n = buildings.length - 1; n >= 0; n--) {
      const b = buildings[n];
      if (b.ring.some((v) => pointInRing(v, footprint)) || pointInRing(s.at, b.ring)) {
        ways.delete(b.id);
        buildings.splice(n, 1);
      }
    }
    addBuilding(footprint, s.tags);
  }

  // Remote landmarks: one building each.
  for (const [name, lng, lat, height, qid] of REMOTE) {
    const ring = rect([lng, lat], [1, 0], [0, 1], -28, 28, -24, 24);
    addBuilding(ring, { name, building: 'yes', height: String(height), wikidata: qid });
  }

  // Park and river.
  const parkRing = rect([cx, cy], ACROSS, ALONG, (parkBlock.i - nA / 2) * AVE + 15, (parkBlock.i - nA / 2) * AVE + AVE - 15, (parkBlock.j - nS / 2) * ST + 10, (parkBlock.j - nS / 2) * ST + ST - 10);
  const riverRing = rect([cx, cy], ACROSS, ALONG, (-nA / 2) * AVE - 700, (-nA / 2) * AVE - 90, -nS / 2 * ST - 900, nS / 2 * ST + 900);
  const eastRiver = rect([cx, cy], ACROSS, ALONG, (nA / 2) * AVE + 120, (nA / 2) * AVE + 520, -nS / 2 * ST - 900, nS / 2 * ST + 900);
  const highway = [toLL(-nA / 2 * AVE - 60, -nS / 2 * ST - 800), toLL(-nA / 2 * AVE - 60, nS / 2 * ST + 800)];
  const highwayE = [toLL(nA / 2 * AVE + 80, -nS / 2 * ST - 800), toLL(nA / 2 * AVE + 80, nS / 2 * ST + 800)];

  return {
    buildings,
    ways,
    roads: [...avenues, ...streets, { class: 'motorway', name: 'West Side Highway', coords: highway }, { class: 'motorway', name: 'FDR Drive', coords: highwayE }],
    parks: [{ ring: parkRing, name: 'Bryant Park' }],
    rivers: [riverRing, eastRiver],
    places: [
      { name: 'New York', class: 'city', rank: 1, at: [-73.99, 40.73] },
      { name: 'Midtown', class: 'neighbourhood', rank: 10, at: toLL(0, 200) },
      { name: 'Chelsea', class: 'neighbourhood', rank: 10, at: toLL(-600, -700) },
      { name: 'Murray Hill', class: 'neighbourhood', rank: 10, at: toLL(700, 100) },
    ],
  };
}

/** GeoJSON FeatureCollections per OpenMapTiles layer. */
export function worldLayers(world) {
  const land = require('world-atlas/land-110m.json');
  const countries = require('world-atlas/countries-110m.json');
  const landGeo = topojson.feature(land, land.objects.land);
  const holes = [];
  for (const f of landGeo.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const p of polys) holes.push(p[0]);
  }
  const ocean = {
    type: 'Feature',
    properties: { class: 'ocean' },
    geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]], ...holes] },
  };
  const borders = topojson.mesh(countries, countries.objects.countries, (a, b) => a !== b);

  const fc = (features) => ({ type: 'FeatureCollection', features });
  const cities = [
    ['New York', -74.006, 40.7128, 1], ['London', -0.1278, 51.5074, 1], ['Paris', 2.3522, 48.8566, 1], ['Tokyo', 139.6503, 35.6762, 1],
    ['Dubai', 55.2708, 25.2048, 2], ['Singapore', 103.8198, 1.3521, 2], ['Sydney', 151.2093, -33.8688, 2], ['Los Angeles', -118.2437, 34.0522, 2],
    ['São Paulo', -46.6333, -23.5505, 2], ['Moscow', 37.6173, 55.7558, 2], ['Mumbai', 72.8777, 19.076, 2], ['Lagos', 3.3792, 6.5244, 3],
    ['Cairo', 31.2357, 30.0444, 2], ['Mexico City', -99.1332, 19.4326, 2], ['Hong Kong', 114.1694, 22.3193, 2], ['Toronto', -79.3832, 43.6532, 3],
  ];
  const countriesPts = [
    ['United States', -98, 39, 1], ['Canada', -106, 58, 1], ['Brazil', -52, -10, 1], ['Russia', 95, 62, 1], ['China', 104, 34, 1],
    ['India', 79, 22, 1], ['Australia', 134, -25, 1], ['Algeria', 3, 28, 2], ['Argentina', -64, -35, 2], ['Kazakhstan', 67, 48, 2],
  ];

  return {
    water: fc([
      ocean,
      ...world.rivers.map((ring) => ({ type: 'Feature', properties: { class: 'river' }, geometry: { type: 'Polygon', coordinates: [ring] } })),
    ]),
    boundary: fc([{ type: 'Feature', properties: { admin_level: 2, maritime: 0, disputed: 0 }, geometry: borders }]),
    park: fc(world.parks.map((p) => ({ type: 'Feature', properties: { class: 'park', name: p.name }, geometry: { type: 'Polygon', coordinates: [p.ring] } }))),
    transportation: fc(world.roads.map((r) => ({ type: 'Feature', properties: { class: r.class }, geometry: { type: 'LineString', coordinates: r.coords } }))),
    transportation_name: fc(world.roads.map((r) => ({ type: 'Feature', properties: { class: r.class, name: r.name, name_en: r.name }, geometry: { type: 'LineString', coordinates: r.coords } }))),
    place: fc([
      ...world.places.map((p) => ({ type: 'Feature', properties: { class: p.class, name: p.name, name_en: p.name, rank: p.rank }, geometry: { type: 'Point', coordinates: p.at } })),
      ...cities.map(([name, lng, lat, rank]) => ({ type: 'Feature', properties: { class: 'city', name, name_en: name, rank, capital: 0 }, geometry: { type: 'Point', coordinates: [lng, lat] } })),
      ...countriesPts.map(([name, lng, lat, rank]) => ({ type: 'Feature', properties: { class: 'country', name, name_en: name, rank }, geometry: { type: 'Point', coordinates: [lng, lat] } })),
    ]),
    poi: fc(
      world.buildings
        .filter((b, i) => i % 7 === 3 && !b.tags.name)
        .slice(0, 160)
        .map((b, i) => {
          const signs = [['bar', 'Neon Tiger'], ['restaurant', 'Joe’s Pizza'], ['cinema', 'Regal'], ['lodging', 'Hotel Aria'], ['cafe', 'Blue Cup'], ['shop', 'Hudson News'], ['nightclub', 'Club 44'], ['pharmacy', 'Duane Reade'], ['fast_food', 'Halal Cart'], ['theatre', 'Majestic']];
          const [cls, name] = signs[i % signs.length];
          const [x, y] = b.ring[0];
          return { type: 'Feature', properties: { class: cls, subclass: cls, name, name_en: name, rank: 1 + (i % 20) }, geometry: { type: 'Point', coordinates: [x, y] } };
        }),
    ),
    building: fc(
      world.buildings.map((b) => {
        const h = parseFloat(b.tags.height);
        const levels = parseFloat(b.tags['building:levels']);
        const render = Math.ceil(Number.isFinite(h) ? h : Number.isFinite(levels) ? levels * 3.66 : 5);
        return {
          type: 'Feature',
          id: b.id * 10 + 2,
          properties: { render_height: render, render_min_height: 0 },
          geometry: { type: 'Polygon', coordinates: [b.ring] },
        };
      }),
    ),
  };
}

export { pointInRing, rect };
