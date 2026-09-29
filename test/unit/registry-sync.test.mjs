// ChainRegistry against a real SVM (LiteSVM) behind a JSON-RPC shim:
// paging, chunked catch-up, resume after RPC failures, spam filtering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Chain } from '../e2e/chain.mjs';
import { Rpc, compileMessage, memoInstruction, serializeUnsignedTransaction, transferInstruction } from '../../solworld/assets/js/solana.js';
import { ChainRegistry, buildMemo, deriveRegistryAddress } from '../../solworld/assets/js/registry.js';

const addr = (kp) => bs58.encode(kp.publicKey);

function memoryStorage() {
  const m = new Map();
  return { get: (k) => (m.has(k) ? structuredClone(m.get(k)) : null), set: (k, v) => m.set(k, structuredClone(v)), remove: (k) => m.delete(k) };
}

function rpcFor(chain, { failTx } = {}) {
  return new Rpc(['http://chain.test'], {
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (failTx && body.method === 'getTransaction' && failTx(body.params[0])) {
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => chain.handle(body) };
    },
  });
}

async function setupChain() {
  const chain = new Chain();
  const treasury = nacl.sign.keyPair();
  chain.airdrop(addr(treasury), 1_000_000);
  const reference = await deriveRegistryAddress(addr(treasury));
  const send = (kp, { lamports, memo, to = addr(treasury), refs = [reference] }) => {
    const instructions = [transferInstruction({ from: addr(kp), to, lamports, references: refs })];
    if (memo) instructions.push(memoInstruction(memo));
    const msg = compileMessage({ payer: addr(kp), instructions, recentBlockhash: chain.svm.latestBlockhash() });
    return chain.signAndSubmit(serializeUnsignedTransaction(msg), kp);
  };
  return { chain, treasury, reference, send };
}



test('catches up on a long history in chunks and applies the rules', async () => {
  const { chain, treasury, send } = await setupChain();
  const buyers = Array.from({ length: 6 }, () => nacl.sign.keyPair());
  for (const b of buyers) chain.airdrop(addr(b), 20_000_000_000);
  let n = 0;
  for (let i = 0; i < 240; i++) {
    const b = buyers[i % buyers.length];
    send(b, { lamports: 50_000_000, memo: buildMemo('buy', { key: `w${1000 + i}`, center: [0.001 * i, 10], price: 50_000_000 }) });
    n++;
  }
  // Noise that references the registry but isn't a valid purchase.
  send(buyers[0], { lamports: 1, memo: null }); // no memo
  send(buyers[0], { lamports: 1, memo: 'hello world' }); // junk memo
  send(buyers[1], { lamports: 49_000_000, memo: buildMemo('buy', { key: 'w5', center: [1, 1], price: 50_000_000 }) }); // underpaid
  send(buyers[2], { lamports: 50_000_000, memo: buildMemo('buy', { key: 'w1000', center: [1, 1], price: 50_000_000 }) }); // already owned -> refund
  send(buyers[3], { lamports: 1_000_000, memo: buildMemo('buy', { key: 'w9001', center: [2, 2], price: 1_000_000 }) }); // cheapest building

  const registry = new ChainRegistry({ rpc: rpcFor(chain), treasury: addr(treasury), cluster: 'localnet', rules: { treasury: addr(treasury), feeBps: 500 }, storage: memoryStorage() });
  await registry.init();
  const changes = [];
  registry.on('change', (c) => changes.push(c));
  await registry.sync();

  const s = registry.state;
  assert.equal(s.totals.buildings, 241);
  assert.equal(s.totals.volume, 240 * 50_000_000 + 1_000_000);
  assert.equal(s.buildings.get('w9001').owner, addr(buyers[3]));
  assert.deepEqual(s.voids.map((v) => v.reason).sort(), ['taken', 'underpaid']);
  assert.ok(changes.length >= 3, 'history arrived progressively in chunks');
  assert.ok(changes.every((c) => c.initial), 'first sync is flagged as history');

  // Live updates after catch-up are not "initial".
  send(buyers[4], { lamports: 50_000_000, memo: buildMemo('buy', { key: 'w77777', center: [3, 3], price: 50_000_000 }) });
  await registry.sync();
  assert.equal(changes.at(-1).initial, false);
  assert.equal(changes.at(-1).fresh[0].key, 'w77777');
});

test('resumes where it stopped when the RPC fails mid-way, and persists progress', async () => {
  const { chain, treasury, send } = await setupChain();
  const buyer = nacl.sign.keyPair();
  chain.airdrop(addr(buyer), 10_000_000_000);
  const sigs = [];
  for (let i = 0; i < 30; i++) sigs.push(send(buyer, { lamports: 50_000_000, memo: buildMemo('buy', { key: `w${i + 1}`, center: [0, 0], price: 50_000_000 }) }));
  const storage = memoryStorage();
  let broken = true;
  const rpc = rpcFor(chain, { failTx: (sig) => broken && sig === sigs[20] });
  const registry = new ChainRegistry({ rpc, treasury: addr(treasury), cluster: 'localnet', rules: { treasury: addr(treasury), feeBps: 500 }, storage });
  await registry.init();
  await registry.sync();
  assert.equal(registry.state.totals.buildings, 20, 'everything before the failing transaction is kept');

  broken = false;
  await registry.sync();
  assert.equal(registry.state.totals.buildings, 30, 'the next sync picks up from the failure');

  // A new page load starts from the cache and only asks for new signatures.
  const again = new ChainRegistry({ rpc: rpcFor(chain), treasury: addr(treasury), cluster: 'localnet', rules: { treasury: addr(treasury), feeBps: 500 }, storage });
  await again.init();
  assert.equal(again.state.totals.buildings, 30);
  let fetched = 0;
  again.rpc = rpcFor(chain, { failTx: () => (fetched++, false) });
  await again.sync();
  assert.equal(fetched, 0, 'nothing is re-downloaded');
});

test('ignores payments to the treasury that do not carry the registry reference', async () => {
  const { chain, treasury, send } = await setupChain();
  const buyer = nacl.sign.keyPair();
  chain.airdrop(addr(buyer), 5_000_000_000);
  send(buyer, { lamports: 50_000_000, memo: buildMemo('buy', { key: 'w42', center: [0, 0], price: 50_000_000 }), refs: [] });
  const registry = new ChainRegistry({ rpc: rpcFor(chain), treasury: addr(treasury), cluster: 'localnet', rules: { treasury: addr(treasury), feeBps: 500 }, storage: memoryStorage() });
  await registry.init();
  await registry.sync();
  assert.equal(registry.state.totals.buildings, 0);
});
