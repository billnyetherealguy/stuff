// Invite links on a real SVM (LiteSVM): a friend's first purchase pays the
// inviter 10% in the same transaction, and every replay agrees on the rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Chain } from '../e2e/chain.mjs';
import { Rpc } from '../../solworld/assets/js/solana.js';
import { ChainRegistry, buildMemo, deriveRegistryAddress, parseMemo, referralCut } from '../../solworld/assets/js/registry.js';
import { actionMessage } from '../../solworld/assets/js/market.js';
import { BurnerWallet } from '../../solworld/assets/js/burner.js';
import { captureReferral, referralFor } from '../../solworld/assets/js/referral.js';

const SOL = 1_000_000_000;

function memoryStorage() {
  const m = new Map();
  return { get: (k) => (m.has(k) ? structuredClone(m.get(k)) : null), set: (k, v) => m.set(k, structuredClone(v)), remove: (k) => m.delete(k) };
}

async function setup() {
  const chain = new Chain();
  const rpc = new Rpc(['http://chain.test'], { fetchImpl: async (u, init) => ({ ok: true, status: 200, json: async () => chain.handle(JSON.parse(init.body)) }) });
  const treasury = bs58.encode(nacl.sign.keyPair().publicKey);
  chain.airdrop(treasury, 1_000_000);
  const reference = await deriveRegistryAddress(treasury);
  const registry = new ChainRegistry({ rpc, treasury, cluster: 'localnet', rules: { treasury, feeBps: 100, memecoin: null }, storage: memoryStorage() });
  await registry.init();
  const wallet = async (sol) => {
    const w = new BurnerWallet({ rpc, storage: memoryStorage() });
    await w.create();
    chain.airdrop(w.address, sol * SOL);
    return w;
  };
  const act = async (w, lamports, memo, referral = null) =>
    w.send(actionMessage({ from: w.address, treasury, reference, lamports, memo, referral }, (await rpc.getLatestBlockhash()).blockhash));
  const balance = async (address) => (await rpc.call('getBalance', [address])).value;
  return { chain, rpc, treasury, registry, wallet, act, balance };
}

test('invite memos round-trip, and old memos still parse', () => {
  const ref = bs58.encode(nacl.sign.keyPair().publicKey);
  const buy = parseMemo(buildMemo('buy', { key: 'w1', center: [-73.98, 40.75], price: 2e7, ref }));
  assert.equal(buy.ref, ref);
  assert.equal(parseMemo(buildMemo('buy', { key: 'w1', center: [-73.98, 40.75], price: 2e7 })).ref, undefined);
  const land = parseMemo(buildMemo('land', { bbox: [-73.99, 40.74, -73.98, 40.75], price: 3e9, count: 40, title: 'Solana City', ref }));
  assert.equal(land.ref, ref);
  assert.equal(land.title, 'Solana City');
  assert.equal(parseMemo(buildMemo('hold', { key: 'w1', center: [-73.98, 40.75], price: 2e7, ref })).ref, undefined); // holds pay nothing
});

test('a friend’s first building pays the inviter 10%, on-chain; only once, never yourself', async () => {
  const { registry, wallet, act, balance, treasury } = await setup();
  const inviter = await wallet(2);
  const friend = await wallet(2);
  const stranger = await wallet(2);
  const center = [-73.985, 40.748];
  const price = 0.4 * SOL;

  // The inviter owns something first.
  await act(inviter, price, buildMemo('buy', { key: 'w100', center, price }));
  await registry.sync();

  // The friend opened the invite link, then buys their first building.
  const store = memoryStorage();
  const loc = { href: `https://solworld.test/?ref=${inviter.address}#/b/w200` };
  let replaced = null;
  assert.equal(captureReferral(store, loc, { replaceState: (_a, _b, url) => (replaced = url) }), inviter.address);
  assert.equal(replaced, '/#/b/w200');
  const referral = referralFor({ storage: store, state: registry.state, me: friend.address, price, treasury });
  assert.deepEqual(referral, { to: inviter.address, lamports: referralCut(price) });
  const before = await balance(inviter.address);
  await act(friend, price, buildMemo('buy', { key: 'w200', center, price, ref: inviter.address }), referral);
  await registry.sync();
  assert.equal(registry.state.buildings.get('w200').owner, friend.address);
  assert.equal((await balance(inviter.address)) - before, 0.04 * SOL);
  const o = registry.state.owners.get(inviter.address);
  assert.equal(o.referrals, 1);
  assert.equal(o.referralEarned, 0.04 * SOL);

  // Second purchase: no longer a first one, so the client attaches nothing…
  assert.equal(referralFor({ storage: store, state: registry.state, me: friend.address, price, treasury }), null);
  // …and a forced split is underpaid for the treasury: not recorded.
  await act(friend, price, buildMemo('buy', { key: 'w201', center, price, ref: inviter.address }), { to: inviter.address, lamports: referralCut(price) });
  await registry.sync();
  assert.equal(registry.state.buildings.has('w201'), false);

  // Someone who never owned anything can't be an inviter (no self-made discount wallets).
  const fresh = await wallet(1);
  await act(stranger, price, buildMemo('buy', { key: 'w300', center, price, ref: fresh.address }), { to: fresh.address, lamports: referralCut(price) });
  await registry.sync();
  assert.equal(registry.state.buildings.has('w300'), false);
  assert.equal(referralFor({ storage: (() => { const s = memoryStorage(); s.set('solworld:ref', fresh.address); return s; })(), state: registry.state, me: stranger.address, price, treasury }), null);

  // Inviting yourself doesn't work either.
  const solo = await wallet(2);
  await act(solo, price, buildMemo('buy', { key: 'w400', center, price, ref: solo.address }), { to: solo.address, lamports: referralCut(price) });
  await registry.sync();
  assert.equal(registry.state.buildings.has('w400'), false);
});
