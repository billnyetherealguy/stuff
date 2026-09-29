// Vector tiles for the synthetic world, shaped like OpenFreeMap's output:
// OpenMapTiles layer names, feature ids = osmId * 10 + 2, and buildings with
// identical attributes merged per tile (planetiler's mergeMultiPolygon), with
// the merged feature keeping the first id rounded down to a multiple of 10.
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';
import { buildWorld, worldLayers } from './world.mjs';

const MIN_ZOOM = { building: 13, poi: 14, transportation: 8, transportation_name: 12, park: 9, place: 0, water: 0, boundary: 0 };

export function createTiles() {
  const world = buildWorld();
  const layers = worldLayers(world);
  const indexes = {};
  for (const [name, fc] of Object.entries(layers)) {
    indexes[name] = geojsonvt(fc, { maxZoom: 14, indexMaxZoom: 5, buffer: 64, extent: 4096, tolerance: name === 'building' ? 1 : 3 });
  }
  const cache = new Map();

  function mergeBuildings(features) {
    const groups = new Map();
    for (const f of features) {
      const key = JSON.stringify(f.tags);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    const out = [];
    for (const group of groups.values()) {
      if (group.length === 1) out.push(group[0]);
      else out.push({ ...group[0], id: Math.floor(group[0].id / 10) * 10, geometry: group.flatMap((f) => f.geometry) });
    }
    return out;
  }

  function tile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (cache.has(key)) return cache.get(key);
    const out = {};
    for (const [name, index] of Object.entries(indexes)) {
      if (z < (MIN_ZOOM[name] ?? 0)) continue;
      const t = index.getTile(z, x, y);
      if (!t || !t.features.length) continue;
      out[name] = name === 'building' ? { ...t, features: mergeBuildings(t.features) } : t;
    }
    const buf = Object.keys(out).length ? Buffer.from(vtpbf.fromGeojsonVt(out, { version: 2, extent: 4096 })) : null;
    cache.set(key, buf);
    return buf;
  }

  function tileJson(base) {
    return {
      tilejson: '3.0.0',
      name: 'solworld-test-world',
      tiles: [`${base}/{z}/{x}/{y}.pbf`],
      minzoom: 0,
      maxzoom: 14,
      attribution: 'Synthetic test world',
      vector_layers: ['water', 'waterway', 'landcover', 'landuse', 'mountain_peak', 'park', 'boundary', 'aeroway', 'transportation', 'building', 'water_name', 'transportation_name', 'place', 'housenumber', 'poi', 'aerodrome_label'].map((id) => ({ id, fields: {} })),
    };
  }

  return { world, tile, tileJson };
}
