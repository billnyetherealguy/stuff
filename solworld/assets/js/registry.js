// The Solworld registry.
//
// There is no server and no database: the Solana ledger is the source of truth.
// Every Solworld action is one transaction that sends SOL (possibly 0) to the
// treasury with the registry "reference" key attached (so all of them can be
// listed with getSignaturesForAddress(registry)) and carries a memo:
//
//   solworld:buy:<key>@<lat>,<lng>;p=<lamports>       buy an unowned building
//   solworld:hold:<key>@<lat>,<lng>;p=<lamports>      take one using meme-coin credit
//   solworld:link:<holder>                            link a holder wallet (both sign)
//   solworld:offer:<key>;p=..;n=<nonce>;v=<value>;s=<buyer signature of the sale>
//   solworld:cancel:<offer signature>
//   solworld:sale:<key>;p=<lamports>                  atomic sale, signed by buyer and owner
//   solworld:sign:<key>;c=<color>;t=<text>            owner's billboard
//   solworld:revoke:<signature>                       treasury voids an action
//   solworld:refund:<signature>                       treasury refunded a payment
//
// Every browser replays these in order with the same rules, so everyone sees
// the same owners. Building keys are OpenStreetMap ids: "w123" / "r456".

import { Emitter } from './emitter.js';
import {
  MEMO_PROGRAM,
  MEMO_PROGRAM_V1,
  SYSTEM_PROGRAM,
  base58Decode,
  base58Encode,
  mapLimit,
  sha256,
} from './solana.js';

const KEY = '[wr][1-9]\\d{0,15}';
const ADDR = '[1-9A-HJ-NP-Za-km-z]{32,44}';
const SIG = '[1-9A-HJ-NP-Za-km-z]{64,90}';
const COORD = '(-?\\d{1,2}(?:\\.\\d{1,8})?),(-?\\d{1,3}(?:\\.\\d{1,8})?)';
const CACHE_VERSION = 3;

const MEMOS = {
  buy: new RegExp(`^(${KEY})@${COORD};p=(\\d{1,13})$`),
  hold: new RegExp(`^(${KEY})@${COORD};p=(\\d{1,13})$`),
  link: new RegExp(`^(${ADDR})$`),
  offer: new RegExp(`^(${KEY});p=(\\d{1,13});n=(${ADDR});v=(${ADDR});s=(${SIG})$`),
  cancel: new RegExp(`^(${SIG})$`),
  sale: new RegExp(`^(${KEY});p=(\\d{1,13})$`),
  sign: new RegExp(`^(${KEY});c=([0-7]);t=([A-Za-z0-9%._~!*'()-]{0,240})$`),
  revoke: new RegExp(`^(${SIG})$`),
  refund: new RegExp(`^(${SIG})$`),
  coin: new RegExp(`^(${ADDR});s=([A-Za-z0-9]{1,12});p=(\\d{1,13}(?:\\.\\d{1,9})?)$`),
};

export const MIN_PRICE = 1_000_000; // protocol floor: 0.001 SOL
export const SIGN_COLORS = ['#2af5a8', '#8f6bff', '#5ad1ff', '#ffd166', '#ff6b9a', '#ff8a3d', '#ffffff', '#b8ff5a'];
export const isBuildingKey = (key) => typeof key === 'string' && new RegExp(`^${KEY}$`).test(key);

const fixed = (n) => Number(n).toFixed(6);

export function buildMemo(action, fields) {
  switch (action) {
    case 'buy':
    case 'hold': {
      const { key, center, price } = fields;
      if (!isBuildingKey(key)) throw new Error(`Invalid building key: ${key}`);
      const [lng, lat] = center;
      if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) throw new Error('Invalid coordinates');
      return `solworld:${action}:${key}@${fixed(lat)},${fixed(lng)};p=${Math.round(price)}`;
    }
    case 'link':
      return `solworld:link:${fields.holder}`;
    case 'offer':
      return `solworld:offer:${fields.key};p=${Math.round(fields.price)};n=${fields.nonce};v=${fields.nonceValue};s=${fields.buyerSig}`;
    case 'sale':
      return `solworld:sale:${fields.key};p=${Math.round(fields.price)}`;
    case 'sign':
      return `solworld:sign:${fields.key};c=${fields.color};t=${encodeURIComponent(fields.text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
    case 'cancel':
    case 'revoke':
    case 'refund':
      return `solworld:${action}:${fields.ref}`;
    case 'coin': {
      // Operator setting: the meme coin and what one token is worth (lamports, up to 9 decimals).
      const lpt = Number(fields.lamportsPerToken).toFixed(9).replace(/\.?0+$/, '');
      return `solworld:coin:${fields.mint};s=${String(fields.symbol).replace(/^\$/, '')};p=${lpt}`;
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

export function parseMemo(text) {
  if (typeof text !== 'string') return null;
  const m = /^solworld:([a-z]+):(.*)$/.exec(text.trim());
  if (!m || !MEMOS[m[1]]) return null;
  const action = m[1];
  const g = MEMOS[action].exec(m[2]);
  if (!g) return null;
  switch (action) {
    case 'buy':
    case 'hold': {
      const lat = Number(g[2]);
      const lng = Number(g[3]);
      if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) return null;
      return { action, key: g[1], lat, lng, price: Number(g[4]) };
    }
    case 'link':
      return { action, holder: g[1] };
    case 'offer':
      return { action, key: g[1], price: Number(g[2]), nonce: g[3], nonceValue: g[4], buyerSig: g[5] };
    case 'sale':
      return { action, key: g[1], price: Number(g[2]) };
    case 'sign': {
      let text = '';
      try {
        text = decodeURIComponent(g[3]);
      } catch {
        return null;
      }
      return { action, key: g[1], color: Number(g[2]), text: text.slice(0, 60) };
    }
    case 'coin':
      return { action, mint: g[1], symbol: g[2], lamportsPerToken: Number(g[3]) };
    default:
      return { action, ref: g[1] };
  }
}

/** Deterministic, per-treasury registry reference key (not a wallet; nobody holds its key). */
export async function deriveRegistryAddress(treasury) {
  return base58Encode(await sha256(`solworld/registry/v1/${treasury}`));
}

/** Marketplace fee (lamports) on a sale at `price`. */
export const saleFee = (price, feeBps) => Math.ceil((price * feeBps) / 10_000);

/** Lamports of credit per whole token at unix time `time` (config schedule). */
export function tokenPriceAt(schedule, time) {
  let price = 0;
  for (const e of schedule || []) {
    if (time == null || e.from <= time) price = e.lamportsPerToken;
    else break;
  }
  return price;
}

/**
 * Turns a jsonParsed transaction into a registry event, or null when it is
 * not a well-formed Solworld action. Rules are applied later in computeState.
 */
export function parseRegistryTransaction(tx, signature) {
  if (!tx?.transaction?.message || !tx.meta || tx.meta.err) return null;
  const message = tx.transaction.message;
  const keys = (message.accountKeys || []).map((k) => (typeof k === 'string' ? { pubkey: k } : k));
  const numSigners = message.header?.numRequiredSignatures ?? 1;
  const signers = keys.filter((k, i) => k.signer ?? i < numSigners).map((k) => k.pubkey);

  let memo = null;
  const transfers = [];
  for (const ix of message.instructions || []) {
    const programId = ix.programId;
    if (programId === MEMO_PROGRAM || programId === MEMO_PROGRAM_V1 || ix.program === 'spl-memo') {
      let text = typeof ix.parsed === 'string' ? ix.parsed : null;
      if (text == null && typeof ix.data === 'string') {
        try {
          text = new TextDecoder().decode(base58Decode(ix.data));
        } catch {
          text = null;
        }
      }
      memo ||= parseMemo(text);
    } else if ((programId === SYSTEM_PROGRAM || ix.program === 'system') && ix.parsed?.type === 'transfer') {
      const { source, destination, lamports } = ix.parsed.info || {};
      transfers.push({ s: source, d: destination, l: Number(lamports || 0) });
    }
  }
  if (!memo) return null;

  const pre = {};
  keys.forEach((k, i) => {
    if (tx.meta.preBalances?.[i] != null) pre[k.pubkey] = Number(tx.meta.preBalances[i]);
  });
  const tokens = (tx.meta.preTokenBalances || []).map((b) => ({
    owner: b.owner,
    mint: b.mint,
    amount: Number(b.uiTokenAmount?.uiAmountString ?? b.uiTokenAmount?.uiAmount ?? 0),
  }));

  return { sig: signature, slot: tx.slot ?? null, time: tx.blockTime ?? null, ...memo, signers, transfers, pre, tokens };
}

const sumTransfers = (ev, from, to) => ev.transfers.filter((t) => t.s === from && t.d === to).reduce((a, t) => a + t.l, 0);

/** The wallet acting in `ev`: the signer paying the treasury (for sales, the buyer). */
function actorOf(ev, treasury) {
  const t = ev.transfers.find((x) => x.d === treasury && ev.signers.includes(x.s));
  return t?.s || null;
}

/**
 * Replays events (oldest first) and applies the rules:
 *  - one owner per building; the first valid action wins;
 *  - buy: pays the treasury at least the price in its memo (never below 0.001 SOL);
 *  - hold: meme-coin credit — the linked holder's token balance (recorded in the
 *    transaction itself) times the configured SOL price must cover everything
 *    that holder has taken so far;
 *  - sale: signed by the current owner, paying them the price minus the market
 *    fee and the treasury the fee;
 *  - revoke (by the treasury) voids any action; refunds are tracked.
 */
export function computeState(events, rules) {
  const { treasury, feeBps = 0, memecoin } = rules;
  // The active meme coin: config.js first, then any settings the treasury
  // publishes on-chain ("coin" actions), each effective from its own time.
  let coin = memecoin?.mint ? { ...memecoin, prices: [...(memecoin.prices || [])] } : null;
  const buildings = new Map();
  const owners = new Map();
  const offers = new Map();
  const links = new Map();
  const holderSpent = new Map();
  const bySig = new Map();
  const voids = [];
  const activity = [];
  const revoked = new Set();
  const refunded = new Map();
  const totals = { buildings: 0, owners: 0, volume: 0, revenue: 0, buys: 0, holds: 0, sales: 0 };

  for (const ev of events) {
    if ((ev.action === 'revoke' || ev.action === 'refund') && ev.signers.includes(treasury) && ev.transfers.some((t) => t.s === treasury)) {
      if (ev.action === 'revoke') revoked.add(ev.ref);
      else refunded.set(ev.ref, (refunded.get(ev.ref) || 0) + ev.transfers.filter((t) => t.s === treasury).reduce((a, t) => a + t.l, 0));
    }
  }

  const ownerRec = (address) => {
    let o = owners.get(address);
    if (!o) {
      o = { address, count: 0, spent: 0, value: 0, keys: new Set(), first: null, last: null };
      owners.set(address, o);
    }
    return o;
  };
  const take = (address, b, price, time) => {
    const o = ownerRec(address);
    o.count++;
    o.value += price;
    o.keys.add(b.key);
    o.first ??= time;
    o.last = time;
  };
  const release = (address, b) => {
    const o = owners.get(address);
    if (!o) return;
    o.count--;
    o.value -= b.price;
    o.keys.delete(b.key);
  };
  const voidEvent = (ev, reason, paid = 0) => {
    const record = { ...ev, reason, paid, buyer: ev.actor, refunded: refunded.get(ev.sig) || 0 };
    voids.push(record);
    bySig.set(ev.sig, { void: record });
  };

  for (const raw of events) {
    const ev = { ...raw, actor: actorOf(raw, treasury) };
    if (ev.action === 'coin') {
      if (treasury && ev.signers.includes(treasury) && !revoked.has(ev.sig) && ev.lamportsPerToken >= 0) {
        const step = { from: ev.time ?? 0, lamportsPerToken: ev.lamportsPerToken };
        coin = coin?.mint === ev.mint ? { ...coin, symbol: ev.symbol, prices: [...coin.prices, step] } : { mint: ev.mint, symbol: ev.symbol, prices: [step] };
        bySig.set(ev.sig, { record: { kind: 'coin', mint: ev.mint } });
      }
      continue;
    }
    if (ev.action === 'revoke' || ev.action === 'refund') continue;
    if (!ev.actor) continue; // not paying the treasury: not a Solworld action
    const isRevoked = revoked.has(ev.sig);

    if (ev.action === 'buy' || ev.action === 'hold') {
      const paid = ev.action === 'buy' ? sumTransfers(ev, ev.actor, treasury) : 0;
      if (isRevoked) {
        voidEvent(ev, 'revoked', paid);
        continue;
      }
      if (buildings.has(ev.key)) {
        voidEvent(ev, 'taken', paid);
        continue;
      }
      if (!(ev.price >= MIN_PRICE)) {
        voidEvent(ev, 'underpaid', paid);
        continue;
      }
      if (ev.action === 'buy' && paid < ev.price) {
        voidEvent(ev, 'underpaid', paid);
        continue;
      }
      let holder = null;
      if (ev.action === 'hold') {
        holder = links.get(ev.actor);
        if (!coin?.mint || !holder) {
          voidEvent(ev, 'unlinked');
          continue;
        }
        const tokens = ev.tokens.filter((t) => t.owner === holder && t.mint === coin.mint).reduce((a, t) => a + t.amount, 0);
        const credit = tokens * tokenPriceAt(coin.prices, ev.time);
        const spent = holderSpent.get(holder) || 0;
        if (spent + ev.price > credit) {
          voidEvent(ev, 'no-credit');
          continue;
        }
        holderSpent.set(holder, spent + ev.price);
      }
      const b = { key: ev.key, owner: ev.actor, acquired: ev.action, price: ev.price, sig: ev.sig, time: ev.time, lat: ev.lat, lng: ev.lng, holder, nonce: null, sign: null, sales: 0 };
      buildings.set(ev.key, b);
      take(ev.actor, b, ev.price, ev.time);
      if (ev.action === 'buy') {
        totals.buys++;
        totals.volume += paid;
        totals.revenue += paid;
      } else totals.holds++;
      ownerRec(ev.actor).spent += paid;
      const rec = { kind: ev.action, key: ev.key, owner: ev.actor, price: ev.price, paid, sig: ev.sig, time: ev.time, lat: ev.lat, lng: ev.lng, seed: !!ev.seed };
      activity.push(rec);
      bySig.set(ev.sig, { record: rec });
      continue;
    }

    if (ev.action === 'link') {
      if (!isRevoked && ev.holder !== ev.actor && ev.signers.includes(ev.holder)) links.set(ev.actor, ev.holder);
      bySig.set(ev.sig, { record: { kind: 'link', holder: ev.holder, owner: ev.actor } });
      continue;
    }

    if (ev.action === 'offer') {
      const b = buildings.get(ev.key);
      if (isRevoked || !b || b.owner === ev.actor || !(ev.price >= MIN_PRICE)) continue;
      b.nonce ??= ev.nonce;
      const offer = { sig: ev.sig, key: ev.key, buyer: ev.actor, price: ev.price, nonce: ev.nonce, nonceValue: ev.nonceValue, buyerSig: ev.buyerSig, time: ev.time, status: 'open', round: b.sales };
      offers.set(ev.sig, offer);
      bySig.set(ev.sig, { record: { kind: 'offer', ...offer } });
      continue;
    }

    if (ev.action === 'cancel') {
      const offer = offers.get(ev.ref);
      if (offer && offer.buyer === ev.actor && offer.status === 'open') offer.status = 'cancelled';
      bySig.set(ev.sig, { record: { kind: 'cancel', ref: ev.ref } });
      continue;
    }

    if (ev.action === 'sale') {
      const b = buildings.get(ev.key);
      const buyer = ev.actor;
      const fee = saleFee(ev.price, feeBps);
      const seller = b?.owner;
      const toSeller = seller ? sumTransfers(ev, buyer, seller) : 0;
      const toTreasury = sumTransfers(ev, buyer, treasury);
      if (isRevoked) {
        voidEvent(ev, 'revoked', toTreasury);
        continue;
      }
      if (!b || !ev.signers.includes(seller)) {
        voidEvent(ev, 'not-owner', toTreasury);
        continue;
      }
      if (buyer === seller || !(ev.price >= MIN_PRICE) || toSeller < ev.price - fee || toTreasury < fee) {
        voidEvent(ev, 'bad-sale', toTreasury);
        continue;
      }
      release(seller, b);
      b.owner = buyer;
      b.acquired = 'sale';
      b.price = ev.price;
      b.sig = ev.sig;
      b.time = ev.time;
      b.sign = null;
      b.sales++;
      take(buyer, b, ev.price, ev.time);
      ownerRec(buyer).spent += ev.price;
      for (const o of offers.values()) {
        if (o.key !== ev.key || o.status !== 'open') continue;
        o.status = o.buyer === buyer && o.price === ev.price ? 'accepted' : 'stale';
      }
      totals.sales++;
      totals.volume += ev.price;
      totals.revenue += toTreasury;
      const rec = { kind: 'sale', key: ev.key, owner: buyer, seller, price: ev.price, paid: ev.price, sig: ev.sig, time: ev.time, lat: b.lat, lng: b.lng };
      activity.push(rec);
      bySig.set(ev.sig, { record: rec });
      continue;
    }

    if (ev.action === 'sign') {
      const b = buildings.get(ev.key);
      if (!isRevoked && b && b.owner === ev.actor) b.sign = { color: ev.color, text: ev.text, time: ev.time, sig: ev.sig };
      bySig.set(ev.sig, { record: { kind: 'sign', key: ev.key } });
    }
  }

  for (const o of owners.values()) o.keys = [...o.keys];
  const ranked = [...owners.values()].filter((o) => o.count > 0);
  ranked.sort((a, b) => b.count - a.count || b.value - a.value || (a.first ?? 0) - (b.first ?? 0));
  ranked.forEach((o, i) => {
    o.rank = i + 1;
  });
  for (const o of owners.values()) if (!o.count) o.rank = null;
  totals.buildings = buildings.size;
  totals.owners = ranked.length;
  activity.reverse();

  return {
    coin,
    buildings,
    owners,
    leaderboard: ranked,
    offers,
    links,
    holderSpent,
    voids,
    refunded,
    activity,
    bySig,
    totals,
  };
}

/** Open offers on a building, best first. */
export function openOffers(state, key) {
  return [...state.offers.values()].filter((o) => o.key === key && o.status === 'open').sort((a, b) => b.price - a.price || a.time - b.time);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class BaseRegistry extends Emitter {
  constructor({ rules, storage }) {
    super();
    this.rules = rules;
    this.storage = storage;
    this.events = [];
    this.state = computeState([], rules);
    this.status = { ok: true, syncing: false, lastSync: null, error: null };
  }

  recompute() {
    this.state = computeState(this.events, this.rules);
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  /** Resolves once `sig` has been applied (valid or void) or the timeout passes. */
  async waitFor(sig, { timeoutMs = 75_000, intervalMs = 2000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await this.sync();
      } catch {
        // keep trying until the deadline
      }
      const hit = this.state.bySig.get(sig);
      if (hit?.record) return { ok: true, record: hit.record };
      if (hit?.void) return { ok: false, void: hit.void };
      await sleep(intervalMs);
    }
    return { ok: false, timeout: true };
  }
}

export class ChainRegistry extends BaseRegistry {
  constructor({ rpc, treasury, cluster, rules, storage, pollMs = 20_000 }) {
    super({ rules, storage });
    this.rpc = rpc;
    this.treasury = treasury;
    this.cluster = cluster;
    this.pollMs = pollMs;
    this.newest = null;
    this.address = null;
    this.inflight = null;
    this.timer = null;
  }

  get cacheKey() {
    return `solworld:registry:v${CACHE_VERSION}:${this.cluster}:${this.address}`;
  }

  async init() {
    this.address = await deriveRegistryAddress(this.treasury);
    const cached = this.storage?.get(this.cacheKey);
    if (cached && Array.isArray(cached.events)) {
      this.events = cached.events;
      this.newest = cached.newest || null;
      this.recompute();
    }
    this.emit('change', { fresh: [], initial: true });
    return this;
  }

  persist() {
    this.storage?.set(this.cacheKey, { newest: this.newest, events: this.events });
  }

  sync() {
    if (!this.inflight) {
      this.inflight = this._sync().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  async _sync() {
    this.setStatus({ syncing: true });
    try {
      const collected = [];
      let before;
      for (let page = 0; page < 100; page++) {
        const opts = { limit: 1000 };
        if (before) opts.before = before;
        if (this.newest) opts.until = this.newest;
        const batch = await this.rpc.getSignaturesForAddress(this.address, opts);
        collected.push(...batch);
        if (batch.length < 1000) break;
        before = batch[batch.length - 1].signature;
      }
      collected.reverse(); // oldest first

      const known = new Set(this.events.map((e) => e.sig));
      const isCandidate = (s) =>
        !s.err && !known.has(s.signature) && (s.memo === undefined || (typeof s.memo === 'string' && s.memo.includes('solworld:')));
      // The first sync of a session is catching up on history, not live news.
      const initial = !this.caughtUp;
      const fresh = [];
      let processed = this.newest;

      // Work in chunks so a long history shows up progressively and a failure
      // part-way keeps everything before it.
      for (let start = 0; start < collected.length; start += 100) {
        const chunk = collected.slice(start, start + 100);
        const candidates = chunk.filter(isCandidate);
        const txs = await mapLimit(candidates, 4, async (s) => {
          try {
            return await this.rpc.getTransaction(s.signature);
          } catch (err) {
            return { __error: err };
          }
        });
        const txBySig = new Map(candidates.map((s, i) => [s.signature, txs[i]]));
        const added = [];
        let stalled = false;
        for (const s of chunk) {
          if (isCandidate(s)) {
            const tx = txBySig.get(s.signature);
            if (!tx || tx.__error) {
              stalled = true; // not retrievable yet: resume from here next time
              break;
            }
            const ev = parseRegistryTransaction(tx, s.signature);
            if (ev) {
              ev.slot ??= s.slot;
              ev.time ??= s.blockTime ?? Math.floor(Date.now() / 1000);
              added.push(ev);
              known.add(ev.sig);
            }
          }
          processed = s.signature;
        }
        if (added.length) {
          this.events.push(...added);
          this.recompute();
          fresh.push(...added);
        }
        if (processed !== this.newest || added.length) {
          this.newest = processed;
          this.persist();
        }
        if (added.length) this.emit('change', { fresh: added, initial });
        if (stalled) break;
      }

      this.caughtUp = true;
      this.setStatus({ ok: true, syncing: false, lastSync: Date.now(), error: null });
      return fresh;
    } catch (err) {
      this.setStatus({ ok: false, syncing: false, error: err?.message || String(err) });
      throw err;
    }
  }

  start() {
    const tick = async () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        await this.sync().catch(() => {});
      }
      this.timer = setTimeout(tick, this.status.ok ? this.pollMs : Math.min(this.pollMs * 3, 90_000));
    };
    this.stop();
    tick();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }
}

export const DEMO_TREASURY = 'DemoTreasury1111111111111111111111111111111';

/**
 * Demo mode (no treasury configured): the same rules, but actions are
 * simulated and stored in this browser only. Nothing touches the chain.
 */
export class DemoRegistry extends BaseRegistry {
  constructor({ rules, storage, seeds }) {
    super({ rules: { ...rules, treasury: DEMO_TREASURY }, storage });
    this.seeds = seeds;
    this.slot = 1;
    this.address = 'demo';
  }

  static STORAGE_KEY = 'solworld:demo:v3';

  async init() {
    const saved = this.storage?.get(DemoRegistry.STORAGE_KEY);
    if (saved && Array.isArray(saved.events)) {
      this.events = saved.events;
      this.slot = saved.slot || this.events.length + 1;
      this.seeded = !!saved.seeded;
    }
    this.recompute();
    this.emit('change', { fresh: [], initial: true });
    if (!this.seeded && this.seeds) this.seedLater();
    return this;
  }

  async seedLater() {
    try {
      const seeds = await this.seeds();
      if (!seeds?.length) return;
      this.events = [...seeds.map((s) => ({ ...s, seed: true, slot: 0 })), ...this.events];
      this.seeded = true;
      this.recompute();
      this.persist();
      this.emit('change', { fresh: [], initial: true });
    } catch (err) {
      console.warn('[solworld] demo seeding skipped', err);
    }
  }

  persist() {
    this.storage?.set(DemoRegistry.STORAGE_KEY, { events: this.events, slot: this.slot, seeded: !!this.seeded });
  }

  /**
   * Records a simulated action. `transfers` / `signers` mirror what the real
   * transaction would contain, so the same rules apply.
   */
  async submit(fields) {
    await sleep(700 + Math.random() * 600); // feel like a network round trip
    const sigBytes = new Uint8Array(64);
    globalThis.crypto.getRandomValues(sigBytes);
    const ev = {
      sig: base58Encode(sigBytes),
      demo: true,
      slot: ++this.slot,
      time: Math.floor(Date.now() / 1000),
      tokens: [],
      pre: {},
      ...fields,
    };
    this.events.push(ev);
    this.recompute();
    this.persist();
    this.emit('change', { fresh: [ev], initial: false });
    return ev.sig;
  }

  reset() {
    this.events = [];
    this.seeded = false;
    this.storage?.remove?.(DemoRegistry.STORAGE_KEY);
    this.recompute();
    this.emit('change', { fresh: [], initial: true });
    if (this.seeds) this.seedLater();
  }

  async sync() {
    return [];
  }

  start() {}

  stop() {}
}
