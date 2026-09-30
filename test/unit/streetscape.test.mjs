// 3D streets: road beds, sidewalks, trees and street-level billboards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStreetscape } from '../../solworld/assets/js/streetscape.js';

const center = [-73.9855, 40.7505];
const kx = 111_320 * Math.cos((center[1] * Math.PI) / 180);
const ll = (x, y) => [center[0] + x / kx, center[1] + y / 110_574];
// An east–west avenue through the middle and a north–south street crossing it.
const road = (cls, a, b) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: [ll(...a), ll(...b)] }, properties: { class: cls } });
const roads = [road('primary', [-200, 0], [0, 0]), road('primary', [0, 0], [200, 0]), road('minor', [0, -200], [0, 200]), road('motorway', [-200, 100], [200, 100])];
const park = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[ll(40, -150), ll(150, -150), ll(150, -40), ll(40, -40), ll(40, -150)]] }, properties: { class: 'park' } };

test('asphalt, sidewalks, markings and trees from the road network', () => {
  const s = buildStreetscape(center, roads, [park], { radius: 300 });
  const kinds = s.surfaces.features.map((f) => f.properties.kind);
  assert.equal(kinds.filter((k) => k === 'asphalt').length, 4);
  // Two sidewalks per walkable road, none on the motorway.
  assert.equal(kinds.filter((k) => k === 'sidewalk').length, 6);
  assert.ok(s.markings.features.length >= 3);
  const trunks = s.trees.features.filter((f) => f.properties.part === 'trunk');
  assert.ok(trunks.length > 40, `trees: ${trunks.length}`);
  for (const f of s.trees.features) assert.ok(f.properties.top > f.properties.base);
  // Same input, same street (every visitor sees the same trees).
  assert.deepEqual(buildStreetscape(center, roads, [park], { radius: 300 }), s);
});

test('billboards stand on the sidewalk in front of their building', () => {
  const at = (x, y) => ({ lng: ll(x, y)[0], lat: ll(x, y)[1], text: 'BILL', color: '#2af5a8' });
  const s = buildStreetscape(center, roads, [], { radius: 300, signs: [at(60, 25), at(0, 5000)] });
  assert.equal(s.signs.features.length, 1, 'signs out of range are skipped');
  const [lng, lat] = s.signs.features[0].geometry.coordinates;
  const x = (lng - center[0]) * kx;
  const y = (lat - center[1]) * 110_574;
  // North side of the avenue (the building's side), on the sidewalk (7.5–10.3 m from its centre line).
  assert.ok(y > 7.5 && y < 10.3, `y=${y}`);
  assert.ok(Math.abs(x - 60) < 0.5, `x=${x}`);
  const board = s.trees.features.find((f) => f.properties.part === 'board');
  assert.equal(board.properties.color, '#2af5a8');
  assert.ok(board.properties.base > 3);
  assert.equal(s.trees.features.filter((f) => f.properties.part === 'post').length, 2);
});
