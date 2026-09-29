// The building panel: what the building looks like, who owns it, and the
// buy / claim flow. Rendering only — app.js decides what to show.

import { buildingFacts, buildingTitle, satelliteView } from '../info.js';
import { SIGN_COLORS } from '../registry.js';
import { placeLabel } from '../cities.js';
import { avatar, copyText, fmtCoord, fmtInt, fmtSol, fmtUsd, h, shortAddr, timeAgo } from '../util.js';
import { icon } from './icons.js';

const STAGES = {
  preparing: 'Preparing transaction…',
  nonce: 'Setting up offers for this building…',
  signing: 'Signing…',
  wallet: 'Approve in your wallet…',
  sending: 'Sending to Solana…',
  confirming: 'Confirming on Solana…',
  indexing: 'Recording ownership…',
  simulating: 'Recording ownership…',
};

export class BuildingPanel {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.state = null;
    this.busy = null;
    this.build();
  }

  build() {
    this.mediaStage = h('div', { class: 'media-stage' });
    this.mediaTabs = h('div', { class: 'media-tabs', role: 'tablist' });
    this.streetLink = h('a', { class: 'media-chip', target: '_blank', rel: 'noopener', title: 'Open Street View in Google Maps' }, h('span', { svg: icon('street', { size: 14 }) }), 'Street View', h('span', { svg: icon('external', { size: 12 }) }));
    this.statusPill = h('span', { class: 'status-pill' });
    this.orbitBtn = h('button', { class: 'icon-btn icon-btn--ghost', title: 'Orbit', 'aria-label': 'Orbit camera', svg: icon('orbit'), onclick: () => this.ctx.onToggleOrbit() });
    this.shareBtn = h('button', { class: 'icon-btn icon-btn--ghost', title: 'Share', 'aria-label': 'Share this building', svg: icon('share'), onclick: () => this.ctx.onShare() });
    this.title = h('h2', { class: 'panel-title', id: 'panel-title' });
    this.sub = h('p', { class: 'panel-sub' });
    this.owner = h('div', { class: 'owner-card' });
    this.market = h('div', { class: 'market' });
    this.facts = h('dl', { class: 'facts' });
    this.links = h('div', { class: 'panel-links' });
    this.foot = h('div', { class: 'panel-foot' });
    this.handle = h('button', { class: 'sheet-handle', 'aria-label': 'Expand details', onclick: () => this.root.classList.toggle('is-expanded') }, h('span'));

    this.root.replaceChildren(
      this.handle,
      h(
        'div',
        { class: 'panel-scroll' },
        h(
          'div',
          { class: 'panel-media' },
          this.mediaStage,
          h('div', { class: 'media-bar' }, this.mediaTabs, this.streetLink),
          h('button', { class: 'panel-close icon-btn', 'aria-label': 'Close', svg: icon('close'), onclick: () => this.ctx.onClose() }),
        ),
        h(
          'div',
          { class: 'panel-body' },
          h('div', { class: 'panel-row' }, this.statusPill, h('div', { class: 'panel-tools' }, this.orbitBtn, this.shareBtn)),
          this.title,
          this.sub,
          this.owner,
          this.market,
          this.facts,
          this.links,
        ),
      ),
      this.foot,
    );
    this.root.setAttribute('aria-labelledby', 'panel-title');
  }

  get isOpen() {
    return !!this._open;
  }

  open() {
    this._open = true;
    this.root.hidden = false;
    document.getElementById('app')?.classList.add('panel-open');
    requestAnimationFrame(() => this.root.classList.add('is-open'));
  }

  close() {
    this._open = false;
    this.root.classList.remove('is-open', 'is-expanded');
    document.getElementById('app')?.classList.remove('panel-open');
    this.state = null;
    this.busy = null;
  }

  setOrbiting(on) {
    this.orbitBtn.classList.toggle('is-active', !!on);
  }

  /** A footprint was clicked; the OSM building is still being resolved. */
  showPending(pick) {
    this.state = { status: 'resolving', pick, polygons: [pick.part], center: pick.point, top: pick.top };
    this.busy = null;
    this.renderMedia();
    this.title.replaceChildren(h('span', { class: 'skeleton skeleton--title' }));
    this.sub.replaceChildren(h('span', { class: 'skeleton skeleton--line' }));
    this.renderAll();
    this.open();
    this.root.querySelector('.panel-scroll').scrollTop = 0;
  }

  showError(kind, retry) {
    if (!this.state) return;
    this.state.status = 'error';
    this.state.error = kind;
    this.state.retry = retry;
    this.title.textContent = kind === 'not-building' ? 'Not a building' : 'Couldn’t identify this building';
    this.sub.textContent =
      kind === 'not-building'
        ? 'OpenStreetMap has no building outline at this spot, so it can’t be owned.'
        : 'The building directory (OpenStreetMap) didn’t answer. Check your connection and try again.';
    this.renderAll();
  }

  /** The OSM building is known. */
  showBuilding(building, { tileTop } = {}) {
    const keepMedia = this.state?.key === building.key;
    this.state = {
      status: 'ready',
      key: building.key,
      building,
      polygons: building.polygons,
      center: building.center,
      top: tileTop,
      photo: keepMedia ? this.state.photo : null,
      address: keepMedia ? this.state.address : null,
      usd: this.state?.usd ?? null,
      tab: keepMedia ? this.state.tab : 'satellite',
    };
    this.busy = null;
    if (!keepMedia) this.renderMedia();
    this.renderHeadline();
    this.renderAll();
    this.open();
  }

  setAddress(key, address) {
    if (this.state?.key !== key) return;
    this.state.address = address;
    this.renderHeadline();
  }

  setPhoto(key, photo) {
    if (this.state?.key !== key || !photo) return;
    this.state.photo = photo;
    if (photo.exact) this.state.tab = 'photo';
    this.renderMedia();
  }

  setUsd(usd) {
    if (!this.state) return;
    this.state.usd = usd;
    this.renderFoot();
  }

  setBusy(stage) {
    this.busy = stage;
    this.renderFoot();
  }

  refresh() {
    if (this.state) this.renderAll();
  }

  /* ------------------------------------------------------------ render */

  renderAll() {
    this.renderStatus();
    this.renderOwner();
    this.renderMarket();
    this.renderFacts();
    this.renderLinks();
    this.renderFoot();
  }

  record() {
    return this.state?.key ? this.ctx.registry.state.buildings.get(this.state.key) : null;
  }

  tone() {
    const rec = this.record();
    if (!rec) return 'available';
    return rec.owner === this.ctx.wallet.address ? 'mine' : 'owned';
  }

  renderMedia() {
    const s = this.state;
    if (!s) return;
    const { map } = this.ctx.settings;
    const tabs = [{ id: 'satellite', label: 'Satellite', icon: 'satellite' }];
    if (s.photo) tabs.push({ id: 'photo', label: s.photo.exact ? 'Photo' : 'Nearby', icon: 'image' });
    const tab = tabs.some((t) => t.id === s.tab) ? s.tab : 'satellite';

    this.mediaTabs.replaceChildren(
      ...(tabs.length > 1
        ? tabs.map((t) =>
            h(
              'button',
              {
                class: `media-chip${t.id === tab ? ' is-active' : ''}`,
                role: 'tab',
                'aria-selected': String(t.id === tab),
                onclick: () => {
                  s.tab = t.id;
                  this.renderMedia();
                },
              },
              h('span', { svg: icon(t.icon, { size: 14 }) }),
              t.label,
            ),
          )
        : []),
    );

    const [lng, lat] = s.center;
    this.streetLink.href = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)},${lng.toFixed(6)}`;

    let node;
    if (tab === 'photo' && s.photo) {
      const img = h('img', { src: s.photo.url, alt: s.photo.title || 'Photo of the building', referrerpolicy: 'no-referrer', decoding: 'async' });
      img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
      img.addEventListener('error', () => {
        s.photo = null;
        s.tab = 'satellite';
        this.renderMedia();
      });
      node = h(
        'figure',
        { class: 'photo' },
        img,
        h(
          'figcaption',
          null,
          s.photo.exact ? '' : h('span', { class: 'photo-near' }, 'Nearby · ', s.photo.title || ''),
          h('a', { href: s.photo.link, target: '_blank', rel: 'noopener' }, s.photo.credit),
        ),
      );
    } else {
      node = satelliteView({
        template: map.satellite,
        maxZoom: map.satelliteMaxZoom,
        polygons: s.polygons,
        width: 400,
        height: 250,
        attribution: map.satelliteAttribution,
      });
      node.classList.add(`sat--${this.tone()}`);
    }
    for (const old of [...this.mediaStage.children]) {
      if (old.classList.contains('media-leave')) continue;
      old.classList.add('media-leave');
      setTimeout(() => old.remove(), 450);
    }
    node.classList.add('media-enter');
    this.mediaStage.append(node);
    requestAnimationFrame(() => node.classList.add('media-in'));
  }

  renderHeadline() {
    const s = this.state;
    if (!s?.building) return;
    const tags = s.building.tags;
    const addr = s.address;
    const named = buildingTitle(tags);
    this.title.textContent = named || addr?.street || addr?.name || this.ctx.kindLabel(tags);
    const [lng, lat] = s.center;
    const street = named && addr?.street && addr.street !== named ? addr.street : null;
    const where = [addr?.city || placeLabel(lat, lng), addr?.country].filter((v, i, a) => v && a.indexOf(v) === i).join(', ');
    this.sub.replaceChildren(
      ...[street, where].filter(Boolean).flatMap((part, i) => (i ? [h('span', { class: 'dot-sep' }, '·'), part] : [part])),
    );
    if (!this.sub.textContent) this.sub.textContent = fmtCoord(lat, lng);
  }

  renderStatus() {
    const s = this.state;
    const tone = s?.status === 'ready' ? this.tone() : s?.status;
    const label = { resolving: 'Locating', error: 'Unavailable', available: 'Available', owned: 'Owned', mine: 'Yours' }[tone] || '';
    this.statusPill.className = `status-pill status-pill--${tone}`;
    this.statusPill.replaceChildren(h('i'), label);
    this.shareBtn.disabled = s?.status !== 'ready';
    this.root.dataset.tone = tone || '';
  }

  renderOwner() {
    const s = this.state;
    if (!s || s.status === 'resolving') {
      this.owner.className = 'owner-card owner-card--loading';
      this.owner.replaceChildren(h('span', { class: 'skeleton skeleton--avatar' }), h('div', { class: 'grow' }, h('span', { class: 'skeleton skeleton--line' }), h('span', { class: 'skeleton skeleton--line short' })));
      return;
    }
    if (s.status === 'error') {
      this.owner.className = 'owner-card owner-card--empty';
      this.owner.replaceChildren();
      this.owner.hidden = true;
      return;
    }
    this.owner.hidden = false;
    const rec = this.record();
    const { registry, settings, wallet } = this.ctx;
    if (!rec) {
      this.owner.className = 'owner-card owner-card--empty';
      this.owner.replaceChildren(
        h('span', { class: 'avatar avatar--empty', svg: icon('sparkle', { size: 14 }) }),
        h('div', { class: 'grow' }, h('div', { class: 'owner-name' }, 'No owner yet'), h('div', { class: 'owner-meta' }, 'Be the first person to own this building.')),
      );
      return;
    }
    const mine = rec.owner === wallet.address;
    const holder = registry.state.owners.get(rec.owner);
    const acquired =
      rec.acquired === 'hold'
        ? `Taken with holder credit ${timeAgo(rec.time)} · ${fmtSol(rec.price)} SOL value`
        : rec.acquired === 'sale'
          ? `Bought from another owner ${timeAgo(rec.time)} for ${fmtSol(rec.price)} SOL`
          : `Bought ${timeAgo(rec.time)} for ${fmtSol(rec.price)} SOL`;
    const txLink = rec.seed || !settings.live
      ? null
      : h('a', { class: 'owner-tx', href: settings.explorer.tx(rec.sig), target: '_blank', rel: 'noopener', title: 'View transaction' }, 'Tx', h('span', { svg: icon('external', { size: 12 }) }));
    this.owner.className = `owner-card owner-card--${mine ? 'mine' : 'owned'}`;
    this.owner.replaceChildren(
      h('button', { class: 'owner-avatar-btn', 'aria-label': 'View owner', onclick: () => this.ctx.onOwner(rec.owner) }, avatar(rec.owner, 36)),
      h(
        'div',
        { class: 'grow' },
        h(
          'div',
          { class: 'owner-name' },
          h('button', { class: 'link-btn mono', onclick: () => this.ctx.onOwner(rec.owner) }, mine ? 'You' : shortAddr(rec.owner, 4, 4)),
          h('button', {
            class: 'mini-btn',
            title: 'Copy address',
            'aria-label': 'Copy owner address',
            svg: icon('copy', { size: 13 }),
            onclick: async () => {
              await copyText(rec.owner);
              this.ctx.toast({ title: 'Address copied', tone: 'success', duration: 1800 });
            },
          }),
          txLink,
        ),
        h('div', { class: 'owner-meta' }, `Owns ${fmtInt(holder?.count || 1)} building${holder?.count === 1 ? '' : 's'} · Rank #${holder?.rank || '—'}`),
        h('div', { class: 'owner-meta owner-meta--dim' }, acquired),
      ),
    );
  }

  renderFacts() {
    const s = this.state;
    if (!s || s.status !== 'ready') {
      this.facts.replaceChildren(
        ...(s?.status === 'resolving'
          ? [0, 1, 2, 3].map(() => h('div', { class: 'fact' }, h('dt', null, h('span', { class: 'skeleton skeleton--tiny' })), h('dd', null, h('span', { class: 'skeleton skeleton--line short' }))))
          : []),
      );
      return;
    }
    const f = buildingFacts(s.building, s.top);
    const items = [
      ['Height', f.height ? `${f.heightExact ? '' : '≈ '}${fmtInt(f.height)} m` : '—'],
      ['Floors', f.levels ? fmtInt(f.levels) : '—'],
      ['Footprint', f.area ? `${fmtInt(f.area)} m²` : '—'],
      ['Type', f.kind],
    ];
    if (f.built) items.push(['Built', f.built]);
    if (f.architect) items.push(['Architect', f.architect]);
    items.push(['Registry ID', h('button', { class: 'link-btn mono', title: 'Copy building ID', onclick: () => copyText(s.key).then(() => this.ctx.toast({ title: 'Building ID copied', tone: 'success', duration: 1600 })) }, s.key)]);
    this.facts.replaceChildren(...items.map(([k, v]) => h('div', { class: 'fact' }, h('dt', null, k), h('dd', null, v))));
  }

  renderLinks() {
    const s = this.state;
    if (!s || s.status !== 'ready') {
      this.links.replaceChildren();
      return;
    }
    const [lng, lat] = s.center;
    const osmUrl = `https://www.openstreetmap.org/${s.building.type}/${s.building.id}`;
    const ext = (label, href) => h('a', { href, target: '_blank', rel: 'noopener' }, label, h('span', { svg: icon('external', { size: 12 }) }));
    this.links.replaceChildren(
      ext('OpenStreetMap', osmUrl),
      ext('Google Maps', `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`),
      h('span', { class: 'coords mono' }, fmtCoord(lat, lng)),
    );
  }

  price() {
    return this.state?.building ? this.ctx.priceFor(this.state.building) : null;
  }

  /** Billboard + offers, between the owner card and the facts. */
  renderMarket() {
    const s = this.state;
    const rec = s?.status === 'ready' ? this.record() : null;
    const nodes = [];
    if (rec?.sign?.text) {
      nodes.push(
        h('div', { class: 'billboard', style: { '--sign': SIGN_COLORS[rec.sign.color] || SIGN_COLORS[0] } }, h('span', { class: 'billboard-label' }, 'Billboard'), h('p', null, rec.sign.text)),
      );
    }
    if (rec) {
      const me = this.ctx.wallet.address;
      const offers = this.ctx.openOffersFor(s.key);
      const mine = rec.owner === me;
      if (offers.length && (mine || offers.some((o) => o.buyer === me))) {
        nodes.push(
          h(
            'div',
            { class: 'offers' },
            h('div', { class: 'offers-head' }, h('b', null, mine ? `Offers (${offers.length})` : 'Open offers'), mine ? h('small', null, `You receive the price minus a ${this.ctx.settings.feeBps / 100}% fee`) : null),
            offers.slice(0, 6).map((o) =>
              h(
                'div',
                { class: 'offer' },
                avatar(o.buyer, 24),
                h('div', { class: 'grow' }, h('b', { class: 'mono' }, `${fmtSol(o.price)} SOL`), h('small', null, `${o.buyer === me ? 'You' : shortAddr(o.buyer)} · ${timeAgo(o.time)}`)),
                mine && !this.busy
                  ? h('button', { class: 'btn btn--accent btn--sm', onclick: () => this.ctx.onAccept(o) }, 'Accept')
                  : o.buyer === me && !this.busy
                    ? h('button', { class: 'btn btn--ghost btn--sm', onclick: () => this.ctx.onCancelOffer(o) }, 'Cancel')
                    : null,
              ),
            ),
          ),
        );
      } else if (offers.length && !mine) {
        nodes.push(h('p', { class: 'foot-note offers-count' }, `${offers.length} open offer${offers.length === 1 ? '' : 's'} · best ${fmtSol(offers[0].price)} SOL`));
      }
    }
    this.market.replaceChildren(...nodes);
  }

  renderFoot() {
    const s = this.state;
    const { wallet, settings } = this.ctx;
    const quote = this.price();
    const usd = s?.usd && quote ? (quote.lamports / 1e9) * s.usd : null;
    const fine = h(
      'p',
      { class: 'fine' },
      h('span', { svg: icon('shield', { size: 13 }) }),
      settings.live ? 'Ownership is recorded on Solana. ' : 'Demo mode: nothing real is spent. ',
      h('button', { class: 'link-btn', onclick: () => this.ctx.onHelp() }, 'How it works'),
    );
    const nodes = [];

    if (!s || s.status === 'resolving') {
      nodes.push(h('button', { class: 'btn btn--primary btn--block', disabled: true }, h('span', { class: 'spinner' }), 'Locating building…'));
    } else if (s.status === 'error') {
      if (s.retry) nodes.push(h('button', { class: 'btn btn--ghost btn--block', onclick: () => s.retry() }, h('span', { svg: icon('refresh', { size: 16 }) }), 'Try again'));
    } else if (this.busy) {
      nodes.push(h('button', { class: 'btn btn--primary btn--block is-busy', disabled: true }, h('span', { class: 'spinner' }), STAGES[this.busy] || 'Working…'));
    } else {
      const rec = this.record();
      if (rec && rec.owner === wallet.address) {
        nodes.push(
          h('div', { class: 'owned-banner owned-banner--mine' }, h('span', { svg: icon('sparkle', { size: 16 }) }), 'You own this building'),
          this.signEditor(rec),
          h('button', { class: 'btn btn--ghost btn--block', onclick: () => this.ctx.onShare() }, h('span', { svg: icon('share', { size: 16 }) }), 'Share it'),
        );
      } else if (rec) {
        nodes.push(this.offerForm(rec));
      } else {
        nodes.push(
          h(
            'div',
            { class: 'price-row' },
            h('div', null, h('small', null, 'Price'), h('b', { class: 'price-big' }, `${fmtSol(quote.lamports)} SOL`), usd ? h('span', { class: 'price-usd' }, `≈ ${fmtUsd(usd)}`) : null),
            h('div', { class: 'price-factors' }, quote.factors.length ? quote.factors.map((f) => h('span', { class: 'chip chip--xs', title: `×${f.x.toFixed(1)}` }, f.label)) : h('span', { class: 'chip chip--xs' }, 'Quiet spot')),
          ),
        );
        if (!wallet.exists) {
          nodes.push(h('button', { class: 'btn btn--primary btn--block', onclick: () => this.ctx.onConnect() }, h('span', { svg: icon('wallet', { size: 16 }) }), 'Get a wallet to own this'));
        } else {
          const need = quote.lamports + 20_000 - (wallet.balance ?? 0);
          const credit = this.ctx.creditLeft();
          if (credit >= quote.lamports) {
            nodes.push(h('button', { class: 'btn btn--accent btn--block', onclick: () => this.ctx.onAcquire('hold') }, h('span', { svg: icon('gift', { size: 16 }) }), `Use $${settings.memecoinView.symbol} credit`, h('span', { class: 'btn-sub' }, `${fmtSol(credit)} left`)));
          }
          if (need > 0) {
            nodes.push(h('button', { class: `btn btn--${credit >= quote.lamports ? 'ghost' : 'primary'} btn--block`, onclick: () => this.ctx.onDeposit(need) }, h('span', { svg: icon('plus', { size: 16 }) }), `Deposit to buy · ${fmtSol(quote.lamports)} SOL`));
          } else {
            nodes.push(h('button', { class: `btn btn--${credit >= quote.lamports ? 'ghost' : 'primary'} btn--block`, onclick: () => this.ctx.onAcquire('buy') }, `Buy for ${fmtSol(quote.lamports)} SOL`));
          }
        }
      }
    }
    nodes.push(fine);
    this.foot.replaceChildren(...nodes.filter(Boolean));
  }

  offerForm(rec) {
    const { wallet, settings } = this.ctx;
    const me = wallet.address;
    const mine = this.ctx.openOffersFor(rec.key).find((o) => o.buyer === me);
    const suggested = Math.max(rec.price * 1.25, this.price()?.lamports || 0, 1_000_000);
    const input = h('input', { class: 'field-input', type: 'number', min: '0.001', step: '0.001', value: (suggested / 1e9).toFixed(3), 'aria-label': 'Offer in SOL' });
    const submit = () => {
      const lamports = Math.round(Number(input.value) * 1e9);
      if (!(lamports >= 1_000_000)) return this.ctx.toast({ title: 'Offers start at 0.001 SOL', tone: 'error' });
      this.ctx.onOffer(lamports);
    };
    return h(
      'div',
      { class: 'offer-form' },
      h('div', { class: 'owned-banner' }, h('span', { svg: icon('building', { size: 16 }) }), 'Owned by ', h('span', { class: 'mono' }, shortAddr(rec.owner))),
      mine ? h('p', { class: 'foot-note' }, `Your offer: ${fmtSol(mine.price)} SOL — keep that much in your wallet until the owner decides.`) : null,
      wallet.exists
        ? h('div', { class: 'field-row' }, input, h('span', { class: 'field-unit' }, 'SOL'), h('button', { class: 'btn btn--primary btn--sm', onclick: submit }, mine ? 'Offer again' : 'Make offer'))
        : h('button', { class: 'btn btn--primary btn--block', onclick: () => this.ctx.onConnect() }, 'Get a wallet to make an offer'),
      h('p', { class: 'foot-note' }, `Last price ${fmtSol(rec.price)} SOL. If the owner accepts, the swap happens instantly on-chain (${settings.feeBps / 100}% market fee).`),
    );
  }

  signEditor(rec) {
    const text = h('input', { class: 'field-input', maxlength: '60', placeholder: 'Put up a sign: your name, brand, $TICKER…', value: rec.sign?.text || '' });
    let color = rec.sign?.color ?? 0;
    const swatches = h(
      'div',
      { class: 'swatches' },
      SIGN_COLORS.map((c, i) =>
        h('button', {
          class: `swatch${i === color ? ' is-active' : ''}`,
          style: { background: c },
          'aria-label': `Color ${i + 1}`,
          onclick: (e) => {
            color = i;
            swatches.querySelectorAll('.swatch').forEach((el) => el.classList.remove('is-active'));
            e.currentTarget.classList.add('is-active');
          },
        }),
      ),
    );
    return h(
      'details',
      { class: 'sign-editor' },
      h('summary', null, h('span', { svg: icon('sparkle', { size: 15 }) }), rec.sign ? 'Edit your billboard' : 'Put up a billboard'),
      h('p', { class: 'foot-note' }, 'Your sign glows on the map for everyone who flies by — advertise anything.'),
      text,
      swatches,
      h('button', { class: 'btn btn--primary btn--block', onclick: () => this.ctx.onSign({ text: text.value.trim(), color }) }, 'Save billboard'),
    );
  }
}
