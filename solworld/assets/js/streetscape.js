// The street, up close (map view): real roads from the map data turned into
// 3D: asphalt road beds, raised concrete sidewalks with slab joints and
// cracks, lane markings, and trees along the streets and throughout parks.
// Everything is generated around the view from the loaded map tiles.

const M_PER_DEG_LAT = 110_574;
const mPerDegLng = (lat) => 111_320 * Math.cos((lat * Math.PI) / 180);

// Half the paved width of each road class (m), and whether it has sidewalks.
const ROADS = {
  motorway: { half: 11, walk: false },
  trunk: { half: 9, walk: false },
  primary: { half: 7.5, walk: true },
  secondary: { half: 6.5, walk: true },
  tertiary: { half: 5.5, walk: true },
  minor: { half: 4.3, walk: true },
  service: { half: 2.8, walk: false },
};
const SIDEWALK = 2.8;
const CURB = 0.16;

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------- textures */

/** Concrete sidewalk slabs with joints, hairline cracks and the odd stain. */
export function sidewalkImage(phase = 'day', size = 128) {
  const rand = rng(1337);
  const data = new Uint8ClampedArray(size * size * 4);
  const light = { day: 1, dusk: 0.7, night: 0.32 }[phase];
  const base = [166, 162, 154].map((v) => v * light);
  const put = (x, y, c) => {
    const i = (((y + size) % size) * size + ((x + size) % size)) * 4;
    data[i] = c[0];
    data[i + 1] = c[1];
    data[i + 2] = c[2];
    data[i + 3] = 255;
  };
  const get = (x, y) => {
    const i = (((y + size) % size) * size + ((x + size) % size)) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = (rand() - 0.5) * 18 * light;
    const slab = ((Math.floor(x / 64) + Math.floor(y / 64)) % 2) * 6 * light; // slabs differ slightly
    put(x, y, base.map((v) => v + n + slab));
  }
  // joints between 64px slabs
  for (let i = 0; i < size; i++) for (const j of [0, 64]) {
    put(i, j, base.map((v) => v * 0.55));
    put(j, i, base.map((v) => v * 0.55));
    put(i, j + 1, base.map((v) => v * 0.8));
    put(j + 1, i, base.map((v) => v * 0.8));
  }
  // cracks: wandering dark hairlines
  for (let c = 0; c < 5; c++) {
    let x = Math.floor(rand() * size);
    let y = Math.floor(rand() * size);
    let dir = rand() * Math.PI * 2;
    const len = 18 + rand() * 40;
    for (let k = 0; k < len; k++) {
      dir += (rand() - 0.5) * 0.9;
      x += Math.cos(dir);
      y += Math.sin(dir);
      put(Math.round(x), Math.round(y), get(Math.round(x), Math.round(y)).map((v) => v * 0.5));
    }
  }
  // gum / stains
  for (let g = 0; g < 7; g++) {
    const cx = Math.floor(rand() * size);
    const cy = Math.floor(rand() * size);
    const r = 1 + rand() * 2.5;
    for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) if (x * x + y * y <= r * r) put(cx + x, cy + y, get(cx + x, cy + y).map((v) => v * 0.72));
  }
  return { width: size, height: size, data };
}

/** Worn asphalt: fine grain, patches and oil stains. */
export function asphaltImage(phase = 'day', size = 128) {
  const rand = rng(4242);
  const data = new Uint8ClampedArray(size * size * 4);
  const light = { day: 1, dusk: 0.72, night: 0.35 }[phase];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const n = (rand() - 0.5) * 22;
    const v = (58 + n) * light;
    data[i] = v;
    data[i + 1] = v + 1;
    data[i + 2] = v + 3;
    data[i + 3] = 255;
  }
  for (let p = 0; p < 4; p++) {
    const cx = rand() * size;
    const cy = rand() * size;
    const rx = 6 + rand() * 18;
    const ry = 4 + rand() * 10;
    const k = rand() < 0.5 ? 0.82 : 1.12;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1) continue;
      const i = (y * size + x) * 4;
      data[i] *= k;
      data[i + 1] *= k;
      data[i + 2] *= k;
    }
  }
  return { width: size, height: size, data };
}

/* ------------------------------------------------------------- geometry */

/** Offsets a polyline (local meters) by `d` to its left (d > 0) or right. */
function offsetLine(pts, d) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let nx = -(b[1] - a[1]);
    let ny = b[0] - a[0];
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    out.push([pts[i][0] + nx * d, pts[i][1] + ny * d]);
  }
  return out;
}

const strip = (pts, d0, d1) => {
  const a = offsetLine(pts, d0);
  const b = offsetLine(pts, d1).reverse();
  return [...a, ...b, a[0]];
};

/** Trims `len` meters off each end of a polyline (to open up intersections). */
function trim(pts, startCut, endCut) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum.at(-1);
  if (total - startCut - endCut < 3) return null;
  const at = (s) => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const t = (s - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
  };
  const s0 = startCut;
  const s1 = total - endCut;
  const out = [at(s0)];
  for (let i = 1; i < pts.length - 1; i++) if (cum[i] > s0 && cum[i] < s1) out.push(pts[i]);
  out.push(at(s1));
  return out;
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

/**
 * Builds the streetscape around `center` from map features.
 * roads: transportation line features; greens: park/wood polygon features.
 * signs: owners' billboards [{ lng, lat, text, color }], put up at the curb in
 * front of their building so they can be read from the road.
 * Returns GeoJSON FeatureCollections: { surfaces, markings, trees, signs }
 * (sign boards and posts ride along in `trees`, which is all extrusions).
 */
export function buildStreetscape(center, roads, greens, { radius = 420, maxTrees = 900, signs = [] } = {}) {
  const [cx, cy] = center;
  const kx = mPerDegLng(cy);
  const toM = ([x, y]) => [(x - cx) * kx, (y - cy) * M_PER_DEG_LAT];
  const toLL = ([x, y]) => [cx + x / kx, cy + y / M_PER_DEG_LAT];
  const near = ([x, y]) => Math.abs(x) < radius && Math.abs(y) < radius;
  const rand = rng(Math.round(cx * 1e4) ^ Math.round(cy * 1e4));

  // Unique road polylines in meters.
  const lines = [];
  const seen = new Set();
  for (const f of roads) {
    const spec = ROADS[f.properties?.class];
    if (!spec || f.properties?.brunnel === 'tunnel') continue;
    const g = f.geometry;
    const parts = g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : [];
    for (const line of parts) {
      const pts = line.map(toM).filter(near);
      if (pts.length < 2) continue;
      const id = `${pts[0].map((v) => v.toFixed(0))}|${pts.at(-1).map((v) => v.toFixed(0))}`;
      if (seen.has(id)) continue;
      seen.add(id);
      lines.push({ pts, spec, cls: f.properties.class });
    }
  }
  // Where roads meet (shared vertices): sidewalks stop short there.
  const vcount = new Map();
  const vkey = ([x, y]) => `${Math.round(x / 2)},${Math.round(y / 2)}`;
  for (const l of lines) for (const p of l.pts) vcount.set(vkey(p), (vcount.get(vkey(p)) || 0) + 1);
  const isJunction = (p) => (vcount.get(vkey(p)) || 0) > 1;

  const surfaces = [];
  const markings = [];
  const treeSpots = [];
  for (const { pts, spec, cls } of lines) {
    surfaces.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [strip(pts, -spec.half, spec.half).map(toLL)] }, properties: { kind: 'asphalt', h: 0.03 } });
    if (spec.half >= 4) markings.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts.map(toLL) }, properties: { kind: cls === 'minor' ? 'dash' : 'center' } });
    if (!spec.walk) continue;
    const cutA = isJunction(pts[0]) ? spec.half + SIDEWALK + 2 : 0;
    const cutB = isJunction(pts.at(-1)) ? spec.half + SIDEWALK + 2 : 0;
    const walk = trim(pts, cutA, cutB);
    if (!walk) continue;
    for (const side of [1, -1]) {
      const d0 = side * spec.half;
      const d1 = side * (spec.half + SIDEWALK);
      surfaces.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [strip(walk, d0, d1).map(toLL)] }, properties: { kind: 'sidewalk', h: CURB } });
      // Street trees in the sidewalk, every ~11 m.
      const line = offsetLine(walk, side * (spec.half + 1.1));
      let carry = rand() * 11;
      for (let i = 1; i < line.length; i++) {
        const [x0, y0] = line[i - 1];
        const [x1, y1] = line[i];
        const seg = Math.hypot(x1 - x0, y1 - y0);
        for (let s = carry; s < seg; s += 9 + rand() * 5) {
          if (rand() < 0.72) treeSpots.push([x0 + ((x1 - x0) * s) / seg, y0 + ((y1 - y0) * s) / seg, 'street']);
          carry = s + 9 + rand() * 5 - seg;
        }
      }
    }
  }
  // Park and wood trees on a jittered grid.
  for (const f of greens) {
    const g = f.geometry;
    const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
    for (const p of polys) {
      const ring = p[0].map(toM);
      const xs = ring.map((v) => v[0]);
      const ys = ring.map((v) => v[1]);
      const x0 = Math.max(-radius, Math.min(...xs));
      const x1 = Math.min(radius, Math.max(...xs));
      const y0 = Math.max(-radius, Math.min(...ys));
      const y1 = Math.min(radius, Math.max(...ys));
      const step = f.properties?.class === 'wood' || f.properties?.class === 'forest' ? 6 : 9;
      for (let x = x0; x < x1; x += step) for (let y = y0; y < y1; y += step) {
        const pt = [x + (rand() - 0.5) * step * 0.8, y + (rand() - 0.5) * step * 0.8];
        if (rand() < 0.72 && pointInRing(pt, ring)) treeSpots.push([pt[0], pt[1], 'park']);
      }
    }
  }
  // Nearest trees first, capped.
  treeSpots.sort((a, b) => a[0] ** 2 + a[1] ** 2 - (b[0] ** 2 + b[1] ** 2));
  const trees = [];
  const GREENS = ['#2f5a2a', '#3a6b31', '#28502a', '#46783a', '#335f2f', '#556f2c'];
  for (const [x, y, kind] of treeSpots.slice(0, maxTrees)) {
    const size = kind === 'park' ? 0.9 + rand() * 0.6 : 0.8 + rand() * 0.35;
    const color = GREENS[Math.floor(rand() * GREENS.length)];
    const oct = (r) => {
      const ring = [];
      for (let i = 0; i <= 8; i++) {
        const a = (i / 8) * Math.PI * 2 + 0.39;
        ring.push(toLL([x + Math.cos(a) * r, y + Math.sin(a) * r]));
      }
      return ring;
    };
    const trunkTop = 2.4 * size;
    trees.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [oct(0.22 * size)] }, properties: { part: 'trunk', base: 0, top: trunkTop + 0.6, color: '#4a3726' } });
    // A rounded crown: wide middle, narrower bottom and top.
    trees.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [oct(1.5 * size)] }, properties: { part: 'crown', base: trunkTop, top: trunkTop + 1.1 * size, color } });
    trees.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [oct(2.3 * size)] }, properties: { part: 'crown', base: trunkTop + 1.1 * size, top: trunkTop + 3.2 * size, color } });
    trees.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [oct(1.4 * size)] }, properties: { part: 'crown', base: trunkTop + 3.2 * size, top: trunkTop + 4.3 * size, color } });
  }
  // Street billboards: on the sidewalk of the nearest street, facing it.
  const signPoints = [];
  for (const sign of signs) {
    const b = toM([sign.lng, sign.lat]);
    if (!near(b)) continue;
    let best = null;
    for (const { pts, spec } of lines) {
      if (!spec.walk) continue;
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1];
        const [x1, y1] = pts[i];
        const dx = x1 - x0;
        const dy = y1 - y0;
        const len2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((b[0] - x0) * dx + (b[1] - y0) * dy) / len2));
        const px = x0 + dx * t;
        const py = y0 + dy * t;
        const d = Math.hypot(b[0] - px, b[1] - py);
        if (!best || d < best.d) best = { d, px, py, dx, dy, half: spec.half };
      }
    }
    if (!best || best.d > 90) continue;
    const len = Math.hypot(best.dx, best.dy) || 1;
    const ux = best.dx / len;
    const uy = best.dy / len;
    // Normal pointing from the road toward the building.
    let nx = -uy;
    let ny = ux;
    if ((b[0] - best.px) * nx + (b[1] - best.py) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const off = Math.min(best.half + SIDEWALK - 0.5, Math.max(best.half + 0.6, best.d - 1));
    const sx = best.px + nx * off;
    const sy = best.py + ny * off;
    const box = (along, across, shift = 0) =>
      [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([a, c]) => toLL([sx + ux * (shift + a * along) + nx * c * across, sy + uy * (shift + a * along) + ny * c * across]));
    for (const shift of [-3.4, 3.4]) trees.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [box(0.16, 0.16, shift)] }, properties: { part: 'post', base: 0, top: 3.6, color: '#2b2f36' } });
    trees.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [box(4.8, 0.3)] }, properties: { part: 'board', base: 3.4, top: 8.4, color: sign.color } });
    signPoints.push({ type: 'Feature', geometry: { type: 'Point', coordinates: toLL([sx, sy]) }, properties: { text: sign.text, color: sign.color } });
  }
  const fc = (features) => ({ type: 'FeatureCollection', features });
  return { surfaces: fc(surfaces), markings: fc(markings), trees: fc(trees), signs: fc(signPoints) };
}
