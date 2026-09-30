// Solworld's map style: a near-black, Tesla-inspired dark theme on the
// OpenMapTiles schema (served free by OpenFreeMap): land, water, roads, labels
// and extruded buildings. Close up, darkened satellite imagery fades in under
// the streets and buildings switch to lit, windowed facades.

export const PALETTE = {
  land: '#0b0c0f',
  water: '#030407',
  waterway: '#0a0e15',
  park: '#0b100e',
  wood: '#0a0d0c',
  ice: '#101217',
  sand: '#0e0e0d',
  aeroway: '#111318',
  runway: '#1b1e24',
  borderCountry: '#2c3039',
  borderState: '#1b1e24',
  motorway: '#343a45',
  motorwayGlow: '#3b4bff',
  trunk: '#2c313a',
  primary: '#272b33',
  secondary: '#20232a',
  minor: '#191b20',
  service: '#15171b',
  path: '#16181c',
  rail: '#1e2127',
  building2d: '#111318',
  buildingLow: '#16181d',
  buildingHigh: '#232730',
  label: '#8a909b',
  labelStrong: '#e8eaee',
  labelMuted: '#5d636d',
  waterLabel: '#3a4759',
  halo: 'rgba(0,0,0,0.92)',
};

const P = PALETTE;
const REGULAR = ['Noto Sans Regular'];
const BOLD = ['Noto Sans Bold'];
const ITALIC = ['Noto Sans Italic'];
const NAME = ['coalesce', ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name']];
const notTunnelOrBridge = ['match', ['get', 'brunnel'], ['bridge', 'tunnel'], false, true];
const isLine = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];
const isPolygon = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false];
const classIn = (...classes) => ['match', ['get', 'class'], classes, true, false];
const width = (...stops) => ['interpolate', ['exponential', 1.35], ['zoom'], ...stops];

function road(id, classes, color, widths, minzoom, extra = {}) {
  return {
    id,
    type: 'line',
    source: 'omt',
    'source-layer': 'transportation',
    minzoom,
    filter: ['all', isLine, notTunnelOrBridge, classIn(...classes), ...(extra.filter || [])],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': color, 'line-width': width(...widths), ...(extra.paint || {}) },
  };
}

function cityLabel(id, rankFilter, minzoom) {
  return {
    id,
    type: 'symbol',
    source: 'omt',
    'source-layer': 'place',
    minzoom,
    maxzoom: 15,
    filter: ['all', ['==', ['get', 'class'], 'city'], rankFilter],
    layout: {
      'text-field': NAME,
      'text-font': ['case', ['==', ['get', 'capital'], 2], ['literal', BOLD], ['literal', REGULAR]],
      'text-size': ['interpolate', ['exponential', 1.2], ['zoom'], 3, 10.5, 8, 14, 12, 19],
      'text-max-width': 8,
      'text-letter-spacing': 0.02,
      'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
    },
    paint: { 'text-color': P.labelStrong, 'text-halo-color': P.halo, 'text-halo-width': 1.4, 'text-halo-blur': 0.5 },
  };
}

export const NEON = ['#22e6ff', '#ff3df2', '#8f6bff', '#2af5a8', '#ffb547'];
// Places that really have lit signs (OpenStreetMap points of interest), and
// the neon color their sign glows in.
export const SIGN_CLASSES = {
  bar: NEON[1], beer: NEON[1], nightclub: NEON[1], music: NEON[1],
  restaurant: '#ff5a4f', fast_food: '#ff5a4f', cafe: NEON[4], ice_cream: '#ff8ad8', bakery: NEON[4],
  cinema: '#ffd166', theatre: '#ffd166', casino: '#ffd166', lodging: NEON[0],
  shop: NEON[2], clothing_store: NEON[2], alcohol_shop: NEON[1], jewelry: '#ffd166', mobile_phone: NEON[0],
  grocery: NEON[3], pharmacy: NEON[3], convenience: NEON[3], fuel: NEON[0], hairdresser: '#ff8ad8',
};

/** A sign color washed toward soft grey: shop names stay calm map labels, not billboards. */
function muted(hex, amount = 0.55) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const g = [196, 200, 212];
  return `#${c.map((v, i) => Math.round(v + (g[i] - v) * amount).toString(16).padStart(2, '0')).join('')}`;
}
const SHOP_LABEL_COLOR = ['match', ['get', 'class'], ...Object.entries(SIGN_CLASSES).flatMap(([k, v]) => [k, muted(v)]), muted(NEON[2])];

export const CLOSE_UP_ZOOM = 16; // close-up zoom (street-level details)

export function buildStyle({ tiles, glyphs, attribution }) {
  return {
    version: 8,
    name: 'Solworld Dark',
    projection: { type: 'globe' },
    glyphs,
    light: { anchor: 'viewport', color: '#dce4ff', intensity: 0.32, position: [1.4, 205, 35] },
    sky: {
      'sky-color': '#000000',
      'horizon-color': '#0d1120',
      'fog-color': '#000000',
      'sky-horizon-blend': 0.55,
      'horizon-fog-blend': 0.4,
      'fog-ground-blend': 0.6,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.75, 4, 0.6, 7, 0],
    },
    sources: {
      omt: { type: 'vector', url: tiles, attribution },
    },
    layers: [
      { id: 'land', type: 'background', paint: { 'background-color': P.land } },

      {
        id: 'landcover-ice',
        type: 'fill',
        source: 'omt',
        'source-layer': 'landcover',
        filter: ['==', ['get', 'class'], 'ice'],
        paint: { 'fill-color': P.ice, 'fill-opacity': 0.8 },
      },
      {
        id: 'landcover-wood',
        type: 'fill',
        source: 'omt',
        'source-layer': 'landcover',
        minzoom: 8,
        filter: classIn('wood', 'forest'),
        paint: { 'fill-color': P.wood, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0, 11, 0.9] },
      },
      {
        id: 'landcover-sand',
        type: 'fill',
        source: 'omt',
        'source-layer': 'landcover',
        minzoom: 8,
        filter: ['==', ['get', 'class'], 'sand'],
        paint: { 'fill-color': P.sand },
      },
      {
        id: 'park',
        type: 'fill',
        source: 'omt',
        'source-layer': 'park',
        minzoom: 9,
        paint: { 'fill-color': P.park, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0, 12, 1] },
      },
      {
        id: 'landuse-green',
        type: 'fill',
        source: 'omt',
        'source-layer': 'landuse',
        minzoom: 12,
        filter: classIn('cemetery', 'pitch', 'playground', 'grass', 'garden', 'stadium'),
        paint: { 'fill-color': P.park },
      },

      {
        id: 'water',
        type: 'fill',
        source: 'omt',
        'source-layer': 'water',
        filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'fill-color': P.water, 'fill-antialias': true },
      },
      {
        id: 'waterway',
        type: 'line',
        source: 'omt',
        'source-layer': 'waterway',
        minzoom: 8,
        filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: {
          'line-color': P.waterway,
          'line-width': ['interpolate', ['exponential', 1.3], ['zoom'], 8, 0.5, 14, 2, 20, 8],
        },
      },

      {
        id: 'aeroway-area',
        type: 'fill',
        source: 'omt',
        'source-layer': 'aeroway',
        minzoom: 11,
        filter: isPolygon,
        paint: { 'fill-color': P.aeroway },
      },
      {
        id: 'aeroway-runway',
        type: 'line',
        source: 'omt',
        'source-layer': 'aeroway',
        minzoom: 11,
        filter: ['all', isLine, classIn('runway', 'taxiway')],
        paint: {
          'line-color': P.runway,
          'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 11, 1, 14, 8, 18, 60],
        },
      },


      {
        id: 'road-tunnel',
        type: 'line',
        source: 'omt',
        'source-layer': 'transportation',
        minzoom: 12,
        filter: ['all', isLine, ['==', ['get', 'brunnel'], 'tunnel'], classIn('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor')],
        layout: { 'line-join': 'round' },
        paint: {
          'line-color': P.secondary,
          'line-opacity': 0.55,
          'line-dasharray': [1.5, 1.2],
          'line-width': width(12, 0.6, 16, 5, 20, 22),
        },
      },
      road('road-path', ['path', 'pedestrian'], P.path, [14, 0.5, 16, 1.4, 20, 5], 14, {
        paint: { 'line-dasharray': [2, 1.5] },
      }),
      road('road-service', ['service', 'track'], P.service, [14, 0.4, 16, 2.2, 20, 10], 14),
      road('road-minor', ['minor'], P.minor, [12, 0.4, 14, 1.4, 16, 5, 20, 26], 12),
      road('road-secondary', ['secondary', 'tertiary'], P.secondary, [8, 0.4, 12, 1.2, 16, 7, 20, 30], 8),
      road('road-primary', ['primary', 'trunk'], P.primary, [6, 0.4, 10, 1.3, 14, 4, 16, 9, 20, 36], 6),
      road('road-motorway-glow', ['motorway'], P.motorwayGlow, [5, 1, 10, 3, 14, 10, 18, 40], 5, {
        filter: [['!=', ['get', 'ramp'], 1]],
        paint: { 'line-blur': ['interpolate', ['linear'], ['zoom'], 5, 2, 14, 10], 'line-opacity': 0.08 },
      }),
      road('road-motorway', ['motorway'], P.motorway, [4, 0.4, 8, 1, 12, 2.2, 16, 10, 20, 40], 4),
      road('road-rail', ['rail', 'transit'], P.rail, [12, 0.4, 16, 1.4, 20, 3], 12),
      {
        id: 'road-bridge-casing',
        type: 'line',
        source: 'omt',
        'source-layer': 'transportation',
        minzoom: 13,
        filter: ['all', isLine, ['==', ['get', 'brunnel'], 'bridge'], classIn('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor')],
        layout: { 'line-join': 'round' },
        paint: { 'line-color': '#000000', 'line-width': width(13, 2, 16, 11, 20, 42) },
      },
      {
        id: 'road-bridge',
        type: 'line',
        source: 'omt',
        'source-layer': 'transportation',
        minzoom: 13,
        filter: ['all', isLine, ['==', ['get', 'brunnel'], 'bridge'], classIn('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor')],
        layout: { 'line-join': 'round' },
        paint: {
          'line-color': ['match', ['get', 'class'], 'motorway', P.motorway, ['trunk', 'primary'], P.primary, P.secondary],
          'line-width': width(13, 1, 16, 8, 20, 34),
        },
      },

      {
        id: 'border-state',
        type: 'line',
        source: 'omt',
        'source-layer': 'boundary',
        minzoom: 4,
        filter: ['all', ['>=', ['to-number', ['get', 'admin_level']], 3], ['<=', ['to-number', ['get', 'admin_level']], 4], ['!=', ['get', 'maritime'], 1]],
        paint: {
          'line-color': P.borderState,
          'line-dasharray': [3, 2],
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.4, 10, 1.2],
        },
      },
      {
        id: 'border-country',
        type: 'line',
        source: 'omt',
        'source-layer': 'boundary',
        filter: ['all', ['==', ['to-number', ['get', 'admin_level']], 2], ['!=', ['get', 'maritime'], 1], ['!=', ['get', 'disputed'], 1]],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': P.borderCountry,
          'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.5, 5, 1, 12, 2],
        },
      },
      {
        id: 'border-disputed',
        type: 'line',
        source: 'omt',
        'source-layer': 'boundary',
        filter: ['all', ['!=', ['get', 'maritime'], 1], ['==', ['get', 'disputed'], 1]],
        paint: {
          'line-color': P.borderCountry,
          'line-dasharray': [2, 2],
          'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.5, 5, 1, 12, 2],
        },
      },


      {
        id: 'building-2d',
        type: 'fill',
        source: 'omt',
        'source-layer': 'building',
        minzoom: 13,
        maxzoom: 15.5,
        paint: {
          'fill-color': P.building2d,
          'fill-outline-color': '#181a20',
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 13.6, 1],
        },
      },
      {
        // Invisible, ground-level copy of the footprints used for exact picking.
        id: 'building-pick',
        type: 'fill',
        source: 'omt',
        'source-layer': 'building',
        minzoom: 13,
        paint: { 'fill-color': '#000000', 'fill-opacity': 0 },
      },
      {
        id: 'building-3d',
        type: 'fill-extrusion',
        source: 'omt',
        'source-layer': 'building',
        minzoom: 14,
        filter: ['!=', ['get', 'hide_3d'], true],
        paint: {
          'fill-extrusion-color': [
            'interpolate',
            ['linear'],
            ['coalesce', ['get', 'render_height'], 5],
            0,
            P.buildingLow,
            80,
            '#1c1f25',
            250,
            P.buildingHigh,
          ],
          // The city rises into 3D as you zoom in.
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 15.8, ['coalesce', ['get', 'render_height'], 5]],
          'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 14, 0, 15.8, ['coalesce', ['get', 'render_min_height'], 0]],
          'fill-extrusion-opacity': 1,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      {
        // Shops, bars, restaurants, cinemas, hotels… named where they really are,
        // up close only, in calm muted colors (owners' billboards are what glow).
        id: 'poi-neon',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'poi',
        minzoom: 16.6,
        filter: ['all', ['has', 'name'], ['match', ['get', 'class'], Object.keys(SIGN_CLASSES), true, false]],
        layout: {
          'text-field': NAME,
          'text-font': REGULAR,
          'text-size': ['interpolate', ['linear'], ['zoom'], 16.6, 10, 19, 13],
          'text-max-width': 8,
          'text-padding': 6,
          'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
        },
        paint: {
          'text-color': SHOP_LABEL_COLOR,
          'text-halo-color': 'rgba(8, 10, 16, 0.85)',
          'text-halo-width': 1.2,
          'text-halo-blur': 0.4,
          'text-opacity': ['interpolate', ['linear'], ['zoom'], 16.6, 0, 17.1, 0.85],
        },
      },
      {
        id: 'label-water',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'water_name',
        filter: ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false],
        layout: {
          'text-field': NAME,
          'text-font': ITALIC,
          'text-size': ['interpolate', ['linear'], ['zoom'], 0, 10, 8, 13],
          'text-letter-spacing': 0.18,
          'text-max-width': 6,
        },
        paint: { 'text-color': P.waterLabel, 'text-halo-color': P.halo, 'text-halo-width': 1 },
      },
      {
        id: 'label-road',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'transportation_name',
        minzoom: 13.5,
        filter: ['all', isLine, classIn('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor')],
        layout: {
          'symbol-placement': 'line',
          'text-field': NAME,
          'text-font': REGULAR,
          'text-size': ['interpolate', ['linear'], ['zoom'], 14, 10, 18, 13],
          'text-letter-spacing': 0.04,
          'text-padding': 8,
        },
        paint: { 'text-color': P.label, 'text-halo-color': P.halo, 'text-halo-width': 1.2 },
      },
      {
        id: 'label-neighbourhood',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'place',
        minzoom: 11,
        maxzoom: 16,
        filter: classIn('suburb', 'quarter', 'neighbourhood'),
        layout: {
          'text-field': NAME,
          'text-font': REGULAR,
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.18,
          'text-size': ['interpolate', ['linear'], ['zoom'], 11, 9, 15, 11],
          'text-max-width': 8,
        },
        paint: { 'text-color': P.labelMuted, 'text-halo-color': P.halo, 'text-halo-width': 1 },
      },
      {
        id: 'label-town',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'place',
        minzoom: 7,
        maxzoom: 15,
        filter: classIn('town', 'village'),
        layout: {
          'text-field': NAME,
          'text-font': REGULAR,
          'text-size': ['interpolate', ['linear'], ['zoom'], 7, 10, 12, 13],
          'text-max-width': 8,
          'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
        },
        paint: { 'text-color': P.label, 'text-halo-color': P.halo, 'text-halo-width': 1.2 },
      },
      {
        id: 'label-state',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'place',
        minzoom: 4,
        maxzoom: 7,
        filter: classIn('state', 'province'),
        layout: {
          'text-field': NAME,
          'text-font': REGULAR,
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.22,
          'text-size': ['interpolate', ['linear'], ['zoom'], 4, 9, 7, 11],
          'text-max-width': 9,
        },
        paint: { 'text-color': P.labelMuted, 'text-halo-color': P.halo, 'text-halo-width': 1 },
      },
      cityLabel('label-city', ['>', ['coalesce', ['get', 'rank'], 99], 4], 6),
      cityLabel('label-city-major', ['<=', ['coalesce', ['get', 'rank'], 99], 4], 2.5),
      {
        id: 'label-country',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'place',
        minzoom: 1.5,
        maxzoom: 7,
        filter: ['==', ['get', 'class'], 'country'],
        layout: {
          'text-field': NAME,
          'text-font': REGULAR,
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.28,
          'text-size': ['interpolate', ['linear'], ['zoom'], 2, 9, 5, 13],
          'text-max-width': 7,
          'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
        },
        paint: { 'text-color': '#7c828d', 'text-halo-color': P.halo, 'text-halo-width': 1.2 },
      },
    ],
  };
}
