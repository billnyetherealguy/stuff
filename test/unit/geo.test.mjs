// Geometry used for picking and highlights.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflatePolygon, interiorPoint, pickOnRay, pickPartOnRay, pointInPolygon, polygonAreaM2 } from '../../solworld/assets/js/geo.js';
import { assembleRings, elementPolygons, buildingHeights } from '../../solworld/assets/js/osm.js';

const M = 1 / 111_320; // ~1 m in degrees near the equator
const square = (x, y, s) => [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]];

test('area, containment and interior points', () => {
  const sq = square(0, 0, 100 * M);
  assert.ok(Math.abs(polygonAreaM2(sq) - 10_000) < 150);
  assert.ok(pointInPolygon([50 * M, 50 * M], sq));
  assert.ok(!pointInPolygon([150 * M, 50 * M], sq));
  // L-shape whose centroid lies outside the polygon
  const L = [[[0, 0], [100 * M, 0], [100 * M, 10 * M], [10 * M, 10 * M], [10 * M, 100 * M], [0, 100 * M], [0, 0]]];
  assert.ok(pointInPolygon(interiorPoint(L), L));
  const withHole = [square(0, 0, 100 * M)[0], square(40 * M, 40 * M, 20 * M)[0].slice().reverse()];
  assert.ok(!pointInPolygon([50 * M, 50 * M], withHole));
});

test('inflated shells fully wrap the footprint', () => {
  const sq = square(10 * M, 10 * M, 20 * M);
  const big = inflatePolygon(sq, 0.5);
  assert.ok(polygonAreaM2(big) > polygonAreaM2(sq));
  for (const v of sq[0]) assert.ok(pointInPolygon(v, big), 'every original corner is inside the shell');
  const cw = [sq[0].slice().reverse()];
  const big2 = inflatePolygon(cw, 0.5);
  assert.ok(polygonAreaM2(big2) > polygonAreaM2(cw), 'works for either winding');
});

test('3D ray pick chooses the building the camera actually sees', () => {
  // Two merged footprints on a north-south line; camera to the south, looking north.
  const front = square(0, 0, 20 * M); // 0..20 m north
  const back = square(0, 40 * M, 20 * M); // 40..60 m north
  const camera = { lngLat: [10 * M, -200 * M], altitude: 200 };
  // The cursor ray meets the ground inside the back building's footprint, but
  // the front building is 60 m tall and blocks it.
  const ground = [10 * M, 50 * M];
  assert.equal(pickPartOnRay([back, front], ground, camera, 60, 0), front);
  // With low buildings the ray clears the front one and lands on the back roof.
  assert.equal(pickPartOnRay([back, front], ground, camera, 5, 0), back);
  // Single part short-circuits.
  assert.equal(pickPartOnRay([back], ground, camera, 60, 0), back);
});

test('overpass geometry: rings assemble and heights follow OpenMapTiles rules', () => {
  const a = [[0, 0], [1, 0], [1, 1]];
  const b = [[0, 1], [0, 0]];
  const c = [[1, 1], [0, 1]];
  const rings = assembleRings([a, b, c]);
  assert.equal(rings.length, 1);
  assert.deepEqual(rings[0][0], rings[0].at(-1));
  const rel = elementPolygons({
    type: 'relation',
    members: [
      { type: 'way', role: 'outer', geometry: [{ lon: 0, lat: 0 }, { lon: 3, lat: 0 }, { lon: 3, lat: 3 }] },
      { type: 'way', role: 'outer', geometry: [{ lon: 3, lat: 3 }, { lon: 0, lat: 3 }, { lon: 0, lat: 0 }] },
      { type: 'way', role: 'inner', geometry: [{ lon: 1, lat: 1 }, { lon: 2, lat: 1 }, { lon: 2, lat: 2 }, { lon: 1, lat: 2 }, { lon: 1, lat: 1 }] },
    ],
  });
  assert.equal(rel.length, 1);
  assert.equal(rel[0].length, 2, 'outer ring plus courtyard');
  assert.deepEqual(buildingHeights({ height: '443' }), { top: 443, base: 0, height: 443, levels: null });
  assert.equal(buildingHeights({ 'building:levels': '10' }).top, 37);
  assert.equal(buildingHeights({}).top, 5);
  assert.equal(Math.round(buildingHeights({ height: "100'" }).top), 31);
});

test('street life: packed in big cities, a few in towns, none in the middle of nowhere', async () => {
  const { streetLife } = await import('../../solworld/assets/js/traffic.js');
  const nyc = streetLife(-73.9857, 40.7484);
  const dc = streetLife(-77.0365, 38.8977);
  const suburb = streetLife(-77.4312, 38.8012);
  const nowhere = streetLife(-100.5, 45.2);
  assert.ok(nyc.cars >= 100 && nyc.people >= 150, JSON.stringify(nyc));
  assert.ok(dc.cars > 20 && dc.people > 30, JSON.stringify(dc));
  assert.ok(suburb.cars < dc.cars / 3, JSON.stringify(suburb));
  assert.deepEqual([nowhere.cars, nowhere.people], [0, 0]);
  assert.ok(streetLife(-73.9857, 40.7484, { night: true }).people < nyc.people);
});

test('the building you point at is the one the camera sees, not one behind it', () => {
  const N = 1 / 110_574; // ~1 m north in degrees
  const box = (y0, y1) => [[[-10 * M, y0 * N], [10 * M, y0 * N], [10 * M, y1 * N], [-10 * M, y1 * N], [-10 * M, y0 * N]]];
  const tall = { name: 'tall', part: box(60, 100), top: 60, base: 0 };
  const small = { name: 'small', part: box(190, 210), top: 5, base: 0 };
  const camera = { lngLat: [0, 0], altitude: 100 };
  // The cursor ray reaches the ground at the small building 200 m away, but passes through the tall one first.
  assert.equal(pickOnRay([small, tall], [0, 200 * N], camera).name, 'tall');
  // Aim just past the tall one's roof: now the small building behind it is what's seen.
  assert.equal(pickOnRay([small, tall], [0, 205 * N], { lngLat: [0, 150 * N], altitude: 30 }).name, 'small');
});
