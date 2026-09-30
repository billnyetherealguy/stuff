// Street life: simulated cars driving the real roads and people walking the
// sidewalks and footpaths, taken from the map data around the view. How many
// depends on how busy the place is in real life (cities.js): Manhattan or
// downtown DC is packed, a small town gets a few, the countryside gets none.
// Fewer people are out late at night.
//
// Cars keep to their lane (right- or left-hand traffic, one-way streets
// respected), follow the car ahead at a safe distance, take turns through
// intersections and turn onto the streets that really connect. People keep to
// the sidewalks, step around each other and turn the corner onto the next
// block.

import { busyness } from './cities.js';
import { ROADS, SIDEWALK, clipLine } from './streetscape.js';

const M_PER_DEG_LAT = 110_574;
const mPerDegLng = (lat) => 111_320 * Math.cos((lat * Math.PI) / 180);

const FOOT_PATHS = new Set(['path', 'pedestrian', 'footway']);
const LANE_W = 3.3; // meters
const IDM = { s0: 2.2, T: 1.15, a: 1.8, b: 3 }; // car following (intelligent driver model)
const JUNCTION_HOLD = 1.1; // seconds a car keeps an intersection after entering it

const PEOPLE_COLORS = ['#2d3440', '#6b2d2d', '#2f4f6f', '#c9b28b', '#1f1f1f', '#7a6a55', '#3f5a3a', '#b04a6a', '#d8d2c4', '#4b3b6b'];
const WALKERS = 36; // assets/models/walker-N.glb
// assets/models/car-N.glb, and each one's paint (for the flat map)
const CAR_PAINT = ['#2f6fc4', '#eeeeee', '#4a3620', '#c9c9c9', '#c41c16', '#62c475', '#93f2de', '#1e9e1a', '#c9c9c9', '#2a22b8', '#c9c9c9'];

// Where traffic keeps left (rough boxes: [west, south, east, north]).
const KEEP_LEFT = [
  [-11, 49.8, 2, 61], // UK, Ireland
  [122.9, 24, 146, 46], // Japan
  [68, 6, 97.5, 35.6], // India, Nepal, Bangladesh, Sri Lanka
  [112, -44, 154, -10], // Australia
  [166, -47.5, 179, -34], // New Zealand
  [16, -35, 33, -22], // South Africa and neighbours
  [95, -11, 141, 6], // Indonesia, Malaysia, Singapore
  [97.3, 5.6, 105.7, 20.5], // Thailand
  [113.8, 22.1, 114.5, 22.6], // Hong Kong
  [-62, 10, -60.5, 11.4], // Trinidad and Tobago
];
export const keepsLeft = (lng, lat) => KEEP_LEFT.some(([w, s, e, n]) => lng >= w && lng <= e && lat >= s && lat <= n);

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const angleDiff = (a, b) => ((((b - a) % 360) + 540) % 360) - 180;

/** How many cars and people to simulate around a place. */
export function streetLife(lng, lat, { night = false } = {}) {
  const f = busyness(lat, lng).factor; // 1 (nowhere) … ~43 (center of NYC)
  const density = Math.min(3.5, Math.max(0, (f - 1.15) / 5));
  return {
    cars: Math.round(Math.min(170, 46 * density * (night ? 0.55 : 1))),
    people: Math.round(Math.min(260, 74 * density * (night ? 0.35 : 1))),
    density,
  };
}

export class Traffic {
  constructor() {
    this.agents = [];
    this.lanes = { car: [], foot: [] };
    this.rand = rng(Date.now() & 0xffff);
    this.center = null;
    this.ids = 0;
    this.time = 0;
  }

  /**
   * Rebuilds the road network from map features near `center` and respawns
   * the right numbers of cars and people for this place.
   * `features`: GeoJSON-ish { geometry, properties: { class, oneway } } road lines.
   */
  setArea(center, features, { radius = 650, night = false } = {}) {
    const [cx, cy] = center;
    const kx = mPerDegLng(cy);
    const toM = ([x, y]) => [(x - cx) * kx, (y - cy) * M_PER_DEG_LAT];
    this.origin = { cx, cy, kx };
    this.left = keepsLeft(cx, cy);
    const roads = [];
    const seen = new Set();
    for (const f of features) {
      const cls = f.properties?.class;
      const geom = f.geometry;
      const spec = ROADS[cls];
      const foot = FOOT_PATHS.has(cls);
      if (!geom || (!spec && !foot) || f.properties?.brunnel === 'tunnel') continue;
      const lines = geom.type === 'LineString' ? [geom.coordinates] : geom.type === 'MultiLineString' ? geom.coordinates : [];
      for (const line of lines) {
        for (let pts of clipLine(line.map(toM), radius * 1.2)) {
          const id = `${cls}:${pts[0].map((v) => v.toFixed(0))}:${pts.at(-1).map((v) => v.toFixed(0))}`;
          const rid = `${cls}:${pts.at(-1).map((v) => v.toFixed(0))}:${pts[0].map((v) => v.toFixed(0))}`;
          if (seen.has(id) || seen.has(rid)) continue; // the same road comes from several tiles
          seen.add(id);
          let oneway = Number(f.properties?.oneway) || 0;
          if (oneway === -1) {
            pts = pts.slice().reverse();
            oneway = 1;
          }
          const road = this._road(pts, cls, spec, oneway, foot);
          if (road.length >= 12) roads.push(road);
        }
      }
    }
    // Junctions: road vertices shared with other roads.
    const jn = new Map();
    const key = ([x, y]) => `${Math.round(x / 1.5)}:${Math.round(y / 1.5)}`;
    for (const r of roads) r.keys = r.pts.map(key);
    for (const r of roads) r.keys.forEach((k, i) => (jn.get(k) || jn.set(k, { at: [], holder: null, until: 0 }).get(k)).at.push({ road: r, i }));
    roads.forEach((r, i) => (r.id = i));
    // A real intersection, not just where a road was cut in two by map tiles.
    const isEnd = (o) => o.i === 0 || o.i === o.road.pts.length - 1;
    for (const j of jn.values()) j.real = j.at.length > 2 || (j.at.length === 2 && !j.at.every(isEnd));
    for (const r of roads) r.jv = r.keys.map((k, i) => (jn.get(k).real ? i : -1)).filter((i) => i >= 0);
    this.jn = jn;
    this.roads = roads;
    const car = roads.filter((r) => r.car);
    const foot = roads.filter((r) => r.walk || r.path);
    this.lanes = { car, foot };
    this.carWeight = cumulative(car.map((r) => r.length * r.carLanes * (r.oneway ? 1 : 2)));
    this.footWeight = cumulative(foot.map((r) => r.length * (r.path ? 1 : 2)));
    const want = streetLife(cx, cy, { night });
    this.want = want;
    this.agents = [];
    for (let i = 0; i < want.cars && car.length; i++) this._place(this._car());
    for (let i = 0; i < want.people && foot.length; i++) this._place(this._person());
  }

  _road(pts, cls, spec, oneway, path) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const half = spec?.half ?? 1.5;
    const total = Math.max(1, Math.floor((2 * half) / LANE_W));
    return {
      pts,
      cum,
      length: cum.at(-1),
      cls,
      half,
      oneway,
      car: !!spec,
      walk: !!spec?.walk,
      path,
      // Lanes each way (all of them on a one-way street).
      carLanes: oneway ? total : Math.max(1, Math.floor(total / 2)),
    };
  }

  /** Which vehicle (3D model in assets/models) and its real size. Cabs in busy cities. */
  _vehicle() {
    const r = this.rand;
    const x = r();
    const cabs = (this.want?.density || 0) > 1.5 ? 0.16 : 0.02;
    let v;
    if (x < 0.02) v = { model: 'bus', length: 12, width: 2.55, height: 3.1, color: '#2b5aa8', vmax: 11 };
    else if (x < 0.06) v = { model: 'van', length: 5.6, width: 2, height: 2.3, color: '#eceff2', vmax: 13 };
    else if (x < 0.06 + cabs) v = { model: 'car-taxi', length: 4.45, width: 1.9, height: 1.45, color: '#f2b705', vmax: 14 };
    else {
      const i = Math.floor(r() * CAR_PAINT.length);
      v = { model: `car-${i}`, length: 4.3, width: 1.9, height: 1.45, color: CAR_PAINT[i], vmax: 13 + r() * 4 };
    }
    return { ...v, id: ++this.ids };
  }

  _car() {
    const road = this.lanes.car[pickWeighted(this.carWeight, this.rand())];
    const dir = road.oneway || this.rand() < 0.5 ? 1 : -1;
    const fast = road.cls === 'motorway' || road.cls === 'trunk';
    const v = this._vehicle();
    return {
      kind: 'car',
      road,
      dir,
      lane: Math.floor(this.rand() * road.carLanes),
      s: this.rand() * road.length,
      ...v,
      vmax: fast ? v.vmax + 10 : road.cls === 'service' || road.cls === 'minor' ? v.vmax * 0.7 : v.vmax,
      v: 0,
    };
  }

  _person() {
    const r = this.rand;
    const road = this.lanes.foot[pickWeighted(this.footWeight, r())];
    return {
      kind: 'person',
      road,
      dir: r() < 0.5 ? 1 : -1,
      side: road.path ? 0 : r() < 0.5 ? 1 : -1,
      s: r() * road.length,
      lat: (r() - 0.5) * 1.1,
      latTarget: 0,
      vmax: 1.1 + r() * 0.5,
      v: 1.2,
      walked: r() * 10,
      color: PEOPLE_COLORS[Math.floor(r() * PEOPLE_COLORS.length)],
      model: `walker-${Math.floor(r() * WALKERS)}`,
      id: ++this.ids,
      length: 0.45,
      width: 0.5,
      height: 1.65 + r() * 0.2,
      pause: 0,
    };
  }

  /** Adds an agent where it doesn't overlap anyone (a few tries). */
  _place(a) {
    for (let t = 0; t < 6; t++) {
      const clash = this.agents.some((b) => b.road === a.road && b.dir === a.dir && b.lane === a.lane && b.side === a.side && Math.abs(b.s - a.s) < (a.kind === 'car' ? 9 : 1.2));
      if (!clash) break;
      a.s = this.rand() * a.road.length;
    }
    a.vmax ||= 10;
    this._pose(a, true);
    this.agents.push(a);
  }

  /** Advances everyone by `dt` seconds. */
  step(dt) {
    if (!this.roads) return;
    // Small fixed substeps keep following distances stable at any frame rate.
    for (let left = Math.min(dt, 0.5); left > 1e-4; left -= 0.05) this._tick(Math.min(0.05, left));
  }

  _tick(dt) {
    this.time += dt;
    // Who's ahead of whom, per road, direction and lane / sidewalk side.
    const groups = new Map();
    for (const a of this.agents) {
      const k = a.kind === 'car' ? `${a.road.id}:${a.dir}:${a.lane}` : `${a.road.id}:p${a.side}`;
      a._g = k;
      (groups.get(k) || groups.set(k, []).get(k)).push(a);
    }
    for (const list of groups.values()) list.sort((x, y) => x.s - y.s);
    for (const a of this.agents) {
      if (a.kind === 'car') this._drive(a, groups.get(a._g), dt);
      else this._walk(a, groups.get(a._g), dt);
      this._pose(a, false, dt);
    }
  }

  _drive(a, group, dt) {
    const road = a.road;
    // The car ahead in this lane.
    const idx = group.indexOf(a);
    const ahead = a.dir > 0 ? group[idx + 1] : group[idx - 1];
    let gap = ahead ? Math.abs(ahead.s - a.s) - (ahead.length + a.length) / 2 : Infinity;
    let dv = ahead ? a.v - ahead.v : 0;
    // The next intersection: wait while another car is crossing it.
    const nj = this._nextJunction(a);
    if (nj) {
      const j = this.jn.get(road.keys[nj.i]);
      // Cars following straight through on the same road don't wait for each other.
      const h = j.holder;
      const busy = h && h !== a && this.time < j.until && !(h.road === a.road && h.dir === a.dir);
      if (busy && nj.dist - 3 < gap) {
        gap = Math.max(0.01, nj.dist - 3);
        dv = a.v;
      } else if (!busy && nj.dist < 5) {
        j.holder = a;
        j.until = this.time + JUNCTION_HOLD + 8 / Math.max(a.v, 2);
      }
    }
    // Slow down for tight bends.
    const bend = this._bendAhead(a);
    const vmax = bend > 35 ? Math.min(a.vmax, 5 + (90 - Math.min(90, bend)) / 8) : a.vmax;
    const sStar = IDM.s0 + Math.max(0, a.v * IDM.T + (a.v * dv) / (2 * Math.sqrt(IDM.a * IDM.b)));
    const acc = IDM.a * (1 - (a.v / vmax) ** 4 - (sStar / Math.max(gap, 0.1)) ** 2);
    a.v = Math.max(0, Math.min(vmax * 1.05, a.v + Math.max(-9, acc) * dt));
    this._advance(a, a.v * dt);
  }

  _walk(a, group, dt) {
    if (a.pause > 0) {
      a.pause -= dt;
      a.v = 0;
      return;
    }
    // Keep a step behind whoever walks ahead the same way; sidestep people coming the other way.
    let v = a.vmax;
    a.latTarget = 0;
    const i = group.indexOf(a);
    for (let k = Math.max(0, i - 4); k < Math.min(group.length, i + 5); k++) {
      const b = group[k];
      if (b === a) continue;
      const d = (b.s - a.s) * a.dir; // > 0: ahead
      if (d <= 0 || d > 3) continue;
      if (Math.abs(b.lat - a.lat) > 0.9) continue;
      if (b.dir === a.dir) v = Math.min(v, d < 1.1 ? 0 : b.v);
      else a.latTarget = a.lat >= b.lat ? 0.55 : -0.55;
    }
    a.v += (v - a.v) * Math.min(1, dt * 3);
    a.lat += (a.latTarget + (a.id % 5) * 0.08 - 0.16 - a.lat) * Math.min(1, dt * 1.5);
    a.walked += a.v * dt;
    this._advance(a, a.v * dt);
    if (this.rand() < dt * 0.015) a.pause = 1 + this.rand() * 4; // stop to look at something
  }

  /** Distance to the next intersection ahead: { i (vertex), dist }. */
  _nextJunction(a) {
    const { jv, cum } = a.road;
    if (!jv.length) return null;
    if (a.dir > 0) {
      for (const i of jv) if (cum[i] > a.s + 0.01) return { i, dist: cum[i] - a.s };
    } else {
      for (let k = jv.length - 1; k >= 0; k--) if (cum[jv[k]] < a.s - 0.01) return { i: jv[k], dist: a.s - cum[jv[k]] };
    }
    return null;
  }

  /** How sharply the road turns in the next ~25 m (degrees). */
  _bendAhead(a) {
    const { pts, cum } = a.road;
    let i = segmentAt(cum, a.s);
    const h0 = segHeading(pts, i, a.dir);
    let worst = 0;
    for (let k = 1; k <= 4; k++) {
      const j = i + k * a.dir;
      if (j < 1 || j >= pts.length) break;
      if (Math.abs(cum[j] - a.s) > 25) break;
      worst = Math.max(worst, Math.abs(angleDiff(h0, segHeading(pts, j, a.dir))));
    }
    return worst;
  }

  /** Moves along the road by `ds`, turning onto connecting roads at intersections. */
  _advance(a, ds) {
    let left = ds;
    for (let guard = 0; guard < 4 && left > 0; guard++) {
      const road = a.road;
      const nj = this._nextJunction(a);
      const toEnd = a.dir > 0 ? road.length - a.s : a.s;
      const stop = nj ? Math.min(nj.dist, toEnd) : toEnd;
      if (left < stop) {
        a.s += left * a.dir;
        return;
      }
      a.s += stop * a.dir;
      left -= stop;
      const atEnd = !nj || nj.dist >= toEnd - 0.01;
      const vi = atEnd ? (a.dir > 0 ? road.pts.length - 1 : 0) : nj.i;
      const turned = this._turn(a, vi, atEnd);
      if (!turned) {
        if (atEnd) {
          // Dead end or edge of the area.
          if (!road.oneway && a.kind === 'car' && this.rand() < 0.3) a.dir *= -1;
          else if (a.kind === 'person') a.dir *= -1;
          else return this._respawn(a);
        }
        a.s += 0.02 * a.dir; // step past the vertex
      }
    }
  }

  /** At road vertex `vi`, maybe turn onto another road there. Must turn at the end. */
  _turn(a, vi, mustTurn) {
    const j = this.jn.get(a.road.keys[vi]);
    if (!j) return false;
    const chance = a.kind === 'car' ? 0.35 : 0.25;
    if (!mustTurn && (!j.real || this.rand() > chance)) return false;
    const here = a.road.pts[vi];
    const options = [];
    for (const o of j.at) {
      if (o.road === a.road) continue;
      if (a.kind === 'car' ? !o.road.car : !(o.road.walk || o.road.path)) continue;
      const last = o.road.pts.length - 1;
      const dirs = o.road.oneway ? [1] : [1, -1];
      for (const d of dirs) {
        if ((d > 0 && o.i === last) || (d < 0 && o.i === 0)) continue;
        options.push({ road: o.road, i: o.i, dir: d });
      }
    }
    // Prefer not doubling straight back the way we came.
    const h = segHeading(a.road.pts, segmentAt(a.road.cum, a.road.cum[vi] - 0.01 * a.dir), a.dir);
    const scored = options
      .map((o) => ({ ...o, turn: Math.abs(angleDiff(h, segHeading(o.road.pts, o.dir > 0 ? o.i + 1 : o.i, o.dir))) }))
      .filter((o) => o.turn < 150);
    if (!scored.length) return false;
    const o = scored[Math.floor(this.rand() * scored.length)];
    const s = o.road.cum[o.i];
    if (a.kind === 'car') {
      const lane = Math.min(a.lane, o.road.carLanes - 1);
      // Don't turn into a car that's right there.
      const clash = this.agents.some((b) => b !== a && b.kind === 'car' && b.road === o.road && b.dir === o.dir && Math.abs(b.s - s) < 7);
      if (clash && !mustTurn) return false;
      Object.assign(a, { road: o.road, dir: o.dir, s: s + 0.02 * o.dir, lane });
      if (o.turn > 40) a.v = Math.min(a.v, 6);
    } else {
      // Keep to the sidewalk nearest where we are (round the corner, not across the road).
      let side = 0;
      if (!o.road.path) {
        const t = segmentTangent(o.road.pts, o.dir > 0 ? o.i + 1 : o.i);
        const off = o.road.half + SIDEWALK * 0.5;
        const pos = (sd) => [here[0] + t[1] * sd * off, here[1] - t[0] * sd * off];
        const me = [a.x ?? here[0], a.y ?? here[1]];
        const d = (p) => Math.hypot(p[0] - me[0], p[1] - me[1]);
        side = d(pos(1)) <= d(pos(-1)) ? 1 : -1;
      }
      Object.assign(a, { road: o.road, dir: o.dir, s: s + 0.02 * o.dir, side });
    }
    return true;
  }

  _respawn(a) {
    const fresh = a.kind === 'car' ? this._car() : this._person();
    for (const k of ['road', 'dir', 'lane', 's', 'side']) a[k] = fresh[k];
    a.v = a.kind === 'car' ? 0 : a.v;
    this._pose(a, true);
  }

  /** World position and heading (smoothed so corners and lane changes glide). */
  _pose(a, snap, dt = 0) {
    const { pts, cum } = a.road;
    const i = segmentAt(cum, a.s);
    const t = (a.s - cum[i - 1]) / Math.max(0.001, cum[i] - cum[i - 1]);
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const [tx, ty] = segmentTangent(pts, i);
    // Offset to the right of the road's own direction (+1) …
    let off;
    if (a.kind === 'car') {
      const lanes = a.road.carLanes;
      const w = a.road.oneway ? (2 * a.road.half) / lanes : Math.min(LANE_W, a.road.half / lanes);
      const fromCenter = a.road.oneway ? -a.road.half + (a.lane + 0.5) * w : (lanes - 1 - a.lane + 0.5) * w;
      // two-way: drive on your own side of the center line (right, or left where traffic keeps left)
      off = a.road.oneway ? fromCenter * (this.left ? -1 : 1) : fromCenter * a.dir * (this.left ? -1 : 1);
    } else off = a.side ? a.side * (a.road.half + SIDEWALK * 0.5 + a.lat * 0.9) : a.lat;
    const x = x0 + (x1 - x0) * t + ty * off;
    const y = y0 + (y1 - y0) * t - tx * off;
    const heading = (Math.atan2(tx * a.dir, ty * a.dir) * 180) / Math.PI;
    if (snap || a.x == null || Math.hypot(x - a.x, y - a.y) > 25) {
      a.x = x;
      a.y = y;
      a.heading = heading;
      return;
    }
    const k = 1 - Math.exp(-dt / (a.kind === 'car' ? 0.12 : 0.2));
    a.x += (x - a.x) * k;
    a.y += (y - a.y) * k;
    a.heading += angleDiff(a.heading, heading) * (1 - Math.exp(-dt / 0.18));
  }

  /** Positions for drawing: [{ kind, lng, lat, heading (deg, 0 = north), … }]. */
  snapshot() {
    if (!this.origin) return [];
    const { cx, cy, kx } = this.origin;
    return this.agents.map((a) => ({
      id: a.id,
      model: a.model,
      kind: a.kind,
      paused: a.kind === 'person' ? a.v < 0.15 : a.v < 0.3,
      lng: cx + a.x / kx,
      lat: cy + a.y / M_PER_DEG_LAT,
      heading: a.heading,
      color: a.color,
      length: a.length,
      width: a.width,
      height: a.height,
      speed: a.v,
      stride: a.walked || 0,
      braking: a.kind === 'car' && a.v < a.vmax * 0.5,
    }));
  }
}

function cumulative(ws) {
  const out = [];
  let s = 0;
  for (const w of ws) out.push((s += w));
  return out;
}
function pickWeighted(cum, x) {
  const target = x * (cum.at(-1) || 0);
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
/** Index i (≥ 1) of the segment pts[i-1] → pts[i] that contains distance s. */
function segmentAt(cum, s) {
  let lo = 1;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < s) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function segmentTangent(pts, i) {
  i = Math.max(1, Math.min(pts.length - 1, i));
  const dx = pts[i][0] - pts[i - 1][0];
  const dy = pts[i][1] - pts[i - 1][1];
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}
function segHeading(pts, i, dir) {
  const [tx, ty] = segmentTangent(pts, i);
  return (Math.atan2(tx * dir, ty * dir) * 180) / Math.PI;
}

/** A rotated rectangle footprint (GeoJSON ring) for an agent. */
export function agentFootprint({ lng, lat, heading, length, width }) {
  const kx = mPerDegLng(lat);
  const h = (heading * Math.PI) / 180;
  const fx = Math.sin(h);
  const fy = Math.cos(h);
  const rx = fy;
  const ry = -fx;
  const pts = [
    [length / 2, width / 2],
    [length / 2, -width / 2],
    [-length / 2, -width / 2],
    [-length / 2, width / 2],
  ].map(([a, b]) => [lng + (fx * a + rx * b) / kx, lat + (fy * a + ry * b) / M_PER_DEG_LAT]);
  pts.push(pts[0]);
  return pts;
}
