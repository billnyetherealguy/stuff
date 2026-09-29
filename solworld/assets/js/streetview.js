// "Drop in": walk the real street without leaving Solworld. Google Street View
// (real 360° photos: sidewalks, cracks, trees, parked cars, storefronts) opens
// full screen inside the site, pointed at the building, with owners'
// billboards and the building's own poster standing in the street.
//
// Uses the Google Maps JavaScript API with the same key as realistic 3D
// (enable "Maps JavaScript API" on it). Loaded only when someone drops in.

import { Emitter } from './emitter.js';
import { h } from './util.js';
import { icon } from './ui/icons.js';

let loading = null;
function loadMaps(key) {
  if (globalThis.google?.maps?.importLibrary) return Promise.resolve(globalThis.google.maps);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const cb = `__solworldMaps${Date.now()}`;
    globalThis[cb] = () => {
      delete globalThis[cb];
      resolve(globalThis.google.maps);
    };
    // Google calls this if the key is rejected (wrong API, billing, restriction).
    globalThis.gm_authFailure = () => reject(new Error('Google refused the key for Street View (enable “Maps JavaScript API” on it)'));
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=${cb}`;
    s.async = true;
    s.onerror = () => reject(new Error('Could not reach Google Maps'));
    document.head.append(s);
  });
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/** Initial compass heading from a to b ([lng, lat]), degrees clockwise from north. */
export function headingTo([lng1, lat1], [lng2, lat2]) {
  const r = Math.PI / 180;
  const y = Math.sin((lng2 - lng1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lng2 - lng1) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}

/** A poster/billboard as an image for a Street View marker. */
export function posterImage({ title, line, color = '#2af5a8', big = false }) {
  const w = big ? 520 : 440;
  const hgt = big ? 230 : 170;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hgt + 60;
  const ctx = c.getContext('2d');
  // post
  ctx.fillStyle = '#2a2d33';
  ctx.fillRect(w / 2 - 6, hgt - 4, 12, 64);
  // panel with a neon edge
  ctx.shadowColor = color;
  ctx.shadowBlur = 28;
  ctx.fillStyle = 'rgba(8,10,16,0.92)';
  const r = 18;
  ctx.beginPath();
  ctx.moveTo(r, 4);
  ctx.arcTo(w - 4, 4, w - 4, hgt, r);
  ctx.arcTo(w - 4, hgt, 4, hgt, r);
  ctx.arcTo(4, hgt, 4, 4, r);
  ctx.arcTo(4, 4, w - 4, 4, r);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 5;
  ctx.strokeStyle = color;
  ctx.stroke();
  // text
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = color;
  ctx.shadowBlur = 16;
  let size = big ? 64 : 52;
  ctx.font = `800 ${size}px Geist, system-ui, sans-serif`;
  while (ctx.measureText(title).width > w - 60 && size > 22) ctx.font = `800 ${(size -= 2)}px Geist, system-ui, sans-serif`;
  ctx.fillText(title, w / 2, hgt * 0.5);
  ctx.shadowBlur = 0;
  if (line) {
    ctx.fillStyle = color;
    ctx.font = `600 ${big ? 26 : 22}px Geist, system-ui, sans-serif`;
    ctx.fillText(line, w / 2, hgt * 0.8);
  }
  return { url: c.toDataURL('image/png'), width: w, height: c.height };
}

export class StreetDrop extends Emitter {
  constructor({ root }) {
    super();
    this.root = root;
    this.key = '';
    this.open = false;
    this.markers = [];
  }

  setKey(key) {
    this.key = key || '';
  }

  get available() {
    return !!this.key;
  }

  _ui() {
    if (this.stage) return;
    this.stage = h('div', { class: 'street-pano' });
    this.caption = h('div', { class: 'street-caption' });
    const close = h('button', { class: 'street-close', 'aria-label': 'Back to Solworld', onclick: () => this.close() }, h('span', { svg: icon('close', { size: 18 }) }), h('span', null, 'Back up'));
    this.root.replaceChildren(this.stage, h('div', { class: 'street-top' }, this.caption, close));
    addEventListener('keydown', (e) => e.key === 'Escape' && this.open && this.close());
  }

  /**
   * Opens the street at the nearest panorama to `target` ([lng, lat]),
   * facing it. `posters`: [{ lng, lat, title, line, color, big, onClick }].
   */
  async drop({ target, label = '', posters = [] }) {
    if (!this.key) throw new Error('Street view needs the Google key');
    const maps = await loadMaps(this.key);
    const { StreetViewPanorama, StreetViewService, StreetViewSource, StreetViewPreference } = await maps.importLibrary('streetView');
    const { Marker } = await maps.importLibrary('marker');
    const { Size } = await maps.importLibrary('core');
    const service = new StreetViewService();
    let result;
    for (const radius of [60, 150, 400]) {
      try {
        result = await service.getPanorama({ location: { lng: target[0], lat: target[1] }, radius, source: StreetViewSource?.OUTDOOR ?? 'outdoor', preference: StreetViewPreference?.NEAREST ?? 'nearest' });
        if (result?.data?.location) break;
      } catch {
        // nothing within this radius; widen
      }
    }
    const loc = result?.data?.location;
    if (!loc) throw new Error('No street imagery here yet');
    this._ui();
    const at = loc.latLng;
    const from = [typeof at.lng === 'function' ? at.lng() : at.lng, typeof at.lat === 'function' ? at.lat() : at.lat];
    this.root.classList.add('is-open');
    document.body.classList.add('has-street');
    this.open = true;
    this.caption.replaceChildren(h('b', null, label || 'Street level'), h('small', null, 'Drag to look around · tap arrows to walk'));
    this.pano ||= new StreetViewPanorama(this.stage, {
      addressControl: false,
      fullscreenControl: false,
      motionTracking: false,
      motionTrackingControl: false,
      enableCloseButton: false,
      showRoadLabels: true,
      zoomControl: true,
      panControl: false,
      linksControl: true,
    });
    this.pano.setPano(loc.pano);
    this.pano.setPov({ heading: headingTo(from, target), pitch: 8 });
    this.pano.setZoom(0);
    this.pano.setVisible(true);
    for (const m of this.markers) m.setMap(null);
    this.markers = posters.map((p) => {
      const img = posterImage(p);
      const marker = new Marker({
        position: { lng: p.lng, lat: p.lat },
        map: this.pano,
        title: p.title,
        icon: { url: img.url, scaledSize: new Size(img.width / 2, img.height / 2) },
      });
      if (p.onClick) marker.addListener('click', () => p.onClick());
      return marker;
    });
    this.emit('open', { target });
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove('is-open');
    document.body.classList.remove('has-street');
    this.pano?.setVisible(false);
    this.emit('close');
  }
}
