// City takeover: drag across the map to select land, see how many buildings
// it holds, what it becomes (neighborhood → town → city → mega city → state →
// country), its price, then name it and buy it in one go.

import { LAND_MAX_DEG, estimateBuildings, landPrice, tierFor } from '../pricing.js';
import { fmtInt, fmtSol, fmtUsd, h, who } from '../util.js';
import { icon } from './icons.js';

const norm = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
const inside = ([lng, lat], [w, s, e, n]) => lng >= w && lng <= e && lat >= s && lat <= n;

export class TakeoverTool {
  constructor({ mapc, ctx, root }) {
    this.mapc = mapc;
    this.ctx = ctx;
    this.root = root;
    this.active = false;
    this.start = null;
    this.bbox = null;
    this._bind();
  }

  _bind() {
    const m = this.mapc.map;
    const down = (e) => {
      if (!this.active || this.quoteOpen) return;
      e.preventDefault?.();
      this.start = [e.lngLat.lng, e.lngLat.lat];
      this.bbox = null;
    };
    const move = (e) => {
      if (!this.active || !this.start) return;
      this.bbox = norm(this.start, [e.lngLat.lng, e.lngLat.lat]);
      this.mapc.setDraft(this.bbox, this._problem(this.bbox) ? 'bad' : 'ok');
      this._hint(this._live(this.bbox));
    };
    const up = () => {
      if (!this.active || !this.start) return;
      this.start = null;
      if (this.bbox && this.bbox[2] - this.bbox[0] > 1e-5 && this.bbox[3] - this.bbox[1] > 1e-5) this.quote();
    };
    m.on('mousedown', down);
    m.on('touchstart', (e) => e.points?.length === 1 && down(e));
    m.on('mousemove', move);
    m.on('touchmove', move);
    m.on('mouseup', up);
    m.on('touchend', up);
    addEventListener('keydown', (e) => e.key === 'Escape' && this.active && this.stop());
  }

  begin() {
    const m = this.mapc.map;
    this.active = true;
    this.quoteOpen = false;
    this.mapc.stopOrbit();
    this.mapc.stopSpin?.();
    m.dragPan.disable();
    m.dragRotate.disable();
    m.touchZoomRotate.disable();
    m.getCanvas().style.cursor = 'crosshair';
    document.body.classList.add('is-takeover');
    this.root.className = 'takeover glass is-open';
    this._hint('Drag across the map to select land. Zoom out for bigger takeovers.');
  }

  stop() {
    const m = this.mapc.map;
    this.active = false;
    this.start = null;
    this.bbox = null;
    this.quoteOpen = false;
    m.dragPan.enable();
    m.dragRotate.enable();
    m.touchZoomRotate.enable();
    m.getCanvas().style.cursor = '';
    this.mapc.setDraft(null);
    document.body.classList.remove('is-takeover');
    this.root.className = 'takeover';
    this.root.replaceChildren();
  }

  _hint(text) {
    this.root.replaceChildren(
      h('div', { class: 'takeover-hint' }, h('span', { svg: icon('trophy', { size: 16 }) }), h('span', null, text)),
      h('button', { class: 'btn btn--ghost btn--sm', onclick: () => this.stop() }, 'Cancel'),
    );
  }

  _problem(bbox) {
    if (bbox[2] - bbox[0] > LAND_MAX_DEG || bbox[3] - bbox[1] > LAND_MAX_DEG) return 'That’s bigger than the largest takeover (a large state). Select a smaller area.';
    const hit = this.ctx.registry.state.territories.find((t) => t.bbox[0] < bbox[2] && t.bbox[2] > bbox[0] && t.bbox[1] < bbox[3] && t.bbox[3] > bbox[1]);
    if (hit) return `Overlaps “${hit.title || hit.tier}” owned by ${who(hit.owner)}.`;
    return null;
  }

  _live(bbox) {
    const count = this._count(bbox);
    return `${count.approx ? '≈ ' : ''}${fmtInt(count.n)} buildings · ${tierFor(count.n)} · ${fmtSol(landPrice(bbox))} SOL`;
  }

  /** Buildings inside: counted from the map when they're loaded, estimated otherwise. */
  _count(bbox) {
    const m = this.mapc.map;
    const view = m.getBounds();
    const visible = m.getZoom() >= 13.5 && inside([bbox[0], bbox[1]], [view.getWest(), view.getSouth(), view.getEast(), view.getNorth()]) && inside([bbox[2], bbox[3]], [view.getWest(), view.getSouth(), view.getEast(), view.getNorth()]);
    if (!visible) return { n: estimateBuildings(bbox), approx: true };
    const seen = new Set();
    let n = 0;
    for (const f of m.querySourceFeatures('omt', { sourceLayer: 'building' })) {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
      for (const p of polys) {
        const ring = p[0];
        if (!ring?.length) continue;
        let cx = 0;
        let cy = 0;
        for (const [x, y] of ring) {
          cx += x;
          cy += y;
        }
        cx /= ring.length;
        cy /= ring.length;
        const id = `${cx.toFixed(5)},${cy.toFixed(5)}`; // the same building appears in neighbouring tiles
        if (seen.has(id) || !inside([cx, cy], bbox)) continue;
        seen.add(id);
        n++;
      }
    }
    return { n, approx: false };
  }

  async quote() {
    // Rounded exactly as the on-chain record stores it, so the price we quote
    // is the price every visitor's browser will check.
    const bbox = this.bbox.map((v) => Number(v.toFixed(5)));
    this.quoteOpen = true;
    const problem = this._problem(bbox);
    const count = this._count(bbox);
    const taken = [...this.ctx.registry.state.buildings.values()].filter((r) => inside([r.lng, r.lat], bbox));
    const yours = Math.max(0, count.n - taken.length);
    const tier = tierFor(yours);
    const price = landPrice(bbox);
    const usd = await this.ctx.solUsd();
    const km2 = ((bbox[2] - bbox[0]) * 111.32 * Math.cos((((bbox[1] + bbox[3]) / 2) * Math.PI) / 180)) * ((bbox[3] - bbox[1]) * 110.574);
    const nameIn = h('input', { class: 'field-input', maxlength: '40', placeholder: `Name your ${tier.toLowerCase()} (e.g. “${this.ctx.myName() || 'Sol'} ${tier === 'Neighborhood' ? 'Heights' : tier === 'Town' ? 'Town' : tier === 'City' ? 'City' : tier}”)` });
    this.mapc.setDraft(bbox, problem ? 'bad' : 'ok');
    this.root.replaceChildren(
      h(
        'div',
        { class: 'takeover-quote' },
        h('div', { class: 'takeover-tier' }, h('small', null, 'You’d found a'), h('b', null, tier)),
        h(
          'div',
          { class: 'takeover-stats' },
          stat(`${count.approx ? '≈ ' : ''}${fmtInt(yours)}`, 'buildings'),
          stat(km2 < 1 ? `${fmtInt(km2 * 1e6)} m²` : `${fmtInt(km2)} km²`, 'land'),
          stat(`${fmtSol(price)} SOL`, usd ? `≈ ${fmtUsd((price / 1e9) * usd)}` : 'price'),
        ),
        taken.length ? h('p', { class: 'modal-fine' }, `${fmtInt(taken.length)} building${taken.length === 1 ? ' is' : 's are'} already owned here and stay with their owners.`) : null,
        count.approx ? h('p', { class: 'modal-fine' }, 'Building count estimated from how built-up the area is. Zoom in to count exactly.') : null,
        problem ? h('p', { class: 'field-error' }, problem) : nameIn,
        h(
          'div',
          { class: 'field-row' },
          h('button', { class: 'btn btn--ghost btn--sm', onclick: () => ((this.quoteOpen = false), this.mapc.setDraft(null), this._hint('Drag across the map to select land.')) }, 'Redraw'),
          h('button', { class: 'btn btn--ghost btn--sm', onclick: () => this.stop() }, 'Cancel'),
          problem
            ? null
            : h(
                'button',
                {
                  class: 'btn btn--primary btn--sm takeover-buy',
                  onclick: async () => {
                    const ok = await this.ctx.onBuyLand({ bbox, price, count: yours, title: nameIn.value });
                    if (ok) this.stop();
                  },
                },
                `Take over · ${fmtSol(price)} SOL`,
              ),
        ),
      ),
    );
    nameIn.focus?.();
  }
}

function stat(value, label) {
  return h('div', { class: 'stat' }, h('b', null, value), h('span', null, label));
}
