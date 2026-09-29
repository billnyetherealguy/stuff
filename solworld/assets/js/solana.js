// Minimal, dependency-free Solana toolkit: base58/base64, legacy transaction
// compilation, and a JSON-RPC client that fails over between endpoints.
// Kept framework-free so it runs unchanged in the browser and in Node tests.

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const MEMO_PROGRAM_V1 = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';

/* ------------------------------------------------------------------ base58 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function base58Encode(input) {
  const bytes = input instanceof Uint8Array ? input : Uint8Array.from(input);
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let k = digits.length - 1; k >= 0; k--) out += ALPHABET[digits[k]];
  return out;
}

export function base58Decode(str) {
  if (typeof str !== 'string') throw new TypeError('base58: expected a string');
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;
  const bytes = [];
  for (let i = zeros; i < str.length; i++) {
    const value = ALPHABET_INDEX.get(str[i]);
    if (value === undefined) throw new Error('base58: invalid character');
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let k = 0; k < bytes.length; k++) out[out.length - 1 - k] = bytes[k];
  return out;
}

/** Number of bytes a base58 string decodes to, or -1 if it isn't base58. */
export function base58Length(str) {
  try {
    return base58Decode(String(str).trim()).length;
  } catch {
    return -1;
  }
}

/** True for a well-formed 32-byte Solana address. */
export function isAddress(str) {
  return typeof str === 'string' && str.length >= 32 && str.length <= 44 && base58Length(str) === 32;
}

/* ------------------------------------------------------------------ base64 */

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/* ------------------------------------------------------------ primitives */

export function concatBytes(parts) {
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function compactU16(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new RangeError('compact-u16 out of range');
  const out = [];
  let rem = n;
  for (;;) {
    const elem = rem & 0x7f;
    rem >>= 7;
    if (rem === 0) {
      out.push(elem);
      return Uint8Array.from(out);
    }
    out.push(elem | 0x80);
  }
}

function u32le(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function u64le(n) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}

export async function sha256(bytes) {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data));
}

export const solToLamports = (sol) => Math.round(Number(sol) * LAMPORTS_PER_SOL);
export const lamportsToSol = (lamports) => Number(lamports) / LAMPORTS_PER_SOL;

/* ---------------------------------------------------------- instructions */
// Instruction shape: { programId, keys: [{ pubkey, isSigner, isWritable }], data }

/**
 * SystemProgram::Transfer. `references` are appended as read-only,
 * non-signer keys (the Solana Pay "reference" pattern): the system program
 * ignores them, but they make the transaction findable with
 * getSignaturesForAddress(reference).
 */
export function transferInstruction({ from, to, lamports, references = [] }) {
  const data = new Uint8Array(12);
  data.set(u32le(2), 0);
  data.set(u64le(lamports), 4);
  return {
    programId: SYSTEM_PROGRAM,
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
      ...references.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    ],
    data,
  };
}

export function memoInstruction(text) {
  return { programId: MEMO_PROGRAM, keys: [], data: new TextEncoder().encode(text) };
}

export function computeUnitLimitInstruction(units) {
  const data = new Uint8Array(5);
  data[0] = 2;
  data.set(u32le(units), 1);
  return { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data };
}

export function computeUnitPriceInstruction(microLamports) {
  const data = new Uint8Array(9);
  data[0] = 3;
  data.set(u64le(microLamports), 1);
  return { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data };
}

/* ------------------------------------------------------------ compilation */

/**
 * Compiles a legacy message. Account order follows the runtime's rules:
 * fee payer, other writable signers, read-only signers, writable
 * non-signers, read-only non-signers (programs and references).
 */
export function compileMessage({ payer, instructions, recentBlockhash }) {
  const metas = new Map();
  const touch = (pubkey, isSigner, isWritable) => {
    const existing = metas.get(pubkey);
    if (existing) {
      existing.isSigner ||= isSigner;
      existing.isWritable ||= isWritable;
    } else {
      metas.set(pubkey, { pubkey, isSigner, isWritable, order: metas.size });
    }
  };
  touch(payer, true, true);
  for (const ix of instructions) {
    for (const key of ix.keys) touch(key.pubkey, key.isSigner, key.isWritable);
    touch(ix.programId, false, false);
  }

  const rank = (m) => {
    if (m.pubkey === payer) return -1;
    if (m.isSigner) return m.isWritable ? 0 : 1;
    return m.isWritable ? 2 : 3;
  };
  const accounts = [...metas.values()].sort((a, b) => rank(a) - rank(b) || a.order - b.order);
  const index = new Map(accounts.map((m, i) => [m.pubkey, i]));

  const numSigners = accounts.filter((m) => m.isSigner).length;
  const numReadonlySigned = accounts.filter((m) => m.isSigner && !m.isWritable).length;
  const numReadonlyUnsigned = accounts.filter((m) => !m.isSigner && !m.isWritable).length;

  const parts = [Uint8Array.of(numSigners, numReadonlySigned, numReadonlyUnsigned), compactU16(accounts.length)];
  for (const m of accounts) {
    const key = base58Decode(m.pubkey);
    if (key.length !== 32) throw new Error(`Invalid account key: ${m.pubkey}`);
    parts.push(key);
  }
  const blockhash = base58Decode(recentBlockhash);
  if (blockhash.length !== 32) throw new Error('Invalid recent blockhash');
  parts.push(blockhash, compactU16(instructions.length));
  for (const ix of instructions) {
    parts.push(
      Uint8Array.of(index.get(ix.programId)),
      compactU16(ix.keys.length),
      Uint8Array.from(ix.keys.map((k) => index.get(k.pubkey))),
      compactU16(ix.data.length),
      ix.data,
    );
  }
  return { bytes: concatBytes(parts), numSigners, accountKeys: accounts.map((m) => m.pubkey) };
}

/** Wire-format transaction with empty signature slots, ready for a wallet to sign. */
export function serializeUnsignedTransaction(message) {
  return concatBytes([compactU16(message.numSigners), new Uint8Array(64 * message.numSigners), message.bytes]);
}

/* -------------------------------------------------------------------- RPC */

export class RpcError extends Error {
  constructor(message, { code, data, retryable = false, status } = {}) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
    this.retryable = retryable;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class Rpc {
  constructor(urls, { timeoutMs = 15000, fetchImpl } = {}) {
    this.urls = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
    if (!this.urls.length) throw new Error('No RPC endpoints configured');
    this.cursor = 0;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.fetch = fetchImpl || ((...args) => fetchWithTimeout(...args));
  }

  get endpoint() {
    return this.urls[this.cursor % this.urls.length];
  }

  async call(method, params = []) {
    let lastError;
    const attempts = Math.max(2, this.urls.length * 2);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const url = this.endpoint;
      try {
        const res = await this.fetch(
          url,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
          },
          this.timeoutMs,
        );
        if (!res.ok) throw new RpcError(`RPC HTTP ${res.status}`, { retryable: true, status: res.status });
        const json = await res.json();
        if (json.error) {
          const { code, message, data } = json.error;
          // -32005 (node behind) and -32429/-32007 style throttling are worth retrying elsewhere.
          const retryable = code === -32005 || code === -32429 || code === 429 || /rate|limit|busy/i.test(message || '');
          throw new RpcError(message || 'RPC error', { code, data, retryable });
        }
        return json.result;
      } catch (err) {
        lastError = err;
        const retryable = err?.name === 'AbortError' || err instanceof TypeError || (err instanceof RpcError && err.retryable);
        if (!retryable) throw err;
        this.cursor++;
        await sleep(Math.min(3000, 250 * 2 ** attempt));
      }
    }
    throw lastError;
  }

  async getBalance(address, commitment = 'confirmed') {
    const res = await this.call('getBalance', [address, { commitment }]);
    return res.value;
  }

  async getLatestBlockhash(commitment = 'confirmed') {
    const res = await this.call('getLatestBlockhash', [{ commitment }]);
    return res.value;
  }

  getSignaturesForAddress(address, opts = {}) {
    return this.call('getSignaturesForAddress', [address, { commitment: 'confirmed', ...opts }]);
  }

  getTransaction(signature) {
    return this.call('getTransaction', [
      signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
    ]);
  }

  async getSignatureStatuses(signatures) {
    const res = await this.call('getSignatureStatuses', [signatures, { searchTransactionHistory: true }]);
    return res.value;
  }

  sendRawTransaction(bytes) {
    return this.call('sendTransaction', [
      toBase64(bytes),
      { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 },
    ]);
  }

  /** Resolves when the signature reaches `confirmed`, rejects on failure or timeout. */
  async confirm(signature, { timeoutMs = 90_000, intervalMs = 1500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let status = null;
      try {
        [status] = await this.getSignatureStatuses([signature]);
      } catch {
        // transient; keep polling
      }
      if (status?.err) {
        throw new RpcError('Transaction failed on-chain', { data: status.err });
      }
      if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
        return status;
      }
      await sleep(intervalMs);
    }
    throw new RpcError('Timed out waiting for confirmation', { code: 'timeout' });
  }
}

/** Maps over items with bounded concurrency, preserving order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
