// Loader, hero, stats, map controls, hints, status pill and info modals.
import { FEATURED } from '../cities.js';
import { tokenPriceAt } from '../registry.js';
import { avatar, countTo, fmtInt, fmtSol, h, shortAddr, timeAgo, who } from '../util.js';
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
          'Tap any building in the world, see who owns it, and make it yours with SOL — from ',
          h('b', null, '0.001 SOL'),
          ' for a quiet corner to ',
          h('b', null, '25 SOL'),
          ' for a world-famous icon. Sell to the highest offer, put up your billboard',
          settings.memecoinView ? [', or use your ', h('b', null, `$${settings.memecoinView.symbol}`), ' holdings as credit.'] : '.',
        ),
        h(
          'div',
          { class: 'hero-cta' },
          h('button', { class: 'btn btn--primary btn--lg', onclick: () => this.ctx.onExplore() }, 'Start exploring', h('span', { svg: icon('arrowRight', { size: 18 }) })),
          h('button', { class: 'btn btn--ghost btn--lg', onclick: () => this.ctx.onConnect() }, h('span', { svg: icon('wallet', { size: 18 }) }), 'Get a wallet'),
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
  const coin = settings.memecoinView;
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
        step('1', 'Find any building on Earth', 'Search a city or fly around the globe. Every building mapped on OpenStreetMap — hundreds of millions — is on Solworld. Zoom right in and the city lights up.'),
        step('2', 'Get your Solworld wallet', 'We make one for you in this browser (only you hold its key). Deposit SOL from Phantom, an exchange or a QR scan, and back up the key.'),
        step('3', 'Buy it', 'Quiet corners start at 0.001 SOL; busy downtowns, tall towers and world-famous icons cost the most, up to 25 SOL. One tap, no pop-ups.'),
        step('4', 'Use it, sell it', `Put up a glowing billboard everyone sees. Other players send offers; accept one and the swap happens on-chain instantly (${settings.feeBps / 100}% market fee).`),
        coin ? step('5', `Hold $${coin.symbol}? It’s credit`, `Paste the wallet holding your $${coin.symbol} and sign once to prove it’s yours. Its value in SOL becomes credit you spend on buildings.`) : null,
      ),
      h(
        'div',
        { class: 'help-grid' },
        h('div', { class: 'help-card' }, h('span', { svg: icon('shield', { size: 18 }) }), h('b', null, 'On-chain, no middleman'), h('p', null, 'There’s no Solworld database. Every purchase, offer and sale is a Solana transaction, and this page rebuilds the map of owners from the chain. Anyone can verify it.')),
        h('div', { class: 'help-card' }, h('span', { svg: icon('trophy', { size: 18 }) }), h('b', null, 'Safe trades'), h('p', null, 'An offer is a pre-signed swap. When the owner accepts, payment and ownership move in one transaction, and every other offer on that building expires automatically.')),
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
        : h('p', { class: 'help-demo' }, 'This site is in demo mode: buying, offers and sales are simulated in your browser with pretend SOL.'),
      h(
        'p',
        { class: 'modal-fine' },
        'Solworld buildings are virtual collectibles in a game. Owning one gives no rights to the real property, and Solworld isn’t affiliated with the buildings, their owners or tenants. Purchases are final and are not an investment. Map data © OpenStreetMap contributors.',
      ),
      h('button', { class: 'link-btn modal-link', onclick: () => ctx.onOperator() }, 'Operator tools'),
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
  const reasons = { taken: 'Building already owned', underpaid: 'Paid less than the price', revoked: 'Revoked by you', 'not-owner': 'Seller no longer owned it', 'bad-sale': 'Malformed sale', unlinked: 'Holder not linked', 'no-credit': 'Not enough credit' };
  const owed = state.voids.filter((v) => v.paid > (state.refunded.get(v.sig) || 0) && v.reason !== 'not-owner' && v.reason !== 'bad-sale');
  const row = (k, v) => h('div', { class: 'op-row' }, h('span', null, k), h('b', null, v));
  const auditBox = h('div', { class: 'op-refunds' }, h('p', { class: 'op-empty' }, 'Checks every purchase against today’s price formula and flags ones that paid far less (someone crafting cheap transactions by hand).'));
  const signs = [...state.buildings.values()].filter((b) => b.sign?.text).sort((a, b) => b.sign.time - a.sign.time);
  const connected = () => ctx.operatorReady();

  const refundRow = (v) =>
    h(
      'div',
      { class: 'op-refund' },
      avatar(v.buyer || v.actor, 26),
      h('div', { class: 'grow' }, h('div', { class: 'mono' }, who(v.buyer || v.actor, 6, 6)), h('small', null, `${reasons[v.reason] || v.reason} · ${v.key || ''} · ${timeAgo(v.time)}`)),
      h('b', { class: 'mono' }, `${fmtSol(v.paid - (state.refunded.get(v.sig) || 0))} SOL`),
      settings.live ? h('button', { class: 'btn btn--ghost btn--sm', onclick: (e) => ctx.onRefund(v, e.currentTarget) }, 'Refund') : null,
    );

  // Meme coin: entered here, saved on-chain (signed by the treasury wallet).
  const coin = settings.memecoinView;
  const perMillion = (c) => (c ? (tokenPriceAt(c.prices, Math.floor(Date.now() / 1000)) * 1e6) / 1e9 : null);
  const mintIn = h('input', { class: 'field-input', placeholder: 'Token mint address', spellcheck: 'false', autocomplete: 'off', value: coin?.mint || '' });
  const symIn = h('input', { class: 'field-input', placeholder: 'Ticker (e.g. SOLW)', maxlength: '12', value: coin?.symbol || '' });
  const priceIn = h('input', { class: 'field-input', type: 'number', min: '0', step: 'any', placeholder: 'SOL', value: coin ? String(+perMillion(coin).toPrecision(6)) : '' });
  const coinMsg = h('p', { class: 'field-error' });
  const coinHint = h('p', { class: 'modal-fine' });
  const updateHint = () => {
    const v = Number(priceIn.value);
    coinHint.textContent = v > 0 ? `Example: a holder with 1,000,000 $${symIn.value || 'TOKEN'} gets ${fmtSol(v * 1e9)} SOL to spend on buildings.` : 'Holders get building credit worth what their tokens are worth in SOL.';
  };
  priceIn.addEventListener('input', updateHint);
  symIn.addEventListener('input', updateHint);
  updateHint();
  const coinForm = h(
    'div',
    { class: 'form op-coin' },
    coin ? h('div', { class: 'holder-preview' }, h('b', null, `$${coin.symbol} is active`), ` · 1,000,000 tokens = ${fmtSol(perMillion(coin) * 1e9)} SOL of credit`) : h('p', { class: 'op-empty' }, 'No coin set yet. Holders can’t use credit until you add one.'),
    h('label', null, 'Token mint', mintIn),
    h('div', { class: 'field-row' }, h('label', { class: 'grow' }, 'Ticker', symIn), h('label', { class: 'grow' }, 'Value of 1,000,000 tokens', h('div', { class: 'field-row' }, priceIn, h('span', { class: 'field-unit' }, 'SOL')))),
    coinHint,
    coinMsg,
    h(
      'div',
      { class: 'field-row' },
      h(
        'button',
        {
          class: 'btn btn--ghost btn--sm',
          onclick: async (e) => {
            const btn = e.currentTarget;
            coinMsg.textContent = '';
            btn.setAttribute('disabled', '');
            try {
              const m = await ctx.coinMarket(mintIn.value.trim());
              priceIn.value = String(+(m.sol * 1e6).toPrecision(6));
              if (!symIn.value) symIn.value = m.symbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
              updateHint();
            } catch (err) {
              coinMsg.textContent = err.message;
            } finally {
              btn.removeAttribute('disabled');
            }
          },
        },
        'Use current market price',
      ),
      h(
        'button',
        {
          class: 'btn btn--primary btn--sm',
          onclick: (e) => {
            coinMsg.textContent = '';
            const sol = Number(priceIn.value) / 1e6;
            if (!(sol > 0)) return void (coinMsg.textContent = 'Enter what 1,000,000 tokens are worth in SOL.');
            ctx.onSetCoin({ mint: mintIn.value.trim(), symbol: symIn.value.trim().replace(/^\$/, ''), sol }, e.currentTarget);
          },
        },
        coin ? 'Update coin' : 'Save coin',
      ),
    ),
  );

  // Google Map Tiles API key for the realistic 3D close-ups.
  const keyIn = h('input', { class: 'field-input', placeholder: 'Google Maps API key (starts with AIza…)', spellcheck: 'false', autocomplete: 'off' });
  const keyReport = h('div', { class: 'key-report' });
  const keyForm = h(
    'div',
    { class: 'form op-coin' },
    ctx.key3dActive() ? h('div', { class: 'holder-preview' }, h('b', null, 'Realistic 3D is on'), ' · zoom into any city to see it') : h('p', { class: 'op-empty' }, 'Off. Add a Google key to show real 3D buildings with real photo textures when people zoom in.'),
    keyIn,
    h('p', { class: 'modal-fine' }, 'In Google Cloud: create a project, enable the “Map Tiles API” (3D) and “Maps JavaScript API” (walking the street), create an API key, and restrict it to your site’s address (Websites). The key becomes public, so the restriction matters.'),
    h(
      'div',
      { class: 'field-row' },
      h('button', { class: 'btn btn--primary btn--sm', onclick: (e) => keyIn.value.trim() && ctx.onSetKey3d(keyIn.value.trim(), e.currentTarget) }, 'Save key'),
      h(
        'button',
        {
          class: 'btn btn--ghost btn--sm',
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.setAttribute('disabled', '');
            keyReport.replaceChildren(h('span', { class: 'spinner' }), ' Testing with Google…');
            const rows = await ctx.testGoogleKey(keyIn.value.trim());
            keyReport.replaceChildren(
              ...rows.map((r) => h('div', { class: `key-check ${r.ok ? 'is-ok' : 'is-bad'}` }, h('b', null, `${r.ok ? '✓' : '✗'} ${r.name}`), h('small', null, r.detail), r.fix ? h('small', { class: 'key-fix' }, r.fix) : null)),
            );
            btn.removeAttribute('disabled');
          },
        },
        'Test key',
      ),
    ),
    keyReport,
  );

  openModal({
    eyebrow: settings.live ? 'Live' : 'Demo',
    title: 'Operator tools',
    size: 'lg',
    content: h(
      'div',
      { class: 'operator' },
      h(
        'div',
        { class: 'op-grid' },
        row('Your revenue', `${fmtSol(state.totals.revenue)} SOL`),
        row('Trading volume', `${fmtSol(state.totals.volume)} SOL`),
        row('Buildings owned', fmtInt(state.totals.buildings)),
        row('Sales between players', fmtInt(state.totals.sales)),
        row('Taken with credit', fmtInt(state.totals.holds)),
        row('Market fee', `${settings.feeBps / 100}%`),
      ),
      settings.live
        ? h(
            'div',
            { class: 'op-keys' },
            h('div', null, h('span', null, 'Treasury'), h('code', null, settings.treasury)),
            h('div', null, h('span', null, 'Registry reference'), h('code', null, registry.address)),
            h('p', { class: 'modal-fine' }, 'Refunds, revokes and billboard removals are signed by your treasury wallet (Phantom asks you to approve each one).', connected() ? '' : ' You’ll be asked to connect it.'),
          )
        : null,
      h('h3', { class: 'op-h' }, 'Realistic 3D (Google 3D Tiles)'),
      keyForm,
      h('h3', { class: 'op-h' }, 'Your meme coin'),
      coinForm,
      h('h3', { class: 'op-h' }, `Refunds owed (${owed.length})`),
      owed.length ? h('div', { class: 'op-refunds' }, owed.map(refundRow)) : h('p', { class: 'op-empty' }, 'Nothing to refund. When two people pay for the same building at once, the second payment shows up here.'),
      h('h3', { class: 'op-h' }, 'Price audit'),
      auditBox,
      h('button', { class: 'btn btn--ghost btn--sm', onclick: async (e) => ctx.onAudit(auditBox, e.currentTarget) }, 'Run price audit'),
      h('h3', { class: 'op-h' }, `Billboards (${signs.length})`),
      signs.length
        ? h(
            'div',
            { class: 'op-refunds' },
            signs.slice(0, 50).map((b) =>
              h('div', { class: 'op-refund' }, h('div', { class: 'grow' }, h('div', null, `“${b.sign.text}”`), h('small', null, `${b.key} · ${who(b.owner)} · ${timeAgo(b.sign.time)}`)), settings.live ? h('button', { class: 'btn btn--ghost btn--sm', onclick: (e) => ctx.onRevoke(b.sign.sig, 0, b.owner, e.currentTarget) }, 'Remove') : null),
            ),
          )
        : h('p', { class: 'op-empty' }, 'No billboards yet.'),
      h('p', { class: 'modal-fine' }, 'Coin changes apply from the moment you save them; past purchases keep the price they had. To change the treasury or fee, edit config.js and redeploy.'),
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
