// The Solworld wallet: a keypair generated in the visitor's own browser.
// Nobody else (including the site operator) ever sees the key. People deposit
// SOL to it, spend from it without wallet pop-ups, and can export it to
// Phantom/Solflare or restore it on another device.

import * as ed from '../../vendor/noble-ed25519-3.2.0/ed25519.js';
import { Emitter } from './emitter.js';
import {
  base58Decode,
  base58Encode,
  placeSignature,
  serializeUnsignedTransaction,
  transferInstruction,
  compileMessage,
  computeUnitLimitInstruction,
  computeUnitPriceInstruction,
} from './solana.js';

const KEY = 'solworld:wallet:v1';

export class BurnerWallet extends Emitter {
  constructor({ rpc, storage }) {
    super();
    this.rpc = rpc;
    this.storage = storage;
    this.secret = null; // 32-byte seed
    this.address = null;
    this.balance = null;
    this.backedUp = false;
  }

  get exists() {
    return !!this.address;
  }

  async load() {
    const saved = this.storage?.get(KEY);
    if (saved?.seed) {
      try {
        await this._use(base58Decode(saved.seed), saved.backedUp);
      } catch {
        // corrupted entry: start fresh on next create
      }
    }
    return this;
  }

  async create() {
    if (this.exists) return this;
    await this._use(ed.utils.randomSecretKey(), false);
    this._save();
    return this;
  }

  async _use(seed, backedUp) {
    this.secret = seed;
    this.address = base58Encode(await ed.getPublicKeyAsync(seed));
    this.backedUp = !!backedUp;
    this.balance = null;
    this.emit('change', this.snapshot());
    this.refreshBalance();
  }

  _save() {
    this.storage?.set(KEY, { seed: base58Encode(this.secret), address: this.address, backedUp: this.backedUp });
  }

  snapshot() {
    return { exists: this.exists, address: this.address, balance: this.balance, backedUp: this.backedUp };
  }

  markBackedUp() {
    this.backedUp = true;
    this._save();
    this.emit('change', this.snapshot());
  }

  /** Phantom/Solflare-compatible secret key (base58 of seed + public key). */
  exportSecret() {
    const out = new Uint8Array(64);
    out.set(this.secret, 0);
    out.set(base58Decode(this.address), 32);
    return base58Encode(out);
  }

  /** Accepts a base58 64-byte secret key, a 32-byte seed, or a JSON byte array. */
  async importSecret(text) {
    const s = String(text || '').trim();
    let bytes;
    if (s.startsWith('[')) bytes = Uint8Array.from(JSON.parse(s));
    else bytes = base58Decode(s);
    if (bytes.length !== 64 && bytes.length !== 32) throw new Error('That is not a Solana secret key.');
    const seed = bytes.slice(0, 32);
    const address = base58Encode(await ed.getPublicKeyAsync(seed));
    if (bytes.length === 64 && base58Encode(bytes.slice(32)) !== address) throw new Error('That secret key is damaged (public key mismatch).');
    await this._use(seed, true);
    this._save();
  }

  /** Demo mode: a pretend balance kept in this browser. */
  simulate(storage, startLamports = 5_000_000_000) {
    this.simulated = true;
    this.demoStore = storage;
    if (storage.get('solworld:demo-balance') == null) storage.set('solworld:demo-balance', startLamports);
  }

  adjustDemoBalance(delta) {
    const next = Math.max(0, (this.demoStore.get('solworld:demo-balance') ?? 0) + delta);
    this.demoStore.set('solworld:demo-balance', next);
    this.balance = next;
    this.emit('change', this.snapshot());
  }

  async refreshBalance() {
    if (!this.address) return null;
    if (this.simulated) {
      this.balance = this.demoStore.get('solworld:demo-balance') ?? 0;
      this.emit('change', this.snapshot());
      return this.balance;
    }
    const address = this.address;
    try {
      const lamports = await this.rpc.getBalance(address);
      if (address === this.address) {
        this.balance = lamports;
        this.emit('change', this.snapshot());
      }
      return lamports;
    } catch (err) {
      console.warn('[solworld] balance lookup failed', err);
      return this.balance;
    }
  }

  sign(bytes) {
    return ed.signAsync(bytes, this.secret);
  }

  /** Adds this wallet's signature to a wire transaction built from `message`. */
  async signInto(wire, message) {
    return placeSignature(wire, message, this.address, await this.sign(message.bytes));
  }

  /** Signs (as fee payer) and submits. Returns the signature. */
  async send(message, { extra } = {}) {
    const wire = serializeUnsignedTransaction(message);
    await this.signInto(wire, message);
    if (extra) await extra(wire);
    return this.rpc.sendRawTransaction(wire);
  }

  /** Sends SOL to another address. `lamports = 'max'` empties the wallet (minus fees). */
  async withdraw(to, lamports, { priorityFee = 0 } = {}) {
    const balance = (await this.refreshBalance()) ?? 0;
    const fee = 5000 + Math.ceil((priorityFee * 1000) / 1e6);
    const amount = lamports === 'max' ? balance - fee : lamports;
    if (!(amount > 0) || amount + fee > balance) throw new Error('Not enough SOL in your Solworld wallet.');
    const { blockhash } = await this.rpc.getLatestBlockhash();
    const instructions = [];
    if (priorityFee) instructions.push(computeUnitLimitInstruction(1000), computeUnitPriceInstruction(priorityFee));
    instructions.push(transferInstruction({ from: this.address, to, lamports: amount }));
    return this.send(compileMessage({ payer: this.address, instructions, recentBlockhash: blockhash }));
  }
}

export async function verifySignature(signature, message, publicKey) {
  try {
    return await ed.verifyAsync(signature, message, base58Decode(publicKey));
  } catch {
    return false;
  }
}
