// The Solworld registry.
//
// There is no server and no database: the Solana ledger is the source of truth.
// Every purchase or free claim is one transaction that
//   1. transfers SOL (0 for a free claim) from the buyer to the treasury,
//   2. carries the registry "reference" key on that transfer, so every Solworld
//      transaction can be listed with getSignaturesForAddress(registry), and
//   3. carries a memo:  solworld:<buy|claim>:<buildingKey>@<lat>,<lng>
//
// Any browser can replay those transactions in order and apply the same rules,
// so everyone derives the same ownership map. Building keys are OpenStreetMap
// element ids: "w123" for a way, "r456" for a relation.

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

const KEY_RE = /^[wr][1-9]\d{0,15}$/;
const MEMO_RE = /^solworld:(buy|claim):([wr][1-9]\d{0,15})@(-?\d{1,2}(?:\.\d{1,8})?),(-?\d{1,3}(?:\.\d{1,8})?)$/;
const CACHE_VERSION = 2;

export const isBuildingKey = (key) => typeof key === 'string' && KEY_RE.test(key);

export function buildMemo(kind, key, [lng, lat]) {
  if (kind !== 'buy' && kind !== 'claim') throw new Error(`Unknown action: ${kind}`);
  if (!isBuildingKey(key)) throw new Error(`Invalid building key: ${key}`);
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) throw new Error('Invalid coordinates');
  return `solworld:${kind}:${key}@${lat.toFixed(6)},${lng.toFixed(6)}`;
}

export function parseMemo(text) {
  if (typeof text !== 'string') return null;
  const m = MEMO_RE.exec(text.trim());
  if (!m) return null;
  const lat = Number(m[3]);
  const lng = Number(m[4]);
  if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) return null;
  return { kind: m[1], key: m[2], lat, lng };
}

/** Deterministic, per-treasury registry reference key (not a wallet; nobody holds its key). */
export async function deriveRegistryAddress(treasury) {
  return base58Encode(await sha256(`solworld/registry/v1/${treasury}`));
}

/** Price in lamports that applied at unix time `time` (null = now / latest). */
export function priceAt(prices, time) {
  let price = prices[0].lamports;
  for (const entry of prices) {
    if (time == null || entry.from <= time) price = entry.lamports;
    else break;
  }
  return price;
}

/**
 * Extracts a registry event from a jsonParsed transaction, or null when the
 * transaction is not a well-formed Solworld action.
 */
export function parseRegistryTransaction(tx, signature, { treasury }) {
  if (!tx?.transaction?.message || !tx.meta || tx.meta.err) return null;
  const message = tx.transaction.message;
  const keys = (message.accountKeys || []).map((k) => (typeof k === 'string' ? { pubkey: k } : k));

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
      transfers.push(ix.parsed.info);
    }
  }
  if (!memo) return null;

  const toTreasury = transfers.filter((t) => t?.destination === treasury);
  if (!toTreasury.length) return null;
  const buyer = toTreasury[0].source;
  const paid = toTreasury.filter((t) => t.source === buyer).reduce((sum, t) => sum + Number(t.lamports || 0), 0);

  const index = keys.findIndex((k) => k.pubkey === buyer);
  if (index < 0) return null;
  const numSigners = message.header?.numRequiredSignatures ?? 1;
  const isSigner = keys[index].signer ?? index < numSigners;
  if (!isSigner) return null;

  return {
    sig: signature,
    slot: tx.slot ?? null,
    time: tx.blockTime ?? null,
    kind: memo.kind,
    key: memo.key,
    lat: memo.lat,
    lng: memo.lng,
    buyer,
    paid,
    pre: Number(tx.meta.preBalances?.[index] ?? 0),
  };
}

/**
 * Replays events (oldest first) and applies the ownership rules:
 *  - a building has exactly one owner: the first valid action wins;
 *  - "buy" must pay at least the price in force at that block time;
 *  - "claim" is free, once per wallet, for wallets holding MORE than the
 *    free-claim threshold (checked against the pre-transaction balance).
 * Anything else is recorded as void (paid voids can be refunded by the operator).
 */
export function computeState(events, { prices, freeClaimMinLamports }) {
  const buildings = new Map();
  const owners = new Map();
  const claimed = new Set();
  const bySig = new Map();
  const voids = [];
  const activity = [];
  let volume = 0;
  let buys = 0;
  let claims = 0;

  for (const ev of events) {
    let reason = null;
    if (buildings.has(ev.key)) reason = 'taken';
    else if (ev.kind === 'buy' && ev.paid < priceAt(prices, ev.time)) reason = 'underpaid';
    else if (ev.kind === 'claim' && claimed.has(ev.buyer)) reason = 'claim-used';
    else if (ev.kind === 'claim' && !(ev.pre > freeClaimMinLamports)) reason = 'balance';

    if (reason) {
      const record = { ...ev, reason };
      voids.push(record);
      bySig.set(ev.sig, { void: record });
      continue;
    }

    const record = {
      key: ev.key,
      owner: ev.buyer,
      kind: ev.kind,
      sig: ev.sig,
      time: ev.time,
      lat: ev.lat,
      lng: ev.lng,
      paid: ev.kind === 'buy' ? ev.paid : 0,
      seed: !!ev.seed,
    };
    buildings.set(ev.key, record);
    bySig.set(ev.sig, { record });
    if (ev.kind === 'claim') {
      claimed.add(ev.buyer);
      claims++;
    } else {
      buys++;
      volume += ev.paid;
    }
    let owner = owners.get(ev.buyer);
    if (!owner) {
      owner = { address: ev.buyer, count: 0, spent: 0, keys: [], first: ev.time, last: ev.time };
      owners.set(ev.buyer, owner);
    }
    owner.count++;
    owner.spent += record.paid;
    owner.keys.push(ev.key);
    owner.last = ev.time;
    activity.push(record);
  }

  activity.reverse();
  const leaderboard = [...owners.values()].sort(
    (a, b) => b.count - a.count || b.spent - a.spent || (a.first ?? 0) - (b.first ?? 0),
  );
  leaderboard.forEach((o, i) => {
    o.rank = i + 1;
  });

  return {
    buildings,
    owners,
    leaderboard,
    claimed,
    voids,
    activity,
    bySig,
    totals: { buildings: buildings.size, owners: owners.size, volume, buys, claims },
  };
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
            const ev = parseRegistryTransaction(tx, s.signature, { treasury: this.treasury });
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

/**
 * Demo mode (no treasury configured): identical rules, but actions are
 * simulated and stored in this browser only. Nothing touches the chain.
 */
export class DemoRegistry extends BaseRegistry {
  constructor({ rules, storage, seeds }) {
    super({ rules, storage });
    this.seeds = seeds;
    this.slot = 1;
    this.address = 'demo';
  }

  static STORAGE_KEY = 'solworld:demo:v2';

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
      const taken = new Set(this.events.map((e) => e.key));
      const fresh = seeds.filter((s) => !taken.has(s.key)).map((s) => ({ ...s, seed: true, slot: 0 }));
      // Seeds are "history": put them before anything the visitor did.
      this.events = [...fresh, ...this.events];
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

  async submit({ kind, key, lng, lat, buyer, paid, pre }) {
    await sleep(900 + Math.random() * 700); // feel like a network round trip
    const sigBytes = new Uint8Array(64);
    globalThis.crypto.getRandomValues(sigBytes);
    const ev = {
      sig: `demo-${base58Encode(sigBytes).slice(0, 40)}`,
      slot: ++this.slot,
      time: Math.floor(Date.now() / 1000),
      kind,
      key,
      lat,
      lng,
      buyer,
      paid,
      pre,
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
