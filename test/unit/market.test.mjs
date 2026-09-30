// The v2 protocol end to end on a real SVM (LiteSVM): Solworld wallets,
// purchases, competing offers, atomic sales, resale, meme-coin credit,
// billboards, and treasury revoke/refund — all through the site's own code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Chain } from '../e2e/chain.mjs';
import {
  Rpc,
  compileMessage,
  memoInstruction,
  parseNonceAccount,
  placeSignature,
  serializeUnsignedTransaction,
  transferInstruction,
} from '../../solworld/assets/js/solana.js';
import { ChainRegistry, buildMemo, deriveRegistryAddress, openOffers, saleFee } from '../../solworld/assets/js/registry.js';
import { actionMessage, buildSaleMessage, createNonceMessage, nonceAddressFor } from '../../solworld/assets/js/market.js';
import { BurnerWallet, verifySignature } from '../../solworld/assets/js/burner.js';
import { priceBuilding, MIN_LAMPORTS, MAX_LAMPORTS } from '../../solworld/assets/js/pricing.js';

const SOL = 1_000_000_000;
const MINT = 'MemeMint111111111111111111111111111111111111'.slice(0, 44);

function memoryStorage() {
  const m = new Map();
  return { get: (k) => (m.has(k) ? structuredClone(m.get(k)) : null), set: (k, v) => m.set(k, structuredClone(v)), remove: (k) => m.delete(k) };
}

function world() {
  const chain = new Chain();
  const rpc = new Rpc(['http://chain.test'], { fetchImpl: async (u, init) => ({ ok: true, status: 200, json: async () => chain.handle(JSON.parse(init.body)) }) });
  return { chain, rpc };
}

async function wallet(rpc, chain, sol) {
  const w = new BurnerWallet({ rpc, storage: memoryStorage() });
  await w.create();
  if (sol) chain.airdrop(w.address, sol * SOL);
  await w.refreshBalance();
  return w;
}

test('prices stay between 0.001 and 25 SOL and favour famous, busy, tall buildings', () => {
  const rural = priceBuilding({ tags: { building: 'shed' }, area: 40, center: [-100.5, 45.2] });
  const suburb = priceBuilding({ tags: { building: 'house' }, area: 140, center: [-73.75, 40.9] });
  const midtown = priceBuilding({ tags: { building: 'apartments', height: '30' }, area: 600, center: [-73.9855, 40.7484] });
  const empire = priceBuilding({ tags: { name: 'Empire State Building', wikidata: 'Q9188', height: '443' }, area: 8000, center: [-73.9857, 40.7484] });
  assert.equal(rural.lamports, MIN_LAMPORTS);
  assert.equal(empire.lamports, MAX_LAMPORTS);
  assert.ok(suburb.lamports > rural.lamports && midtown.lamports > suburb.lamports && empire.lamports > midtown.lamports, JSON.stringify([rural, suburb, midtown, empire].map((p) => p.lamports)));
  assert.ok(midtown.factors.some((f) => /Busy area · New York/.test(f.label)));
});

test('world icons cost far more than ordinary landmarks, named or plain buildings', () => {
  const at = [-73.982, 40.755];
  const p = (tags) => priceBuilding({ tags, area: 2500, center: at }).lamports;
  const icon = p({ name: 'Icon', wikidata: 'Q1', tourism: 'attraction', height: '150' });
  const landmark = p({ name: 'Tower', wikidata: 'Q2', height: '150' });
  const named = p({ name: 'Tower', height: '150' });
  const plain = p({ height: '150' });
  assert.ok(icon > landmark * 5 && landmark > named * 5 && named > plain, JSON.stringify({ icon, landmark, named, plain }));
  assert.ok(icon <= MAX_LAMPORTS && MAX_LAMPORTS === 25_000_000_000);
});

test('Solworld wallet exports a Phantom-compatible key and restores from it', async () => {
  const { rpc } = world();
  const a = new BurnerWallet({ rpc, storage: memoryStorage() });
  await a.create();
  const secret = a.exportSecret();
  const kp = nacl.sign.keyPair.fromSecretKey(bs58.decode(secret));
  assert.equal(bs58.encode(kp.publicKey), a.address);
  const b = new BurnerWallet({ rpc, storage: memoryStorage() });
  await b.importSecret(secret);
  assert.equal(b.address, a.address);
  const msg = new TextEncoder().encode('hello');
  assert.ok(await verifySignature(await b.sign(msg), msg, a.address));
  await assert.rejects(b.importSecret('abc'), /not a Solana secret key/);
});

test('buy → competing offers → atomic sale → resale, with fees and nonce safety', async () => {
  const { chain, rpc } = world();
  const treasury = bs58.encode(nacl.sign.keyPair().publicKey);
  chain.airdrop(treasury, 1_000_000);
  const reference = await deriveRegistryAddress(treasury);
  const feeBps = 500;
  const rules = { treasury, feeBps, memecoin: null };
  const registry = new ChainRegistry({ rpc, treasury, cluster: 'localnet', rules, storage: memoryStorage() });
  await registry.init();
  const alice = await wallet(rpc, chain, 5);
  const bob = await wallet(rpc, chain, 5);
  const carol = await wallet(rpc, chain, 5);
  const key = 'w34633854';
  const center = [-73.985664, 40.74844];
  const blockhash = async () => (await rpc.getLatestBlockhash()).blockhash;
  const act = async (w, lamports, memo) => w.send(actionMessage({ from: w.address, treasury, reference, lamports, memo }, await blockhash()));

  // Alice buys.
  await act(alice, 0.5 * SOL, buildMemo('buy', { key, center, price: 0.5 * SOL }));
  await registry.sync();
  assert.equal(registry.state.buildings.get(key).owner, alice.address);

  // Bob's offer creates the building's nonce (authority: Alice) and pre-signs the sale.
  const rent = await rpc.getMinimumBalanceForRentExemption(80);
  const nonce = await nonceAddressFor(bob.address, key);
  await bob.send(createNonceMessage({ payer: bob.address, nonce, key, lamports: rent, authority: alice.address, recentBlockhash: await blockhash() }));
  const info = parseNonceAccount((await rpc.getAccountInfo(nonce)).data);
  assert.equal(info.authority, alice.address);
  const offer = async (buyer, price) => {
    const sale = buildSaleMessage({ buyer: buyer.address, seller: alice.address, treasury, reference, key, price, feeBps, nonce, nonceValue: info.value });
    const buyerSig = bs58.encode(await buyer.sign(sale.bytes));
    await act(buyer, 0, buildMemo('offer', { key, price, nonce, nonceValue: info.value, buyerSig }));
  };
  await offer(bob, 1.2 * SOL);
  await offer(carol, 1.0 * SOL);
  await registry.sync();
  const offers = openOffers(registry.state, key);
  assert.deepEqual(offers.map((o) => [o.buyer, o.price]), [[bob.address, 1.2 * SOL], [carol.address, 1.0 * SOL]]);

  // Alice accepts Bob's offer: rebuild, verify his signature, co-sign, submit.
  const accept = async (seller, o) => {
    const sale = buildSaleMessage({ buyer: o.buyer, seller: seller.address, treasury, reference, key, price: o.price, feeBps, nonce: o.nonce, nonceValue: o.nonceValue });
    assert.ok(await verifySignature(bs58.decode(o.buyerSig), sale.bytes, o.buyer));
    const wire = serializeUnsignedTransaction(sale);
    placeSignature(wire, sale, o.buyer, bs58.decode(o.buyerSig));
    await seller.signInto(wire, sale);
    return rpc.sendRawTransaction(wire);
  };
  const aliceBefore = chain.balance(alice.address);
  const treasuryBefore = chain.balance(treasury);
  await accept(alice, offers[0]);
  await registry.sync();
  assert.equal(registry.state.buildings.get(key).owner, bob.address);
  assert.equal(chain.balance(alice.address) - aliceBefore, 1.2 * SOL - saleFee(1.2 * SOL, feeBps));
  assert.equal(chain.balance(treasury) - treasuryBefore, saleFee(1.2 * SOL, feeBps));
  assert.equal(registry.state.offers.get(offers[1].sig).status, 'stale');
  assert.equal(parseNonceAccount((await rpc.getAccountInfo(nonce)).data).authority, bob.address, 'nonce now belongs to the new owner');

  // Carol's old pre-signed sale can no longer execute (nonce advanced).
  await assert.rejects(accept(alice, offers[1]));

  // Resale: Carol offers again on the same nonce, Bob accepts.
  const info2 = parseNonceAccount((await rpc.getAccountInfo(nonce)).data);
  const sale2 = buildSaleMessage({ buyer: carol.address, seller: bob.address, treasury, reference, key, price: 2 * SOL, feeBps, nonce, nonceValue: info2.value });
  await act(carol, 0, buildMemo('offer', { key, price: 2 * SOL, nonce, nonceValue: info2.value, buyerSig: bs58.encode(await carol.sign(sale2.bytes)) }));
  await registry.sync();
  await accept(bob, openOffers(registry.state, key)[0]);
  await registry.sync();
  const b = registry.state.buildings.get(key);
  assert.equal(b.owner, carol.address);
  assert.equal(b.price, 2 * SOL);
  assert.equal(registry.state.totals.sales, 2);
  assert.deepEqual(registry.state.leaderboard.map((o) => o.address), [carol.address]);

  // Billboard: only the owner's counts.
  await act(bob, 0, buildMemo('sign', { key, color: 1, text: 'Not mine' }));
  await act(carol, 0, buildMemo('sign', { key, color: 3, text: 'Carol’s HQ 🚀' }));
  await registry.sync();
  assert.deepEqual([registry.state.buildings.get(key).sign.text, registry.state.buildings.get(key).sign.color], ['Carol’s HQ 🚀', 3]);
});

test('meme-coin credit: linked holders take buildings up to their holdings value', async () => {
  const { chain, rpc } = world();
  const treasuryKp = nacl.sign.keyPair();
  const treasury = bs58.encode(treasuryKp.publicKey);
  chain.airdrop(treasury, 2 * SOL);
  const reference = await deriveRegistryAddress(treasury);
  const mint = bs58.encode(nacl.randomBytes(32));
  const memecoin = { mint, symbol: 'MEME', prices: [{ from: 0, lamportsPerToken: 0.000001 * SOL }] };
  const registry = new ChainRegistry({ rpc, treasury, cluster: 'localnet', rules: { treasury, feeBps: 500, memecoin }, storage: memoryStorage() });
  await registry.init();
  const dave = await wallet(rpc, chain, 0.01);
  const holder = nacl.sign.keyPair();
  const holderAddr = bs58.encode(holder.publicKey);
  const tokenAccount = bs58.encode(nacl.randomBytes(32));
  chain.setTokenAccount(tokenAccount, { mint, owner: holderAddr, uiAmount: 1_000_000 }); // worth 1 SOL
  const blockhash = async () => (await rpc.getLatestBlockhash()).blockhash;

  // Link: the holder wallet co-signs (in the app this is Phantom's signTransaction).
  const link = actionMessage({ from: dave.address, treasury, reference, memo: buildMemo('link', { holder: holderAddr }), memoSigners: [holderAddr] }, await blockhash());
  const wire = serializeUnsignedTransaction(link);
  placeSignature(wire, link, holderAddr, nacl.sign.detached(link.bytes, holder.secretKey));
  await dave.signInto(wire, link);
  await rpc.sendRawTransaction(wire);

  const hold = async (key, price) =>
    dave.send(actionMessage({ from: dave.address, treasury, reference, memo: buildMemo('hold', { key, center: [0, 0], price }), extraRefs: [tokenAccount] }, await blockhash()));
  await hold('w1', 0.6 * SOL);
  await hold('w2', 0.5 * SOL); // would exceed 1 SOL of credit
  await hold('w3', 0.4 * SOL); // exactly uses the rest
  await registry.sync();
  const s = registry.state;
  assert.deepEqual([...s.buildings.keys()].sort(), ['w1', 'w3']);
  assert.equal(s.voids.find((v) => v.key === 'w2').reason, 'no-credit');
  assert.equal(s.holderSpent.get(holderAddr), SOL);
  assert.equal(s.totals.volume, 0, 'credit purchases move no SOL');

  // A holder who didn't co-sign can't be claimed by someone else.
  const mallory = await wallet(rpc, chain, 0.01);
  const fake = actionMessage({ from: mallory.address, treasury, reference, memo: buildMemo('link', { holder: holderAddr }) }, await blockhash());
  await mallory.send(fake);
  await mallory.send(actionMessage({ from: mallory.address, treasury, reference, memo: buildMemo('hold', { key: 'w9', center: [0, 0], price: 0.001 * SOL }), extraRefs: [tokenAccount] }, await blockhash()));
  await registry.sync();
  assert.equal(registry.state.voids.find((v) => v.key === 'w9').reason, 'unlinked');

  // Treasury revokes w3 and refunds nothing (it was credit); w3 is free again.
  const revoke = compileMessage({
    payer: treasury,
    recentBlockhash: await blockhash(),
    instructions: [transferInstruction({ from: treasury, to: dave.address, lamports: 0, references: [reference] }), memoInstruction(buildMemo('revoke', { ref: s.buildings.get('w3').sig }))],
  });
  const rw = serializeUnsignedTransaction(revoke);
  placeSignature(rw, revoke, treasury, nacl.sign.detached(revoke.bytes, treasuryKp.secretKey));
  await rpc.sendRawTransaction(rw);
  await registry.sync();
  assert.equal(registry.state.buildings.has('w3'), false);
  assert.equal(registry.state.voids.find((v) => v.key === 'w3').reason, 'revoked');
});

test('operator sets the meme coin on-chain; only the treasury can, and prices apply from then on', async () => {
  const { chain, rpc } = world();
  const treasuryKp = nacl.sign.keyPair();
  const treasury = bs58.encode(treasuryKp.publicKey);
  chain.airdrop(treasury, 2 * SOL);
  const reference = await deriveRegistryAddress(treasury);
  const registry = new ChainRegistry({ rpc, treasury, cluster: 'localnet', rules: { treasury, feeBps: 500, memecoin: null }, storage: memoryStorage() });
  await registry.init();
  const blockhash = async () => (await rpc.getLatestBlockhash()).blockhash;
  const mint = bs58.encode(nacl.randomBytes(32));

  // Someone else can't set it.
  const mallory = await wallet(rpc, chain, 0.01);
  await mallory.send(actionMessage({ from: mallory.address, treasury, reference, memo: buildMemo('coin', { mint, symbol: 'FAKE', lamportsPerToken: 1e9 }) }, await blockhash()));
  await registry.sync();
  assert.equal(registry.state.coin, null);

  // The treasury can (0-SOL transfer to itself carries the registry reference).
  const setCoin = async (lamportsPerToken) => {
    const msg = compileMessage({
      payer: treasury,
      recentBlockhash: await blockhash(),
      instructions: [transferInstruction({ from: treasury, to: treasury, lamports: 0, references: [reference] }), memoInstruction(buildMemo('coin', { mint, symbol: 'SOLW', lamportsPerToken }))],
    });
    const wire = serializeUnsignedTransaction(msg);
    placeSignature(wire, msg, treasury, nacl.sign.detached(msg.bytes, treasuryKp.secretKey));
    await rpc.sendRawTransaction(wire);
  };
  await setCoin(0.5); // 0.5 lamports per token: 1,000,000 tokens = 0.0005 SOL
  await registry.sync();
  assert.equal(registry.state.coin.mint, mint);
  assert.equal(registry.state.coin.symbol, 'SOLW');
  assert.equal(registry.state.coin.prices.at(-1).lamportsPerToken, 0.5);

  // A linked holder spends credit at that price.
  const erin = await wallet(rpc, chain, 0.01);
  const holder = nacl.sign.keyPair();
  const holderAddr = bs58.encode(holder.publicKey);
  const tokenAccount = bs58.encode(nacl.randomBytes(32));
  chain.setTokenAccount(tokenAccount, { mint, owner: holderAddr, uiAmount: 4_000_000 }); // = 2,000,000 lamports of credit
  const link = actionMessage({ from: erin.address, treasury, reference, memo: buildMemo('link', { holder: holderAddr }), memoSigners: [holderAddr] }, await blockhash());
  const lw = serializeUnsignedTransaction(link);
  placeSignature(lw, link, holderAddr, nacl.sign.detached(link.bytes, holder.secretKey));
  await erin.signInto(lw, link);
  await rpc.sendRawTransaction(lw);
  const hold = async (key, price) => erin.send(actionMessage({ from: erin.address, treasury, reference, memo: buildMemo('hold', { key, center: [0, 0], price }), extraRefs: [tokenAccount] }, await blockhash()));
  await hold('w11', 1_500_000);
  await hold('w12', 1_000_000); // over the 2,000,000 credit
  await registry.sync();
  assert.ok(registry.state.buildings.has('w11'));
  assert.equal(registry.state.voids.find((v) => v.key === 'w12').reason, 'no-credit');

  // Price goes up: the remaining credit grows, past purchases unaffected.
  await setCoin(1);
  await hold('w13', 1_000_000);
  await registry.sync();
  assert.ok(registry.state.buildings.has('w13'));
  assert.equal(registry.state.buildings.get('w11').price, 1_500_000);
});

test('sale tax: 1% goes to the treasury; older sales at 5% still count, underpaying the tax does not', async () => {
  const { computeState, buildMemo: memo, parseMemo } = await import('../../solworld/assets/js/registry.js');
  const T = 'Treasury11111111111111111111111111111111111';
  const A = 'Alice111111111111111111111111111111111111111';
  const B = 'Bob11111111111111111111111111111111111111111';
  const C = 'Carol111111111111111111111111111111111111111';
  const ev = (i, fields, signers, transfers) => ({ sig: `s${i}`, slot: i, time: 1000 + i, ...parseMemo(memo(...fields)), signers, transfers, tokens: [], pre: {} });
  const P = 1_000_000_000;
  const events = [
    ev(1, ['buy', { key: 'w1', center: [0, 0], price: P }], [A], [{ s: A, d: T, l: P }]),
    // old-style 5% split: still valid under the 1% rule
    ev(2, ['sale', { key: 'w1', price: 2 * P }], [B, A], [{ s: B, d: A, l: 1.9 * P }, { s: B, d: T, l: 0.1 * P }]),
    // 1% split
    ev(3, ['sale', { key: 'w1', price: 3 * P }], [C, B], [{ s: C, d: B, l: 2.97 * P }, { s: C, d: T, l: 0.03 * P }]),
    // tax short-changed: void
    ev(4, ['sale', { key: 'w1', price: 4 * P }], [A, C], [{ s: A, d: C, l: 3.99 * P }, { s: A, d: T, l: 0.01 * P }]),
  ];
  const s = computeState(events, { treasury: T, feeBps: 100, memecoin: null });
  assert.equal(s.buildings.get('w1').owner, C);
  assert.equal(s.totals.sales, 2);
  assert.equal(s.voids.find((v) => v.sig === 's4').reason, 'bad-sale');
  assert.equal(s.totals.revenue, P + 0.1 * P + 0.03 * P);
});

test('display names: first come first served, can be changed or cleared, no address look-alikes', async () => {
  const { computeState, buildMemo: memo, parseMemo } = await import('../../solworld/assets/js/registry.js');
  const T = 'Treasury11111111111111111111111111111111111';
  const A = 'Alice111111111111111111111111111111111111111';
  const B = 'Bob11111111111111111111111111111111111111111';
  const ev = (i, who, name) => ({ sig: `n${i}`, slot: i, time: i, ...parseMemo(memo('name', { name })), signers: [who], transfers: [{ s: who, d: T, l: 0 }], tokens: [], pre: {} });
  let s = computeState([ev(1, A, 'Big Bill'), ev(2, B, 'big bill'), ev(3, B, 'Tower Queen')], { treasury: T, feeBps: 100 });
  assert.equal(s.names.get(A), 'Big Bill');
  assert.equal(s.names.get(B), 'Tower Queen');
  assert.equal(s.voids.find((v) => v.sig === 'n2').reason, 'name-taken');
  s = computeState([ev(1, A, 'Big Bill'), ev(2, A, 'Bill 2'), ev(3, B, 'Big Bill'), ev(4, A, '')], { treasury: T, feeBps: 100 });
  assert.equal(s.names.get(B), 'Big Bill', 'released names can be taken');
  assert.equal(s.names.has(A), false, 'empty clears');
  assert.equal(parseMemo(memo('name', { name: '8tiwEgFFPdkMRhPMZtxHRwvopwf1PeqzgMpVMq7GKkpV' })).name, '');
});

test('city takeover: land pays the area price, no overlaps, buildings inside are the owner’s, tiers by size', async () => {
  const { computeState, buildMemo: memo, parseMemo } = await import('../../solworld/assets/js/registry.js');
  const { landPrice, tierFor } = await import('../../solworld/assets/js/pricing.js');
  const T = 'Treasury11111111111111111111111111111111111';
  const A = 'Alice111111111111111111111111111111111111111';
  const B = 'Bob11111111111111111111111111111111111111111';
  const box = [-73.99, 40.75, -73.98, 40.757];
  const price = landPrice(box);
  const ev = (i, who, fields, paid) => ({ sig: `l${i}`, slot: i, time: i, ...parseMemo(memo(...fields)), signers: [who], transfers: [{ s: who, d: T, l: paid }], tokens: [], pre: {} });
  const events = [
    ev(1, B, ['buy', { key: 'w5', center: [-73.985, 40.753], price: 1e8 }], 1e8), // bought before the takeover: stays Bob's
    ev(2, A, ['land', { bbox: box, price, count: 240, title: 'Alice City' }], price),
    ev(3, B, ['land', { bbox: [-73.985, 40.755, -73.97, 40.76], price: 1e12, count: 10, title: 'Overlap' }], 1e12), // overlaps
    ev(4, B, ['buy', { key: 'w6', center: [-73.986, 40.751], price: 1e8 }], 1e8), // inside Alice City now
    ev(5, B, ['land', { bbox: [-73.97, 40.75, -73.96, 40.757], price: 1000, count: 10, title: 'Cheap' }], 1000), // underpaid
  ];
  const s = computeState(events, { treasury: T, feeBps: 100 });
  assert.equal(s.territories.length, 1);
  const t = s.territories[0];
  assert.deepEqual([t.owner, t.title, t.tier], [A, 'Alice City', 'City']);
  assert.equal(s.buildings.get('w5').owner, B);
  assert.equal(s.voids.find((v) => v.sig === 'l3').reason, 'land-taken');
  assert.equal(s.voids.find((v) => v.sig === 'l4').reason, 'in-territory');
  assert.equal(s.voids.find((v) => v.sig === 'l5').reason, 'underpaid');
  assert.equal(s.owners.get(A).count, 240);
  assert.equal(s.leaderboard[0].address, A);
  assert.equal(s.territoryAt(-73.985, 40.752).title, 'Alice City');
  assert.deepEqual([tierFor(4), tierFor(5), tierFor(50), tierFor(200), tierFor(2000), tierFor(20000), tierFor(200000)], ['Block', 'Neighborhood', 'Town', 'City', 'Mega city', 'State', 'Country']);
});
