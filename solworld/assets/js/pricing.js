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
