// Core protocol tests: encoding, transaction compilation (checked against
// @solana/web3.js and executed on a real SVM via LiteSVM), memo format and
// the ownership rules every browser applies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import web3 from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { LiteSVM } from 'litesvm';
import { getTransactionDecoder } from '@solana/kit';

import * as sol from '../../solworld/assets/js/solana.js';
import { buildMemo, parseMemo, computeState, deriveRegistryAddress, parseRegistryTransaction, isBuildingKey } from '../../solworld/assets/js/registry.js';

const { Keypair, Transaction, SystemProgram, PublicKey, LAMPORTS_PER_SOL } = web3;

function signWire(unsignedWire, messageBytes, keypair) {
  const signature = nacl.sign.detached(messageBytes, keypair.secretKey);
  const out = Uint8Array.from(unsignedWire);
  out.set(signature, 1); // one signer: compact-u16(1) is a single byte
  return { wire: out, signature: bs58.encode(signature) };
}

function buildPurchase({ payer, treasury, reference, lamports, memo, blockhash }) {
  const instructions = [
    sol.computeUnitLimitInstruction(40_000),
    sol.computeUnitPriceInstruction(50_000),
    sol.transferInstruction({ from: payer, to: treasury, lamports, references: [reference] }),
    sol.memoInstruction(memo),
  ];
  const message = sol.compileMessage({ payer, instructions, recentBlockhash: blockhash });
  return { message, wire: sol.serializeUnsignedTransaction(message), instructions };
}

test('base58 matches bs58 across edge cases', () => {
  const samples = [
    new Uint8Array([]),
    new Uint8Array([0]),
    new Uint8Array([0, 0, 1, 2, 3]),
    new Uint8Array(32),
    Uint8Array.from({ length: 32 }, (_, i) => 255 - i),
    Uint8Array.from({ length: 64 }, (_, i) => (i * 37) & 0xff),
  ];
  for (let i = 0; i < 200; i++) samples.push(nacl.randomBytes(1 + (i % 64)));
  for (const bytes of samples) {
    const enc = sol.base58Encode(bytes);
    assert.equal(enc, bs58.encode(bytes));
    assert.deepEqual(sol.base58Decode(enc), Uint8Array.from(bytes));
  }
  assert.throws(() => sol.base58Decode('0OIl'));
  assert.equal(sol.isAddress(Keypair.generate().publicKey.toBase58()), true);
  assert.equal(sol.isAddress(bs58.encode(nacl.randomBytes(64))), false);
  assert.equal(sol.isAddress('not an address'), false);
});

test('compact-u16 encodes like the Solana wire format', () => {
  const cases = [
    [0, [0]],
    [0x7f, [0x7f]],
    [0x80, [0x80, 0x01]],
    [0x3fff, [0xff, 0x7f]],
    [0x4000, [0x80, 0x80, 0x01]],
    [0xffff, [0xff, 0xff, 0x03]],
  ];
  for (const [n, bytes] of cases) assert.deepEqual([...sol.compactU16(n)], bytes);
});

test('compiled purchase transaction decodes identically with web3.js', () => {
  const payer = Keypair.generate().publicKey.toBase58();
  const treasury = Keypair.generate().publicKey.toBase58();
  const reference = Keypair.generate().publicKey.toBase58();
  const blockhash = bs58.encode(nacl.randomBytes(32));
  const memo = buildMemo('buy', { key: 'w34633854', center: [-73.985664, 40.74844], price: 50_000_000 });
  const { wire } = buildPurchase({ payer, treasury, reference, lamports: 50_000_000, memo, blockhash });

  const tx = Transaction.from(Buffer.from(wire));
  assert.equal(tx.feePayer.toBase58(), payer);
  assert.equal(tx.recentBlockhash, blockhash);
  assert.equal(tx.instructions.length, 4);

  const [cuLimit, cuPrice, transfer, memoIx] = tx.instructions;
  assert.equal(cuLimit.programId.toBase58(), sol.COMPUTE_BUDGET_PROGRAM);
  assert.deepEqual([...cuLimit.data], [2, 0x40, 0x9c, 0, 0]);
  assert.equal(cuPrice.data[0], 3);
  assert.equal(cuPrice.data.readBigUInt64LE(1), 50_000n);

  assert.equal(transfer.programId.toBase58(), SystemProgram.programId.toBase58());
  const decoded = web3.SystemInstruction.decodeTransfer(
    new web3.TransactionInstruction({ keys: transfer.keys.slice(0, 2), programId: transfer.programId, data: transfer.data }),
  );
  assert.equal(decoded.fromPubkey.toBase58(), payer);
  assert.equal(decoded.toPubkey.toBase58(), treasury);
  assert.equal(decoded.lamports, 50_000_000n);
  assert.deepEqual(
    transfer.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [payer, true, true],
      [treasury, false, true],
      [reference, false, false],
    ],
  );
  assert.equal(memoIx.programId.toBase58(), sol.MEMO_PROGRAM);
  assert.equal(Buffer.from(memoIx.data).toString('utf8'), memo);
  assert.equal(memoIx.keys.length, 0);

  // The header must classify accounts correctly: 1 signer, 4 read-only non-signers.
  const message = tx.compileMessage();
  assert.equal(message.header.numRequiredSignatures, 1);
  assert.equal(message.header.numReadonlySignedAccounts, 0);
  assert.equal(message.header.numReadonlyUnsignedAccounts, 4);
});

test('purchase and free-claim transactions execute on a real SVM', () => {
  const svm = new LiteSVM();
  const buyer = Keypair.generate();
  const treasury = Keypair.generate().publicKey.toBase58();
  const reference = Keypair.generate().publicKey.toBase58();
  svm.airdrop(buyer.publicKey.toBase58(), BigInt(2 * LAMPORTS_PER_SOL));
  svm.airdrop(treasury, 1_000_000n);
  const decoder = getTransactionDecoder();

  const run = (lamports, memo) => {
    const blockhash = svm.latestBlockhash();
    const { message, wire } = buildPurchase({
      payer: buyer.publicKey.toBase58(),
      treasury,
      reference,
      lamports,
      memo,
      blockhash,
    });
    const signed = signWire(wire, message.bytes, buyer);
    const result = svm.sendTransaction(decoder.decode(signed.wire));
    svm.expireBlockhash();
    return result;
  };

  const before = svm.getBalance(treasury);
  const buy = run(50_000_000, buildMemo('buy', { key: 'w1', center: [2.2945, 48.8584], price: 50_000_000 }));
  assert.ok(typeof buy.err !== 'function', `buy failed: ${buy.err?.()} ${buy.meta?.().prettyLogs?.()}`);
  assert.equal(svm.getBalance(treasury) - before, 50_000_000n);
  assert.ok(buy.logs().some((l) => l.includes('solworld:buy:w1@48.858400,2.294500;p=50000000')), buy.prettyLogs());
  const buyUnits = Number(buy.computeUnitsConsumed());
  assert.ok(buyUnits < 40_000, `compute units ${buyUnits} must fit the 40k limit`);

  const claim = run(0, buildMemo('hold', { key: 'r42', center: [-0.1246, 51.5007], price: 1_000_000 }));
  assert.ok(typeof claim.err !== 'function', `claim failed: ${claim.err?.()}`);
  assert.equal(svm.getBalance(treasury) - before, 50_000_000n, 'a free claim moves no SOL');
  console.log(`    compute units: buy=${buyUnits} claim=${claim.computeUnitsConsumed()}`);

  // A tampered signature must be rejected by the runtime.
  const blockhash = svm.latestBlockhash();
  const { wire } = buildPurchase({
    payer: buyer.publicKey.toBase58(),
    treasury,
    reference,
    lamports: 1,
    memo: 'x',
    blockhash,
  });
  const forged = Uint8Array.from(wire);
  forged.set(nacl.randomBytes(64), 1);
  const rejected = svm.sendTransaction(decoder.decode(forged));
  assert.equal(typeof rejected.err, 'function');
});

test('memo format round-trips and rejects junk', () => {
  const memo = buildMemo('hold', { key: 'r123456', center: [151.215297, -33.856784], price: 2_500_000 });
  assert.equal(memo, 'solworld:hold:r123456@-33.856784,151.215297;p=2500000');
  assert.deepEqual(parseMemo(memo), { action: 'hold', key: 'r123456', lat: -33.856784, lng: 151.215297, price: 2_500_000 });
  const sign = buildMemo('sign', { key: 'w9', color: 2, text: "Joe's (café) 100% ✓" });
  assert.deepEqual(parseMemo(sign), { action: 'sign', key: 'w9', color: 2, text: "Joe's (café) 100% ✓" });
  const sig = bs58.encode(nacl.randomBytes(64));
  assert.deepEqual(parseMemo(buildMemo('revoke', { ref: sig })), { action: 'revoke', ref: sig });
  for (const bad of ['solworld:steal:w1@0,0;p=1', 'solworld:buy:x1@0,0;p=1', 'solworld:buy:w0@0,0;p=1', 'solworld:buy:w1@91,0;p=1', 'solworld:buy:w1@0,0', 'solworld:sign:w1;c=9;t=x', 'hello', null]) {
    assert.equal(parseMemo(bad), null, String(bad));
  }
  assert.equal(isBuildingKey('w34633854'), true);
  assert.equal(isBuildingKey('n1'), false);
  assert.throws(() => buildMemo('buy', { key: 'w-1', center: [0, 0], price: 1 }));
});

test('registry address is deterministic per treasury', async () => {
  const a = await deriveRegistryAddress('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
  const b = await deriveRegistryAddress('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
  const c = await deriveRegistryAddress('So11111111111111111111111111111111111111112');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(sol.isAddress(a), true);
  new PublicKey(a); // valid 32-byte key
});

function parsedTx({ buyer, treasury, reference, lamports, memo, preBalance, slot = 10, blockTime = 1_800_000_000 }) {
  // Shape mirrors getTransaction(..., { encoding: 'jsonParsed' }) for a legacy transaction.
  return {
    blockTime,
    slot,
    version: 'legacy',
    meta: {
      err: null,
      fee: 5000,
      preBalances: [preBalance, 5_000_000, 0, 1, 1, 1],
      postBalances: [preBalance - lamports - 5000, 5_000_000 + lamports, 0, 1, 1, 1],
      logMessages: [],
      status: { Ok: null },
    },
    transaction: {
      signatures: ['sig'],
      message: {
        accountKeys: [
          { pubkey: buyer, signer: true, writable: true, source: 'transaction' },
          { pubkey: treasury, signer: false, writable: true, source: 'transaction' },
          { pubkey: reference, signer: false, writable: false, source: 'transaction' },
          { pubkey: sol.COMPUTE_BUDGET_PROGRAM, signer: false, writable: false, source: 'transaction' },
          { pubkey: sol.SYSTEM_PROGRAM, signer: false, writable: false, source: 'transaction' },
          { pubkey: sol.MEMO_PROGRAM, signer: false, writable: false, source: 'transaction' },
        ],
        instructions: [
          { accounts: [], data: '3DTZbgwsozUF', programId: sol.COMPUTE_BUDGET_PROGRAM, stackHeight: null },
          {
            parsed: { info: { destination: treasury, lamports, source: buyer }, type: 'transfer' },
            program: 'system',
            programId: sol.SYSTEM_PROGRAM,
            stackHeight: null,
          },
          { parsed: memo, program: 'spl-memo', programId: sol.MEMO_PROGRAM, stackHeight: null },
        ],
        recentBlockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
      },
    },
  };
}

test('parses jsonParsed purchase transactions and ignores impostors', () => {
  const buyer = Keypair.generate().publicKey.toBase58();
  const treasury = Keypair.generate().publicKey.toBase58();
  const reference = Keypair.generate().publicKey.toBase58();
  const memo = buildMemo('buy', { key: 'w5013364', center: [2.294481, 48.85837], price: 50_000_000 });
  const ev = parseRegistryTransaction(parsedTx({ buyer, treasury, reference, lamports: 50_000_000, memo, preBalance: 3e9 }), 'SIG1');
  assert.equal(ev.action, 'buy');
  assert.equal(ev.key, 'w5013364');
  assert.equal(ev.price, 50_000_000);
  assert.deepEqual(ev.signers, [buyer]);
  assert.deepEqual(ev.transfers, [{ s: buyer, d: treasury, l: 50_000_000 }]);
  const one = (e) => computeState([e], { treasury, feeBps: 0 });
  assert.equal(one(ev).buildings.get('w5013364').owner, buyer);
  // Paid somebody else: not a Solworld purchase.
  const other = Keypair.generate().publicKey.toBase58();
  assert.equal(one(parseRegistryTransaction(parsedTx({ buyer, treasury: other, reference, lamports: 50_000_000, memo, preBalance: 1 }), 'S')).buildings.size, 0);
  // Failed transactions never count.
  const failed = parsedTx({ buyer, treasury, reference, lamports: 50_000_000, memo, preBalance: 3e9 });
  failed.meta.err = { InstructionError: [1, 'Custom'] };
  assert.equal(parseRegistryTransaction(failed, 'S'), null);
  // Garbage memo.
  assert.equal(parseRegistryTransaction(parsedTx({ buyer, treasury, reference, lamports: 1, memo: 'gm', preBalance: 1 }), 'S'), null);
  // Memo not decoded by the RPC (base58 data instead of parsed string).
  const raw = parsedTx({ buyer, treasury, reference, lamports: 50_000_000, memo, preBalance: 3e9 });
  raw.transaction.message.instructions[2] = { accounts: [], data: bs58.encode(Buffer.from(memo)), programId: sol.MEMO_PROGRAM };
  assert.equal(parseRegistryTransaction(raw, 'S2')?.key, 'w5013364');
});

test('ownership rules: first valid purchase wins, memo price must be paid and at least 0.001 SOL', () => {
  const T = 'Treasury';
  let n = 0;
  const ev = (key, buyer, paid, price) => ({ sig: `s${++n}`, slot: n, time: 1_900_000_000, action: 'buy', key, lat: 1, lng: 2, price, signers: [buyer], transfers: [{ s: buyer, d: T, l: paid }], tokens: [], pre: {} });
  const events = [
    ev('w1', 'A', 50_000_000, 50_000_000), // ok
    ev('w1', 'B', 50_000_000, 50_000_000), // taken -> refund
    ev('w2', 'B', 49_999_999, 50_000_000), // underpaid
    ev('w3', 'C', 900_000, 900_000), // below the 0.001 SOL floor
    ev('w4', 'C', 3_000_000_000, 3_000_000_000), // ok
    ev('w5', 'A', 2_000_000, 1_000_000), // overpaying is fine
  ];
  const s = computeState(events, { treasury: T, feeBps: 500 });
  assert.deepEqual([...s.buildings.keys()].sort(), ['w1', 'w4', 'w5']);
  assert.deepEqual(s.voids.map((v) => [v.sig, v.reason, v.paid]), [['s2', 'taken', 50_000_000], ['s3', 'underpaid', 49_999_999], ['s4', 'underpaid', 900_000]]);
  assert.deepEqual(s.leaderboard.map((o) => [o.address, o.count, o.rank]), [['A', 2, 1], ['C', 1, 2]]);
  assert.equal(s.totals.revenue, 50_000_000 + 3_000_000_000 + 2_000_000);
  assert.equal(s.activity[0].key, 'w5', 'activity is newest first');
});
