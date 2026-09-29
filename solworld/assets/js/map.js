// Map controller: the globe, building picking, ownership overlays and camera
// choreography. UI code talks to this class instead of MapLibre directly.

import * as maplibregl from '../../vendor/maplibre-6.11.2/maplibre-gl.mjs';
import { Emitter } from './emitter.js';
import { buildStyle } from './mapstyle.js';
import { FACADE_IDS, facadeImage } from './facade.js';
import { sunPosition } from './sun.js';
import { agentFootprint } from './traffic.js';
import { SIGN_COLORS } from './registry.js';
import {
  inflatePolygon,
  interiorPoint,
  pickPartOnRay,
  pointInPolygon,
  polygonsOf,
} from './geo.js';
import { debounce, rafThrottle } from './util.js';

export const COLORS = {
  mine: '#2af5a8',
  owned: '#8f6bff',
  available: '#f3f5fa',
  hover: '#2c323e',
};

const BUILDING_MIN_ZOOM = 14;
const SHELL_MIN_ZOOM = 14.6;
const EMPTY = { type: 'FeatureCollection', features: [] };

const keyFromTileId = (id) => {
  if (typeof id !== 'number' || !Number.isFinite(id)) return null;
  const kind = id % 10;
  const osmId = Math.floor(id / 10);
  if (osmId <= 0) return null;
  return kind === 2 ? `w${osmId}` : kind === 3 ? `r${osmId}` : null;
};

const ringKey = (part) => {
  const [x, y] = interiorPoint(part);
  return `${x.toFixed(6)},${y.toFixed(6)}`;
};

export class MapController extends Emitter {
  constructor({ container, settings, reducedMotion = false, start }) {
    super();
    this.settings = settings;
    this.reducedMotion = reducedMotion;
    this.records = [];
    this.me = null;
    this.selection = null;
    this.hover = null;
    this.outlines = new Map(); // key -> polygons (from OSM), for exact shells
    this.padding = { top: 0, right: 0, bottom: 0, left: 0 };
    this.spinning = false;
    this.orbiting = false;
    this.ready = false;

    this.map = new maplibregl.Map({
      container,
      style: buildStyle(settings.map),
      center: start?.center || [-38, 26],
      zoom: start?.zoom ?? 1.45,
      pitch: start?.pitch ?? 0,
      bearing: start?.bearing ?? 0,
      minZoom: 0.6,
      maxZoom: 19.2,
      maxPitch: 72,
      attributionControl: false,
      canvasContextAttributes: { antialias: true },
      fadeDuration: 220,
      dragRotate: true,
      touchPitch: true,
      reduceMotion: reducedMotion || undefined,
    });
    this.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    this.tileErrors = 0;
    this.errorLog = [];
    this.map.on('error', (e) => {
      const msg = e?.error?.message || '';
      if (this.errorLog.length < 20) this.errorLog.push(msg || String(e?.error || e));
      if (/Unable to parse the tile|AJAXError|Failed to fetch|NetworkError|Load failed/i.test(msg)) {
        this.tileErrors++;
        if (this.tileErrors === 12) this.emit('map-trouble', msg);
      } else {
        console.warn('[solworld] map error', e?.error || e);
      }
    });

    // Facade patterns are drawn on demand, the first time a tile needs one.
    this.map.setMissingStyleImageResolver(async (id) => {
      if (FACADE_IDS.includes(id) && !this.map.hasImage(id)) this.map.addImage(id, facadeImage(id, this.phase || 'night'), { pixelRatio: 4 });
      else if (id === 'sw-skin' && this.skin && !this.map.hasImage(id)) this.map.addImage(id, this.skin.image, { pixelRatio: 1 });
    });
    this.map.on('load', () => this._onLoad());
    this.map.once('idle', () => this.emit('first-idle'));
    this._wireInteraction();
  }

  /* ------------------------------------------------------------ setup */

  _onLoad() {
    const m = this.map;
    m.addSource('sw-points', { type: 'geojson', data: EMPTY });
    m.addSource('sw-shells', { type: 'geojson', data: EMPTY });
    m.addSource('sw-ground', { type: 'geojson', data: EMPTY });
    m.addSource('sw-pulse', { type: 'geojson', data: EMPTY });

    const labelsFrom = 'label-water';
    const shell = (id, filter, opacity) =>
      m.addLayer(
        {
          id,
          type: 'fill-extrusion',
          source: 'sw-shells',
          minzoom: BUILDING_MIN_ZOOM,
          filter,
          paint: {
            'fill-extrusion-color': [
              'match',
              ['get', 'kind'],
              'mine',
              COLORS.mine,
              'owned',
              COLORS.owned,
              'hover',
              COLORS.hover,
              ['match', ['get', 'tone'], 'mine', '#6dffc6', 'owned', '#b39cff', COLORS.available],
            ],
            'fill-extrusion-height': ['get', 'top'],
            'fill-extrusion-base': ['get', 'base'],
            'fill-extrusion-opacity': opacity,
            'fill-extrusion-vertical-gradient': true,
          },
        },
        labelsFrom,
      );
    shell('sw-shell-hover', ['==', ['get', 'kind'], 'hover'], 0.75);
    // Up close the tint turns translucent so the owned building's facade shows through.
    shell('sw-shell-owned', ['match', ['get', 'kind'], ['mine', 'owned'], true, false], ['interpolate', ['linear'], ['zoom'], 15.8, 0.9, 16.6, 0.5]);
    shell('sw-shell-selected', ['all', ['==', ['get', 'kind'], 'selected'], ['!', ['get', 'skin']]], 0.97);
    // The selected building wearing its real photo (see setSkin).
    m.addLayer(
      {
        id: 'sw-shell-skin',
        type: 'fill-extrusion',
        source: 'sw-shells',
        minzoom: BUILDING_MIN_ZOOM,
        filter: ['all', ['==', ['get', 'kind'], 'selected'], ['get', 'skin']],
        paint: {
          'fill-extrusion-pattern': 'sw-skin',
          'fill-extrusion-height': ['get', 'top'],
          'fill-extrusion-base': ['get', 'base'],
          'fill-extrusion-opacity': 1,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      labelsFrom,
    );
    m.on('zoomend', () => {
      if (this.skin && Math.floor(m.getZoom()) !== this.skin.zoom) this._applySkin();
    });

    m.addLayer(
      {
        id: 'sw-ground-glow',
        type: 'line',
        source: 'sw-ground',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 14, 6, 18, 18],
          'line-blur': ['interpolate', ['linear'], ['zoom'], 14, 5, 18, 14],
          'line-opacity': 0.55,
        },
      },
      'building-3d',
    );
    m.addLayer(
      {
        id: 'sw-ground-line',
        type: 'line',
        source: 'sw-ground',
        paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-opacity': 0.9 },
      },
      'building-3d',
    );

    const pointColor = ['case', ['get', 'mine'], COLORS.mine, COLORS.owned];
    m.addLayer({
      id: 'sw-points-glow',
      type: 'circle',
      source: 'sw-points',
      paint: {
        'circle-color': pointColor,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 0, 9, 4, 11, 10, 14, 15, 18],
        'circle-blur': 1,
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.75, 14, 0.55, 15.4, 0],
        'circle-pitch-alignment': 'map',
      },
    });
    m.addLayer({
      id: 'sw-points-core',
      type: 'circle',
      source: 'sw-points',
      paint: {
        'circle-color': ['case', ['get', 'mine'], '#b9ffe3', '#ddd2ff'],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 0, 1.8, 8, 2.4, 14, 3.2],
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 0, 1, 14.6, 1, 15.4, 0],
        'circle-pitch-alignment': 'map',
      },
    });
    // Street life (traffic.js): cars and people as small 3D shapes, headlights after dark.
    m.addSource('sw-agents', { type: 'geojson', data: EMPTY });
    m.addSource('sw-lights', { type: 'geojson', data: EMPTY });
    for (const [id, kind] of [['sw-cars', 'car'], ['sw-people', 'person']]) {
      m.addLayer(
        {
          id,
          type: 'fill-extrusion',
          source: 'sw-agents',
          minzoom: 15,
          filter: ['==', ['get', 'kind'], kind],
          paint: {
            'fill-extrusion-color': ['get', 'color'],
            'fill-extrusion-height': ['get', 'height'],
            'fill-extrusion-base': 0.12,
            'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0, 15.6, 1],
            'fill-extrusion-vertical-gradient': true,
          },
        },
        labelsFrom,
      );
    }
    m.addLayer(
      {
        id: 'sw-headlights',
        type: 'circle',
        source: 'sw-lights',
        minzoom: 15,
        paint: {
          'circle-color': ['get', 'color'],
          'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 15, 1.2, 19, 14],
          'circle-blur': 1,
          'circle-opacity': 0,
          'circle-pitch-alignment': 'map',
        },
      },
      labelsFrom,
    );

    // Owners' billboards: glowing text above their building for everyone to see.
    m.addLayer({
      id: 'sw-signs',
      type: 'symbol',
      source: 'sw-points',
      minzoom: 9,
      filter: ['!=', ['get', 'sign'], ''],
      layout: {
        'text-field': ['get', 'sign'],
        'text-font': ['Noto Sans Bold'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 14, 13, 18, 18],
        'text-max-width': 11,
        'text-anchor': 'bottom',
        'text-offset': [0, -0.9],
        'text-letter-spacing': 0.02,
        'text-padding': 4,
        'symbol-sort-key': ['-', 0, ['get', 'price']],
      },
      paint: {
        'text-color': ['get', 'signColor'],
        'text-halo-color': 'rgba(0, 0, 0, 0.88)',
        'text-halo-width': 1.8,
        'text-halo-blur': 0.6,
        'text-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0, 10, 1],
      },
    });
    m.addLayer({
      id: 'sw-pulse',
      type: 'circle',
      source: 'sw-pulse',
      paint: {
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 2,
        'circle-radius': 0,
        'circle-stroke-opacity': 0,
        'circle-pitch-alignment': 'map',
      },
    });

    this.ready = true;
    this._pushPoints();
    this.refreshShells();
    this.updateDaylight();
    this.map.on('moveend', () => this.updateDaylight());
    setInterval(() => this.updateDaylight(), 120_000);
    this.emit('ready');
  }

  /**
   * Lights the map with the real sun at the view center: the light comes from
   * where the sun is right now, and satellite ground, facades, neon and sky
   * switch between day, golden hour and night.
   */
  updateDaylight(date = new Date()) {
    if (!this.ready) return;
    const m = this.map;
    const [lng, lat] = this.center;
    const sun = sunPosition(lng, lat, date);
    const { phase } = sun;
    const night = phase === 'night';
    m.setLight({
      anchor: 'map',
      position: [1.4, night ? (sun.bearing + 180) % 360 : sun.bearing, night ? 40 : Math.min(84, Math.max(10, 90 - sun.altitude))],
      color: { day: '#fff4e2', dusk: '#ffb07a', night: '#a9bbff' }[phase],
      intensity: { day: 0.5, dusk: 0.44, night: 0.3 }[phase],
    });
    this.sun = sun;
    if (this.phase === phase) return;
    this.phase = phase;
    for (const id of FACADE_IDS) if (m.hasImage(id)) m.updateImage(id, facadeImage(id, phase));
    const paint = (layer, prop, value) => m.getLayer(layer) && m.setPaintProperty(layer, prop, value);
    const sat = { day: [0.97, -0.05, 0.96], dusk: [0.72, -0.12, 0.9], night: [0.42, -0.45, 0.84] }[phase];
    paint('satellite', 'raster-brightness-max', sat[0]);
    paint('satellite', 'raster-saturation', sat[1]);
    paint('satellite', 'raster-opacity', ['interpolate', ['linear'], ['zoom'], 15.2, 0, 16.6, sat[2]]);
    // Signs are switched off in daylight, glow at dusk and full at night.
    paint('sw-headlights', 'circle-opacity', { day: 0, dusk: 0.6, night: 0.9 }[phase]);
    const neon = { day: 0, dusk: 0.8, night: 1 }[phase];
    paint('poi-neon', 'text-opacity', ['interpolate', ['linear'], ['zoom'], 15.4, 0, 16, neon]);
    const blocks = { day: ['#4d525b', '#5d626c', '#6f7580'], dusk: ['#2a2527', '#342d2f', '#40383a'], night: ['#16181d', '#1c1f25', '#232730'] }[phase];
    paint('building-3d', 'fill-extrusion-color', ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 5], 0, blocks[0], 80, blocks[1], 250, blocks[2]]);
    const sky = {
      day: { 'sky-color': '#0c1b33', 'horizon-color': '#4f78b0', 'fog-color': '#1a2433' },
      dusk: { 'sky-color': '#140d1c', 'horizon-color': '#b0603a', 'fog-color': '#1a0f14' },
      night: { 'sky-color': '#000000', 'horizon-color': '#0d1120', 'fog-color': '#000000' },
    }[phase];
    m.setSky({ ...m.getStyle().sky, ...sky });
    this.emit('daylight', sun);
  }

  _wireInteraction() {
    const m = this.map;
    const stopMotion = () => {
      if (this.spinning) {
        this.stopSpin();
        this.emit('user-moved');
      }
      if (this.orbiting) this.stopOrbit();
    };
    for (const type of ['mousedown', 'touchstart', 'wheel', 'dragstart']) m.on(type, stopMotion);
    m.getCanvas().addEventListener('keydown', stopMotion);

    const onMove = rafThrottle((e) => this._hoverAt(e.point, e.lngLat));
    m.on('mousemove', (e) => {
      if (this.ready && !this.touchLike) onMove(e);
    });
    m.on('mouseout', () => this._setHover(null));
    m.on('touchstart', () => {
      this.touchLike = true;
    });

    m.on('click', (e) => this._click(e));
    const refresh = debounce(() => this.refreshShells(), 180);
    m.on('moveend', refresh);
    m.on('sourcedata', (e) => {
      if (e.sourceId === 'omt' && e.isSourceLoaded && this.map.getZoom() >= SHELL_MIN_ZOOM) refresh();
    });
    m.on('zoom', () => this.emit('zoom', m.getZoom()));
    m.on('rotate', () => this.emit('rotate', m.getBearing()));
  }

  /* ---------------------------------------------------------- picking */

  /** Camera ground position and altitude (meters), for 3D picking. */
  cameraInfo() {
    const m = this.map;
    try {
      const t = m._camera?.transform || m.transform;
      if (t?.getCameraLngLat && t.getCameraAltitude) {
        const ll = t.getCameraLngLat();
        const altitude = t.getCameraAltitude();
        if (Number.isFinite(ll?.lng) && Number.isFinite(altitude)) return { lngLat: [ll.lng, ll.lat], altitude };
      }
    } catch {
      // internal API moved; fall through to the public reconstruction
    }
    // Reconstruct from public state: distance to the look-at point follows from
    // the vertical field of view, then tilt it back along the bearing.
    const fov = ((m.getVerticalFieldOfView?.() ?? 36.87) * Math.PI) / 180;
    const c = m.getCenter();
    const metersPerPixel = (40_075_016.686 * Math.cos((c.lat * Math.PI) / 180)) / (512 * 2 ** m.getZoom());
    const dist = (0.5 / Math.tan(fov / 2)) * m.getCanvas().clientHeight * metersPerPixel;
    const pitch = (m.getPitch() * Math.PI) / 180;
    const bearing = (m.getBearing() * Math.PI) / 180;
    const back = dist * Math.sin(pitch);
    return {
      lngLat: [
        c.lng - (Math.sin(bearing) * back) / (111_320 * Math.cos((c.lat * Math.PI) / 180)),
        c.lat - (Math.cos(bearing) * back) / 110_574,
      ],
      altitude: dist * Math.cos(pitch),
    };
  }

  /** The single building footprint under a screen point, or null. */
  pickAt(point, lngLat) {
    if (!this.ready || this.map.getZoom() < BUILDING_MIN_ZOOM) return null;
    let feature = this.map.queryRenderedFeatures(point, { layers: ['building-facade', 'building-3d'] })[0];
    if (!feature) feature = this.map.queryRenderedFeatures(point, { layers: ['building-pick'] })[0];
    if (!feature) return null;
    const parts = polygonsOf(feature.geometry);
    if (!parts.length) return null;
    const top = Number(feature.properties?.render_height ?? 5);
    const base = Number(feature.properties?.render_min_height ?? 0);
    const ground = [lngLat.lng, lngLat.lat];
    const part = pickPartOnRay(parts, ground, this.cameraInfo(), top, base);
    if (!part) return null;
    return {
      part,
      point: pointInPolygon(ground, part) ? ground : interiorPoint(part),
      top,
      base,
      tileKey: parts.length === 1 ? keyFromTileId(feature.id) : null,
    };
  }

  _hoverAt(point, lngLat) {
    const pick = this.pickAt(point, lngLat);
    this.map.getCanvas().style.cursor = pick || this._pointAt(point) ? 'pointer' : '';
    const id = pick ? ringKey(pick.part) : null;
    if (id === this.hover?.id) return;
    this._setHover(pick ? { id, ...pick } : null);
  }

  _setHover(hover) {
    this.hover = hover;
    this._renderShells();
  }

  _pointAt(point) {
    if (!this.ready || this.map.getZoom() >= 15.4) return null;
    const box = [
      [point.x - 8, point.y - 8],
      [point.x + 8, point.y + 8],
    ];
    return this.map.queryRenderedFeatures(box, { layers: ['sw-points-core', 'sw-points-glow'] })[0] || null;
  }

  _click(e) {
    const dot = this._pointAt(e.point);
    if (dot) {
      this.emit('point', dot.properties.key);
      return;
    }
    const pick = this.pickAt(e.point, e.lngLat);
    if (pick) this.emit('pick', pick);
    else this.emit('pick-empty', { zoom: this.map.getZoom(), lngLat: [e.lngLat.lng, e.lngLat.lat] });
  }

  /* -------------------------------------------------------- ownership */

  /**
   * Resolves once the camera is still and the visible tiles have loaded.
   * (MapLibre's 'idle' never fires while the street-life animation runs.)
   */
  settled(maxMs = 8000) {
    const m = this.map;
    return new Promise((resolve) => {
      const t0 = performance.now();
      let frames = 0;
      const onRender = () => frames++;
      m.on('render', onRender);
      m.triggerRepaint();
      const check = () => {
        // At least two fresh frames drawn since we started, so what's on screen
        // (and what queryRenderedFeatures sees) matches the current camera.
        const ready = frames >= 2 && !m.isMoving() && m.areTilesLoaded() && m.isStyleLoaded();
        if (ready || performance.now() - t0 > maxMs) {
          m.off('render', onRender);
          resolve();
        } else setTimeout(check, 50);
      };
      setTimeout(check, 30);
    });
  }

  /** Draws the street-life agents (see traffic.js). */
  setAgents(agents) {
    if (!this.ready) return;
    const night = this.phase && this.phase !== 'day';
    const features = [];
    const lights = [];
    for (const a of agents) {
      features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [agentFootprint(a)] }, properties: { kind: a.kind, color: a.color, height: a.height } });
      if (night && a.kind === 'car') {
        const h = (a.heading * Math.PI) / 180;
        const kx = 111_320 * Math.cos((a.lat * Math.PI) / 180);
        const ahead = (a.length / 2 + 3) ;
        lights.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [a.lng + (Math.sin(h) * ahead) / kx, a.lat + (Math.cos(h) * ahead) / 110_574] }, properties: { color: '#fff1c8' } });
        const behind = -(a.length / 2 + 0.6);
        lights.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [a.lng + (Math.sin(h) * behind) / kx, a.lat + (Math.cos(h) * behind) / 110_574] }, properties: { color: '#ff3b30' } });
      }
    }
    this.map.getSource('sw-agents').setData({ type: 'FeatureCollection', features });
    this.map.getSource('sw-lights').setData({ type: 'FeatureCollection', features: lights });
  }

  /** Road lines around the view, from the loaded map tiles (for traffic.js). */
  roadFeatures() {
    try {
      return this.map.querySourceFeatures('omt', { sourceLayer: 'transportation' });
    } catch {
      return [];
    }
  }

  /** Named shops/bars/restaurants… around the view (for neon signs in 3D). */
  signFeatures() {
    try {
      return this.map.querySourceFeatures('omt', { sourceLayer: 'poi' });
    } catch {
      return [];
    }
  }

  setOwnership(records, me) {
    this.records = records;
    this.me = me;
    this._pushPoints();
    this.refreshShells();
  }

  setOutlines(map) {
    for (const [key, b] of map) this.outlines.set(key, b.polygons);
    this.refreshShells();
  }

  _pushPoints() {
    if (!this.ready) return;
    this.map.getSource('sw-points').setData({
      type: 'FeatureCollection',
      features: this.records.map((r) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
        properties: {
          key: r.key,
          mine: r.owner === this.me,
          sign: r.sign?.text || '',
          signColor: SIGN_COLORS[r.sign?.color] || SIGN_COLORS[0],
          price: r.price || 0,
        },
      })),
    });
  }

  /** Owned records whose anchor is on screen and close enough to show shells. */
  visibleRecords() {
    if (!this.ready || this.map.getZoom() < SHELL_MIN_ZOOM) return [];
    const b = this.map.getBounds();
    return this.records.filter((r) => b.contains([r.lng, r.lat]));
  }

  /** Tile footprints (with their own heights) that make up one building. */
  _partsFor(outline, anchor) {
    const m = this.map;
    const out = new Map();
    const collect = (features, keep) => {
      for (const f of features) {
        if (f.properties?.hide_3d === true) continue;
        const top = Number(f.properties?.render_height ?? 5);
        const base = Number(f.properties?.render_min_height ?? 0);
        for (const part of polygonsOf(f.geometry)) {
          if (!keep(part)) continue;
          out.set(ringKey(part), { part, top, base });
        }
      }
    };
    if (outline?.length) {
      const pts = outline.flat(2).map((c) => m.project(c));
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const canvas = m.getCanvas();
      const w = canvas.clientWidth;
      const hgt = canvas.clientHeight;
      const box = [
        [Math.max(0, Math.min(...xs) - 2), Math.max(0, Math.min(...ys) - 2)],
        [Math.min(w, Math.max(...xs) + 2), Math.min(hgt, Math.max(...ys) + 2)],
      ];
      if (box[1][0] > box[0][0] && box[1][1] > box[0][1]) {
        collect(m.queryRenderedFeatures(box, { layers: ['building-pick'] }), (part) => {
          const p = interiorPoint(part);
          return outline.some((poly) => pointInPolygon(p, poly));
        });
      }
    }
    if (!out.size && anchor) {
      collect(m.queryRenderedFeatures(m.project(anchor), { layers: ['building-pick'] }), (part) => pointInPolygon(anchor, part));
    }
    return [...out.values()];
  }

  refreshShells() {
    if (!this.ready) return;
    const shells = [];
    if (this.map.getZoom() >= SHELL_MIN_ZOOM) {
      const selectedKey = this.selection?.key;
      for (const r of this.visibleRecords()) {
        if (r.key === selectedKey) continue;
        const kind = r.owner === this.me ? 'mine' : 'owned';
        for (const p of this._partsFor(this.outlines.get(r.key), [r.lng, r.lat])) shells.push({ ...p, kind });
      }
      if (this.selection) {
        const sel = this.selection;
        const parts = this._partsFor(sel.polygons, sel.anchor);
        const list = parts.length ? parts : sel.fallback ? [sel.fallback] : [];
        for (const p of list) shells.push({ ...p, kind: 'selected', tone: sel.tone });
      }
    }
    this.shells = shells;
    this._renderShells();
    this._renderGround();
  }

  _renderShells() {
    if (!this.ready) return;
    const features = (this.shells || []).map((s) => this._shellFeature(s));
    if (this.hover && this.map.getZoom() >= BUILDING_MIN_ZOOM) {
      const covered = (this.shells || []).some((s) => pointInPolygon(this.hover.point, s.part));
      if (!covered) features.push(this._shellFeature({ ...this.hover, kind: 'hover' }));
    }
    this.map.getSource('sw-shells').setData({ type: 'FeatureCollection', features });
  }

  _shellFeature({ part, top, base, kind, tone }) {
    const lift = kind === 'hover' ? 0.3 : 0.6;
    return {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: inflatePolygon(part, kind === 'hover' ? 0.25 : 0.45) },
      properties: {
        kind,
        tone: tone || '',
        top: top + lift,
        base: Math.max(0, base - (base > 0 ? 0.3 : 0)),
        skin: kind === 'selected' && !!this.skin?.ready && this.skin.key === this.selection?.key,
      },
    };
  }

  _renderGround() {
    const sel = this.selection;
    const color = sel ? (sel.tone === 'mine' ? COLORS.mine : sel.tone === 'owned' ? COLORS.owned : '#dfe6ff') : null;
    const polys = sel?.polygons?.length ? sel.polygons : sel?.fallback ? [sel.fallback.part] : [];
    this.map.getSource('sw-ground').setData({
      type: 'FeatureCollection',
      features: polys.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: p },
        properties: { color },
      })),
    });
  }

  /**
   * Highlights one building. `polygons` is the exact OSM outline when known;
   * `fallback` is the tile footprint that was clicked (used until then).
   */
  setSelection(selection) {
    if (this.skin && this.skin.key !== selection?.key) this.skin = null;
    this.selection = selection;
    this.refreshShells();
  }

  clearSelection() {
    this.selection = null;
    this.skin = null;
    this.refreshShells();
  }

  /**
   * Wraps the selected building in a texture made from its real photo
   * (skin.js). `height` (m) sizes the photo so one copy spans the building.
   */
  setSkin({ key, image, height }) {
    if (!this.ready || this.selection?.key !== key) return;
    this.skin = { key, image, height: Math.max(6, height || 10), ready: false };
    this._applySkin();
  }

  _applySkin() {
    const m = this.map;
    const skin = this.skin;
    if (!skin) return;
    // Patterns draw at a fixed screen size per zoom level: pick the pixel ratio
    // that makes one copy of the photo about as tall as the building.
    const zoom = Math.floor(m.getZoom());
    const lat = this.selection?.anchor?.[1] ?? this.center[1];
    const metersPerPx = (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
    const pixelRatio = Math.min(24, Math.max(0.2, (skin.image.height * metersPerPx) / skin.height));
    if (m.hasImage('sw-skin')) m.removeImage('sw-skin');
    m.addImage('sw-skin', skin.image, { pixelRatio });
    skin.zoom = zoom;
    skin.ready = true;
    this._renderShells();
  }

  /* ----------------------------------------------------------- camera */

  setPadding(padding) {
    this.padding = { top: 0, right: 0, bottom: 0, left: 0, ...padding };
    if (!this.map.isMoving()) this.map.easeTo({ padding: this.padding, duration: this.reducedMotion ? 0 : 450 });
  }

  flyToBuilding(center, { top = 20, duration } = {}) {
    this.stopSpin();
    // Frame taller buildings from further away; keep the user's viewing
    // direction (they clicked what they could see from here).
    const zoom = Math.max(15.2, Math.min(16.9, 16.9 - 0.85 * Math.log2(Math.max(1, top / 40))));
    const current = this.map.getZoom();
    const far = current < 12;
    this.map.flyTo({
      center,
      zoom,
      pitch: Math.max(50, Math.min(60, this.map.getPitch() || 55)),
      bearing: this.map.getBearing(),
      padding: this.padding,
      duration: this.reducedMotion ? 0 : duration ?? (far ? 4200 : 1400),
      curve: far ? 1.55 : 1.2,
      essential: true,
    });
  }

  flyToPreset(p, { duration } = {}) {
    this.stopSpin();
    const far = this.map.getZoom() < 9;
    this.map.flyTo({
      center: p.center,
      zoom: p.zoom,
      pitch: p.pitch,
      bearing: p.bearing,
      padding: this.padding,
      duration: this.reducedMotion ? 0 : duration ?? (far ? 5600 : 3200),
      curve: 1.6,
      essential: true,
    });
  }

  flyToExtent([west, north, east, south], { maxZoom = 16 } = {}) {
    this.stopSpin();
    this.map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: { top: 90, bottom: 90, left: 60 + this.padding.left, right: 60 + this.padding.right }, maxZoom, pitch: 45, duration: this.reducedMotion ? 0 : 3200, essential: true },
    );
  }

  flyTo(center, zoom = 15.5) {
    this.stopSpin();
    this.map.flyTo({ center, zoom, pitch: 55, padding: this.padding, duration: this.reducedMotion ? 0 : 3200, curve: 1.5, essential: true });
  }

  goGlobe() {
    this.stopOrbit();
    const c = this.map.getCenter();
    this.map.flyTo({
      center: [c.lng, Math.max(-35, Math.min(45, c.lat))],
      zoom: 1.6,
      pitch: 0,
      bearing: 0,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      duration: this.reducedMotion ? 0 : 2800,
      essential: true,
    });
  }

  zoomBy(delta) {
    this.map.easeTo({ zoom: this.map.getZoom() + delta, duration: 300 });
  }

  resetNorth() {
    this.map.easeTo({ bearing: 0, duration: 500 });
  }

  toggle3d() {
    const pitched = this.map.getPitch() > 5;
    this.map.easeTo({ pitch: pitched ? 0 : 60, duration: 700 });
    return !pitched;
  }

  startSpin() {
    if (this.reducedMotion || this.spinning) return;
    this.spinning = true;
    let last = performance.now();
    const step = (now) => {
      if (!this.spinning) return;
      const dt = Math.min(64, now - last);
      last = now;
      if (!this.map.isMoving() && this.map.getZoom() < 5 && document.visibilityState === 'visible') {
        const c = this.map.getCenter();
        this.map.jumpTo({ center: [c.lng - dt * 0.0035, c.lat] });
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  stopSpin() {
    this.spinning = false;
  }

  startOrbit() {
    if (this.reducedMotion || this.orbiting) return;
    this.orbiting = true;
    this.emit('orbit', true);
    let last = performance.now();
    const step = (now) => {
      if (!this.orbiting) return;
      const dt = Math.min(64, now - last);
      last = now;
      if (!this.map.isMoving() && document.visibilityState === 'visible') {
        this.map.setBearing(this.map.getBearing() + dt * 0.0045);
      }
      requestAnimationFrame(step);
    };
    this.map.once('moveend', () => requestAnimationFrame(step));
    if (!this.map.isMoving()) requestAnimationFrame(step);
  }

  stopOrbit() {
    if (!this.orbiting) return;
    this.orbiting = false;
    this.emit('orbit', false);
  }

  /** Expanding rings at a point, e.g. when a purchase lands. */
  pulse(center, color = COLORS.mine) {
    if (!this.ready || this.reducedMotion) return;
    const src = this.map.getSource('sw-pulse');
    src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: center }, properties: { color } }] });
    const start = performance.now();
    const duration = 2200;
    const frame = (now) => {
      const t = (now - start) / duration;
      if (t >= 1) {
        this.map.setPaintProperty('sw-pulse', 'circle-stroke-opacity', 0);
        src.setData(EMPTY);
        return;
      }
      const e = 1 - Math.pow(1 - t, 3);
      this.map.setPaintProperty('sw-pulse', 'circle-radius', 6 + e * 90);
      this.map.setPaintProperty('sw-pulse', 'circle-stroke-opacity', 0.9 * (1 - t));
      this.map.setPaintProperty('sw-pulse', 'circle-stroke-width', 3 * (1 - t) + 0.5);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  get zoom() {
    return this.map.getZoom();
  }

  get center() {
    const c = this.map.getCenter();
    return [c.lng, c.lat];
  }

  cameraState() {
    const c = this.map.getCenter();
    return { center: [c.lng, c.lat], zoom: this.map.getZoom(), pitch: this.map.getPitch(), bearing: this.map.getBearing() };
  }

  resize() {
    this.map.resize();
  }
}
