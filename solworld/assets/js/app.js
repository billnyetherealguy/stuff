// Solworld — application entry point. Wires the chain registry, the Solworld
// wallet, the map and the UI together and runs every action: buying, meme-coin
// credit, offers, sales, billboards and the operator's tools.

import { loadSettings } from './settings.js';
import {
  Rpc,
  base58Decode,
  base58Encode,
  compileMessage,
  memoInstruction,
  parseNonceAccount,
  placeSignature,
  serializeUnsignedTransaction,
  sha256,
  transferInstruction,
} from './solana.js';
import { ChainRegistry, DEMO_TREASURY, DemoRegistry, SIGN_COLORS, buildMemo, isBuildingKey, openOffers, parseMemo, saleFee, tokenPriceAt } from './registry.js';
import { WalletManager, isUserRejection } from './wallet.js';
import { BurnerWallet, verifySignature } from './burner.js';
import { actionMessage, buildSaleMessage, createNonceMessage, nonceAddressFor } from './market.js';
import { priceBuilding, tierFor } from './pricing.js';
import { sunPosition } from './sun.js';
import { buildingSkin } from './skin.js';
import { Realistic3D } from './realistic3d.js';
import { StreetDrop } from './streetview.js';
import { TakeoverTool } from './ui/takeover.js';
import { Traffic } from './traffic.js';
import { buildStreetscape } from './streetscape.js';
import { SIGN_CLASSES } from './mapstyle.js';
import { OsmClient, buildingHeights, geoKey, geoKeyCenter, isOsmKey } from './osm.js';
import { Geocoder, PhotoFinder, SolPrice, buildingKind, buildingTitle } from './info.js';
import { MapController, COLORS } from './map.js';
import { FEATURED, placeLabel } from './cities.js';
import { distanceM, interiorPoint, pointInPolygon, polygonAreaM2 } from './geo.js';
import { $, avatar, copyText, debounce, fmtInt, fmtSol, h, isTouch, prefersReducedMotion, setNameResolver, shortAddr, storage, who } from './util.js';
import { Toasts } from './ui/feedback.js';
import { BuildingPanel } from './ui/panel.js';
import { Rail } from './ui/rail.js';
import { Search } from './ui/search.js';
import { WalletUI } from './ui/walletui.js';
import { Hero, Stats, createControls, createLoader, ensureConsent, openHelp, openOperator, renderFatal, renderNetPill } from './ui/chrome.js';
import { icon } from './ui/icons.js';

const CAMERA_KEY = 'solworld:camera';
const FEE_BUFFER = 20_000; // lamports kept aside for network + priority fees
const DEMO_COIN = { mint: 'DemoMint1111111111111111111111111111111111111', symbol: 'DEMO', prices: [{ from: 0, lamportsPerToken: 1_000 }] };
const DEMO_HOLDINGS = 1_000_000; // demo $DEMO tokens (worth 1 SOL)

class FriendlyError extends Error {}

function friendlyError(err) {
  if (err instanceof FriendlyError) return err.message;
  const text = `${err?.message || err || ''} ${JSON.stringify(err?.data || '')}`;
  if (/insufficient|no record of a prior credit|0x1\b/i.test(text)) return 'Your wallet doesn’t have enough SOL for this.';
  if (/blockhash|expired|block height exceeded/i.test(text)) return 'The network was busy and the transaction expired. Please try again.';
  if (/timed out|timeout/i.test(text)) return 'Solana is slow right now. If it went through, it will show up shortly.';
  if (/HTTP 4|HTTP 5|fetch|network/i.test(text)) return 'Couldn’t reach Solana. Check your connection and try again.';
  return err?.message || 'Please try again.';
}

const VOID_REASONS = {
  taken: 'Someone got this building a moment before you.',
  underpaid: 'The payment was below the building price.',
  revoked: 'The operator voided this action.',
  unlinked: 'Your holder wallet isn’t linked yet.',
  'no-credit': 'Not enough holder credit left.',
  'not-owner': 'The seller no longer owned it.',
  'bad-sale': 'The sale didn’t match the offer.',
  'name-taken': 'Someone already has that name. Try another.',
  'land-taken': 'Someone took over part of that land a moment before you.',
  'in-territory': 'That building is part of someone’s territory now.',
  'bad-land': 'That area isn’t valid.',
};

async function boot() {
  const app = $('#app');
  const settings = loadSettings(window.SOLWORLD_CONFIG || {});
  if (settings.fatal) return renderFatal(app, settings.fatal);
  if (window.top !== window.self) {
    return renderFatal(app, {
      title: 'Open Solworld in its own tab',
      body: 'For your safety, Solworld doesn’t run inside other websites. Open it directly to continue.',
    });
  }
  const live = settings.live;

  const reduced = prefersReducedMotion();
  const loader = createLoader($('#loader'));
  const toasts = new Toasts($('#toasts'));
  const toast = (opts) => toasts.show(opts);
  const rpc = new Rpc(settings.rpc);
  const osm = new OsmClient({ endpoints: settings.services.overpass, storage });
  const geocoder = new Geocoder({ photon: settings.services.photon });
  const photos = new PhotoFinder(settings.services);
  const solPrice = new SolPrice(settings.services.solPrice);
  const registry = live
    ? new ChainRegistry({ rpc, treasury: settings.treasury, cluster: settings.cluster, rules: settings.rules, storage, pollMs: settings.pollMs })
    : new DemoRegistry({ rules: { ...settings.rules, memecoin: DEMO_COIN }, storage, seeds: () => demoSeeds(osm) });
  const treasury = live ? settings.treasury : DEMO_TREASURY;
  // The active meme coin (config.js, or whatever the operator set on-chain).
  setNameResolver((address) => registry.state.names?.get(address) || null);
  Object.defineProperty(settings, 'memecoinView', { get: () => registry.state.coin || null, configurable: true });
  const ext = new WalletManager({ cluster: settings.cluster, rpc, storage: null });
  const wallet = new BurnerWallet({ rpc, storage });
  if (!live) wallet.simulate(storage);
  await wallet.load();

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
  let holderInfo = null; // { holder, tokens, account }
  const priceCache = new Map();

  const me = () => wallet.address;
  const linkedHolder = () => (wallet.address ? registry.state.links.get(wallet.address) || null : null);
  const creditLeft = () => {
    const holder = linkedHolder();
    const coin = registry.state.coin;
    if (!holder || !coin || holderInfo?.holder !== holder) return 0;
    const value = holderInfo.tokens * tokenPriceAt(coin.prices, Math.floor(Date.now() / 1000));
    return Math.max(0, Math.floor(value - (registry.state.holderSpent.get(holder) || 0)));
  };

  const ctx = {
    settings,
    registry,
    wallet,
    ext,
    osm,
    storage,
    toast,
    kindLabel: (tags) => buildingKind(tags),
    priceFor: (building) => {
      if (!priceCache.has(building.key)) priceCache.set(building.key, priceBuilding(building));
      return priceCache.get(building.key);
    },
    creditLeft,
    linkedHolder,
    openOffersFor: (key) => openOffers(registry.state, key),
    myOffers: () => (me() ? [...registry.state.offers.values()].filter((o) => o.status === 'open' && o.buyer === me()) : []),
    incomingOffers: () => (me() ? [...registry.state.offers.values()].filter((o) => o.status === 'open' && registry.state.buildings.get(o.key)?.owner === me()) : []),
    onConnect: () => walletUI.open(),
    onDeposit: (need) => (wallet.exists ? walletUI.deposit({ need }) : walletUI.open()),
    onHelp: () => openHelp(ctx),
    onOperator: () => openOperator(ctx),
    onOwner: (address) => rail.showOwner(address),
    onOpenRecord: (rec) => {
      if (rec.kind === 'land') {
        const t = rec.bbox ? rec : registry.state.territories.find((x) => x.sig === rec.sig);
        const [w, so, e, n] = (t || rec).bbox || [];
        if (w != null) {
          hero.hide();
          mapc.flyToExtent([w, n, e, so], { maxZoom: 16 });
        }
        return;
      }
      openKey(rec.key, [rec.lng, rec.lat]);
    },
    onOpenOffer: (offer) => {
      const b = registry.state.buildings.get(offer.key);
      openKey(offer.key, b ? [b.lng, b.lat] : undefined);
    },
    onShare: () => share(),
    onClose: () => closeSelection(),
    onAcquire: (kind) => acquire(kind),
    onOffer: (lamports) => makeOffer(lamports),
    onAccept: (offer) => acceptOffer(offer),
    onCancelOffer: (offer) => cancelOffer(offer),
    onSign: (sign) => setSign(sign),
    onToggleOrbit: () => (mapc.orbiting ? mapc.stopOrbit() : mapc.startOrbit()),
    onMine: () => me() && rail.showOwner(me()),
    onRailToggle: () => updatePadding(),
    onOwnerViewed: (records) => prefetchOutlines(records.slice(0, 40)),
    holderPreview: (address) => holderPreview(address),
    linkHolder: (address, pick) => linkHolder(address, pick),
    withdraw: (to, value) => withdraw(to, value),
    sendExternalTransfer: (lamports) => sendExternalTransfer(lamports),
    operatorReady: () => live && ext.address === settings.treasury,
    onRefund: (v, btn) => operatorAction('refund', v.sig, v.paid - (registry.state.refunded.get(v.sig) || 0), v.buyer || v.actor, btn),
    onRevoke: (sig, lamports, to, btn) => operatorAction('revoke', sig, lamports, to, btn),
    onAudit: (box, btn) => audit(box, btn),
    onSetCoin: (coin, btn) => setCoin(coin, btn),
    streetAvailable: () => street.available,
    myName: () => (me() ? registry.state.names?.get(me()) || '' : ''),
    nameTaken: (name) => {
      const lower = String(name).toLowerCase();
      for (const [addr, n] of registry.state.names || []) if (n.toLowerCase() === lower && addr !== me()) return true;
      return false;
    },
    onSetName: (name) => setName(name),
    solUsd: () => solPrice.get(),
    onBuyLand: (land) => buyLand(land),
    territoryAt: (lngLat) => registry.state.territoryAt?.(lngLat[0], lngLat[1]) || null,
    onStreet: (lngLat) => dropIn(lngLat),
    onSetKey3d: (apiKey, btn) => publishSetting(buildMemo('tiles', { apiKey }), 'Realistic 3D is on', btn),
    key3dActive: () => !!(settings.realistic3d.googleKey || registry.state.key3d || settings.realistic3d.ionToken),
    coinMarket: (mint) => coinMarket(mint),
    testGoogleKey: (key) => testGoogleKey(key),
    onHolder: async () => {
      if (!wallet.exists && !(await walletUI.open())) return;
      walletUI.holder();
    },
  };

  /* ------------------------------------------------------------- UI */

  const panel = new BuildingPanel($('#panel'), ctx);
  const rail = new Rail($('#rail'), ctx);
  const walletUI = new WalletUI($('#wallet-slot'), ctx);
  const stats = new Stats($('#stats'));
  const hero = new Hero($('#hero'), {
    settings,
    onExplore: () => explore(),
    onConnect: () => walletUI.open(),
    onPreset: (p) => {
      hero.hide();
      mapc.flyToPreset(p);
    },
    onHidden: () => {
      setTimeout(() => {
        paint3DButton();
        paintWalk();
        refreshTraffic(true);
      }, 1200);
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
      // A street address (e.g. a house): go there and open the building at that spot.
      if (r.isBuilding && r.center) return openAt(r.center);
      if (r.extent) mapc.flyToExtent(r.extent, { maxZoom: r.kind === 'city' ? 14 : 16.5 });
      else if (r.center) mapc.flyTo(r.center, 16);
    },
  });
  createControls($('#controls'), mapc);

  /* ------------------------------------------------- realistic 3D view */

  const r3d = new Realistic3D({
    container: $('#map3d'),
    cdnBase: settings.services.cesium,
    googleKey: settings.realistic3d.googleKey,
    ionToken: settings.realistic3d.ionToken,
  });
  const R3D_PREF = 'solworld:realistic3d';
  let r3dArmed = true; // re-armed once you zoom back out
  let r3dBusy = false;
  const r3dButton = h('button', { class: 'ctrl-pill glass is-hidden', onclick: () => (r3d.active ? leave3D() : enter3D({ manual: true })) }, h('span', { svg: icon('cube', { size: 16 }) }), h('span', { class: 'ctrl-pill-label' }, 'Realistic 3D'));
  $('#controls').append(r3dButton);
  function paint3DButton() {
    const show = r3d.available && (r3d.active || mapc.zoom >= 14.5) && !hero.visible;
    r3dButton.classList.toggle('is-hidden', !show);
    r3dButton.classList.toggle('is-active', r3d.active);
    r3dButton.querySelector('.ctrl-pill-label').textContent = r3d.active ? 'Map view' : r3dBusy ? 'Loading 3D…' : 'Realistic 3D';
  }
  async function enter3D({ manual = false } = {}) {
    if (!r3d.available || r3d.active || r3dBusy) return;
    r3dBusy = true;
    paint3DButton();
    if (manual) storage.set(R3D_PREF, 'on');
    const m = mapc.map;
    try {
      mapc.stopSpin();
      mapc.stopOrbit();
      await r3d.enter({ center: mapc.center, zoom: Math.max(mapc.zoom, manual ? 16.4 : mapc.zoom), pitch: m.getPitch(), bearing: m.getBearing(), fovDeg: m.getVerticalFieldOfView?.() ?? 36.87, heightPx: m.getCanvas().clientHeight });
      document.body.classList.add('is-3d');
      if (current) r3d.focus({ center: current.building.center, height: Math.max(current.tileTop || 0, buildingHeights(current.building.tags).top), polygons: current.building.polygons, tone: toneFor(current.key) });
      refresh3DOverlays();
      refreshTraffic(true);
      coverageAt = null;
      checkCoverage().catch(() => {});
      if (!storage.get('solworld:tip-3d')) {
        storage.set('solworld:tip-3d', 1);
        toast({ title: 'Realistic 3D', body: 'Real 3D buildings from Google. Tap any building; zoom out to go back to the map.', iconName: 'cube', duration: 6500 });
      }
    } catch (err) {
      console.warn('[solworld] realistic 3D unavailable', err);
      r3d.exit();
      r3dArmed = false;
      const why = String(err?.message || err?.statusCode || err || '').slice(0, 140);
      const refused = /403|401|key|denied|forbidden|referer|referrer/i.test(why) || err?.statusCode === 403;
      toast({
        title: 'Realistic 3D didn’t load',
        body: refused
          ? `Google refused the key. Check: Map Tiles API enabled, billing on, and the key's website restriction matches ${location.origin}. (${why})`
          : `Your device or connection couldn’t load it (${why || 'unknown error'}). The map still works.`,
        tone: 'error',
        duration: 15000,
      });
    } finally {
      r3dBusy = false;
      paint3DButton();
    }
  }
  /*
   * Google only has true 3D buildings in some places; elsewhere its 3D layer
   * is flat photos draped on the terrain, which would hide every building.
   * After loading, check that known buildings actually stand up in it; if not,
   * go back to Solworld's own 3D buildings here (and don't auto-switch nearby).
   */
  const flat3D = new Set();
  const flatKey = ([lng, lat]) => `${Math.round(lng * 20)},${Math.round(lat * 20)}`; // ~5 km cells
  let coverageAt = null;
  async function checkCoverage() {
    if (!r3d.active) return;
    const center = mapc.center;
    if (coverageAt && distanceM(coverageAt, center) < 400) return;
    const kx = 111_320 * Math.cos((center[1] * Math.PI) / 180);
    const seen = new Set();
    const buildings = [];
    for (const f of mapc.map.querySourceFeatures('omt', { sourceLayer: 'building' })) {
      const height = Number(f.properties?.render_height) || 0;
      if (height < 8 || f.geometry?.type !== 'Polygon') continue;
      const ring = f.geometry.coordinates[0];
      const lng = ring.reduce((s, p) => s + p[0], 0) / ring.length;
      const lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
      const id = `${lng.toFixed(5)},${lat.toFixed(5)}`;
      if (seen.has(id) || Math.hypot((lng - center[0]) * kx, (lat - center[1]) * 110_574) > 350) continue;
      seen.add(id);
      const xs = ring.map((p) => p[0]);
      const radius = ((Math.max(...xs) - Math.min(...xs)) * kx) / 2;
      buildings.push({ center: [lng, lat], height, radius });
    }
    if (buildings.length < 4) return; // nothing tall to test here
    buildings.sort((a, b) => b.height - a.height);
    // Let the detailed tiles stream in first.
    await new Promise((r) => setTimeout(r, 2500));
    const share = await r3d.coverage(buildings.slice(0, 12));
    if (share == null || !r3d.active) return;
    coverageAt = center;
    if (share >= 0.3) return;
    flat3D.add(flatKey(center));
    const cam = r3d.cameraState();
    r3d.exit();
    document.body.classList.remove('is-3d');
    r3dArmed = false;
    if (cam) mapc.map.jumpTo({ center: cam.center, zoom: Math.min(cam.zoom, 17), pitch: cam.pitch, bearing: cam.bearing });
    paint3DButton();
    refreshTraffic(true);
    toast({ title: 'No realistic 3D here yet', body: 'Google hasn’t mapped this area in 3D, so you’re seeing Solworld’s own 3D buildings.', iconName: 'cube', duration: 7000 });
  }

  function leave3D(cam = r3d.active ? r3d.cameraState() : null) {
    r3d.exit();
    document.body.classList.remove('is-3d');
    r3dArmed = false;
    storage.set(R3D_PREF, 'off');
    if (cam) mapc.map.jumpTo({ center: cam.center, zoom: Math.min(cam.zoom, 16.2), pitch: cam.pitch, bearing: cam.bearing });
    paint3DButton();
    refreshTraffic(true);
  }
  mapc.map.on('zoomend', () => {
    const z = mapc.zoom;
    if (z < 16) r3dArmed = true;
    paint3DButton();
    if (!r3d.active && r3dArmed && z >= 16.6 && r3d.available && !hero.visible && storage.get(R3D_PREF) !== 'off' && !flat3D.has(flatKey(mapc.center))) enter3D();
  });
  r3d.on('moveend', (cam) => {
    if (!cam) return;
    if (cam.heightAboveGround > 2600 || cam.zoom < 15.2) {
      storage.set(R3D_PREF, 'on'); // zooming out isn't "turn it off"
      r3d.exit();
      document.body.classList.remove('is-3d');
      r3dArmed = false;
      mapc.map.jumpTo({ center: cam.center, zoom: Math.min(cam.zoom, 15.8), pitch: cam.pitch, bearing: cam.bearing });
      paint3DButton();
      refreshTraffic(true);
      return;
    }
    // Keep the flat map (hidden underneath) on the same spot: it supplies
    // roads, shop signs and building footprints for the 3D view.
    mapc.map.jumpTo({ center: cam.center, zoom: Math.min(19, cam.zoom), pitch: Math.min(60, cam.pitch), bearing: cam.bearing });
    mapc.settled().then(() => {
      refresh3DOverlays();
      refreshTraffic();
      checkCoverage().catch(() => {});
    });
  });
  r3d.on('pick', async ({ lngLat }) => {
    const pick = await tileBuildingNear(lngLat).catch(() => null);
    if (pick) selectPick(pick);
  });
  function refresh3DOverlays() {
    if (!r3d.active) return;
    const [cx, cy] = mapc.center;
    const near = (lng, lat, m) => distanceM([cx, cy], [lng, lat]) < m;
    const records = [...registry.state.buildings.values()].filter((r) => near(r.lng, r.lat, 1500));
    r3d.setOwned(
      records
        .filter((r) => r.key !== current?.key && mapc.outlines.get(r.key))
        .map((r) => ({ polygons: mapc.outlines.get(r.key), height: buildingHeights(osm.byKey.get(r.key)?.tags || {}).top, mine: r.owner === me() })),
    );
    const seen = new Set();
    const signs = [];
    for (const f of mapc.signFeatures()) {
      const p = f.properties || {};
      const name = p.name_en || p.name;
      if (!name || !SIGN_CLASSES[p.class] || f.geometry?.type !== 'Point') continue;
      const [lng, lat] = f.geometry.coordinates;
      const id = `${name}:${lng.toFixed(4)},${lat.toFixed(4)}`;
      if (seen.has(id) || !near(lng, lat, 900)) continue;
      seen.add(id);
      signs.push({ name, lng, lat, color: SIGN_CLASSES[p.class] });
    }
    r3d.setLabels({
      billboards: records.filter((r) => r.sign?.text).map((r) => ({ lng: r.lng, lat: r.lat, text: r.sign.text, color: SIGN_COLORS[r.sign.color] || SIGN_COLORS[0], height: buildingHeights(osm.byKey.get(r.key)?.tags || {}).top })),
      signs,
    });
  }

  /* ------------------------------------------------ drop into the street */

  const street = new StreetDrop({ root: $('#street') });
  street.setKey(settings.realistic3d.googleKey);
  const takeover = new TakeoverTool({ mapc, ctx, root: $('#takeover') });
  const takeoverButton = h('button', { class: 'ctrl-pill glass', onclick: () => (takeover.active ? takeover.stop() : (hero.hide(), closeSelection(), takeover.begin())) }, h('span', { svg: icon('trophy', { size: 16 }) }), h('span', { class: 'ctrl-pill-label' }, 'Take over'));
  $('#controls').append(takeoverButton);
  const walkButton = h('button', { class: 'ctrl-pill glass is-hidden', onclick: () => dropIn() }, h('span', { svg: icon('street', { size: 16 }) }), h('span', { class: 'ctrl-pill-label' }, 'Walk here'));
  $('#controls').append(walkButton);
  const paintWalk = () => walkButton.classList.toggle('is-hidden', !(!hero.visible && (r3d.active || mapc.zoom >= 15.5)));
  mapc.map.on('zoomend', paintWalk);
  r3d.on('enter', paintWalk);
  r3d.on('exit', paintWalk);

  /** Posters in the street: this building's own, plus owners' billboards nearby. */
  function streetPosters(target) {
    const posters = [];
    const near = (lng, lat) => distanceM(target, [lng, lat]) < 450;
    const open = (key, lngLat) => () => {
      street.close();
      openKey(key, lngLat);
    };
    for (const r of registry.state.buildings.values()) {
      if (!r.sign?.text || !near(r.lng, r.lat) || r.key === current?.key) continue;
      posters.push({ lng: r.lng, lat: r.lat, title: r.sign.text, line: `${who(r.owner)} · Solworld`, color: SIGN_COLORS[r.sign.color] || SIGN_COLORS[0], onClick: open(r.key, [r.lng, r.lat]) });
    }
    if (current) {
      const rec = registry.state.buildings.get(current.key);
      const [lng, lat] = current.building.center;
      const price = ctx.priceFor(current.building).lamports;
      const poster = rec?.sign?.text
        ? { title: rec.sign.text, line: `Owned by ${rec.owner === me() ? 'you' : who(rec.owner)}`, color: SIGN_COLORS[rec.sign.color] || SIGN_COLORS[0] }
        : rec
          ? { title: rec.owner === me() ? 'Yours' : 'Owned', line: rec.owner === me() ? 'Put up your billboard' : `by ${who(rec.owner)} · make an offer`, color: rec.owner === me() ? '#2af5a8' : '#8f6bff' }
          : { title: 'For sale', line: `${fmtSol(price)} SOL · Solworld`, color: '#2af5a8' };
      posters.push({ lng, lat, big: true, ...poster, onClick: () => street.close() });
    }
    return posters;
  }

  async function dropIn(target) {
    if (!street.available) {
      toast({
        title: 'Street view isn’t switched on yet',
        body: settings.live ? 'The site owner needs to add a Google key in Operator tools (enable “Maps JavaScript API”).' : 'Add a Google key in Operator tools to walk the streets inside Solworld.',
        tone: 'info',
        duration: 8000,
      });
      return;
    }
    target ||= current?.building.center || mapc.center;
    const label = current && distanceM(current.building.center, target) < 60 ? buildingTitle(current.building.tags) || 'This building' : 'Street level';
    const loadingToast = toast({ title: 'Dropping in…', tone: 'pending' });
    try {
      // From the 3D view, swoop down to the street first.
      if (r3d.active) await r3d.swoopTo(target).catch(() => {});
      await street.drop({ target, label, posters: streetPosters(target) });
      loadingToast.dismiss();
    } catch (err) {
      console.warn('[solworld] street view unavailable', err);
      loadingToast.update({
        tone: 'error',
        title: /No street imagery/.test(err?.message) ? 'No street photos here yet' : 'Street view didn’t open',
        body: /No street imagery/.test(err?.message) ? 'Google hasn’t photographed this spot. Try a nearby street.' : `${err?.message || err}. In Google Cloud, enable “Maps JavaScript API” for your key.`,
        duration: 12000,
      });
    }
  }

  /* ------------------------------------------------------ street life */

  const traffic = new Traffic();
  let trafficAt = null;
  function refreshTraffic(force = false) {
    const z = r3d.active ? 17 : mapc.zoom;
    if (z < 15 || hero.visible) {
      if (traffic.agents.length) {
        traffic.agents = [];
        mapc.setAgents([]);
      }
      trafficAt = null;
      return;
    }
    const center = mapc.center;
    const night = sunPosition(center[0], center[1]).phase === 'night';
    if (!force && trafficAt && distanceM(trafficAt.center, center) < 220 && trafficAt.night === night) return;
    traffic.setArea(center, mapc.roadFeatures(), { night, radius: z >= 17 ? 450 : 700 });
    // Roads may not be loaded yet: only remember this spot once there was something to drive on.
    trafficAt = traffic.lanes.car.length || traffic.lanes.foot.length ? { center, night } : null;
  }
  // The street up close: sidewalks, asphalt, markings and trees, rebuilt as you move.
  let scapeAt = null;
  let scapeRoads = 0;
  let scapeSigns = '';
  let scapeRetry = 0;
  function refreshStreetscape(tries = 0) {
    clearTimeout(scapeRetry);
    if (mapc.zoom < 15.8 || r3d.active) {
      if (scapeAt) mapc.setStreetscape(null);
      scapeAt = null;
      return;
    }
    const center = mapc.center;
    const roads = mapc.roadFeatures();
    const signs = [...registry.state.buildings.values()]
      .filter((r) => r.sign?.text && distanceM(center, [r.lng, r.lat]) < 520)
      .map((r) => ({ lng: r.lng, lat: r.lat, text: r.sign.text, color: SIGN_COLORS[r.sign.color] || SIGN_COLORS[0] }));
    const signKey = signs.map((s) => `${s.lng},${s.lat},${s.text},${s.color}`).join('|');
    // Same spot, no new road tiles and the same billboards: nothing to rebuild.
    if (scapeAt && distanceM(scapeAt, center) < 150 && roads.length <= scapeRoads * 1.1 && signKey === scapeSigns) return;
    scapeSigns = signKey;
    const scape = buildStreetscape(center, roads, mapc.greenFeatures(), { radius: mapc.zoom >= 17 ? 320 : 480, signs });
    mapc.setStreetscape(scape);
    scapeAt = scape.surfaces.features.length ? center : null;
    scapeRoads = roads.length;
    // Road tiles can land after the map settles: look again shortly.
    if (tries < 6) scapeRetry = setTimeout(() => refreshStreetscape(tries + 1), 1500);
  }
  mapc.map.on('moveend', () => mapc.settled().then(() => refreshStreetscape()));

  // Refresh the street network after moving, once the new tiles are in.
  mapc.map.on('moveend', () => mapc.settled().then(() => !r3d.active && refreshTraffic()));
  let lastFrame = 0;
  function animateTraffic(t) {
    requestAnimationFrame(animateTraffic);
    // ~30 fps (movement is smoothed between steps, so it still glides).
    if (document.hidden || t - lastFrame < (reduced ? 200 : 32)) return;
    const dt = Math.min(0.25, (t - (lastFrame || t)) / 1000);
    lastFrame = t;
    if (!traffic.agents.length) return;
    traffic.step(dt);
    const snap = traffic.snapshot();
    if (r3d.active) r3d.setAgents(snap);
    else if (mapc.zoom >= 15) mapc.setAgents(snap);
  }
  requestAnimationFrame(animateTraffic);
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
    // Instant answer from memory (buildings around the view are prefetched).
    const cached = osm.cachedAt(pick.point);
    if (cached) return showBuilding(cached, { tileTop: pick.top });
    // The map tile often knows the exact OSM building already: show it right
    // away and fill in the details (name, photo, fame) in the background.
    if (pick.tileKey && !osm.byKey.has(pick.tileKey)) {
      const provisional = { key: pick.tileKey, tags: {}, polygons: [pick.part], center: pick.point, area: polygonAreaM2(pick.part), provisional: true };
      showBuilding(provisional, { tileTop: pick.top });
      provisional.hydrate = osm
        .buildingsByKeys([pick.tileKey])
        .then((found) => {
          const full = found.get(pick.tileKey);
          if (full && seq === selectSeq && current?.key === full.key) {
            priceCache.delete(full.key);
            showBuilding(full, { tileTop: pick.top, fly: false });
          }
          return full || null;
        })
        .catch(() => null);
      return;
    }
    panel.showPending(pick);
    updatePadding();
    updateHint();
    mapc.setSelection({ key: null, polygons: null, anchor: pick.point, fallback: { part: pick.part, top: pick.top, base: pick.base }, tone: '' });
    try {
      const building = pick.tileKey ? osm.byKey.get(pick.tileKey) : await osm.buildingAt(pick.point, pick.part);
      if (seq !== selectSeq) return;
      // Not in OpenStreetMap's answer: still a building on the map, so identify it by its footprint.
      showBuilding(building || tileBuilding(pick), { tileTop: pick.top });
    } catch (err) {
      if (seq !== selectSeq) return;
      console.warn('[solworld] building lookup failed, using the map footprint', err);
      // OpenStreetMap servers are busy: every building is still buyable, identified by its footprint.
      showBuilding(tileBuilding(pick), { tileTop: pick.top });
    }
  }

  /** A building made from the map tile alone (no OpenStreetMap lookup needed). */
  function tileBuilding(pick, key) {
    const center = interiorPoint(pick.part);
    return {
      key: key || pick.tileKey || geoKey(center),
      tags: { building: 'yes', height: String(pick.top || 5) },
      polygons: [pick.part],
      center,
      area: polygonAreaM2(pick.part),
      fromTiles: true,
    };
  }

  async function openAt(lngLat) {
    const seq = ++selectSeq;
    const pick = await tileBuildingNear(lngLat).catch(() => null);
    if (seq !== selectSeq) return;
    if (pick) selectPick(pick);
    else toast({ title: 'No building right at that address', body: 'Tap the house on the map to open it.', tone: 'info' });
  }

  /** Waits for the map to show `lngLat` up close, then reads the building there from the tiles. */
  async function tileBuildingNear(lngLat) {
    mapc.stopOrbit();
    mapc.map.jumpTo({ center: lngLat, zoom: Math.max(mapc.zoom, 17), pitch: 0 });
    await mapc.settled();
    // Address points often sit a few meters off the building: search outward a little.
    const at = mapc.map.project(lngLat);
    for (const radius of [0, 10, 22, 36]) {
      for (let a = 0; a < (radius ? 8 : 1); a++) {
        const p = { x: at.x + radius * Math.cos((a * Math.PI) / 4), y: at.y + radius * Math.sin((a * Math.PI) / 4) };
        const ll = mapc.map.unproject([p.x, p.y]);
        const pick = mapc.pickAt(p, ll);
        if (pick) return pick;
      }
    }
    return null;
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
      if (r3d.active) r3d.focus({ center: building.center, height: top, polygons: building.polygons, tone: toneFor(building.key) });
      else {
        mapc.flyToBuilding(building.center, { top });
        if (!reduced) mapc.startOrbit();
      }
    }
    geocoder.reverse(building.center).then((address) => panel.setAddress(building.key, address));
    // Photos match the time of day at the building: night photos after dark.
    const night = sunPosition(building.center[0], building.center[1]).phase !== 'day';
    photos.find({ key: building.key, tags: building.tags, center: building.center, night }).then((photo) => {
      panel.setPhoto(building.key, photo);
      if (photo?.exact) skinWithPhoto(building, photo, tileTop);
    });
    solPrice.get().then((usd) => usd && panel.setUsd(usd));
  }

  /** Dresses the selected 3D building in its real photo (lit windows glow after dark). */
  async function skinWithPhoto(building, photo, tileTop) {
    try {
      const url = await photos.corsUrl(photo);
      if (!url || current?.key !== building.key) return;
      const { phase } = sunPosition(building.center[0], building.center[1]);
      const image = await buildingSkin(url, { phase, nightPhoto: !!photo.night });
      if (current?.key !== building.key) return;
      mapc.setSkin({ key: building.key, image, height: Math.max(tileTop || 0, buildingHeights(building.tags).top) });
    } catch (err) {
      console.warn('[solworld] photo texture unavailable', err);
    }
  }

  async function openKey(key, near) {
    if (!isBuildingKey(key)) return;
    hero.hide();
    const seq = ++selectSeq;
    let building = osm.byKey.get(key);
    const rec = registry.state.buildings.get(key);
    near ||= rec ? [rec.lng, rec.lat] : isOsmKey(key) ? undefined : geoKeyCenter(key);
    if (!building && isOsmKey(key)) {
      if (near) mapc.flyTo(near, 16.2);
      const loading = toast({ title: 'Finding building…', tone: 'pending' });
      try {
        building = (await osm.buildingsByKeys([key], { deadlineMs: 7000 })).get(key);
      } catch (err) {
        console.warn('[solworld] building fetch failed', err);
      }
      loading.dismiss();
    }
    if (seq !== selectSeq) return;
    // No OpenStreetMap answer (or a footprint key): read the building straight from the map.
    if (!building && near) {
      const pick = await tileBuildingNear(near).catch(() => null);
      if (seq !== selectSeq) return;
      if (pick) building = tileBuilding(pick, key);
    }
    if (!building) {
      toast({ title: 'Couldn’t find that building', body: 'Try zooming in and tapping it on the map.', tone: 'error' });
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
    r3d.setSelection({});
    r3d.stopOrbit();
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

  /* ------------------------------------------------------ transactions */

  /** Sends one Solworld action from the Solworld wallet (or simulates it in demo). */
  async function sendAction({ lamports = 0, memo, extraRefs = [], demo = {} }) {
    if (!live) {
      const fields = parseMemo(memo) || {};
      const sig = await registry.submit({ ...fields, signers: [me()], transfers: [{ s: me(), d: treasury, l: lamports }], ...demo });
      if (lamports) wallet.adjustDemoBalance(-lamports);
      return sig;
    }
    const { blockhash } = await rpc.getLatestBlockhash();
    const message = actionMessage({ from: me(), treasury, reference: registry.address, lamports, memo, extraRefs, priorityFee: settings.priorityFeeMicroLamports }, blockhash);
    const sig = await wallet.send(message);
    await rpc.confirm(sig);
    return sig;
  }

  /** Runs `fn` with panel/toast progress and reports the registry outcome. */
  async function runAction({ label, pending, success, stage = 'sending', fn, onDone }) {
    panel.setBusy(stage);
    const progress = toast({ title: pending, body: label, tone: 'pending' });
    try {
      const sig = await fn((next) => {
        if (next.stage) panel.setBusy(next.stage);
        if (next.title) progress.update({ title: next.title });
      });
      if (live && sig) progress.update({ link: { href: settings.explorer.tx(sig), label: 'View transaction' } });
      panel.setBusy('indexing');
      const result = await registry.waitFor(sig);
      if (result.ok) {
        progress.update({ tone: 'mine', title: success, body: label, duration: 7000 });
        onDone?.(result);
      } else if (result.void) {
        progress.update({ tone: 'error', title: 'Not recorded', body: `${VOID_REASONS[result.void.reason] || 'It didn’t meet the rules.'}${result.void.paid > 0 ? ' Your payment is flagged for a refund.' : ''}`, duration: 14000 });
      } else {
        progress.update({ tone: 'info', title: 'Still confirming', body: 'It was sent; it will show up as soon as Solana confirms it.', duration: 10000 });
      }
      return result;
    } catch (err) {
      if (isUserRejection(err)) progress.update({ tone: 'info', title: 'Cancelled', body: 'Nothing was sent.', duration: 3000 });
      else {
        console.warn('[solworld] action failed', err);
        progress.update({ tone: 'error', title: 'That didn’t go through', body: friendlyError(err), duration: 10000 });
      }
      return null;
    } finally {
      panel.setBusy(null);
      panel.refresh();
      wallet.refreshBalance();
    }
  }

  async function ensureWallet() {
    if (!wallet.exists && !(await walletUI.open())) return false;
    return ensureConsent(ctx);
  }

  const labelOf = (building) => buildingTitle(building.tags) || `Building ${building.key}`;

  /* ---------------------------------------------------- buy / credit */

  async function acquire(kind) {
    if (!current) return;
    if (current.building.provisional) {
      // Price depends on the full OSM details; wait for them.
      await current.building.hydrate;
      if (!current) return;
    }
    const { building } = current;
    const { key } = building;
    const land = registry.state.territoryAt?.(building.center[0], building.center[1]);
    if (land && !registry.state.buildings.has(key)) return void toast({ title: `Part of ${land.title || land.tier}`, body: `Owned by ${who(land.owner)} as part of their ${land.tier.toLowerCase()}.`, tone: 'info' });
    if (!(await ensureWallet())) return;
    const price = ctx.priceFor(building).lamports;
    const balance = (await wallet.refreshBalance()) ?? 0;
    let extraRefs = [];
    if (kind === 'buy' && balance < price + FEE_BUFFER) return walletUI.deposit({ need: price + FEE_BUFFER - balance });
    if (kind === 'hold') {
      await refreshHolder();
      if (creditLeft() < price) return void toast({ title: 'Not enough credit', body: `This building is ${fmtSol(price)} SOL; you have ${fmtSol(creditLeft())} SOL of credit left.`, tone: 'error' });
      if (live && balance < FEE_BUFFER) return walletUI.deposit({ need: FEE_BUFFER - balance });
      if (live) extraRefs = [holderInfo.account];
    }
    await registry.sync().catch(() => {});
    if (registry.state.buildings.has(key)) return void toast({ title: 'Already owned', body: 'Someone just got this building. Make them an offer instead.', tone: 'error' });
    const memo = buildMemo(kind, { key, center: building.center, price });
    const demo = kind === 'hold' ? { tokens: [{ owner: linkedHolder(), mint: DEMO_COIN.mint, amount: DEMO_HOLDINGS }] } : {};
    await runAction({
      label: labelOf(building),
      pending: kind === 'hold' ? 'Using your holder credit' : `Buying for ${fmtSol(price)} SOL`,
      success: 'It’s yours!',
      fn: () => sendAction({ lamports: kind === 'buy' ? price : 0, memo, extraRefs, demo }),
      onDone: () => {
        mapc.pulse(building.center, COLORS.mine);
        celebrate();
        if (!live) scheduleDemoBidder(key, price);
      },
    });
  }

  /* ----------------------------------------------------------- market */

  /** Finds (or creates) the building's nonce account whose authority is the owner. */
  async function usableNonce(rec, report) {
    const candidates = [];
    if (rec.nonce) candidates.push(rec.nonce);
    for (let n = 0; n < 4; n++) candidates.push(await nonceAddressFor(me(), rec.key, n));
    for (let i = 0; i < candidates.length; i++) {
      const address = candidates[i];
      const account = await rpc.getAccountInfo(address);
      const info = account && parseNonceAccount(account.data);
      if (info?.authority === rec.owner) return { nonce: address, value: info.value };
      if (!account && i > 0) {
        report({ stage: 'nonce', title: 'Setting up offers for this building' });
        const n = i - (rec.nonce ? 1 : 0);
        const lamports = await rpc.getMinimumBalanceForRentExemption(80);
        const { blockhash } = await rpc.getLatestBlockhash();
        const sig = await wallet.send(createNonceMessage({ payer: me(), nonce: address, key: rec.key, n, lamports, authority: rec.owner, recentBlockhash: blockhash }));
        await rpc.confirm(sig);
        const created = parseNonceAccount((await rpc.getAccountInfo(address))?.data);
        if (!created) throw new Error('Could not set up the offer account. Please try again.');
        return { nonce: address, value: created.value };
      }
    }
    throw new Error('Could not set up offers for this building.');
  }

  async function makeOffer(price) {
    if (!current) return;
    const { building } = current;
    if (!(await ensureWallet())) return;
    const rec = registry.state.buildings.get(building.key);
    if (!rec) return;
    if (rec.owner === me()) return;
    const balance = (await wallet.refreshBalance()) ?? 0;
    const setup = live && !rec.nonce ? 1_500_000 : 0;
    if (balance < price + setup + FEE_BUFFER) return walletUI.deposit({ need: price + setup + FEE_BUFFER - balance });
    await runAction({
      label: `${fmtSol(price)} SOL for ${labelOf(building)}`,
      pending: 'Sending your offer',
      success: 'Offer sent',
      stage: 'signing',
      fn: async (report) => {
        if (!live) {
          const sig = await registry.submit({ action: 'offer', key: rec.key, price, nonce: 'demo', nonceValue: 'demo', buyerSig: 'demo', signers: [me()], transfers: [{ s: me(), d: treasury, l: 0 }], tokens: [] });
          scheduleDemoAcceptance(rec.key, price);
          return sig;
        }
        const { nonce, value } = await usableNonce(rec, report);
        report({ stage: 'signing' });
        const sale = buildSaleMessage({ buyer: me(), seller: rec.owner, treasury, reference: registry.address, key: rec.key, price, feeBps: settings.feeBps, nonce, nonceValue: value });
        const buyerSig = base58Encode(await wallet.sign(sale.bytes));
        report({ stage: 'sending', title: 'Publishing your offer' });
        return sendAction({ memo: buildMemo('offer', { key: rec.key, price, nonce, nonceValue: value, buyerSig }) });
      },
      onDone: () => toast({ title: 'Keep the SOL in your wallet', body: 'If the owner accepts, the swap happens instantly. Cancel any time before that.', tone: 'info', duration: 7000 }),
    });
  }

  async function acceptOffer(offer) {
    const rec = registry.state.buildings.get(offer.key);
    if (!rec || rec.owner !== me()) return;
    const building = current?.key === offer.key ? current.building : { key: offer.key, tags: {} };
    const fee = saleFee(offer.price, settings.feeBps);
    await runAction({
      label: `${fmtSol(offer.price)} SOL from ${who(offer.buyer)} · you receive ${fmtSol(offer.price - fee)} SOL`,
      pending: 'Accepting offer',
      success: `Sold for ${fmtSol(offer.price)} SOL`,
      fn: async () => {
        if (!live) {
          const sig = await registry.submit({
            action: 'sale',
            key: offer.key,
            price: offer.price,
            signers: [offer.buyer, me()],
            transfers: [
              { s: offer.buyer, d: me(), l: offer.price - fee },
              { s: offer.buyer, d: treasury, l: fee },
            ],
            tokens: [],
          });
          wallet.adjustDemoBalance(offer.price - fee);
          return sig;
        }
        const account = await rpc.getAccountInfo(offer.nonce);
        const info = account && parseNonceAccount(account.data);
        if (!info || info.value !== offer.nonceValue) throw new FriendlyError('This offer has expired (another sale happened). Ask them to offer again.');
        if (info.authority !== me()) throw new FriendlyError('This offer was made to a previous owner.');
        const buyerBalance = await rpc.getBalance(offer.buyer);
        if (buyerBalance < offer.price + 10_000) throw new FriendlyError('The buyer no longer has enough SOL for this offer.');
        // The buyer pre-signed the split at the fee rate of the time (it was 5% before the 1% change).
        const buyerSig = base58Decode(offer.buyerSig);
        let sale = null;
        for (const feeBps of [...new Set([settings.feeBps, 500, 100])]) {
          const m = buildSaleMessage({ buyer: offer.buyer, seller: me(), treasury, reference: registry.address, key: offer.key, price: offer.price, feeBps, nonce: offer.nonce, nonceValue: offer.nonceValue });
          if (await verifySignature(buyerSig, m.bytes, offer.buyer)) {
            sale = m;
            break;
          }
        }
        if (!sale) throw new FriendlyError('This offer’s signature is invalid.');
        const wire = serializeUnsignedTransaction(sale);
        placeSignature(wire, sale, offer.buyer, buyerSig);
        await wallet.signInto(wire, sale);
        const sig = await rpc.sendRawTransaction(wire);
        await rpc.confirm(sig);
        return sig;
      },
      onDone: () => {
        celebrate();
        if (building.center) mapc.pulse(building.center, COLORS.owned);
      },
    });
  }

  async function cancelOffer(offer) {
    await runAction({
      label: `${fmtSol(offer.price)} SOL offer`,
      pending: 'Cancelling offer',
      success: 'Offer cancelled',
      fn: () => sendAction({ memo: buildMemo('cancel', { ref: offer.sig }) }),
      onDone: () =>
        live &&
        toast({ title: 'Tip', body: 'Cancelling hides the offer everywhere. To be 100% sure it can never execute, keep your balance below the offer amount.', tone: 'info', duration: 8000 }),
    });
  }

  /** City takeover: buy all the land in a box in one transaction. */
  async function buyLand({ bbox, price, count, title }) {
    if (!(await ensureWallet())) return false;
    const balance = (await wallet.refreshBalance()) ?? 0;
    if (balance < price + FEE_BUFFER) {
      walletUI.deposit({ need: price + FEE_BUFFER - balance });
      return false;
    }
    const memo = buildMemo('land', { bbox, price, count, title });
    const land = parseMemo(memo);
    const name = land.title || `${who(me())}’s ${tierFor(count).toLowerCase()}`;
    const result = await runAction({
      label: `${name} · ${fmtInt(count)} buildings`,
      pending: `Taking over ${fmtSol(price)} SOL of land`,
      success: `You founded ${name}, a ${tierFor(count).toLowerCase()}!`,
      fn: () => sendAction({ lamports: price, memo }),
      onDone: () => {
        celebrate();
        mapc.flyToExtent([bbox[0], bbox[3], bbox[2], bbox[1]], { maxZoom: 16 });
      },
    });
    return !!result?.ok;
  }

  async function setName(name) {
    if (!(await ensureWallet())) return false;
    const memo = buildMemo('name', { name });
    const clean = parseMemo(memo)?.name ?? '';
    const result = await runAction({ label: clean || 'Name removed', pending: 'Saving your name', success: clean ? `You’re “${clean}” now` : 'Name removed', fn: () => sendAction({ memo }) });
    return !!result?.ok;
  }

  async function setSign({ text, color }) {
    if (!current) return;
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const memo = buildMemo('sign', { key: current.key, color, text: clean });
    if (!parseMemo(memo)) return void toast({ title: 'That sign is too long', body: 'Use up to 60 characters (emoji count extra).', tone: 'error' });
    await runAction({ label: clean ? `“${clean}”` : 'Billboard removed', pending: 'Putting up your billboard', success: 'Billboard is live', fn: () => sendAction({ memo }) });
  }

  /* --------------------------------------------------- wallet actions */

  async function withdraw(to, value) {
    if (!live) {
      const bal = wallet.balance ?? 0;
      const amount = value === 'max' ? bal : value;
      if (amount > bal) throw new Error('Not enough SOL in your Solworld wallet.');
      wallet.adjustDemoBalance(-amount);
      return null;
    }
    const sig = await wallet.withdraw(to, value, { priorityFee: settings.priorityFeeMicroLamports });
    rpc.confirm(sig).then(() => wallet.refreshBalance()).catch(() => {});
    return sig;
  }

  async function sendExternalTransfer(lamports) {
    const { blockhash } = await rpc.getLatestBlockhash();
    const message = compileMessage({ payer: ext.address, recentBlockhash: blockhash, instructions: [transferInstruction({ from: ext.address, to: me(), lamports })] });
    const sig = await ext.signAndSend(serializeUnsignedTransaction(message));
    rpc.confirm(sig).then(() => wallet.refreshBalance()).catch(() => {});
    return sig;
  }

  async function holderTokens(address) {
    const coin = registry.state.coin;
    if (!coin) throw new Error('No meme coin is set up yet.');
    if (!live) return { tokens: DEMO_HOLDINGS, account: null };
    const accounts = await rpc.getTokenAccountsByOwner(address, coin.mint);
    const best = accounts.sort((a, b) => b.amount - a.amount)[0];
    return { tokens: best?.amount || 0, account: best?.address || null };
  }

  async function refreshHolder() {
    const holder = linkedHolder();
    if (!holder) return (holderInfo = null);
    try {
      const t = await holderTokens(holder);
      holderInfo = { holder, ...t };
    } catch (err) {
      console.warn('[solworld] holder balance failed', err);
    }
    walletUI.render();
    panel.refresh();
    return holderInfo;
  }

  async function holderPreview(address) {
    const coin = registry.state.coin;
    const { tokens } = await holderTokens(address);
    const value = Math.floor(tokens * tokenPriceAt(coin.prices, Math.floor(Date.now() / 1000)));
    return { tokens, value, left: Math.max(0, value - (registry.state.holderSpent.get(address) || 0)) };
  }

  async function linkHolder(address, pick) {
    if (!(await ensureWallet())) return false;
    if (!live) {
      await registry.submit({ action: 'link', holder: address, signers: [me(), address], transfers: [{ s: me(), d: treasury, l: 0 }], tokens: [] });
      await refreshHolder();
      toast({ title: `$${settings.memecoinView.symbol} linked`, body: `${fmtSol(creditLeft())} SOL of credit ready to spend.`, tone: 'mine' });
      return true;
    }
    const account = await pick({ title: 'Verify your holder wallet', reason: `Connect ${shortAddr(address, 6, 6)} and approve one signature. It moves no tokens.` });
    if (!account) return false;
    try {
      if (ext.address !== address) throw new Error(`You connected ${shortAddr(ext.address)} — switch your wallet app to ${shortAddr(address)} and try again.`);
      const topUp = (wallet.balance ?? 0) < 1_000_000 ? 2_000_000 : 0;
      const { blockhash } = await rpc.getLatestBlockhash();
      const message = compileMessage({
        payer: address,
        recentBlockhash: blockhash,
        instructions: [
          transferInstruction({ from: me(), to: treasury, lamports: 0, references: [registry.address] }),
          ...(topUp ? [transferInstruction({ from: address, to: me(), lamports: topUp })] : []),
          memoInstruction(buildMemo('link', { holder: address }), [address]),
        ],
      });
      const signed = await ext.signTransaction(serializeUnsignedTransaction(message));
      await wallet.signInto(signed, message);
      const sig = await rpc.sendRawTransaction(signed);
      await rpc.confirm(sig);
      const result = await registry.waitFor(sig);
      if (!result.ok) throw new Error('The link wasn’t recorded. Please try again.');
      await refreshHolder();
      toast({ title: `$${settings.memecoinView.symbol} linked`, body: `${fmtSol(creditLeft())} SOL of credit ready.${topUp ? ' We also moved 0.002 SOL over for network fees.' : ''}`, tone: 'mine', duration: 8000 });
      return true;
    } finally {
      ext.disconnect().catch(() => {});
    }
  }

  /* --------------------------------------------------------- operator */

  async function ensureTreasuryWallet() {
    if (ext.address === settings.treasury) return true;
    const account = await walletUI.pickExternal({ title: 'Connect your treasury wallet', reason: `Operator actions are signed by ${shortAddr(settings.treasury, 6, 6)}.` });
    if (!account) return false;
    if (ext.address !== settings.treasury) {
      toast({ title: 'That’s not the treasury wallet', body: `Connect ${shortAddr(settings.treasury, 6, 6)} in your wallet app.`, tone: 'error' });
      await ext.disconnect();
      return false;
    }
    return true;
  }

  async function operatorAction(action, ref, lamports, to, btn) {
    if (!live) return void toast({ title: 'Demo mode', body: 'Operator actions need a live treasury.', tone: 'info' });
    if (!(await ensureTreasuryWallet())) return;
    btn?.setAttribute('disabled', '');
    const progress = toast({ title: action === 'refund' ? 'Sending refund' : 'Revoking', body: `Approve in your treasury wallet${lamports ? ` (${fmtSol(lamports)} SOL)` : ''}.`, tone: 'pending' });
    try {
      const { blockhash } = await rpc.getLatestBlockhash();
      const message = compileMessage({
        payer: settings.treasury,
        recentBlockhash: blockhash,
        instructions: [transferInstruction({ from: settings.treasury, to, lamports: Math.max(0, lamports), references: [registry.address] }), memoInstruction(buildMemo(action, { ref }))],
      });
      const sig = await ext.signAndSend(serializeUnsignedTransaction(message));
      await rpc.confirm(sig);
      await registry.sync().catch(() => {});
      progress.update({ tone: 'success', title: action === 'refund' ? 'Refunded' : 'Revoked', body: '', link: { href: settings.explorer.tx(sig), label: 'View transaction' } });
      btn?.replaceWith(h('span', { class: 'chip chip--xs' }, 'Done'));
    } catch (err) {
      btn?.removeAttribute('disabled');
      progress.update({ tone: isUserRejection(err) ? 'info' : 'error', title: isUserRejection(err) ? 'Cancelled' : 'Failed', body: isUserRejection(err) ? '' : friendlyError(err) });
    }
  }

  /** Operator: publish the meme coin (mint, ticker, SOL per token) on-chain. */
  async function setCoin({ mint, symbol, sol }, btn) {
    const memo = buildMemo('coin', { mint, symbol, lamportsPerToken: sol * 1e9 });
    if (!parseMemo(memo)) return void toast({ title: 'Check the coin details', body: 'Mint must be a Solana address, ticker 1–12 letters/numbers, price a positive number.', tone: 'error' });
    if (!live) {
      await registry.submit({ ...parseMemo(memo), signers: [DEMO_TREASURY], transfers: [{ s: DEMO_TREASURY, d: DEMO_TREASURY, l: 0 }], tokens: [] });
      toast({ title: `$${symbol} is live (demo)`, body: 'Holders can now use it as building credit.', tone: 'success' });
      return true;
    }
    if (!(await ensureTreasuryWallet())) return false;
    btn?.setAttribute('disabled', '');
    const progress = toast({ title: 'Saving your coin', body: 'Approve in your treasury wallet (no SOL is moved).', tone: 'pending' });
    try {
      const { blockhash } = await rpc.getLatestBlockhash();
      const message = compileMessage({
        payer: settings.treasury,
        recentBlockhash: blockhash,
        instructions: [transferInstruction({ from: settings.treasury, to: settings.treasury, lamports: 0, references: [registry.address] }), memoInstruction(memo)],
      });
      const sig = await ext.signAndSend(serializeUnsignedTransaction(message));
      await rpc.confirm(sig);
      await registry.waitFor(sig);
      progress.update({ tone: 'success', title: `$${symbol} is live`, body: 'Holders can now use it as building credit.', link: { href: settings.explorer.tx(sig), label: 'View transaction' } });
      walletUI.render();
      panel.refresh();
      return true;
    } catch (err) {
      progress.update({ tone: isUserRejection(err) ? 'info' : 'error', title: isUserRejection(err) ? 'Cancelled' : 'Failed', body: isUserRejection(err) ? '' : friendlyError(err) });
      return false;
    } finally {
      btn?.removeAttribute('disabled');
    }
  }

  /** Operator: publish a treasury-signed setting memo (no SOL moves). */
  async function publishSetting(memo, doneTitle, btn) {
    if (!parseMemo(memo)) return void toast({ title: 'That doesn’t look right', body: 'Check what you pasted and try again.', tone: 'error' });
    if (!live) {
      await registry.submit({ ...parseMemo(memo), signers: [DEMO_TREASURY], transfers: [{ s: DEMO_TREASURY, d: DEMO_TREASURY, l: 0 }], tokens: [] });
      toast({ title: doneTitle, tone: 'success' });
      return true;
    }
    if (!(await ensureTreasuryWallet())) return false;
    btn?.setAttribute('disabled', '');
    const progress = toast({ title: 'Saving', body: 'Approve in your treasury wallet (no SOL is moved).', tone: 'pending' });
    try {
      const { blockhash } = await rpc.getLatestBlockhash();
      const message = compileMessage({
        payer: settings.treasury,
        recentBlockhash: blockhash,
        instructions: [transferInstruction({ from: settings.treasury, to: settings.treasury, lamports: 0, references: [registry.address] }), memoInstruction(memo)],
      });
      const sig = await ext.signAndSend(serializeUnsignedTransaction(message));
      await rpc.confirm(sig);
      await registry.waitFor(sig);
      progress.update({ tone: 'success', title: doneTitle, body: '', link: { href: settings.explorer.tx(sig), label: 'View transaction' } });
      return true;
    } catch (err) {
      progress.update({ tone: isUserRejection(err) ? 'info' : 'error', title: isUserRejection(err) ? 'Cancelled' : 'Failed', body: isUserRejection(err) ? '' : friendlyError(err) });
      return false;
    } finally {
      btn?.removeAttribute('disabled');
    }
  }

  /**
   * Checks a Google key the way the site uses it, from this page (so the
   * website restriction is tested too). Returns [{ name, ok, detail, fix }].
   */
  async function testGoogleKey(key) {
    key ||= settings.realistic3d.googleKey || registry.state.key3d;
    if (!key) return [{ name: 'Google key', ok: false, detail: 'No key saved yet.', fix: 'Paste your key above and tap Save key.' }];
    const out = [];
    try {
      const res = await fetch(`https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent(key)}`);
      let detail = `HTTP ${res.status}`;
      try {
        const j = await res.clone().json();
        if (j?.error?.message) detail = j.error.message;
      } catch {
        // not JSON
      }
      out.push({ name: 'Realistic 3D (Map Tiles API)', ok: res.ok, detail: res.ok ? 'Working' : detail, fix: res.ok ? '' : 'Enable “Map Tiles API”, link billing, and allow this website in the key’s restrictions.' });
    } catch (err) {
      out.push({ name: 'Realistic 3D (Map Tiles API)', ok: false, detail: err.message, fix: 'Check your connection and try again.' });
    }
    try {
      const probe = new StreetDrop({ root: document.createElement('div') });
      probe.setKey(key);
      await probe.check();
      out.push({ name: 'Walk the street (Maps JavaScript API)', ok: true, detail: 'Working', fix: '' });
    } catch (err) {
      out.push({ name: 'Walk the street (Maps JavaScript API)', ok: false, detail: err.message, fix: 'Enable “Maps JavaScript API” on the same project and allow it in the key’s API restrictions.' });
    }
    return out;
  }

  /** Current market price of a token in SOL (DexScreener), to prefill the operator form. */
  async function coinMarket(mint) {
    const res = await fetch(`${settings.services.dexscreener}${encodeURIComponent(mint)}`);
    if (!res.ok) throw new Error('Price lookup failed');
    const json = await res.json();
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const pairs = (json.pairs || []).filter((p) => p.baseToken?.address === mint && p.quoteToken?.address === SOL_MINT && Number(p.priceNative) > 0);
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    if (!pairs.length) throw new Error('No SOL trading pair found for this token yet.');
    return { sol: Number(pairs[0].priceNative), symbol: pairs[0].baseToken.symbol, liquidityUsd: pairs[0].liquidity?.usd || 0 };
  }

  async function audit(box, btn) {
    btn?.setAttribute('disabled', '');
    box.replaceChildren(h('div', { class: 'search-loading' }, h('span', { class: 'spinner' }), 'Recomputing prices from OpenStreetMap…'));
    const recs = [...registry.state.buildings.values()].filter((b) => isOsmKey(b.key) && b.acquired !== 'sale' && !b.seed).slice(-300);
    try {
      const found = await osm.buildingsByKeys(recs.map((r) => r.key));
      const flagged = [];
      for (const r of recs) {
        const b = found.get(r.key);
        if (!b) continue;
        const expected = priceBuilding(b).lamports;
        const moved = distanceM(b.center, [r.lng, r.lat]) > 120 && !b.polygons.some((p) => pointInPolygon([r.lng, r.lat], p));
        if (r.price < expected * 0.8 || moved) flagged.push({ r, expected, moved });
      }
      box.replaceChildren(
        ...(flagged.length
          ? flagged.map(({ r, expected, moved }) =>
              h(
                'div',
                { class: 'op-refund' },
                avatar(r.owner, 26),
                h('div', { class: 'grow' }, h('div', { class: 'mono' }, `${r.key} · ${who(r.owner)}`), h('small', null, moved ? 'Location in the memo doesn’t match the building' : `Paid ${fmtSol(r.price)} SOL, price is ${fmtSol(expected)} SOL`)),
                h('button', { class: 'btn btn--ghost btn--sm', onclick: (e) => operatorAction('revoke', r.sig, r.acquired === 'buy' ? r.price : 0, r.owner, e.currentTarget) }, r.acquired === 'buy' ? 'Revoke & refund' : 'Revoke'),
              ),
            )
          : [h('p', { class: 'op-empty' }, `All ${fmtInt(recs.length)} purchases checked — nothing underpriced.`)]),
      );
    } catch (err) {
      box.replaceChildren(h('p', { class: 'op-empty' }, `Audit failed: ${friendlyError(err)}`));
    } finally {
      btn?.removeAttribute('disabled');
    }
  }

  /* ------------------------------------------------------------- demo */

  function scheduleDemoBidder(key, price) {
    setTimeout(async () => {
      if (registry.state.buildings.get(key)?.owner !== me()) return;
      const bidder = base58Encode(await sha256(`solworld/demo-bidder/${key}`));
      const offer = Math.round((price * (1.3 + Math.random() * 0.9)) / 1e5) * 1e5;
      await registry.submit({ action: 'offer', key, price: offer, nonce: 'demo', nonceValue: 'demo', buyerSig: 'demo', signers: [bidder], transfers: [{ s: bidder, d: treasury, l: 0 }], tokens: [] });
    }, 9000 + Math.random() * 6000);
  }

  function scheduleDemoAcceptance(key, price) {
    setTimeout(async () => {
      const rec = registry.state.buildings.get(key);
      if (!rec || rec.owner === me() || price < rec.price * 1.1 || (wallet.balance ?? 0) < price) return;
      const fee = saleFee(price, settings.feeBps);
      await registry.submit({ action: 'sale', key, price, signers: [me(), rec.owner], transfers: [{ s: me(), d: rec.owner, l: price - fee }, { s: me(), d: treasury, l: fee }], tokens: [] });
      wallet.adjustDemoBalance(-price);
    }, 5000 + Math.random() * 4000);
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
    const need = records.filter((r) => isOsmKey(r.key) && !mapc.outlines.has(r.key) && !outlineMisses.has(r.key));
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
  // Load the buildings around the view in the background so taps are instant.
  const prefetchView = debounce(() => {
    const z = mapc.zoom;
    if (z < 16.2 || mapc.map.isMoving()) return;
    osm.prefetchArea(mapc.center, z >= 17 ? 160 : 230);
  }, 700);
  mapc.map.on('moveend', prefetchView);
  mapc.map.on('moveend', scheduleOutlines);

  /* --------------------------------------------------------- wiring */

  const toastedOffers = new Set();
  function syncOwnershipViews({ fresh = [], initial = false } = {}) {
    const state = registry.state;
    const records = [...state.buildings.values()];
    mapc.setOwnership(records, me());
    mapc.setTerritories(state.territories || [], me(), who);
    refreshStreetscape(); // billboards may have changed
    if (current) mapc.setSelection({ key: current.key, polygons: current.building.polygons, anchor: current.building.center, tone: toneFor(current.key) });
    if (current && r3d.active) r3d.setSelection({ polygons: current.building.polygons, height: Math.max(current.tileTop || 0, buildingHeights(current.building.tags).top), tone: toneFor(current.key) });
    if (!settings.realistic3d.googleKey && registry.state.key3d) {
      r3d.setKey(registry.state.key3d);
      street.setKey(registry.state.key3d);
      paint3DButton();
    }
    rail.render();
    stats.update(state.totals);
    hero.update(state.totals);
    walletUI.render();
    panel.refresh();
    scheduleOutlines();
    if (initial) {
      for (const o of ctx.incomingOffers()) toastedOffers.add(o.sig);
      return;
    }
    const news = [];
    for (const ev of fresh) {
      const rec = state.bySig.get(ev.sig)?.record;
      if (!rec || ev.seed) continue;
      if (rec.kind === 'offer' && rec.buyer !== me() && state.buildings.get(rec.key)?.owner === me() && !toastedOffers.has(rec.sig)) {
        toastedOffers.add(rec.sig);
        toast({
          title: `New offer: ${fmtSol(rec.price)} SOL`,
          body: `${who(rec.buyer)} wants ${buildingLabel(rec.key)}. Open it to accept.`,
          tone: 'mine',
          duration: 12000,
          action: { label: 'View', onClick: () => ctx.onOpenOffer(rec) },
        });
      } else if (rec.kind === 'sale' && rec.seller === me()) {
        toast({ title: `You sold a building for ${fmtSol(rec.price)} SOL`, body: `${buildingLabel(rec.key)} · the SOL is in your Solworld wallet.`, tone: 'mine', duration: 9000 });
        wallet.refreshBalance();
      } else if ((rec.kind === 'buy' || rec.kind === 'hold' || rec.kind === 'sale') && rec.owner !== me()) news.push(rec);
    }
    if (news.length > 2) toast({ title: `${news.length} buildings just changed hands`, body: 'See the Activity tab for details.', tone: 'owned', duration: 4500 });
    else for (const r of news) toast({ title: `${who(r.owner)} ${r.kind === 'sale' ? 'bought from an owner' : 'got a building'}`, body: `${placeLabel(r.lat, r.lng)} · ${fmtSol(r.price)} SOL`, tone: 'owned', duration: 4500 });
  }

  function buildingLabel(key) {
    const b = osm.byKey.get(key);
    const rec = registry.state.buildings.get(key);
    return (b && buildingTitle(b.tags)) || (rec ? `a building in ${placeLabel(rec.lat, rec.lng)}` : 'your building');
  }

  registry.on('change', syncOwnershipViews);
  registry.on('status', paintNet);
  wallet.on('change', () => {
    syncOwnershipViews({ initial: true });
    refreshHolder();
  });
  wallet.on('balance', () => {
    walletUI.render();
    panel.refresh();
  });

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
    const m = /^#\/b\/([wrg][1-9]\d{0,15})$/.exec(location.hash);
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
      refreshHolder();
    })
    .catch((err) => {
      console.error('[solworld] registry failed to start', err);
      toast({ title: 'Can’t read the registry', body: friendlyError(err), tone: 'error' });
    });
  addEventListener('online', () => registry.sync().catch(() => {}));
  if (wallet.exists) wallet.refreshBalance();
  // Keep the Solworld wallet balance fresh (deposits arrive from outside).
  setInterval(() => wallet.exists && document.visibilityState === 'visible' && wallet.refreshBalance(), live ? 30_000 : 60_000);

  // Handy for debugging from the console.
  window.solworld = { settings, registry, wallet, ext, map: mapc, osm, ctx, r3d, traffic, street, takeover, refreshStreetscape };
}

/* -------------------------------------------------------------- demo */

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

async function demoSeeds(osm) {
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
  const events = [];
  const used = new Set();
  const signs = ['gm from the top', 'Not for sale', 'WAGMI', 'Solworld HQ'];
  buildings
    .filter((x) => x.building && !used.has(x.building.key) && used.add(x.building.key))
    .forEach(({ building, index }, n, list) => {
      const buyer = owners[OWNER_PATTERN[index % OWNER_PATTERN.length]];
      const time = now - (list.length - n) * 9 * 3600 - Math.floor(Math.random() * 3600);
      const price = priceBuilding(building).lamports;
      const base = { slot: 0, time, signers: [buyer], tokens: [], pre: {} };
      events.push({ ...base, sig: `demo-seed-${index}`, action: 'buy', key: building.key, lat: building.center[1], lng: building.center[0], price, transfers: [{ s: buyer, d: DEMO_TREASURY, l: price }] });
      if (n % 3 === 0) {
        events.push({ ...base, time: time + 60, sig: `demo-seed-sign-${index}`, action: 'sign', key: building.key, color: n % 8, text: signs[(n / 3) % signs.length], transfers: [{ s: buyer, d: DEMO_TREASURY, l: 0 }] });
      }
    });
  return events;
}

boot();
