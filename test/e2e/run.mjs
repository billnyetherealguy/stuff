// End-to-end scenarios. Usage: node e2e/run.mjs [demo|live|mobile|all]
// Screenshots land in test/artifacts/.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { setup, launch } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'artifacts');
fs.mkdirSync(OUT, { recursive: true });
const which = process.argv[2] || 'all';
const results = [];

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`ok   ${name} (${Date.now() - t0}ms)`);
    console.log(`ok   ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err.message}`);
    console.log(`FAIL ${name}: ${err.stack}`);
    throw err;
  }
}

const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

async function ready(page, origin, hash = '') {
  await page.goto(`${origin}/${hash}`);
  await page.waitForFunction(() => window.solworld && !document.querySelector('#loader'), null, { timeout: 30_000 });
}

/** Screen point of a lng/lat, after the camera settles. */
async function settle(page) {
  await page.waitForFunction(() => !window.solworld.map.map.isMoving(), null, { timeout: 20_000 });
  await page.evaluate(() => new Promise((r) => window.solworld.map.map.once('idle', r)));
}

async function stopMotion(page) {
  await page.evaluate(() => {
    window.solworld.map.stopOrbit();
    window.solworld.map.stopSpin();
  });
}

async function project(page, lngLat) {
  return page.evaluate(([lng, lat]) => {
    const p = window.solworld.map.map.project([lng, lat]);
    return { x: p.x, y: p.y };
  }, lngLat);
}

async function clickBuildingAt(page, lngLat, { keepCamera = false } = {}) {
  if (!keepCamera) {
    // Top-down over the target so nothing taller stands in front of it.
    await page.evaluate(([lng, lat]) => {
      const mc = window.solworld.map;
      mc.stopOrbit();
      mc.map.jumpTo({ center: [lng, lat], zoom: 16.4, pitch: 0 });
    }, lngLat);
    await page.evaluate(() => new Promise((r) => window.solworld.map.map.once('idle', r)));
  }
  const p = await project(page, lngLat);
  await page.mouse.click(p.x, p.y);
  await page.waitForFunction(() => document.querySelector('#panel')?.dataset.tone && document.querySelector('#panel').dataset.tone !== 'resolving', null, { timeout: 15_000 });
}

const EMPIRE = [-73.985664, 40.74844];

async function closePanel(page) {
  if (await page.evaluate(() => document.querySelector('#panel')?.classList.contains('is-open'))) {
    await page.locator('#panel .panel-close').click();
    await page.waitForTimeout(400);
  }
}

async function demo(env) {
  const { page, log, browser } = await launch({ ...env });
  try {
    await step('demo: loads with no errors, hero over globe', async () => {
      await ready(page, env.origin);
      await page.waitForTimeout(2200);
      await shot(page, '01-hero-globe');
      assert.equal(await page.evaluate(() => window.solworld.settings.mode), 'demo');
      assert.deepEqual(log.errors, []);
    });

    await step('demo: seeds landmarks into the leaderboard', async () => {
      await page.waitForFunction(() => window.solworld.registry.state.totals.buildings >= 5, null, { timeout: 15_000 });
    });

    await step('demo: start exploring flies into the city in 3D', async () => {
      await page.getByRole('button', { name: 'Start exploring' }).click();
      await page.waitForTimeout(800);
      await settle(page);
      await stopMotion(page);
      const cam = await page.evaluate(() => window.solworld.map.cameraState());
      assert.ok(cam.zoom > 15 && cam.pitch > 50, JSON.stringify(cam));
      await page.waitForTimeout(700);
      await shot(page, '02-city-3d');
    });

    await step('demo: hovering highlights a single building', async () => {
      let hovered = false;
      for (const [x, y] of [[1000, 400], [900, 483], [1100, 520], [960, 620], [860, 380], [1180, 420], [760, 520], [1040, 700]]) {
        await page.mouse.move(x, y);
        await page.waitForTimeout(250);
        if (await page.evaluate(() => !!window.solworld.map.hover)) {
          hovered = true;
          break;
        }
      }
      assert.ok(hovered, 'hover state set');
      const kinds = await page.evaluate(async () => (await window.solworld.map.map.getSource('sw-shells').getData()).features.map((f) => f.properties.kind));
      assert.ok(kinds.includes('hover'), `hover shell rendered (${kinds})`);
    });

    await step('demo: clicking a landmark opens the panel with owner, facts, photo', async () => {
      await clickBuildingAt(page, EMPIRE);
      await page.waitForFunction(() => document.querySelector('.panel-title')?.textContent === 'Empire State Building', null, { timeout: 10_000 });
      await page.waitForTimeout(2600);
      await stopMotion(page);
      const tone = await page.evaluate(() => document.querySelector('#panel').dataset.tone);
      assert.equal(tone, 'owned', 'Empire State Building is pre-owned in demo');
      assert.match(await page.locator('.facts').innerText(), /443 m/);
      await shot(page, '03-landmark-panel');
      assert.match(page.url(), /#\/b\/w\d+/);
    });

    await step('demo: satellite tab shows the traced footprint', async () => {
      await page.getByRole('tab', { name: 'Satellite' }).click();
      await page.waitForTimeout(1800);
      assert.ok(await page.locator('.sat-line').count());
      await page.locator('#panel .panel-media').screenshot({ path: path.join(OUT, '04-satellite-closeup.png') });
    });

    let target;
    await step('demo: an ordinary building resolves via OSM and is available', async () => {
      await closePanel(page);
      await page.waitForTimeout(500);
      target = await page.evaluate(() => {
        // a default-height building (merged in tiles) near the view center
        const m = window.solworld.map.map;
        const c = m.getCenter();
        return [c.lng + 0.0022, c.lat + 0.0006];
      });
      await clickBuildingAt(page, target);
      const tone = await page.evaluate(() => document.querySelector('#panel').dataset.tone);
      assert.equal(tone, 'available');
      await page.waitForTimeout(1500);
      await stopMotion(page);
      await shot(page, '05-available-panel');
    });

    await step('demo: connect a demo wallet and claim for free', async () => {
      await page.locator('.panel-foot').getByRole('button', { name: /Connect wallet/ }).click();
      await page.getByRole('button', { name: /Use a demo wallet/ }).click();
      await page.waitForTimeout(400);
      await page.getByRole('button', { name: 'Claim for free' }).click();
      await page.getByRole('button', { name: 'I understand' }).click();
      await page.waitForFunction(() => document.querySelector('#panel').dataset.tone === 'mine', null, { timeout: 10_000 });
      await page.waitForTimeout(900);
      await shot(page, '06-claimed');
      const me = await page.evaluate(() => window.solworld.wallet.address);
      const owner = await page.evaluate((a) => window.solworld.registry.state.owners.get(a)?.count, me);
      assert.equal(owner, 1);
    });

    await step('demo: buy a second building, leaderboard shows you', async () => {
      await page.waitForTimeout(1500);
      await closePanel(page);
      await page.waitForTimeout(400);
      const p2 = await page.evaluate(() => {
        const c = window.solworld.map.map.getCenter();
        return [c.lng - 0.0016, c.lat - 0.0012];
      });
      await clickBuildingAt(page, p2);
      const tone = await page.evaluate(() => document.querySelector('#panel').dataset.tone);
      if (tone === 'available') {
        await page.getByRole('button', { name: /^Buy for/ }).click();
        await page.waitForFunction(() => document.querySelector('#panel').dataset.tone === 'mine', null, { timeout: 10_000 });
      }
      await page.evaluate(() => document.querySelector('.rail-opener:not(.is-hidden)')?.click());
      await page.waitForTimeout(900);
      await stopMotion(page);
      await shot(page, '07-leaderboard');
      assert.ok(await page.locator('.leader.is-me').count(), 'you are on the leaderboard');
    });

    await step('demo: activity feed and owner profile', async () => {
      await page.getByRole('tab', { name: 'Activity' }).click();
      await page.waitForTimeout(600);
      assert.ok((await page.locator('.feed-item').count()) >= 3);
      await page.getByRole('tab', { name: 'Leaderboard' }).click();
      await page.locator('.leader').first().click();
      await page.waitForTimeout(600);
      await shot(page, '08-owner-profile');
    });

    await step('demo: search finds a landmark and opens it', async () => {
      await closePanel(page);
      await page.keyboard.press('/');
      await page.keyboard.type('empire state');
      await page.waitForSelector('.search-item >> text=Empire State Building');
      await shot(page, '09-search');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.panel-title')?.textContent === 'Empire State Building', null, { timeout: 15_000 });
    });

    await step('demo: how it works + operator modals', async () => {
      await stopMotion(page);
      await page.locator('#btn-help').click();
      await page.waitForSelector('.modal-title >> text=How it works');
      await page.waitForTimeout(700);
      await shot(page, '10-how-it-works');
      await page.getByRole('button', { name: 'Operator & refunds' }).click();
      await page.waitForSelector('.modal-title >> text=Operator');
      await page.waitForTimeout(700);
      await shot(page, '11-operator');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
    });

    await step('demo: globe view shows ownership lights', async () => {
      await closePanel(page);
      await page.getByRole('button', { name: 'Whole world' }).click();
      await page.waitForTimeout(3600);
      await shot(page, '12-globe-lights');
    });

    await step('demo: deep link opens a building directly', async () => {
      const key = await page.evaluate(() => [...window.solworld.registry.state.buildings.keys()][0]);
      await page.goto(`${env.origin}/#/b/${key}`);
      await page.waitForFunction(() => window.solworld && document.querySelector('#panel.is-open'), null, { timeout: 20_000 });
    });

    await step('demo: no page errors', async () => {
      assert.deepEqual(log.errors, []);
      const bad = log.console.filter((l) => /^error/.test(l));
      assert.deepEqual(bad, []);
    });
  } finally {
    await browser.close();
  }
}

async function live(env) {
  const treasury = nacl.sign.keyPair();
  const treasuryAddr = bs58.encode(treasury.publicKey);
  env.chain.airdrop(treasuryAddr, 1_000_000);
  const alice = nacl.sign.keyPair(); // 1 SOL: free claim + purchase
  const bob = nacl.sign.keyPair(); // 0.1 SOL: not eligible for a free claim
  env.chain.airdrop(bs58.encode(alice.publicKey), 1_000_000_000);
  env.chain.airdrop(bs58.encode(bob.publicKey), 100_000_000);
  const config = { treasury: treasuryAddr, cluster: 'mainnet-beta', pollSeconds: 5 };
  const { page, log, browser, harness } = await launch({ ...env, config });
  harness.setKeypair(alice);
  try {
    await step('live: boots in live mode against the local chain', async () => {
      await ready(page, env.origin);
      assert.equal(await page.evaluate(() => window.solworld.settings.mode), 'live');
      await page.waitForFunction(() => window.solworld.registry.status.lastSync, null, { timeout: 15_000 });
      assert.equal(await page.evaluate(() => window.solworld.registry.state.totals.buildings), 0);
      await page.waitForTimeout(1200);
      await shot(page, '20-live-hero');
    });

    await step('live: connect the Wallet Standard wallet', async () => {
      await page.getByRole('button', { name: 'Start exploring' }).click();
      await page.waitForTimeout(600);
      await settle(page);
      await stopMotion(page);
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
      await page.getByRole('button', { name: /Harness Wallet/ }).click();
      await page.waitForFunction(() => window.solworld.wallet.balance === 1_000_000_000, null, { timeout: 10_000 });
    });

    let claimed;
    await step('live: free claim lands on-chain and shows as yours', async () => {
      await clickBuildingAt(page, EMPIRE);
      await page.getByRole('button', { name: 'Claim for free' }).click();
      await page.getByRole('button', { name: 'I understand' }).click();
      await page.waitForFunction(() => document.querySelector('#panel').dataset.tone === 'mine', null, { timeout: 30_000 });
      claimed = env.chain.sent.at(-1);
      assert.match(claimed.memo, /^solworld:claim:w\d+@40\.74\d+,-73\.98\d+$/);
      const transfer = claimed.instructions.find((i) => i.parsed?.type === 'transfer');
      assert.equal(transfer.parsed.info.lamports, 0);
      assert.equal(transfer.parsed.info.destination, treasuryAddr);
      const registry = await page.evaluate(() => window.solworld.registry.address);
      assert.ok(claimed.keys.includes(registry), 'registry reference key is in the transaction');
      await page.waitForTimeout(1200);
      await stopMotion(page);
      await shot(page, '21-live-claimed');
    });

    await step('live: purchase pays the treasury exactly the price', async () => {
      const before = env.chain.balance(treasuryAddr);
      await closePanel(page);
      await clickBuildingAt(page, [-73.975311, 40.751652]); // Chrysler
      await page.getByRole('button', { name: /^Buy for 0\.05 SOL/ }).click();
      await page.waitForFunction(() => document.querySelector('#panel').dataset.tone === 'mine', null, { timeout: 30_000 });
      assert.equal(env.chain.balance(treasuryAddr) - before, 50_000_000);
      assert.equal(await page.evaluate(() => window.solworld.registry.state.totals.volume), 50_000_000);
    });

    await step('live: rejected wallet request is handled', async () => {
      await closePanel(page);
      await clickBuildingAt(page, [-73.989699, 40.741061]); // Flatiron
      harness.rejectNext();
      await page.getByRole('button', { name: /^Buy for/ }).click();
      await page.waitForSelector('.toast >> text=Cancelled', { timeout: 10_000 });
      assert.equal(await page.evaluate(() => document.querySelector('#panel').dataset.tone), 'available');
    });

    await step('live: another buyer’s purchase appears via polling', async () => {
      // Bob buys the Flatiron from "outside" (straight to the chain).
      const { compileMessage, transferInstruction, memoInstruction, serializeUnsignedTransaction } = await import('../../solworld/assets/js/solana.js');
      const { buildMemo, deriveRegistryAddress } = await import('../../solworld/assets/js/registry.js');
      const flatiron = env.tiles.world.buildings.find((b) => b.tags.name === 'Flatiron Building');
      const reference = await deriveRegistryAddress(treasuryAddr);
      const bobAddr = bs58.encode(bob.publicKey);
      const msg = compileMessage({
        payer: bobAddr,
        recentBlockhash: env.chain.svm.latestBlockhash(),
        instructions: [
          transferInstruction({ from: bobAddr, to: treasuryAddr, lamports: 50_000_000, references: [reference] }),
          memoInstruction(buildMemo('buy', `w${flatiron.id}`, [-73.989699, 40.741061])),
        ],
      });
      env.chain.signAndSubmit(serializeUnsignedTransaction(msg), bob);
      await page.waitForFunction(() => document.querySelector('#panel').dataset.tone === 'owned', null, { timeout: 20_000 });
      await page.waitForTimeout(800);
      await stopMotion(page);
      await shot(page, '22-live-owned-by-other');
    });

    await step('live: wallet without 0.2 SOL cannot claim', async () => {
      harness.setKeypair(bob);
      await page.evaluate(async () => {
        await window.solworld.wallet.disconnect();
      });
      await closePanel(page);
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
      await page.getByRole('button', { name: /Harness Wallet/ }).click();
      await page.waitForFunction(() => window.solworld.wallet.balance != null && window.solworld.wallet.balance < 100_000_000, null, { timeout: 10_000 });
      const p = await page.evaluate(() => {
        const c = window.solworld.map.map.getCenter();
        return [c.lng + 0.0019, c.lat - 0.0004];
      });
      await clickBuildingAt(page, p);
      assert.equal(await page.getByRole('button', { name: 'Claim for free' }).count(), 0);
      assert.ok(await page.getByText(/Hold more than 0\.2 SOL/).count());
    });

    await step('live: leaderboard reflects chain state', async () => {
      const board = await page.evaluate(() => window.solworld.registry.state.leaderboard.map((o) => [o.address, o.count]));
      assert.deepEqual(board, [
        [bs58.encode(alice.publicKey), 2],
        [bs58.encode(bob.publicKey), 1],
      ]);
      await page.evaluate(() => document.querySelector('.rail-opener:not(.is-hidden)')?.click());
      await page.waitForTimeout(700);
      await shot(page, '23-live-leaderboard');
    });

    await step('live: no page errors', async () => {
      assert.deepEqual(log.errors, []);
      assert.deepEqual(log.console.filter((l) => /^error/.test(l)), []);
    });
  } finally {
    await browser.close();
  }
}

async function mobile(env) {
  const { page, log, browser } = await launch({ ...env, viewport: { width: 390, height: 844 }, mobile: true });
  try {
    await step('mobile: hero fits the screen', async () => {
      await ready(page, env.origin);
      await page.waitForTimeout(1800);
      await shot(page, '30-mobile-hero');
    });
    await step('mobile: tap a building opens the bottom sheet', async () => {
      await page.getByRole('button', { name: 'Start exploring' }).tap();
      await page.waitForTimeout(600);
      await settle(page);
      await stopMotion(page);
      const p = await project(page, EMPIRE);
      await page.touchscreen.tap(p.x, p.y);
      await page.waitForFunction(() => document.querySelector('#panel')?.dataset.tone && document.querySelector('#panel').dataset.tone !== 'resolving', null, { timeout: 15_000 });
      await page.waitForTimeout(2200);
      await stopMotion(page);
      await shot(page, '31-mobile-sheet');
    });
    await step('mobile: no page errors', async () => {
      assert.deepEqual(log.errors, []);
    });
  } finally {
    await browser.close();
  }
}

const env = await setup();
try {
  if (which === 'demo' || which === 'all') await demo(env);
  if (which === 'live' || which === 'all') await live(env);
  if (which === 'mobile' || which === 'all') await mobile(env);
} finally {
  env.server.close();
  console.log(`\n${results.join('\n')}`);
}
