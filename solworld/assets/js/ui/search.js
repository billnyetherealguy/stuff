// Search: places and addresses (Photon / OSM), building IDs, coordinates,
// and hand-picked city shortcuts.
import { FEATURED } from '../cities.js';
import { isBuildingKey } from '../registry.js';
import { debounce, h } from '../util.js';
import { icon } from './icons.js';

const COORDS = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

export class Search {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.items = [];
    this.active = -1;
    this.seq = 0;
    this.build();
  }

  build() {
    this.input = h('input', {
      type: 'search',
      class: 'search-input',
      placeholder: globalThis.innerWidth < 760 ? 'Search places' : 'Search any city, address or landmark',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': 'Search places',
      'aria-autocomplete': 'list',
      'aria-controls': 'search-results',
    });
    this.list = h('div', { class: 'search-results', id: 'search-results', role: 'listbox' });
    this.kbd = h('kbd', { class: 'search-kbd' }, '/');
    this.root.replaceChildren(
      h('div', { class: 'search-field' }, h('span', { class: 'search-icon', svg: icon('search', { size: 17 }) }), this.input, this.kbd),
      this.list,
    );

    const run = debounce(() => this.query(), 220);
    this.input.addEventListener('input', () => {
      this.active = -1;
      if (this.input.value.trim().length < 2) this.renderFeatured();
      else run();
    });
    this.input.addEventListener('focus', () => {
      this.root.classList.add('is-focused');
      if (this.input.value.trim().length < 2) this.renderFeatured();
      this.open();
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('pointerdown', (e) => {
      if (!this.root.contains(e.target)) this.close();
    });
    document.addEventListener('keydown', (e) => {
      const typing = /input|textarea|select/i.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
      if (!typing && (e.key === '/' || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)))) {
        e.preventDefault();
        this.input.focus();
        this.input.select();
      }
    });
  }

  open() {
    this.root.classList.add('is-open');
  }

  close() {
    this.root.classList.remove('is-open', 'is-focused');
    this.active = -1;
  }

  onKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this.items.length) return;
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      this.active = (this.active + dir + this.items.length) % this.items.length;
      this.highlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = this.items[this.active >= 0 ? this.active : 0];
      if (item) this.choose(item);
    } else if (e.key === 'Escape') {
      this.input.blur();
      this.close();
    }
  }

  highlight() {
    [...this.list.querySelectorAll('.search-item')].forEach((el, i) => {
      el.classList.toggle('is-active', i === this.active);
      el.setAttribute('aria-selected', String(i === this.active));
      if (i === this.active) el.scrollIntoView({ block: 'nearest' });
    });
  }

  choose(item) {
    this.input.blur();
    this.close();
    if (item.kind !== 'preset') this.input.value = item.title;
    item.run();
  }

  renderFeatured() {
    this.items = FEATURED.map((p) => ({
      kind: 'preset',
      title: p.name,
      sub: p.sub,
      run: () => this.ctx.onPreset(p),
    }));
    this.render('Explore');
  }

  async query() {
    const q = this.input.value.trim();
    const seq = ++this.seq;
    const direct = [];
    if (isBuildingKey(q)) {
      direct.push({ kind: 'key', title: `Building ${q}`, sub: 'Open by registry ID', run: () => this.ctx.onKey(q) });
    }
    const m = COORDS.exec(q);
    if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180) {
      direct.push({ kind: 'coords', title: `${(+m[1]).toFixed(5)}, ${(+m[2]).toFixed(5)}`, sub: 'Go to coordinates', run: () => this.ctx.onCoords([+m[2], +m[1]]) });
    }
    this.items = direct;
    this.render(null, true);
    try {
      const near = this.ctx.mapZoom() > 7 ? this.ctx.mapCenter() : undefined;
      const results = await this.ctx.geocoder.search(q, { near });
      if (seq !== this.seq) return;
      this.items = [
        ...direct,
        ...results.map((r) => ({
          kind: r.isBuilding ? 'building' : 'place',
          title: r.name,
          sub: r.context || r.kind.replace(/_/g, ' '),
          run: () => this.ctx.onResult(r),
        })),
      ];
      this.render(null, false, !results.length && !direct.length ? 'No places found' : null);
    } catch {
      if (seq !== this.seq) return;
      this.render(null, false, direct.length ? null : 'Search is unavailable right now');
    }
  }

  render(heading, loading = false, message = null) {
    const glyph = { preset: 'globe', building: 'building', place: 'pin', key: 'cube', coords: 'pin' };
    const rows = [
      heading ? h('div', { class: 'search-heading' }, heading) : null,
      ...this.items.map((item, i) =>
        h(
          'button',
          {
            class: `search-item${i === this.active ? ' is-active' : ''}`,
            role: 'option',
            'aria-selected': String(i === this.active),
            onmousedown: (e) => e.preventDefault(),
            onclick: () => this.choose(item),
          },
          h('span', { class: 'search-item-icon', svg: icon(glyph[item.kind] || 'pin', { size: 16 }) }),
          h('span', { class: 'search-item-main' }, h('span', { class: 'search-item-title' }, item.title), item.sub ? h('span', { class: 'search-item-sub' }, item.sub) : null),
          h('span', { class: 'search-item-go', svg: icon('arrowRight', { size: 14 }) }),
        ),
      ),
      loading ? h('div', { class: 'search-loading' }, h('span', { class: 'spinner' }), 'Searching…') : null,
      message ? h('div', { class: 'search-empty' }, message) : null,
    ];
    this.list.replaceChildren(...rows.filter(Boolean));
    this.open();
  }
}
