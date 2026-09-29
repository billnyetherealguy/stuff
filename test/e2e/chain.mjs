// A local Solana "cluster" backed by LiteSVM (real runtime, real System and
// Memo programs) exposing the JSON-RPC methods Solworld uses, with responses
// shaped like a real RPC node (jsonParsed transactions, memo field, etc.).
import { LiteSVM } from 'litesvm';
import { getTransactionDecoder } from '@solana/kit';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

const SYSTEM = '11111111111111111111111111111111';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFM2Q7Vr87VAxbFmJ3sR';

function readCompact(bytes, offset) {
  let value = 0;
  let size = 0;
  for (;;) {
    const b = bytes[offset + size];
    value |= (b & 0x7f) << (7 * size);
    size++;
    if ((b & 0x80) === 0) return [value, size];
  }
}

/** Minimal legacy transaction parser. */
export function parseWire(bytes) {
  let o = 0;
  const [nSig, s1] = readCompact(bytes, o);
  o += s1;
  const signatures = [];
  for (let i = 0; i < nSig; i++) signatures.push(bytes.slice(o + i * 64, o + (i + 1) * 64));
  o += nSig * 64;
  const messageStart = o;
  if (bytes[o] & 0x80) throw new Error('versioned transactions not supported by the harness');
  const header = { numRequiredSignatures: bytes[o], numReadonlySignedAccounts: bytes[o + 1], numReadonlyUnsignedAccounts: bytes[o + 2] };
  o += 3;
  const [nKeys, s2] = readCompact(bytes, o);
  o += s2;
  const keys = [];
  for (let i = 0; i < nKeys; i++) keys.push(bs58.encode(bytes.slice(o + i * 32, o + (i + 1) * 32)));
  o += nKeys * 32;
  const recentBlockhash = bs58.encode(bytes.slice(o, o + 32));
  o += 32;
  const [nIx, s3] = readCompact(bytes, o);
  o += s3;
  const instructions = [];
  for (let i = 0; i < nIx; i++) {
    const programIdIndex = bytes[o++];
    const [nAcc, s4] = readCompact(bytes, o);
    o += s4;
    const accounts = [...bytes.slice(o, o + nAcc)];
    o += nAcc;
    const [nData, s5] = readCompact(bytes, o);
    o += s5;
    const data = bytes.slice(o, o + nData);
    o += nData;
    instructions.push({ programIdIndex, accounts, data });
  }
  return { signatures, header, keys, recentBlockhash, instructions, message: bytes.slice(messageStart) };
}

export class Chain {
  constructor() {
    this.svm = new LiteSVM();
    this.decoder = getTransactionDecoder();
    this.txs = [];
    this.bySig = new Map();
    this.slot = 310_000_000;
    this.sent = [];
    this.decimals = new Map();
  }

  /** Writes an SPL token account (owner holds `uiAmount` tokens of `mint`). */
  setTokenAccount(address, { mint, owner, uiAmount, decimals = 6 }) {
    this.decimals.set(mint, decimals);
    (this.tokenAccounts ||= new Map()).set(address, { mint, owner });
    const data = new Uint8Array(165);
    data.set(bs58.decode(mint), 0);
    data.set(bs58.decode(owner), 32);
    new DataView(data.buffer).setBigUint64(64, BigInt(Math.round(uiAmount * 10 ** decimals)), true);
    data[108] = 1; // initialized
    this.svm.setAccount({ address, data, executable: false, lamports: 2_039_280n, programAddress: TOKEN_PROGRAM, space: 165n });
  }

  tokenBalances(keys) {
    const out = [];
    keys.forEach((k, i) => {
      const a = this.svm.getAccount(k);
      if (!a?.exists || a.programAddress !== TOKEN_PROGRAM || a.data.length < 72) return;
      const mint = bs58.encode(a.data.slice(0, 32));
      const decimals = this.decimals.get(mint) ?? 6;
      const raw = new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true);
      const ui = Number(raw) / 10 ** decimals;
      out.push({ accountIndex: i, mint, owner: bs58.encode(a.data.slice(32, 64)), programId: TOKEN_PROGRAM, uiTokenAmount: { amount: String(raw), decimals, uiAmount: ui, uiAmountString: String(ui) } });
    });
    return out;
  }

  airdrop(address, lamports) {
    this.svm.airdrop(address, BigInt(lamports));
  }

  balance(address) {
    return Number(this.svm.getBalance(address) ?? 0n);
  }

  /** Signs a serialized unsigned transaction with a keypair and submits it. */
  signAndSubmit(wire, keypair) {
    const parsed = parseWire(wire);
    const signature = nacl.sign.detached(parsed.message, keypair.secretKey);
    const signed = Uint8Array.from(wire);
    signed.set(signature, 1);
    return this.submit(signed);
  }

  submit(wire) {
    const parsed = parseWire(wire);
    const sig = bs58.encode(parsed.signatures[0]);
    const writableSigners = parsed.header.numRequiredSignatures - parsed.header.numReadonlySignedAccounts;
    const nUnsigned = parsed.keys.length - parsed.header.numRequiredSignatures;
    const writableUnsigned = nUnsigned - parsed.header.numReadonlyUnsignedAccounts;
    const accountKeys = parsed.keys.map((pubkey, i) => ({
      pubkey,
      signer: i < parsed.header.numRequiredSignatures,
      writable: i < parsed.header.numRequiredSignatures ? i < writableSigners : i - parsed.header.numRequiredSignatures < writableUnsigned,
      source: 'transaction',
    }));
    const pre = parsed.keys.map((k) => this.balance(k));
    const preTokens = this.tokenBalances(parsed.keys);
    const result = this.svm.sendTransaction(this.decoder.decode(wire));
    const failed = typeof result.err === 'function';
    if (failed) {
      const meta = result.meta();
      const err = new Error(`Transaction simulation failed: ${result.err()}`);
      err.code = -32002;
      err.data = { logs: meta.logs() };
      throw err;
    }
    const post = parsed.keys.map((k) => this.balance(k));
    // Real clusters move to a new blockhash every slot; durable nonces rely on
    // that, so advance it whenever a nonce was created or used.
    if (parsed.instructions.some((ix) => parsed.keys[ix.programIdIndex] === SYSTEM && [4, 6].includes(ix.data[0]) && ix.data.length <= 36)) {
      this.svm.expireBlockhash();
    }
    this.slot += 1 + Math.floor(Math.random() * 3);

    const instructions = parsed.instructions.map((ix) => {
      const programId = parsed.keys[ix.programIdIndex];
      if (programId === SYSTEM && ix.data.length === 12 && ix.data[0] === 2) {
        const lamports = Number(Buffer.from(ix.data).readBigUInt64LE(4));
        return {
          parsed: { info: { destination: parsed.keys[ix.accounts[1]], lamports, source: parsed.keys[ix.accounts[0]] }, type: 'transfer' },
          program: 'system',
          programId,
          stackHeight: null,
        };
      }
      if (programId === MEMO) return { parsed: Buffer.from(ix.data).toString('utf8'), program: 'spl-memo', programId, stackHeight: null };
      return { accounts: ix.accounts.map((a) => parsed.keys[a]), data: bs58.encode(ix.data), programId, stackHeight: null };
    });
    const memoText = instructions.find((i) => i.program === 'spl-memo')?.parsed;
    const record = {
      sig,
      slot: this.slot,
      blockTime: Math.floor(Date.now() / 1000),
      keys: parsed.keys,
      memo: memoText == null ? null : `[${Buffer.byteLength(memoText)}] ${memoText}`,
      tx: {
        blockTime: Math.floor(Date.now() / 1000),
        slot: this.slot,
        version: 'legacy',
        meta: {
          computeUnitsConsumed: Number(result.computeUnitsConsumed()),
          err: null,
          fee: pre[0] - post[0] - (instructions.find((i) => i.parsed?.type === 'transfer')?.parsed.info.lamports || 0),
          innerInstructions: [],
          logMessages: result.logs(),
          postBalances: post,
          postTokenBalances: [],
          preBalances: pre,
          preTokenBalances: preTokens,
          rewards: [],
          status: { Ok: null },
        },
        transaction: {
          message: { accountKeys, instructions, recentBlockhash: parsed.recentBlockhash },
          signatures: [sig],
        },
      },
    };
    this.txs.push(record);
    this.bySig.set(sig, record);
    this.sent.push({ sig, memo: memoText, keys: parsed.keys, instructions });
    return sig;
  }

  rpc(method, params = []) {
    const ctx = { context: { slot: this.slot } };
    switch (method) {
      case 'getLatestBlockhash':
        return { ...ctx, value: { blockhash: this.svm.latestBlockhash(), lastValidBlockHeight: this.slot + 150 } };
      case 'getBalance':
        return { ...ctx, value: this.balance(params[0]) };
      case 'sendTransaction': {
        const wire = Uint8Array.from(Buffer.from(params[0], params[1]?.encoding === 'base64' ? 'base64' : 'base64'));
        return this.submit(wire);
      }
      case 'getSignatureStatuses':
        return {
          ...ctx,
          value: params[0].map((s) => {
            const r = this.bySig.get(s);
            return r ? { slot: r.slot, confirmations: null, err: null, status: { Ok: null }, confirmationStatus: 'confirmed' } : null;
          }),
        };
      case 'getSignaturesForAddress': {
        const [address, opts = {}] = params;
        let list = this.txs.filter((t) => t.keys.includes(address)).reverse();
        if (opts.before) {
          const i = list.findIndex((t) => t.sig === opts.before);
          list = i >= 0 ? list.slice(i + 1) : list;
        }
        if (opts.until) {
          const i = list.findIndex((t) => t.sig === opts.until);
          if (i >= 0) list = list.slice(0, i);
        }
        return list.slice(0, opts.limit || 1000).map((t) => ({
          signature: t.sig,
          slot: t.slot,
          err: null,
          memo: t.memo,
          blockTime: t.blockTime,
          confirmationStatus: 'confirmed',
        }));
      }
      case 'getAccountInfo': {
        const a = this.svm.getAccount(params[0]);
        if (!a?.exists) return { ...ctx, value: null };
        return { ...ctx, value: { lamports: Number(a.lamports), owner: a.programAddress, executable: a.executable, data: [Buffer.from(a.data).toString('base64'), 'base64'] } };
      }
      case 'getMinimumBalanceForRentExemption':
        return Number(this.svm.minimumBalanceForRentExemption(BigInt(params[0])));
      case 'getTokenAccountsByOwner': {
        const [owner, { mint }] = params;
        const value = [];
        for (const [addr, meta] of this.tokenAccounts || []) {
          if (meta.owner !== owner || meta.mint !== mint) continue;
          const tb = this.tokenBalances([addr])[0];
          value.push({ pubkey: addr, account: { data: { parsed: { info: { mint, owner, tokenAmount: tb.uiTokenAmount } } } } });
        }
        return { ...ctx, value };
      }
      case 'getTransaction':
        return this.bySig.get(params[0])?.tx ?? null;
      default: {
        const err = new Error(`Method not found: ${method}`);
        err.code = -32601;
        throw err;
      }
    }
  }

  /** JSON-RPC over HTTP body (single or batch). */
  handle(body) {
    const one = (req) => {
      try {
        return { jsonrpc: '2.0', id: req.id, result: this.rpc(req.method, req.params) };
      } catch (e) {
        return { jsonrpc: '2.0', id: req.id, error: { code: e.code || -32000, message: e.message, data: e.data } };
      }
    };
    return Array.isArray(body) ? body.map(one) : one(body);
  }
}
