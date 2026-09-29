// Loader, hero, stats, map controls, hints, status pill and info modals.
import { FEATURED } from '../cities.js';
import { avatar, copyText, countTo, fmtInt, fmtSol, h, shortAddr, timeAgo } from '../util.js';
import { BRAND_MARK, icon } from './icons.js';
import { openModal } from './feedback.js';

/* ----------------------------------------------------------------- loader */

export function createLoader(root) {
  const bar = root.querySelector('.loader-bar i');
  let progress = 0.08;
  let target = 0.08;
  let done = false;
  const tick = () => {
    if (done) return;
    progress += (target - progress) * 0.08;
    if (bar) bar.style.transform = `scaleX(${progress.toFixed(3)})`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return {
    to(p) {
      target = Math.max(target, Math.min(1, p));
    },
    finish() {
      if (done) return;
      target = 1;
      if (bar) bar.style.transform = 'scaleX(1)';
      setTimeout(() => {
        done = true;
        root.classList.add('is-done');
        document.getElementById('app')?.classList.remove('is-booting');
        setTimeout(() => root.remove(), 1100);
      }, 260);
    },
  };
}

/* ------------------------------------------------------------------- hero */

export class Hero {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.stats = {};
    this.build();
  }

  build() {
    const { settings } = this.ctx;
    const live = settings.live;
    const net = settings.cluster === 'mainnet-beta' ? 'Mainnet' : settings.cluster;
    const statEl = (key, label) => {
      const value = h('b', { 'data-value': '0' }, '0');
      this.stats[key] = value;
      return h('div', { class: 'hero-stat' }, value, h('span', null, label));
    };
    this.root.replaceChildren(
      h(
        'div',
        { class: 'hero-inner' },
        h('div', { class: `eyebrow-pill ${live ? 'is-live' : 'is-demo'}` }, h('i'), live ? `Live on Solana · ${net}` : 'Demo mode · simulated purchases'),
        h('h1', { class: 'hero-title' }, h('span', { class: 'line' }, 'Every building on Earth.'), h('span', { class: 'line grad' }, 'Own it on Solana.')),
        h(
          'p',
          { class: 'hero-sub' },
          'Tap any building in the world, see who owns it, and make it yours with SOL. Hold more than ',
          h('b', null, `${settings.freeClaimMinSol} SOL`),
          ' and your first building is free.',
        ),
        h(
          'div',
          { class: 'hero-cta' },
          h('button', { class: 'btn btn--primary btn--lg', onclick: () => this.ctx.onExplore() }, 'Start exploring', h('span', { svg: icon('arrowRight', { size: 18 }) })),
          h('button', { class: 'btn btn--ghost btn--lg', onclick: () => this.ctx.onConnect() }, h('span', { svg: icon('wallet', { size: 18 }) }), 'Connect wallet'),
        ),
        h('div', { class: 'hero-stats' }, statEl('buildings', 'buildings owned'), statEl('owners', 'landowners'), statEl('volume', 'SOL volume')),
        h(
          'div',
          { class: 'hero-cities' },
          h('span', null, 'Jump to'),
          FEATURED.slice(0, 6).map((p) => h('button', { class: 'chip', onclick: () => this.ctx.onPreset(p) }, p.name)),
        ),
      ),
    );
  }

  update(totals) {
    countTo(this.stats.buildings, totals.buildings);
    countTo(this.stats.owners, totals.owners);
    countTo(this.stats.volume, totals.volume / 1e9, { format: (v) => (v >= 100 ? fmtInt(v) : v.toFixed(v >= 10 ? 1 : 2)) });
  }

  get visible() {
    return !this.root.classList.contains('is-hidden');
  }

  hide() {
    if (!this.visible) return;
    this.root.classList.add('is-hidden');
    document.getElementById('app').classList.add('is-exploring');
    this.ctx.onHidden?.();
  }
}

/* ------------------------------------------------------------------ stats */

export class Stats {
  constructor(root) {
    this.root = root;
    const item = (label) => {
      const b = h('b', { 'data-value': '0' }, '0');
      return [b, h('div', { class: 'stats-item' }, b, h('span', null, label))];
    };
    const [b1, i1] = item('owned');
    const [b2, i2] = item('landowners');
    const [b3, i3] = item('SOL volume');
    this.values = { buildings: b1, owners: b2, volume: b3 };
    root.replaceChildren(i1, h('i', { class: 'stats-sep' }), i2, h('i', { class: 'stats-sep' }), i3);
  }

  update(totals) {
    countTo(this.values.buildings, totals.buildings);
    countTo(this.values.owners, totals.owners);
    countTo(this.values.volume, totals.volume / 1e9, { format: (v) => (v >= 100 ? fmtInt(v) : v.toFixed(v >= 10 ? 1 : 2)) });
  }
}

/* --------------------------------------------------------------- controls */

export function createControls(root, mapc) {
  const compassIcon = h('span', { class: 'compass', svg: icon('compass', { size: 18 }) });
  const btn = (label, content, onclick, extra = {}) => h('button', { class: 'ctrl', 'aria-label': label, title: label, onclick, ...extra }, content);
  const threeD = btn('Toggle 3D', h('span', { class: 'ctrl-text' }, '3D'), () => {
    const on = mapc.toggle3d();
    threeD.classList.toggle('is-active', on);
  });
  root.replaceChildren(
    h('div', { class: 'ctrl-group' }, btn('Zoom in', h('span', { svg: icon('plus') }), () => mapc.zoomBy(1)), btn('Zoom out', h('span', { svg: icon('minus') }), () => mapc.zoomBy(-1))),
    h('div', { class: 'ctrl-group' }, btn('Reset north', compassIcon, () => mapc.resetNorth()), threeD, btn('Whole world', h('span', { svg: icon('globe') }), () => mapc.goGlobe())),
  );
  mapc.on('rotate', (bearing) => {
    compassIcon.style.transform = `rotate(${-bearing}deg)`;
  });
  mapc.map.on('pitchend', () => threeD.classList.toggle('is-active', mapc.map.getPitch() > 5));
  threeD.classList.toggle('is-active', mapc.map.getPitch() > 5);
}

/* --------------------------------------------------------------- net pill */

export function renderNetPill(root, { settings, registry }) {
  const s = registry.status;
  const net = settings.cluster === 'mainnet-beta' ? 'Mainnet' : settings.cluster[0].toUpperCase() + settings.cluster.slice(1);
  let tone = 'ok';
  let label = `${net} · Live`;
  let title = `Registry ${registry.address}. Ownership is read straight from Solana.`;
  if (!settings.live) {
    tone = 'demo';
    label = 'Demo';
    title = 'Demo mode: purchases are simulated in this browser.';
  } else if (!s.ok) {
    tone = 'bad';
    label = `${net} · Reconnecting`;
    title = `Can’t reach Solana RPC right now (${s.error || 'unknown error'}). Retrying automatically.`;
  } else if (!s.lastSync) {
    tone = 'wait';
    label = `${net} · Syncing`;
  }
  root.className = `net-pill net-pill--${tone}`;
  root.title = title;
  root.replaceChildren(h('i'), h('span', null, label));
}

/* ------------------------------------------------------------------ modals */

export function openHelp(ctx) {
  const { settings, registry } = ctx;
  const step = (n, title, body) => h('li', { class: 'step' }, h('span', { class: 'step-n' }, n), h('div', null, h('b', null, title), h('p', null, body)));
  const priceNow = fmtSol(ctx.currentPrice());
  openModal({
    eyebrow: 'Solworld',
    title: 'How it works',
    size: 'md',
    content: h(
      'div',
      { class: 'help' },
      h(
        'ol',
        { class: 'steps' },
        step('1', 'Find any building on Earth', 'Search a city or fly around the globe. Every building mapped on OpenStreetMap — hundreds of millions of them — is on Solworld.'),
        step('2', `Buy it for ${priceNow} SOL`, 'Tap a building and approve one transaction in your wallet. It’s yours the moment it confirms, and everyone sees your address on it.'),
        step('3', `Or claim one free`, `If your wallet holds more than ${settings.freeClaimMinSol} SOL, your first building costs nothing but the network fee (about 0.00001 SOL).`),
      ),
      h(
        'div',
        { class: 'help-grid' },
        h('div', { class: 'help-card' }, h('span', { svg: icon('shield', { size: 18 }) }), h('b', null, 'On-chain, no middleman'), h('p', null, 'There’s no Solworld database. Every purchase is a Solana transaction, and this page rebuilds the map of owners from the chain. Anyone can verify it.')),
        h('div', { class: 'help-card' }, h('span', { svg: icon('trophy', { size: 18 }) }), h('b', null, 'First come, first served'), h('p', null, 'Each building has exactly one owner. If two people buy the same building at the same moment, the first transaction on-chain wins and the other payment is refundable.')),
      ),
      settings.live
        ? h(
            'div',
            { class: 'help-verify' },
            h('span', null, 'Registry'),
            h('a', { class: 'mono', href: settings.explorer.account(registry.address), target: '_blank', rel: 'noopener' }, shortAddr(registry.address, 6, 6)),
            h('span', null, 'Treasury'),
            h('a', { class: 'mono', href: settings.explorer.account(settings.treasury), target: '_blank', rel: 'noopener' }, shortAddr(settings.treasury, 6, 6)),
          )
        : h('p', { class: 'help-demo' }, 'This site is in demo mode: buying and claiming are simulated in your browser so you can try everything without spending SOL.'),
      h(
        'p',
        { class: 'modal-fine' },
        'Solworld buildings are virtual collectibles in a game. Owning one gives no rights to the real property, and Solworld isn’t affiliated with the buildings, their owners or tenants. Purchases are final and are not an investment. Map data © OpenStreetMap contributors.',
      ),
      h('button', { class: 'link-btn modal-link', onclick: () => ctx.onOperator() }, 'Operator & refunds'),
    ),
    actions: [{ label: 'Got it', kind: 'primary' }],
  });
}

const CONSENT_KEY = 'solworld:consent:v1';

/** Shown once before the first purchase. Resolves true if accepted. */
export function ensureConsent(ctx) {
  if (ctx.storage.get(CONSENT_KEY)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let accepted = false;
    openModal({
      eyebrow: 'Before your first building',
      title: 'A quick heads-up',
      size: 'sm',
      content: h(
        'ul',
        { class: 'consent' },
        h('li', null, h('span', { svg: icon('building', { size: 16 }) }), 'Solworld buildings are virtual collectibles. They give no rights to the real property.'),
        h('li', null, h('span', { svg: icon('shield', { size: 16 }) }), 'Every purchase is a Solana transaction you approve in your own wallet. Purchases are final.'),
        h('li', null, h('span', { svg: icon('info', { size: 16 }) }), 'This is a game, not an investment. Only spend what you’re happy to spend on fun.'),
      ),
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'I understand',
          kind: 'primary',
          onClick: (close) => {
            accepted = true;
            ctx.storage.set(CONSENT_KEY, Date.now());
            close();
          },
        },
      ],
      onClose: () => resolve(accepted),
    });
  });
}

export function openOperator(ctx) {
  const { settings, registry } = ctx;
  const state = registry.state;
  const refundable = state.voids.filter((v) => v.paid > 0);
  const reasons = { taken: 'Building already owned', underpaid: 'Paid less than the price', 'claim-used': 'Second free claim', balance: 'Balance under the free-claim minimum' };
  const row = (k, v) => h('div', { class: 'op-row' }, h('span', null, k), h('b', null, v));
  openModal({
    eyebrow: settings.live ? 'Live' : 'Demo',
    title: 'Operator',
    size: 'lg',
    content: h(
      'div',
      { class: 'operator' },
      h(
        'div',
        { class: 'op-grid' },
        row('Revenue', `${fmtSol(state.totals.volume)} SOL`),
        row('Buildings owned', fmtInt(state.totals.buildings)),
        row('Paid purchases', fmtInt(state.totals.buys)),
        row('Free claims', fmtInt(state.totals.claims)),
        row('Price', settings.prices.map((p) => `${p.sol} SOL${p.from ? ` from ${new Date(p.from * 1000).toISOString().slice(0, 10)}` : ''}`).join(' → ')),
        row('Free claim', `> ${settings.freeClaimMinSol} SOL held`),
      ),
      settings.live
        ? h(
            'div',
            { class: 'op-keys' },
            h('div', null, h('span', null, 'Treasury'), h('code', null, settings.treasury)),
            h('div', null, h('span', null, 'Registry reference'), h('code', null, registry.address)),
          )
        : null,
      h('h3', { class: 'op-h' }, `Refunds owed (${refundable.length})`),
      refundable.length
        ? h(
            'div',
            { class: 'op-refunds' },
            refundable.map((v) =>
              h(
                'div',
                { class: 'op-refund' },
                avatar(v.buyer, 26),
                h('div', { class: 'grow' }, h('div', { class: 'mono' }, shortAddr(v.buyer, 6, 6)), h('small', null, `${reasons[v.reason] || v.reason} · ${v.key} · ${timeAgo(v.time)}`)),
                h('b', { class: 'mono' }, `${fmtSol(v.paid)} SOL`),
                h('button', { class: 'mini-btn', title: 'Copy address', svg: icon('copy', { size: 13 }), onclick: () => copyText(v.buyer).then(() => ctx.toast({ title: 'Address copied', tone: 'success', duration: 1500 })) }),
                settings.live && !String(v.sig).startsWith('demo') ? h('a', { class: 'mini-btn', href: settings.explorer.tx(v.sig), target: '_blank', rel: 'noopener', title: 'Transaction', svg: icon('external', { size: 13 }) }) : null,
              ),
            ),
          )
        : h('p', { class: 'op-empty' }, 'Nothing to refund. When two people pay for the same building, the second payment shows up here so you can send it back from the treasury wallet.'),
      h('p', { class: 'modal-fine' }, 'To change the price or treasury, edit config.js and redeploy. Add new prices with a start date instead of editing old ones, so past purchases stay valid.'),
    ),
    actions: [{ label: 'Close', kind: 'ghost' }],
  });
}

export function renderFatal(root, fatal) {
  root.replaceChildren(
    h(
      'div',
      { class: 'fatal' },
      h('div', { class: 'fatal-card' }, h('div', { class: 'brand-mark', svg: BRAND_MARK }), h('span', { class: 'fatal-icon', svg: icon('alert', { size: 28 }) }), h('h1', null, fatal.title), h('p', null, fatal.body)),
    ),
  );
}
