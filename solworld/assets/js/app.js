// Solworld — application entry point. Wires the chain registry, wallet, map
// and UI together and runs the buy / claim flow.

import { loadSettings } from './settings.js';
import {
  Rpc,
  base58Encode,
  compileMessage,
  computeUnitLimitInstruction,
  computeUnitPriceInstruction,
  memoInstruction,
  serializeUnsignedTransaction,
  sha256,
  transferInstruction,
} from './solana.js';
import { ChainRegistry, DemoRegistry, buildMemo, isBuildingKey, priceAt } from './registry.js';
import { WalletManager, isUserRejection } from './wallet.js';
import { OsmClient, buildingHeights } from './osm.js';
import { Geocoder, PhotoFinder, SolPrice, buildingKind, buildingTitle } from './info.js';
import { MapController, COLORS } from './map.js';
import { FEATURED, placeLabel } from './cities.js';
import { distanceM, pointInPolygon } from './geo.js';
import { $, copyText, debounce, fmtSol, h, isTouch, prefersReducedMotion, shortAddr, storage } from './util.js';
import { Toasts } from './ui/feedback.js';
import { BuildingPanel } from './ui/panel.js';
import { Rail } from './ui/rail.js';
import { Search } from './ui/search.js';
import { WalletUI } from './ui/walletui.js';
import {
  Hero,
  Stats,
  createControls,
  createLoader,
  ensureConsent,
  openHelp,
  openOperator,
  renderFatal,
  renderNetPill,
} from './ui/chrome.js';
import { icon } from './ui/icons.js';

const CAMERA_KEY = 'solworld:camera';
const FEE_BUFFER = 20_000; // lamports kept aside for the network + priority fee

class FriendlyError extends Error {}

function friendlyError(err) {
  if (err instanceof FriendlyError) return err.message;
  const text = `${err?.message || err || ''} ${JSON.stringify(err?.data || '')}`;
  if (/insufficient|no record of a prior credit|0x1\b/i.test(text)) return 'Your wallet doesn’t have enough SOL for this.';
  if (/blockhash|expired|block height exceeded/i.test(text)) return 'The network was busy and the transaction expired. Please try again.';
  if (/timed out|timeout/i.test(text)) return 'Solana is slow right now. If the payment went through, ownership will appear shortly.';
  if (/HTTP 4|HTTP 5|fetch|network/i.test(text)) return 'Couldn’t reach Solana. Check your connection and try again.';
  return err?.message || 'Please try again.';
}

const VOID_REASONS = {
  taken: 'Someone got this building a moment before you.',
  underpaid: 'The payment was below the building price.',
  'claim-used': 'This wallet has already claimed its free building.',
  balance: `The wallet held too little SOL for a free claim.`,
};

function boot() {
  const app = $('#app');
  const settings = loadSettings(window.SOLWORLD_CONFIG || {});
  if (settings.fatal) return renderFatal(app, settings.fatal);
  if (window.top !== window.self) {
    return renderFatal(app, {
      title: 'Open Solworld in its own tab',
      body: 'For your safety, Solworld doesn’t run inside other websites. Open it directly to continue.',
    });
  }

  const reduced = prefersReducedMotion();
  const loader = createLoader($('#loader'));
  const toasts = new Toasts($('#toasts'));
  const toast = (opts) => toasts.show(opts);
  const rpc = new Rpc(settings.rpc);
  const osm = new OsmClient({ endpoints: settings.services.overpass, storage });
  const geocoder = new Geocoder({ photon: settings.services.photon });
  const photos = new PhotoFinder(settings.services);
  const solPrice = new SolPrice(settings.services.solPrice);
  const registry = settings.live
    ? new ChainRegistry({ rpc, treasury: settings.treasury, cluster: settings.cluster, rules: settings.rules, storage, pollMs: settings.pollMs })
    : new DemoRegistry({ rules: settings.rules, storage, seeds: () => demoSeeds(osm, settings) });
  const wallet = new WalletManager({ cluster: settings.cluster, rpc, storage, allowDemo: !settings.live });
  const wide = innerWidth > 980;
  const mapc = new MapController({
    container: $('#map'),
    settings,
    reducedMotion: reduced,
    start: { center: [-38, 26], zoom: wide ? 1.75 : innerWidth > 760 ? 1.45 : 1.05 },
  });
  // While the hero is up, park the globe beside the headline (desktop) or above it (mobile).
  mapc.map.setPadding(wide ? { left: Math.min(700, innerWidth * 0.46), top: 40, right: 0, bottom: 0 } : { top: 40, bottom: Math.round(innerHeight * 0.42), left: 0, right: 0 });
  loader.to(0.35);

  let current = null; // { key, building, tileTop } once a building is resolved
  let selectSeq = 0;

  const ctx = {
    settings,
    registry,
    wallet,
    osm,
    storage,
    toast,
    currentPrice: () => priceAt(settings.prices, Math.floor(Date.now() / 1000)),
    kindLabel: (tags) => buildingKind(tags),
    onConnect: () => walletUI.pick(),
    onHelp: () => openHelp(ctx),
    onOperator: () => openOperator(ctx),
    onOwner: (address) => rail.showOwner(address),
    onOpenRecord: (rec) => openKey(rec.key, [rec.lng, rec.lat]),
    onShare: () => share(),
    onClose: () => closeSelection(),
    onAcquire: (kind) => acquire(kind),
    onToggleOrbit: () => (mapc.orbiting ? mapc.stopOrbit() : mapc.startOrbit()),
    onMine: () => wallet.address && rail.showOwner(wallet.address),
    onRailToggle: () => updatePadding(),
    onOwnerViewed: (records) => prefetchOutlines(records.slice(0, 40)),
  };

  /* ------------------------------------------------------------- UI */

  const panel = new BuildingPanel($('#panel'), ctx);
  const rail = new Rail($('#rail'), ctx);
  const walletUI = new WalletUI($('#wallet-slot'), ctx);
  const stats = new Stats($('#stats'));
  const hero = new Hero($('#hero'), {
    settings,
    onExplore: () => explore(),
    onConnect: () => walletUI.pick(),
    onPreset: (p) => {
      hero.hide();
      mapc.flyToPreset(p);
    },
    onHidden: () => {
      if (innerWidth > 1180) rail.setOpen(true);
      updatePadding();
      updateHint();
    },
  });
  new Search($('#search'), {
    geocoder,
    mapZoom: () => mapc.zoom,
    mapCenter: () => mapc.center,
    onPreset: (p) => {
      hero.hide();
      mapc.flyToPreset(p);
    },
    onKey: (key) => openKey(key),
    onCoords: (c) => {
      hero.hide();
      mapc.flyTo(c, 16.5);
    },
    onResult: (r) => {
      hero.hide();
      if (r.osmKey && r.isBuilding) return openKey(r.osmKey, r.center);
      if (r.extent) mapc.flyToExtent(r.extent, { maxZoom: r.kind === 'city' ? 14 : 16.5 });
      else if (r.center) mapc.flyTo(r.center, 16);
    },
  });
  createControls($('#controls'), mapc);
  $('#btn-help').innerHTML = icon('info', { size: 18 });
  $('#btn-help').addEventListener('click', () => openHelp(ctx));
  $('.brand').addEventListener('click', (e) => {
    e.preventDefault();
    closeSelection();
    mapc.goGlobe();
  });

  const hint = $('#hint');
  function updateHint() {
    const z = mapc.zoom;
    let text = '';
    if (!hero.visible && !panel.isOpen) {
      if (z >= 14) text = isTouch() ? 'Tap any building to see who owns it' : 'Click any building to see who owns it';
      else if (z >= 9) text = 'Zoom in to see buildings in 3D';
    }
    hint.classList.toggle('is-visible', !!text);
    if (text) hint.querySelector('span').textContent = text;
  }

  const banner = $('#banner');
  const session = {
    get: (k) => {
      try {
        return sessionStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        sessionStorage.setItem(k, v);
      } catch {
        // storage blocked; the banner simply comes back next visit
      }
    },
  };
  function showBanner(text, { tone = 'demo', id, short } = {}) {
    if (id && session.get(`solworld:banner:${id}`)) return;
    banner.replaceChildren(
      h('span', { class: 'banner-dot' }),
      h('span', { class: 'banner-text' }, h('span', { class: 'banner-long' }, text), h('span', { class: 'banner-short' }, short || text)),
      h('button', {
        class: 'banner-x',
        'aria-label': 'Dismiss',
        svg: icon('close', { size: 14 }),
        onclick: () => {
          banner.classList.remove('is-visible');
          if (id) session.set(`solworld:banner:${id}`, '1');
        },
      }),
    );
    banner.className = `banner banner--${tone} is-visible`;
  }
  if (!settings.live) {
    showBanner(
      settings.problems[0] || 'Demo mode — buying is simulated. Add your wallet address to config.js to accept real SOL.',
      { id: 'demo', short: 'Demo mode · purchases are simulated' },
    );
  }

  const netPill = $('#net-pill');
  const paintNet = () => renderNetPill(netPill, { settings, registry });

  function updatePadding() {
    const mobile = innerWidth < 760;
    const panelW = $('#panel').offsetWidth || 400;
    const railW = $('#rail').offsetWidth || 320;
    mapc.setPadding({
      top: mobile ? 60 : 70,
      right: !mobile && panel.isOpen ? panelW + 28 : 0,
      left: !mobile && rail.isOpen && !hero.visible ? railW + 24 : 0,
      bottom: mobile && panel.isOpen ? Math.round(innerHeight * 0.5) : 0,
    });
  }
  addEventListener('resize', debounce(() => {
    updatePadding();
    mapc.resize();
  }, 150));

  /* -------------------------------------------------------- selection */

  function toneFor(key) {
    const rec = registry.state.buildings.get(key);
    if (!rec) return 'available';
    return rec.owner === wallet.address ? 'mine' : 'owned';
  }

  async function selectPick(pick) {
    const seq = ++selectSeq;
    hero.hide();
    mapc.stopOrbit();
    current = null;
    panel.showPending(pick);
    updatePadding();
    updateHint();
    mapc.setSelection({ key: null, polygons: null, anchor: pick.point, fallback: { part: pick.part, top: pick.top, base: pick.base }, tone: '' });
    try {
      const building = await osm.buildingAt(pick.point, pick.part);
      if (seq !== selectSeq) return;
      if (!building) {
        panel.showError('not-building');
        return;
      }
      showBuilding(building, { tileTop: pick.top });
    } catch (err) {
      if (seq !== selectSeq) return;
      console.warn('[solworld] building lookup failed', err);
      panel.showError('network', () => selectPick(pick));
    }
  }

  function showBuilding(building, { tileTop = null, fly = true } = {}) {
    current = { key: building.key, building, tileTop };
    mapc.setOutlines(new Map([[building.key, building]]));
    mapc.setSelection({ key: building.key, polygons: building.polygons, anchor: building.center, tone: toneFor(building.key) });
    panel.showBuilding(building, { tileTop });
    updatePadding();
    updateHint();
    setHash(`#/b/${building.key}`);
    if (fly) {
      const top = Math.max(tileTop || 0, buildingHeights(building.tags).top);
      mapc.flyToBuilding(building.center, { top });
      if (!reduced) mapc.startOrbit();
    }
    geocoder.reverse(building.center).then((address) => panel.setAddress(building.key, address));
    photos.find({ key: building.key, tags: building.tags, center: building.center }).then((photo) => panel.setPhoto(building.key, photo));
    solPrice.get().then((usd) => usd && panel.setUsd(usd));
  }

  async function openKey(key, near) {
    if (!isBuildingKey(key)) return;
    hero.hide();
    const seq = ++selectSeq;
    let building = osm.byKey.get(key);
    if (!building) {
      if (near) mapc.flyTo(near, 16.2);
      const loading = toast({ title: 'Finding building…', tone: 'pending' });
      try {
        building = (await osm.buildingsByKeys([key])).get(key);
      } catch (err) {
        console.warn('[solworld] building fetch failed', err);
      }
      loading.dismiss();
    }
    if (seq !== selectSeq) return;
    if (!building) {
      toast({ title: 'Couldn’t load that building', body: 'OpenStreetMap didn’t return it. It may have been removed, or the service is busy.', tone: 'error' });
      return;
    }
    showBuilding(building);
  }

  function closeSelection() {
    selectSeq++;
    current = null;
    panel.close();
    mapc.clearSelection();
    mapc.stopOrbit();
    setHash('');
    updatePadding();
    updateHint();
  }

  mapc.on('orbit', (on) => panel.setOrbiting(on));

  async function share() {
    if (!current) return;
    const url = `${location.origin}${location.pathname}#/b/${current.key}`;
    const name = buildingTitle(current.building.tags) || 'A building';
    if (navigator.share && isTouch()) {
      try {
        await navigator.share({ title: `${name} · Solworld`, url });
        return;
      } catch {
        // fall back to copying
      }
    }
    await copyText(url);
    toast({ title: 'Link copied', body: 'Anyone with the link lands right on this building.', tone: 'success', duration: 3000 });
  }

  /* ---------------------------------------------------- buy / claim */

  async function acquire(kind) {
    if (!current) return;
    const { building } = current;
    const { key } = building;
    const label = buildingTitle(building.tags) || `Building ${key}`;
    if (!wallet.connected) {
      const connected = await walletUI.pick();
      if (!connected) return;
    }
    if (!(await ensureConsent(ctx))) return;
    if (registry.state.buildings.has(key)) {
      toast({ title: 'Already owned', body: 'Someone owns this building now.', tone: 'error' });
      panel.refresh();
      return;
    }

    const me = wallet.address;
    const lamports = kind === 'buy' ? ctx.currentPrice() : 0;
    const balance = (await wallet.refreshBalance()) ?? wallet.balance ?? 0;
    if (kind === 'claim') {
      if (registry.state.claimed.has(me)) return void toast({ title: 'Free building already claimed', body: 'Each wallet gets one.', tone: 'error' });
      if (!(balance > settings.freeClaimMinLamports)) {
        return void toast({ title: 'Not eligible yet', body: `Hold more than ${settings.freeClaimMinSol} SOL in this wallet to claim a building for free.`, tone: 'error' });
      }
    } else if (balance < lamports + FEE_BUFFER) {
      return void toast({ title: 'Not enough SOL', body: `You need ${fmtSol(lamports + FEE_BUFFER)} SOL (price plus network fee). This wallet has ${fmtSol(balance)} SOL.`, tone: 'error' });
    }

    panel.setBusy('preparing');
    const progress = toast({ title: kind === 'claim' ? 'Claiming your building' : 'Buying your building', body: label, tone: 'pending' });
    try {
      let sig;
      if (!settings.live) {
        panel.setBusy('simulating');
        sig = await registry.submit({ kind, key, lng: building.center[0], lat: building.center[1], buyer: me, paid: lamports, pre: balance });
        if (wallet.isDemo) {
          wallet.balance -= lamports;
          wallet.emit('change', wallet.snapshot());
        }
      } else {
        await registry.sync().catch(() => {});
        if (registry.state.buildings.has(key)) throw new FriendlyError('Someone just bought this building.');
        const { blockhash } = await rpc.getLatestBlockhash();
        const instructions = [computeUnitLimitInstruction(40_000)];
        if (settings.priorityFeeMicroLamports) instructions.push(computeUnitPriceInstruction(settings.priorityFeeMicroLamports));
        instructions.push(
          transferInstruction({ from: me, to: settings.treasury, lamports, references: [registry.address] }),
          memoInstruction(buildMemo(kind, key, building.center)),
        );
        const message = compileMessage({ payer: me, instructions, recentBlockhash: blockhash });
        panel.setBusy('wallet');
        progress.update({ title: 'Approve in your wallet', body: kind === 'claim' ? `Free claim · ${label}` : `${fmtSol(lamports)} SOL · ${label}` });
        sig = await wallet.signAndSend(serializeUnsignedTransaction(message));
        panel.setBusy('confirming');
        progress.update({ title: 'Confirming on Solana…', link: { href: settings.explorer.tx(sig), label: 'View transaction' } });
        await rpc.confirm(sig);
        panel.setBusy('indexing');
        progress.update({ title: 'Recording ownership…' });
      }
      const result = await registry.waitFor(sig);
      if (result.ok) {
        progress.update({ tone: 'mine', title: kind === 'claim' ? 'Claimed — it’s yours!' : 'Purchased — it’s yours!', body: label, duration: 8000 });
        mapc.setSelection({ key, polygons: building.polygons, anchor: building.center, tone: 'mine' });
        mapc.pulse(building.center, COLORS.mine);
        celebrate();
        wallet.refreshBalance();
      } else if (result.void) {
        progress.update({
          tone: 'error',
          title: 'Not recorded',
          body: `${VOID_REASONS[result.void.reason] || 'The transaction didn’t meet the rules.'}${result.void.paid > 0 ? ' Your payment is flagged for a refund.' : ''}`,
          duration: 14000,
        });
      } else {
        progress.update({ tone: 'info', title: 'Still confirming', body: 'Your transaction was sent. Ownership will appear here as soon as Solana finalizes it.', duration: 10000 });
      }
    } catch (err) {
      if (isUserRejection(err)) progress.update({ tone: 'info', title: 'Cancelled', body: 'Nothing was sent.', duration: 3000 });
      else {
        console.warn('[solworld] purchase failed', err);
        progress.update({ tone: 'error', title: 'That didn’t go through', body: friendlyError(err), duration: 10000 });
      }
    } finally {
      panel.setBusy(null);
      panel.refresh();
    }
  }

  function celebrate() {
    if (reduced) return;
    const origin = $('#panel .panel-foot') || document.body;
    const rect = origin.getBoundingClientRect();
    const layer = h('div', { class: 'confetti', 'aria-hidden': 'true' });
    const colors = ['#2af5a8', '#8f6bff', '#ffffff', '#5ad1ff', '#ffd166'];
    for (let i = 0; i < 80; i++) {
      const size = 4 + Math.random() * 6;
      layer.append(
        h('i', {
          style: {
            left: `${rect.left + rect.width / 2 + (Math.random() - 0.5) * 60}px`,
            top: `${rect.top + 24}px`,
            width: `${size}px`,
            height: `${size * (0.4 + Math.random())}px`,
            background: colors[i % colors.length],
            '--dx': `${(Math.random() - 0.5) * 560}px`,
            '--dy': `${-180 - Math.random() * 360}px`,
            '--r': `${Math.random() * 900 - 450}deg`,
            '--d': `${1100 + Math.random() * 900}ms`,
          },
        }),
      );
    }
    document.body.append(layer);
    setTimeout(() => layer.remove(), 2400);
  }

  /* ------------------------------------------------ ownership outlines */

  const outlineMisses = new Set();
  async function prefetchOutlines(records) {
    const need = records.filter((r) => !mapc.outlines.has(r.key) && !outlineMisses.has(r.key));
    if (!need.length) return;
    try {
      const found = await osm.buildingsByKeys(need.map((r) => r.key));
      const accepted = new Map();
      for (const r of need) {
        const b = found.get(r.key);
        // Only trust an outline that actually sits where the purchase said it was.
        if (b && (b.polygons.some((p) => pointInPolygon([r.lng, r.lat], p)) || distanceM(b.center, [r.lng, r.lat]) < 80)) accepted.set(r.key, b);
        else outlineMisses.add(r.key);
      }
      if (accepted.size) mapc.setOutlines(accepted);
    } catch (err) {
      console.warn('[solworld] outline fetch failed', err);
    }
  }
  const scheduleOutlines = debounce(() => prefetchOutlines(mapc.visibleRecords().slice(0, 120)), 650);
  mapc.map.on('moveend', scheduleOutlines);

  /* --------------------------------------------------------- wiring */

  function syncOwnershipViews({ fresh = [], initial = false } = {}) {
    const records = [...registry.state.buildings.values()];
    mapc.setOwnership(records, wallet.address);
    if (current) mapc.setSelection({ key: current.key, polygons: current.building.polygons, anchor: current.building.center, tone: toneFor(current.key) });
    rail.render();
    stats.update(registry.state.totals);
    hero.update(registry.state.totals);
    walletUI.render();
    panel.refresh();
    scheduleOutlines();
    if (!initial) {
      const news = fresh.filter((ev) => registry.state.bySig.get(ev.sig)?.record && ev.buyer !== wallet.address && !ev.seed);
      if (news.length > 2) {
        toast({ title: `${news.length} buildings just changed hands`, body: 'See the Activity tab for details.', tone: 'owned', duration: 4500 });
      } else {
        for (const ev of news) {
          toast({
            title: `${shortAddr(ev.buyer)} ${ev.kind === 'claim' ? 'claimed' : 'bought'} a building`,
            body: placeLabel(ev.lat, ev.lng),
            tone: 'owned',
            duration: 4500,
          });
        }
      }
    }
  }

  registry.on('change', syncOwnershipViews);
  registry.on('status', paintNet);
  wallet.on('change', () => syncOwnershipViews({ initial: true }));

  mapc.on('pick', selectPick);
  mapc.on('point', (key) => {
    const rec = registry.state.buildings.get(key);
    openKey(key, rec ? [rec.lng, rec.lat] : undefined);
  });
  mapc.on('pick-empty', ({ zoom }) => {
    if (panel.isOpen && zoom >= 14) closeSelection();
  });
  mapc.on('user-moved', () => hero.hide());
  mapc.on('zoom', debounce(updateHint, 120));
  mapc.on('map-trouble', () => showBanner('Map tiles are loading slowly. The map will fill in as they arrive.', { tone: 'warn', id: 'tiles' }));
  mapc.on('first-idle', () => loader.finish());
  mapc.map.on('moveend', debounce(() => storage.set(CAMERA_KEY, mapc.cameraState()), 400));
  setTimeout(() => loader.finish(), 7000); // never leave people staring at the loader

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.body.classList.contains('has-modal') && panel.isOpen && !/input/i.test(document.activeElement?.tagName || '')) closeSelection();
  });

  function explore() {
    hero.hide();
    const last = storage.get(CAMERA_KEY);
    if (last && last.zoom > 11) mapc.flyToPreset({ ...last, pitch: Math.max(45, last.pitch) });
    else mapc.flyToPreset(FEATURED[0]);
    if (!storage.get('solworld:tip-seen')) {
      storage.set('solworld:tip-seen', 1);
      setTimeout(() => toast({ title: 'Every building is clickable', body: 'Tap one to see what it looks like, who owns it, and to make it yours.', iconName: 'building', duration: 6500 }), reduced ? 300 : 5200);
    }
  }

  /* --------------------------------------------------------- routing */

  function setHash(hash) {
    const target = hash || `${location.pathname}${location.search}`;
    if ((hash || '') !== location.hash) history.replaceState(null, '', target);
  }

  function route() {
    const m = /^#\/b\/([wr][1-9]\d{0,15})$/.exec(location.hash);
    if (m) openKey(m[1]);
    else if (location.hash === '#/operator') openOperator(ctx);
  }
  addEventListener('hashchange', route);

  /* ----------------------------------------------------------- start */

  paintNet();
  walletUI.render();
  rail.render();
  mapc.on('ready', () => {
    loader.to(0.75);
    mapc.startSpin();
    route();
  });
  registry
    .init()
    .then(() => {
      paintNet();
      registry.start();
      registry.sync?.().catch(() => {});
    })
    .catch((err) => {
      console.error('[solworld] registry failed to start', err);
      toast({ title: 'Can’t read the registry', body: friendlyError(err), tone: 'error' });
    });
  addEventListener('online', () => registry.sync().catch(() => {}));

  // Handy for debugging from the console.
  window.solworld = { settings, registry, wallet, map: mapc, osm };
}

/* -------------------------------------------------------------- demo */

// Famous buildings pre-owned by demo wallets so the leaderboard isn't empty.
// [lng, lat, search radius in meters]
const LANDMARKS = [
  [-73.985664, 40.748440, 70], // Empire State Building
  [55.274376, 25.197197, 110], // Burj Khalifa
  [2.294481, 48.858370, 90], // Eiffel Tower
  [-0.086500, 51.504500, 60], // The Shard
  [139.745433, 35.658581, 70], // Tokyo Tower
  [151.215297, -33.856784, 110], // Sydney Opera House
  [-73.975311, 40.751652, 50], // Chrysler Building
  [-74.013382, 40.712742, 70], // One World Trade Center
  [121.564468, 25.033964, 80], // Taipei 101
  [12.492231, 41.890210, 120], // Colosseum
  [2.174400, 41.403600, 80], // Sagrada Família
  [-0.080300, 51.514500, 50], // 30 St Mary Axe
  [101.711600, 3.157800, 70], // Petronas Towers
  [-122.349358, 47.620422, 45], // Space Needle
  [-87.635915, 41.878876, 70], // Willis Tower
  [55.185360, 25.141291, 60], // Burj Al Arab
  [-73.989699, 40.741061, 40], // Flatiron Building
  [-122.402800, 37.795200, 50], // Transamerica Pyramid
  [121.505500, 31.233500, 80], // Shanghai Tower
  [-2.934000, 43.268600, 90], // Guggenheim Bilbao
];
const OWNER_PATTERN = [0, 1, 0, 2, 1, 3, 0, 4, 2, 5, 1, 0, 6, 3, 7, 2, 0, 8, 1, 4];

async function demoSeeds(osm, settings) {
  const owners = [];
  for (let i = 0; i < 9; i++) owners.push(base58Encode(await sha256(`solworld/demo-owner/${i}`)));
  const buildings = [];
  for (let i = 0; i < LANDMARKS.length; i += 7) {
    const chunk = LANDMARKS.slice(i, i + 7);
    try {
      const found = await osm.buildingsAtMany(chunk.map(([lng, lat, radius]) => ({ point: [lng, lat], radius })));
      found.forEach((b, j) => buildings.push({ building: b, index: i + j }));
    } catch (err) {
      console.warn('[solworld] demo landmarks unavailable', err);
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const claimed = new Set();
  const events = [];
  const used = new Set();
  buildings
    .filter((x) => x.building && !used.has(x.building.key) && used.add(x.building.key))
    .forEach(({ building, index }, n, list) => {
      const buyer = owners[OWNER_PATTERN[index % OWNER_PATTERN.length]];
      const time = now - (list.length - n) * 9 * 3600 - Math.floor(Math.random() * 3600);
      const claim = !claimed.has(buyer);
      claimed.add(buyer);
      events.push({
        sig: `demo-seed-${index}`,
        slot: 0,
        time,
        kind: claim ? 'claim' : 'buy',
        key: building.key,
        lat: building.center[1],
        lng: building.center[0],
        buyer,
        paid: claim ? 0 : priceAt(settings.prices, time),
        pre: 3_000_000_000,
      });
    });
  return events;
}

boot();
