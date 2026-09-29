// Geometry helpers. Polygons are arrays of rings ([outer, ...holes]); rings are
// arrays of [lng, lat]. Distances use a local equirectangular projection, which
// is accurate to well under a percent at building scale.

const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 110_574;
const mPerDegLng = (lat) => 111_320 * Math.cos(lat * DEG);

/** Splits a GeoJSON Polygon / MultiPolygon geometry into polygons. */
export function polygonsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

export function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(pt, rings) {
  if (!rings?.length || !pointInRing(pt, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (pointInRing(pt, rings[i])) return false;
  return true;
}

export function bboxOf(rings) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return [minX, minY, maxX, maxY];
}

/** Signed area of a ring in square meters (positive = counter-clockwise). */
function ringAreaM2(ring, lat0) {
  const kx = mPerDegLng(lat0);
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] * kx) * (ring[i][1] * M_PER_DEG_LAT) - (ring[i][0] * kx) * (ring[j][1] * M_PER_DEG_LAT);
  }
  return sum / 2;
}

export function polygonAreaM2(rings) {
  if (!rings?.length) return 0;
  const lat0 = rings[0][0][1];
  let area = Math.abs(ringAreaM2(rings[0], lat0));
  for (let i = 1; i < rings.length; i++) area -= Math.abs(ringAreaM2(rings[i], lat0));
  return Math.max(0, area);
}

export function ringCentroid(ring) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f;
    cx += (ring[j][0] + ring[i][0]) * f;
    cy += (ring[j][1] + ring[i][1]) * f;
  }
  if (Math.abs(a) < 1e-18) {
    const [minX, minY, maxX, maxY] = bboxOf([ring]);
    return [(minX + maxX) / 2, (minY + maxY) / 2];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/** A point guaranteed to be inside the polygon (centroid when possible). */
export function interiorPoint(rings) {
  const c = ringCentroid(rings[0]);
  if (pointInPolygon(c, rings)) return c;
  // Scan a horizontal line through the middle and take the widest inside span.
  const [minX, minY, maxX, maxY] = bboxOf([rings[0]]);
  let best = null;
  for (let k = 1; k < 8; k++) {
    const y = minY + ((maxY - minY) * k) / 8;
    const xs = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > y !== yj > y) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const width = xs[i + 1] - xs[i];
      if (!best || width > best.width) best = { width, pt: [(xs[i] + xs[i + 1]) / 2, y] };
    }
  }
  return best ? best.pt : [(minX + maxX) / 2, (minY + maxY) / 2];
}

export function distanceM([lng1, lat1], [lng2, lat2]) {
  const dLat = (lat2 - lat1) * DEG;
  const dLng = (lng2 - lng1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function maxVertexDistanceM(pt, rings) {
  let max = 0;
  for (const ring of rings) for (const v of ring) max = Math.max(max, distanceM(pt, v));
  return max;
}

/**
 * Pushes every edge outward by `meters` (miter joins, clamped). Used to wrap a
 * highlight shell just outside a building so it never z-fights with it.
 */
export function inflatePolygon(rings, meters) {
  if (!rings?.length) return rings;
  const lat0 = rings[0][0][1];
  const kx = mPerDegLng(lat0);
  const ky = M_PER_DEG_LAT;
  return rings.map((ring, ringIndex) => {
    const pts = ring.slice(0, ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? -1 : undefined);
    const n = pts.length;
    if (n < 3) return ring;
    const xy = pts.map(([lng, lat]) => [lng * kx, lat * ky]);
    let signed = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) signed += xy[j][0] * xy[i][1] - xy[i][0] * xy[j][1];
    // Outward normal of edge a->b is (dy, -dx) for CCW rings. Holes shrink instead of growing.
    const orient = (signed > 0 ? 1 : -1) * (ringIndex === 0 ? 1 : -1);
    const out = xy.map((p, i) => {
      const prev = xy[(i - 1 + n) % n];
      const next = xy[(i + 1) % n];
      const n1 = normal(prev, p, orient);
      const n2 = normal(p, next, orient);
      let mx = n1[0] + n2[0];
      let my = n1[1] + n2[1];
      const len = Math.hypot(mx, my) || 1;
      mx /= len;
      my /= len;
      const cos = Math.max(0.35, mx * n1[0] + my * n1[1]);
      const d = meters / cos;
      return [(p[0] + mx * d) / kx, (p[1] + my * d) / ky];
    });
    out.push(out[0]);
    return out;
  });
}

function normal(a, b, orient) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  return [(orient * dy) / len, (-orient * dx) / len];
}

/**
 * Works out which part of a (possibly merged) extruded feature is under the
 * cursor. OpenFreeMap merges same-height buildings into one MultiPolygon, so
 * MapLibre's pick returns the whole group. We walk down the camera ray from
 * the roof height to the ground and return the first footprint it enters.
 *
 * @param parts   polygons of the picked feature
 * @param ground  [lng, lat] where the cursor ray meets the ground
 * @param camera  { lngLat: [lng, lat], altitude } of the camera (meters)
 * @param top     roof height of the feature (meters); base: bottom height
 */
export function pickPartOnRay(parts, ground, camera, top, base = 0) {
  if (parts.length === 1) return parts[0];
  if (camera && camera.altitude > 1) {
    const steps = Math.max(8, Math.ceil((top - base) / 1.5));
    for (let s = 0; s <= steps; s++) {
      const z = top - ((top - base) * s) / steps;
      const t = Math.min(1, z / camera.altitude);
      const p = [ground[0] + (camera.lngLat[0] - ground[0]) * t, ground[1] + (camera.lngLat[1] - ground[1]) * t];
      for (const part of parts) if (pointInPolygon(p, part)) return part;
    }
  }
  for (const part of parts) if (pointInPolygon(ground, part)) return part;
  // Fall back to the closest footprint.
  let best = null;
  for (const part of parts) {
    const d = distanceM(ground, ringCentroid(part[0]));
    if (!best || d < best.d) best = { d, part };
  }
  return best?.part || null;
}

/* ----------------------------------------------------- web mercator pixels */

export function lngLatToWorldPx([lng, lat], zoom) {
  const scale = 256 * 2 ** zoom;
  const x = ((lng + 180) / 360) * scale;
  const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * DEG);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
  return [x, y];
}
