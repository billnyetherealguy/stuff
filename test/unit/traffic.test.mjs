// Street life: cars keep to their lanes and don't hit each other, people stay
// on the sidewalks, and everyone keeps moving through a real street grid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Traffic, keepsLeft } from '../../solworld/assets/js/traffic.js';
import { ROADS, SIDEWALK } from '../../solworld/assets/js/streetscape.js';

const center = [-73.9855, 40.7505]; // Midtown: lots of traffic
const kx = 111_320 * Math.cos((center[1] * Math.PI) / 180);
const ll = (x, y) => [center[0] + x / kx, center[1] + y / 110_574];
const toM = ([lng, lat]) => [(lng - center[0]) * kx, (lat - center[1]) * 110_574];

// A Manhattan-style grid: two-way avenues every 260 m, one-way streets every 80 m,
// each street split at every crossing (as map tiles deliver them).
function grid() {
  const f = [];
  const line = (cls, pts, oneway = 0) => f.push({ geometry: { type: 'LineString', coordinates: pts.map(([x, y]) => ll(x, y)) }, properties: { class: cls, oneway } });
  const xs = [-390, -130, 130, 390];
  const ys = [-320, -240, -160, -80, 0, 80, 160, 240, 320];
  for (const x of xs) for (let j = 1; j < ys.length; j++) line('primary', [[x, ys[j - 1]], [x, ys[j]]]);
  ys.forEach((y, j) => {
    for (let i = 1; i < xs.length; i++) line('minor', [[xs[i - 1], y], [xs[i], y]], j % 2 ? 1 : -1);
  });
  return f;
}

function run(seconds, check) {
  const t = new Traffic();
  t.setArea(center, grid(), { radius: 500 });
  for (let k = 0; k < seconds * 10; k++) {
    t.step(0.1);
    if (check) check(t, k);
  }
  return t;
}

test('fills the streets with cars and people for a busy place', () => {
  const t = run(0);
  const cars = t.agents.filter((a) => a.kind === 'car').length;
  const people = t.agents.filter((a) => a.kind === 'person').length;
  assert.ok(cars > 60, `cars: ${cars}`);
  assert.ok(people > 80, `people: ${people}`);
  assert.ok(t.agents.every((a) => /^(car-\d+|car-taxi|bus|van|walker-\d+)$/.test(a.model)));
});

test('cars never overlap, stay on the road, and keep moving; people keep to the sidewalk', () => {
  let overlaps = 0;
  let samples = 0;
  let offRoad = 0;
  let inRoad = 0;
  let turns = 0;
  const lastRoad = new Map();
  const t = run(90, (t, k) => {
    if (k % 5) return;
    const cars = t.agents.filter((a) => a.kind === 'car');
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        samples++;
        if (Math.hypot(cars[i].x - cars[j].x, cars[i].y - cars[j].y) < 2.2) overlaps++;
      }
      const a = cars[i];
      if (lastRoad.has(a.id) && lastRoad.get(a.id) !== a.road) turns++;
      lastRoad.set(a.id, a.road);
    }
    for (const a of t.agents) {
      // Distance from the road's center line (the road it's on).
      const [x0, y0] = a.road.pts[0];
      const [x1, y1] = a.road.pts.at(-1);
      const d = Math.abs((x1 - x0) * (y0 - a.y) - (x0 - a.x) * (y1 - y0)) / Math.hypot(x1 - x0, y1 - y0);
      if (a.kind === 'car' && d > a.road.half + 0.5) offRoad++;
      // Mid-block (crossing at the corners is what crosswalks are for).
      const midBlock = a.s > 12 && a.s < a.road.length - 12;
      if (a.kind === 'person' && a.side && midBlock && d < a.road.half + 0.2) inRoad++;
    }
  });
  assert.ok(overlaps / samples < 0.002, `car overlaps: ${overlaps} of ${samples}`);
  assert.equal(offRoad, 0, 'cars outside their road');
  assert.equal(inRoad, 0, 'people walking in the road mid-block');
  assert.ok(turns > 20, `cars turning at junctions: ${turns}`);
  const cars = t.agents.filter((a) => a.kind === 'car');
  const moving = cars.filter((a) => a.v > 0.5).length / cars.length;
  assert.ok(moving > 0.4, `share of cars moving: ${moving.toFixed(2)}`);
});

test('one-way streets only carry traffic one way', () => {
  run(30, (t) => {
    for (const a of t.agents) if (a.kind === 'car' && a.road.oneway) assert.equal(a.dir, 1);
  });
});

test('traffic keeps left where it does in real life', () => {
  assert.equal(keepsLeft(-0.1276, 51.5072), true); // London
  assert.equal(keepsLeft(139.69, 35.69), true); // Tokyo
  assert.equal(keepsLeft(-73.98, 40.75), false); // New York
  assert.equal(keepsLeft(2.35, 48.86), false); // Paris
  assert.ok(ROADS.primary.half > 0 && SIDEWALK > 0);
  void toM;
});
