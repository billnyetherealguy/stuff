// Building prices. Deterministic from public OpenStreetMap data, so the
// operator's price audit (and anyone else) can recompute the price of any
// purchase. Always between MIN_LAMPORTS and MAX_LAMPORTS.

import { busyness } from './cities.js';
import { buildingHeights } from './osm.js';

export const MIN_LAMPORTS = 1_000_000; // 0.001 SOL
export const MAX_LAMPORTS = 3_000_000_000; // 3 SOL

function roundNice(lamports) {
  // Two significant digits: 0.1234 SOL -> 0.12 SOL, 0.00137 -> 0.0014
  const digits = Math.floor(Math.log10(lamports));
  const unit = 10 ** Math.max(0, digits - 1);
  return Math.round(lamports / unit) * unit;
}

/**
 * @param building { tags, area, center: [lng, lat] } (an OsmClient building)
 * @returns { lamports, factors: [{ label, x }] }
 */
export function priceBuilding(building) {
  const tags = building?.tags || {};
  const [lng, lat] = building?.center || [0, 0];
  const factors = [];

  const place = busyness(lat, lng);
  if (place.factor > 1.2) factors.push({ label: place.city ? `Busy area · ${place.city}` : 'Busy area', x: place.factor });

  let fame = 1;
  if (tags.wikidata || tags.wikipedia) fame = 25;
  else if (tags.tourism || tags.historic) fame = 6;
  else if (tags.name || tags['name:en']) fame = 2;
  if (fame > 1) factors.push({ label: fame >= 25 ? 'Famous landmark' : fame >= 6 ? 'Attraction' : 'Named building', x: fame });

  const { top } = buildingHeights(tags);
  const height = 1 + top / 40;
  if (height >= 1.5) factors.push({ label: `${Math.round(top)} m tall`, x: height });

  const size = Math.min(6, Math.max(0.6, Math.sqrt((building?.area || 100) / 150)));
  if (size >= 1.5) factors.push({ label: 'Large footprint', x: size });

  const raw = MIN_LAMPORTS * place.factor * fame * height * size;
  const lamports = Math.min(MAX_LAMPORTS, Math.max(MIN_LAMPORTS, roundNice(Math.round(raw))));
  return { lamports, factors };
}

/* ---------------------------------------------------------------- land */

export const LAND_MAX_DEG = 8; // biggest takeover side, in degrees (a large state)

/**
 * Price of a whole area ([west, south, east, north]), deterministic from its
 * size and how busy it is (sampled on a grid), so every visitor computes the
 * same number. Roughly the price of its buildings, with a bulk discount in
 * dense downtowns.
 */
export function landPrice([w, s, e, n]) {
  if (!(e > w && n > s)) return Infinity;
  const midLat = (s + n) / 2;
  const kx = 111_320 * Math.cos((midLat * Math.PI) / 180);
  const area = (e - w) * kx * (n - s) * 110_574; // m²
  const N = 12;
  let sum = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const f = busyness(s + ((j + 0.5) / N) * (n - s), w + ((i + 0.5) / N) * (e - w)).factor;
      sum += 0.15 + f ** 1.5 - 1; // empty countryside is cheap, downtowns aren't
    }
  }
  const raw = MIN_LAMPORTS * (area / 700) * (sum / (N * N));
  return Math.max(MIN_LAMPORTS * 5, roundNice(Math.round(raw)));
}

/** Rough number of buildings in an area when they aren't all loaded on the map. */
export function estimateBuildings([w, s, e, n]) {
  const midLat = (s + n) / 2;
  const km2 = ((e - w) * 111.32 * Math.cos((midLat * Math.PI) / 180)) * ((n - s) * 110.574);
  const N = 8;
  let dens = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const f = busyness(s + ((j + 0.5) / N) * (n - s), w + ((i + 0.5) / N) * (e - w)).factor;
      dens += 12 + 260 * Math.max(0, f - 1) ** 0.6;
    }
  }
  return Math.round(km2 * (dens / (N * N)));
}

/** What you rule, by how many buildings you own in one takeover. */
export const TIERS = [
  { min: 200_000, name: 'Country' },
  { min: 20_000, name: 'State' },
  { min: 2_000, name: 'Mega city' },
  { min: 200, name: 'City' },
  { min: 50, name: 'Town' },
  { min: 5, name: 'Neighborhood' },
  { min: 0, name: 'Block' },
];
export const tierFor = (count) => TIERS.find((t) => count >= t.min).name;
