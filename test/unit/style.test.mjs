// The map style must validate against the MapLibre style specification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { buildStyle } from '../../solworld/assets/js/mapstyle.js';

test('map style is valid MapLibre style-spec', () => {
  const style = buildStyle({
    tiles: 'https://tiles.openfreemap.org/planet',
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    attribution: 'test',
  });
  const errors = validateStyleMin(style);
  assert.deepEqual(errors.map((e) => e.message), []);
  const ids = style.layers.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length, 'layer ids are unique');
  for (const id of ['building-3d', 'building-pick', 'water', 'label-city-major']) assert.ok(ids.includes(id), id);
});
