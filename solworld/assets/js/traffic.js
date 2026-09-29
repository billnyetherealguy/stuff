// Street life: simulated cars driving the real roads and people walking the
// sidewalks and footpaths, taken from the map data around the view. How many
// depends on how busy the place is in real life (cities.js): Manhattan or
// downtown DC is packed, a small town gets a few, the countryside gets none.
// Fewer people are out late at night.

import { busyness } from './cities.js';

const M_PER_DEG_LAT = 110_574;
const mPerDegLng = (lat) => 111_320 * Math.cos((lat * Math.PI) / 180);

const CAR_ROADS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service']);
const SIDEWALK_ROADS = new Set(['primary', 'secondary', 'tertiary', 'minor']);
const FOOT_PATHS = new Set(['path', 'pedestrian', 'footway']);

const PEOPLE_COLORS = ['#2d3440', '#6b2d2d', '#2f4f6f', '#c9b28b', '#1f1f1f', '#7a6a55', '#3f5a3a', '#b04a6a', '#d8d2c4', '#4b3b6b'];

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** How many cars and people to simulate around a place (at `hourFactor` of peak). */
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
  }

  /**
   * Rebuilds the road network from map features near `center` and tops up /
   * trims the agents to the right numbers for this place.
   * `features`: GeoJSON-ish { geometry, properties: { class } } road lines.
   */
  setArea(center, features, { radius = 650, night = false } = {}) {
    const [cx, cy] = center;
    const kx = mPerDegLng(cy);
    const toM = ([x, y]) => [(x - cx) * kx, (y - cy) * M_PER_DEG_LAT];
    this.origin = { cx, cy, kx };
    const car = [];
    const foot = [];
    const seen = new Set();
    for (const f of features) {
      const cls = f.properties?.class;
      const geom = f.geometry;
      if (!geom || !cls) continue;
      const lines = geom.type === 'LineString' ? [geom.coordinates] : geom.type === 'MultiLineString' ? geom.coordinates : [];
      for (const line of lines) {
        if (line.length < 2) continue;
        const pts = line.map(toM).filter(([x, y]) => Math.abs(x) < radius * 1.3 && Math.abs(y) < radius * 1.3);
        if (pts.length < 2) continue;
        const id = `${cls}:${pts[0][0].toFixed(0)},${pts[0][1].toFixed(0)}:${pts.length}`;
        if (seen.has(id)) continue; // the same road comes from several tiles
        seen.add(id);
        const lane = this._lane(pts, cls);
        if (lane.length < 25) continue;
        if (CAR_ROADS.has(cls)) car.push(lane);
        if (SIDEWALK_ROADS.has(cls)) {
          foot.push({ ...lane, side: 1 });
          foot.push({ ...lane, side: -1 });
        }
        if (FOOT_PATHS.has(cls)) foot.push({ ...lane, side: 0 });
      }
    }
    this.lanes = { car, foot };
    const want = streetLife(cx, cy, { night });
    this.want = want;
    // Keep agents that are still on known lanes nearby; respawn the rest.
    this.agents = [];
    for (let i = 0; i < want.cars && car.length; i++) this.agents.push(this._spawn('car'));
    for (let i = 0; i < want.people && foot.length; i++) this.agents.push(this._spawn('person'));
  }

  _lane(pts, cls) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const width = { motorway: 7, trunk: 6, primary: 5.5, secondary: 5, tertiary: 4.5, minor: 3.5, service: 2.5 }[cls] ?? 3;
    return { pts, cum, length: cum[cum.length - 1], cls, width };
  }

  /** Which vehicle (3D model in assets/models) and its real size. Cabs in busy cities. */
  _vehicle() {
    const r = this.rand;
    const x = r();
    const cabs = (this.want?.density || 0) > 1.5 ? 0.18 : 0.03;
    let v;
    if (x < 0.025) v = { model: 'bus', length: 12, width: 2.55, height: 3.1, color: '#2b5aa8' };
    else if (x < 0.07) v = { model: 'van', length: 5.6, width: 2, height: 2.3, color: '#eceff2' };
    else if (x < 0.07 + cabs) v = { model: 'taxi', length: 4.7, width: 1.85, height: 1.5, color: '#f2b705' };
    else if (x < 0.3 + cabs) {
      const i = Math.floor(r() * 3);
      v = { model: `suv-${i}`, length: 4.8, width: 1.95, height: 1.8, color: ['#1d1f22', '#f1f1f3', '#51607a'][i] };
    } else {
      const i = Math.floor(r() * 6);
      v = { model: `sedan-${i}`, length: 4.6, width: 1.85, height: 1.45, color: ['#e9e9ec', '#16181c', '#8f959e', '#23324d', '#7c1c20', '#3d4652'][i] };
    }
    return { ...v, id: ++this.ids };
  }

  _spawn(kind) {
    const r = this.rand;
    const lanes = kind === 'car' ? this.lanes.car : this.lanes.foot;
    // Busier (longer, bigger) roads get more traffic.
    const lane = lanes[Math.floor(r() * lanes.length)];
    const dir = r() < 0.5 ? 1 : -1;
    if (kind === 'car') {
      const fast = lane.cls === 'motorway' || lane.cls === 'trunk';
      return {
        kind,
        lane,
        dir,
        s: r() * lane.length,
        speed: (fast ? 14 : 6) + r() * (fast ? 10 : 7),
        offset: (lane.width / 2 + 0.2) * 0.62, // keep right of the center line
        ...this._vehicle(),
      };
    }
    return {
      kind,
      lane,
      dir,
      s: r() * lane.length,
      speed: 0.9 + r() * 0.8,
      offset: lane.side ? lane.width + 2.2 + r() * 1.6 : (r() - 0.5) * 2,
      side: lane.side || 1,
      color: PEOPLE_COLORS[Math.floor(r() * PEOPLE_COLORS.length)],
      model: `person-${Math.floor(r() * 8)}`,
      id: ++this.ids,
      length: 0.45,
      width: 0.5,
      height: 1.6 + r() * 0.25,
      pause: 0,
    };
  }

  /** Advances everyone by `dt` seconds. */
  step(dt) {
    const r = this.rand;
    for (const a of this.agents) {
      if (a.pause > 0) {
        a.pause -= dt;
        continue;
      }
      a.s += a.speed * dt * a.dir;
      if (a.s < 0 || a.s > a.lane.length) {
        // End of the road: turn around or reappear somewhere else nearby.
        if (r() < 0.5) {
          a.dir *= -1;
          a.s = Math.max(0, Math.min(a.lane.length, a.s));
        } else Object.assign(a, this._spawn(a.kind), { s: a.dir > 0 ? 0 : a.lane?.length || 0 });
      }
      if (a.kind === 'person' && r() < dt * 0.02) a.pause = 1 + r() * 4; // stop to look at something
    }
  }

  /** Positions for drawing: [{ kind, lng, lat, heading (deg, 0 = north), color, length, width, height }]. */
  snapshot() {
    if (!this.origin) return [];
    const { cx, cy, kx } = this.origin;
    const out = [];
    for (const a of this.agents) {
      const { pts, cum } = a.lane;
      let i = 1;
      while (i < cum.length - 1 && cum[i] < a.s) i++;
      const t = (a.s - cum[i - 1]) / Math.max(0.001, cum[i] - cum[i - 1]);
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      let dx = x1 - x0;
      let dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      // Right-hand side of the direction of travel (sidewalks: a fixed side).
      const side = a.kind === 'car' ? a.dir : a.side;
      const nx = dy * side;
      const ny = -dx * side;
      const x = x0 + (x1 - x0) * t + nx * a.offset;
      const y = y0 + (y1 - y0) * t + ny * a.offset;
      const heading = (Math.atan2(dx * a.dir, dy * a.dir) * 180) / Math.PI;
      out.push({ id: a.id, model: a.model, kind: a.kind, paused: a.pause > 0, lng: cx + x / kx, lat: cy + y / M_PER_DEG_LAT, heading, color: a.color, length: a.length, width: a.width, height: a.height });
    }
    return out;
  }
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
