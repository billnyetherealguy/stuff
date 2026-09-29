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
let activePage = null; // screenshot target when a step fails

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`ok   ${name} (${Date.now() - t0}ms)`);
    console.log(`ok   ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err.message}`);
    await activePage?.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => {});
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
  await page.evaluate(() => window.solworld.map.settled());
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

async function clickBuildingAt(page, lngLat, { keepCamera = false, timeout = 15_000 } = {}) {
  if (!keepCamera) {
    // Top-down over the target so nothing taller stands in front of it.
    await page.evaluate(([lng, lat]) => {
      const mc = window.solworld.map;
      mc.stopOrbit();
      mc.map.jumpTo({ center: [lng, lat], zoom: 16.4, pitch: 0 });
    }, lngLat);
    await page.evaluate(() => window.solworld.map.settled());
  }
  const p = await project(page, lngLat);
  await page.mouse.click(p.x, p.y);
  await page.waitForFunction(() => document.querySelector('#panel.is-open')?.dataset.tone && document.querySelector('#panel').dataset.tone !== 'resolving', null, { timeout });
}

const EMPIRE = [-73.985664, 40.74844];

async function closePanel(page) {
  if (await page.evaluate(() => document.querySelector('#panel')?.classList.contains('is-open'))) {
    await page.locator('#panel .panel-close').click();
    await page.waitForTimeout(400);
  }
}

async function createWallet(page) {
  await page.getByRole('button', { name: 'Create my wallet' }).click();
  await page.waitForSelector('.modal-title >> text=Deposit SOL');
}

async function done(page) {
  await page.getByRole('button', { name: 'Done' }).click();
  await page.waitForTimeout(400);
}

async function openWalletMenu(page) {
  if (!(await page.evaluate(() => document.querySelector('#wallet-slot').classList.contains('menu-open')))) await page.locator('.wallet-pill').click();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.wallet-menu')).opacity === '1');
}

const tone = (page) => page.evaluate(() => document.querySelector('#panel').dataset.tone);
const waitTone = (page, t, timeout = 15_000) => page.waitForFunction((x) => document.querySelector('#panel').dataset.tone === x, t, { timeout });

async function nearby(page, dx, dy) {
  return page.evaluate(([x, y]) => {
    const c = window.solworld.map.map.getCenter();
    return [c.lng + x, c.lat + y];
  }, [dx, dy]);
}

/** Clicks around the view until an available building opens. */
async function openAvailable(page, offsets) {
  for (const [dx, dy] of offsets) {
    await closePanel(page);
    try {
      await clickBuildingAt(page, await nearby(page, dx, dy), { timeout: 4000 });
    } catch {
      continue; // clicked a street, try the next spot
    }
    if ((await tone(page)) === 'available') return true;
  }
  throw new Error('no available building found');
}

async function demo(env) {
  const { page, log, browser, harness } = await launch({ ...env, config: {} });
  activePage = page;
  try {
    await step('demo: loads with no errors, hero over globe', async () => {
      await ready(page, env.origin);
      await page.waitForTimeout(2200);
      await shot(page, '01-hero-globe');
      assert.equal(await page.evaluate(() => window.solworld.settings.mode), 'demo');
      assert.deepEqual(log.errors, []);
    });

    await step('demo: seeds landmarks (with a billboard) into the leaderboard', async () => {
      await page.waitForFunction(() => window.solworld.registry.state.totals.buildings >= 5, null, { timeout: 15_000 });
      assert.ok(await page.evaluate(() => [...window.solworld.registry.state.buildings.values()].some((b) => b.sign)));
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
    });

    await step('demo: famous landmark is owned, priced at the 3 SOL cap', async () => {
      await clickBuildingAt(page, EMPIRE);
      await page.waitForFunction(() => document.querySelector('.panel-title')?.textContent === 'Empire State Building', null, { timeout: 10_000 });
      await page.waitForTimeout(2600);
      await stopMotion(page);
      assert.equal(await tone(page), 'owned');
      assert.match(await page.locator('.facts').innerText(), /443 m/);
      assert.ok(await page.getByRole('button', { name: 'Get a wallet to make an offer' }).count(), 'offer form for owned buildings');
      await shot(page, '03-landmark-panel');
      assert.match(page.url(), /#\/b\/w\d+/);
    });

    await step('demo: satellite tab shows the traced footprint', async () => {
      await page.getByRole('tab', { name: 'Satellite' }).click();
      await page.waitForTimeout(1800);
      assert.ok(await page.locator('.sat-line').count());
      await page.locator('#panel .panel-media').screenshot({ path: path.join(OUT, '04-satellite-closeup.png') });
    });

    await step('demo: an ordinary building is available with a price breakdown', async () => {
      await openAvailable(page, [[0.0022, 0.0006], [-0.0016, -0.0012], [0.0019, -0.0004], [-0.003, 0.001]]);
      await page.waitForTimeout(1500);
      await stopMotion(page);
      assert.ok(await page.locator('.price-factors .chip').count());
      await shot(page, '05-available-panel');
    });

    await step('demo: get a Solworld wallet (no extension) and buy', async () => {
      await page.getByRole('button', { name: 'Get a wallet to own this' }).click();
      await createWallet(page);
      await shot(page, '06-deposit');
      await done(page);
      const before = await page.evaluate(() => window.solworld.wallet.balance);
      assert.equal(before, 5_000_000_000);
      const label = await page.getByRole('button', { name: /^Buy for/ }).innerText();
      const price = Math.round(Number(/Buy for ([\d.]+) SOL/.exec(label)[1]) * 1e9);
      await page.getByRole('button', { name: /^Buy for/ }).click();
      await page.getByRole('button', { name: 'I understand' }).click();
      await waitTone(page, 'mine');
      assert.equal(await page.evaluate(() => window.solworld.wallet.balance), before - price);
      await page.waitForTimeout(900);
      await shot(page, '07-bought');
    });

    await step('demo: put up a billboard that shows on the map', async () => {
      await page.getByText('Put up a billboard').click();
      await page.locator('.sign-editor .field-input').fill('gm from Solworld');
      await page.locator('.sign-editor .swatch').nth(3).click();
      await page.getByRole('button', { name: 'Save billboard' }).click();
      await page.waitForSelector('.billboard >> text=gm from Solworld', { timeout: 10_000 });
      const key = await page.evaluate(() => location.hash.split('/').pop());
      assert.deepEqual(await page.evaluate((k) => window.solworld.registry.state.buildings.get(k).sign.color, key), 3);
      await closePanel(page);
      await page.evaluate(() => window.solworld.map.map.easeTo({ zoom: 15.2, pitch: 45, duration: 0 }));
      await page.evaluate(() => window.solworld.map.settled());
      const signs = await page.evaluate(() => window.solworld.map.map.queryRenderedFeatures({ layers: ['sw-signs'] }).map((f) => f.properties.sign));
      assert.ok(signs.includes('gm from Solworld'), `rendered signs: ${signs}`);
      await shot(page, '08-billboard-map');
    });

    await step('demo: link meme-coin holdings and take a building with credit', async () => {
      await openWalletMenu(page);
      await page.getByRole('button', { name: /Use your \$DEMO/ }).click();
      await page.locator('.modal .field-input').fill('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
      await page.waitForSelector('.holder-preview >> text=Credit left');
      await shot(page, '09-holder');
      await page.getByRole('button', { name: 'Verify with my wallet' }).click();
      await page.waitForSelector('.toast >> text=$DEMO linked', { timeout: 10_000 });
      await page.evaluate(() => window.solworld.map.map.jumpTo({ zoom: 16.4 }));
      await openAvailable(page, [[-0.0016, -0.0012], [0.0019, -0.0004], [-0.003, 0.001], [0.001, 0.0025]]);
      await page.getByRole('button', { name: /Use \$DEMO credit/ }).click();
      await waitTone(page, 'mine');
      const key = await page.evaluate(() => location.hash.split('/').pop());
      assert.equal(await page.evaluate((k) => window.solworld.registry.state.buildings.get(k).acquired, key), 'hold');
    });

    await step('demo: offer on an owned landmark; the owner accepts', async () => {
      await closePanel(page);
      await clickBuildingAt(page, EMPIRE);
      await page.waitForTimeout(600);
      await page.locator('.offer-form .field-input').fill('3.4');
      await page.getByRole('button', { name: 'Make offer' }).click();
      await page.waitForSelector('.toast >> text=Offer sent', { timeout: 10_000 });
      await stopMotion(page);
      await shot(page, '10-offer-sent');
      await waitTone(page, 'mine', 20_000);
      const rec = await page.evaluate(() => {
        const s = window.solworld.registry.state;
        return s.buildings.get(location.hash.split('/').pop());
      });
      assert.equal(rec.acquired, 'sale');
      assert.equal(rec.price, 3_400_000_000);
    });

    await step('demo: an incoming offer can be accepted from the panel', async () => {
      await page.evaluate(async () => {
        const key = location.hash.split('/').pop();
        await window.solworld.registry.submit({ action: 'offer', key, price: 3_900_000_000, nonce: 'demo', nonceValue: 'demo', buyerSig: 'demo', signers: ['Bidder11111111111111111111111111111111111111'], transfers: [{ s: 'Bidder11111111111111111111111111111111111111', d: 'DemoTreasury1111111111111111111111111111111', l: 0 }], tokens: [] });
      });
      await page.waitForSelector('.toast >> text=New offer: 3.90 SOL', { timeout: 10_000 });
      await page.waitForSelector('.offers >> text=3.90 SOL');
      await shot(page, '11-incoming-offer');
      const before = await page.evaluate(() => window.solworld.wallet.balance);
      await page.locator('.offer').getByRole('button', { name: 'Accept' }).click();
      await waitTone(page, 'owned');
      assert.equal(await page.evaluate(() => window.solworld.wallet.balance) - before, 3_900_000_000 - 195_000_000);
    });

    await step('demo: close up, buildings get lit facades over satellite ground', async () => {
      await closePanel(page);
      await page.evaluate(([lng, lat]) => window.solworld.map.map.jumpTo({ center: [lng, lat], zoom: 17.2, pitch: 62, bearing: 30 }), EMPIRE);
      await page.evaluate(() => window.solworld.map.settled());
      await page.waitForTimeout(800);
      const ok = await page.evaluate(() => {
        const m = window.solworld.map.map;
        return m.getZoom() >= 16 && !!m.getLayer('building-facade') && m.hasImage('facade-0') && !!m.getLayer('satellite');
      });
      assert.ok(ok, 'facade patterns + satellite ground are active');
      await shot(page, '12-closeup-realism');
    });

    await step('demo: leaderboard, activity and owner profile', async () => {
      await page.evaluate(() => document.querySelector('.rail-opener:not(.is-hidden)')?.click());
      await page.waitForTimeout(900);
      assert.ok(await page.locator('.leader.is-me').count(), 'you are on the leaderboard');
      await page.getByRole('tab', { name: 'Activity' }).click();
      await page.waitForTimeout(600);
      assert.ok((await page.locator('.feed-item').count()) >= 5);
      await shot(page, '13-activity');
      await page.getByRole('tab', { name: 'Leaderboard' }).click();
      await page.locator('.leader').first().click();
      await page.waitForTimeout(600);
    });

    await step('demo: wallet menu, withdraw and backup', async () => {
      await openWalletMenu(page);
      await shot(page, '14-wallet-menu');
      await page.getByRole('button', { name: 'Withdraw' }).first().click();
      await page.locator('.modal input.field-input').first().fill('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
      await page.locator('.modal input.field-input').nth(1).fill('1');
      const before = await page.evaluate(() => window.solworld.wallet.balance);
      await page.locator('.modal-actions').getByRole('button', { name: 'Withdraw' }).click();
      await page.waitForSelector('.toast >> text=Withdrawal sent');
      assert.equal(before - (await page.evaluate(() => window.solworld.wallet.balance)), 1_000_000_000);
      await openWalletMenu(page);
      await page.getByRole('menuitem', { name: 'Back up key' }).click();
      await page.waitForSelector('.secret');
      const secret = await page.locator('.secret').innerText();
      const kp = nacl.sign.keyPair.fromSecretKey(bs58.decode(secret));
      assert.equal(bs58.encode(kp.publicKey), await page.evaluate(() => window.solworld.wallet.address));
      await page.keyboard.press('Escape');
    });

    await step('demo: search finds a landmark and opens it', async () => {
      await closePanel(page);
      await page.keyboard.press('/');
      await page.keyboard.type('empire state');
      await page.waitForSelector('.search-item >> text=Empire State Building');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.panel-title')?.textContent === 'Empire State Building', null, { timeout: 15_000 });
    });

    await step('demo: how it works + operator modals', async () => {
      await stopMotion(page);
      await page.locator('#btn-help').click();
      await page.waitForSelector('.modal-title >> text=How it works');
      await page.waitForTimeout(700);
      await shot(page, '15-how-it-works');
      await page.getByRole('button', { name: /Operator/ }).click();
      await page.waitForSelector('.modal-title >> text=Operator');
      await page.waitForTimeout(700);
      await shot(page, '16-operator');
      // Enter a meme coin right on the site.
      const coinForm = page.locator('.op-coin');
      await coinForm.getByPlaceholder('Token mint address').fill('So1wor1dMint1111111111111111111111111111111');
      await coinForm.getByPlaceholder('Ticker (e.g. SOLW)').fill('SOLW');
      await coinForm.locator('input[type=number]').fill('0.5');
      await coinForm.getByRole('button', { name: /Update coin|Save coin/ }).click();
      await page.waitForSelector('.toast >> text=$SOLW is live', { timeout: 10_000 });
      const coin = await page.evaluate(() => window.solworld.registry.state.coin);
      assert.equal(coin.symbol, 'SOLW');
      assert.equal(coin.prices.at(-1).lamportsPerToken, 500);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
    });

    await step('demo: globe view shows ownership lights', async () => {
      await closePanel(page);
      await page.getByRole('button', { name: 'Whole world' }).click();
      await page.waitForTimeout(3600);
      await shot(page, '17-globe-lights');
    });

    await step('demo: wallet and buildings survive a reload', async () => {
      const me = await page.evaluate(() => window.solworld.wallet.address);
      const key = await page.evaluate(() => [...window.solworld.registry.state.buildings.keys()][0]);
      await page.goto(`${env.origin}/#/b/${key}`);
      await page.waitForFunction(() => window.solworld && document.querySelector('#panel.is-open'), null, { timeout: 20_000 });
      assert.equal(await page.evaluate(() => window.solworld.wallet.address), me);
      assert.ok(await page.evaluate((a) => window.solworld.registry.state.owners.get(a)?.count >= 2, me));
    });

    await step('demo: with OpenStreetMap servers down, buildings still open and can be bought', async () => {
      harness.setOverpassDown(true);
      await closePanel(page);
      await page.evaluate(() => window.solworld.map.map.jumpTo({ center: [-73.9931, 40.7392], zoom: 16.4, pitch: 0 }));
      await page.evaluate(() => window.solworld.map.settled());
      await openAvailable(page, [[0.0011, 0.0004], [-0.0012, -0.0006], [0.0016, -0.0009], [-0.002, 0.0012], [0.0005, 0.0019]]);
      const key = await page.evaluate(() => location.hash.split('/').pop());
      assert.match(key, /^[wrg]\d+$/);
      assert.ok(await page.getByRole('button', { name: /^Buy for|^Deposit to buy/ }).count(), 'buyable');
      await page.getByRole('button', { name: /^Buy for/ }).click();
      await waitTone(page, 'mine');
      harness.setOverpassDown(false);
    });

    await step('demo: no page errors', async () => {
      assert.deepEqual(log.errors, []);
      const bad = log.console.filter((l) => /^error/.test(l) && !/status of 504/.test(l)); // 504s: the simulated outage
      assert.deepEqual(bad, []);
    });
  } finally {
    await browser.close();
  }
}

async function live(env) {
  const { Rpc } = await import('../../solworld/assets/js/solana.js');
  const { buildMemo, deriveRegistryAddress, saleFee } = await import('../../solworld/assets/js/registry.js');
  const { actionMessage, buildSaleMessage, createNonceMessage, nonceAddressFor } = await import('../../solworld/assets/js/market.js');
  const { BurnerWallet } = await import('../../solworld/assets/js/burner.js');
  const { parseNonceAccount, placeSignature, serializeUnsignedTransaction } = await import('../../solworld/assets/js/solana.js');
  const SOL = 1_000_000_000;
  const chain = env.chain;
  const rpc = new Rpc(['http://chain.test'], { fetchImpl: async (u, init) => ({ ok: true, status: 200, json: async () => chain.handle(JSON.parse(init.body)) }) });
  const mem = () => {
    const m = new Map();
    return { get: (k) => (m.has(k) ? structuredClone(m.get(k)) : null), set: (k, v) => m.set(k, structuredClone(v)), remove: (k) => m.delete(k) };
  };

  const treasury = nacl.sign.keyPair();
  const treasuryAddr = bs58.encode(treasury.publicKey);
  chain.airdrop(treasuryAddr, 1_000_000);
  const reference = await deriveRegistryAddress(treasuryAddr);
  const mint = bs58.encode(nacl.randomBytes(32));
  const config = { treasury: treasuryAddr, cluster: 'mainnet-beta', pollSeconds: 5, memecoin: { mint, symbol: 'MEME', solPerToken: [{ from: '2020-01-01T00:00:00Z', sol: 0.000001 }] } };
  const { page, log, browser, harness } = await launch({ ...env, config });
  activePage = page;
  const bob = new BurnerWallet({ rpc, storage: mem() });
  await bob.create();
  chain.airdrop(bob.address, 10 * SOL);
  const blockhash = async () => (await rpc.getLatestBlockhash()).blockhash;
  const act = async (w, lamports, memo, extra = {}) => w.send(actionMessage({ from: w.address, treasury: treasuryAddr, reference, lamports, memo, ...extra }, await blockhash()));
  let alice;

  try {
    await step('live: boots in live mode against the local chain', async () => {
      await ready(page, env.origin);
      assert.equal(await page.evaluate(() => window.solworld.settings.mode), 'live');
      await page.waitForFunction(() => window.solworld.registry.status.lastSync, null, { timeout: 15_000 });
      assert.equal(await page.evaluate(() => window.solworld.registry.state.totals.buildings), 0);
      await page.waitForTimeout(1200);
      await shot(page, '20-live-hero');
    });

    await step('live: create a Solworld wallet and see a deposit arrive', async () => {
      await page.getByRole('button', { name: 'Start exploring' }).click();
      await page.waitForTimeout(600);
      await settle(page);
      await stopMotion(page);
      await page.locator('.wallet-btn').click();
      await createWallet(page);
      alice = await page.evaluate(() => window.solworld.wallet.address);
      assert.equal(await page.locator('.deposit-addr').innerText(), alice);
      chain.airdrop(alice, 10 * SOL);
      await page.waitForSelector('.deposit-bal >> text=10', { timeout: 12_000 });
      await shot(page, '21-live-deposit');
      await done(page);
    });

    await step('live: buying the Empire State pays the treasury 3 SOL, no pop-ups', async () => {
      const before = chain.balance(treasuryAddr);
      await clickBuildingAt(page, EMPIRE);
      await page.getByRole('button', { name: /^Buy for 3.00 SOL/ }).click();
      await page.getByRole('button', { name: 'I understand' }).click();
      await waitTone(page, 'mine', 30_000);
      assert.equal(chain.balance(treasuryAddr) - before, 3 * SOL);
      const tx = chain.sent.at(-1);
      assert.match(tx.memo, /^solworld:buy:w\d+@40\.74\d+,-73\.98\d+;p=3000000000$/);
      assert.ok(tx.keys.includes(await page.evaluate(() => window.solworld.registry.address)));
    });

    await step('live: billboard lands on-chain', async () => {
      await page.getByText('Put up a billboard').click();
      await page.locator('.sign-editor .field-input').fill('Alice was here');
      await page.getByRole('button', { name: 'Save billboard' }).click();
      await page.waitForSelector('.billboard >> text=Alice was here', { timeout: 20_000 });
      assert.match(chain.sent.at(-1).memo, /^solworld:sign:w\d+;c=0;t=Alice%20was%20here$/);
      await stopMotion(page);
      await shot(page, '22-live-billboard');
    });

    let empireKey;
    await step('live: someone’s offer shows up; accepting swaps atomically', async () => {
      empireKey = await page.evaluate(() => location.hash.split('/').pop());
      const rent = await rpc.getMinimumBalanceForRentExemption(80);
      const nonce = await nonceAddressFor(bob.address, empireKey);
      await bob.send(createNonceMessage({ payer: bob.address, nonce, key: empireKey, lamports: rent, authority: alice, recentBlockhash: await blockhash() }));
      const info = parseNonceAccount((await rpc.getAccountInfo(nonce)).data);
      const price = 3.5 * SOL;
      const sale = buildSaleMessage({ buyer: bob.address, seller: alice, treasury: treasuryAddr, reference, key: empireKey, price, feeBps: 500, nonce, nonceValue: info.value });
      const buyerSig = bs58.encode(await bob.sign(sale.bytes));
      await act(bob, 0, buildMemo('offer', { key: empireKey, price, nonce, nonceValue: info.value, buyerSig }));
      await page.waitForSelector('.toast >> text=New offer: 3.50 SOL', { timeout: 20_000 });
      await shot(page, '23-live-offer');
      const aliceBefore = chain.balance(alice);
      const treasuryBefore = chain.balance(treasuryAddr);
      await page.locator('.offer').getByRole('button', { name: 'Accept' }).click();
      await waitTone(page, 'owned', 30_000);
      const fee = saleFee(price, 500);
      assert.equal(chain.balance(treasuryAddr) - treasuryBefore, fee);
      assert.ok(chain.balance(alice) - aliceBefore >= price - fee - 20_000, 'seller got the price minus fee (less the network fee)');
      assert.equal(await page.evaluate((k) => window.solworld.registry.state.buildings.get(k).owner, empireKey), bob.address);
    });

    await step('live: making an offer sets up the building and the owner can accept it', async () => {
      await page.waitForTimeout(500);
      await page.locator('.offer-form .field-input').fill('3.6');
      await page.getByRole('button', { name: 'Make offer' }).click();
      await page.waitForSelector('.toast >> text=Offer sent', { timeout: 30_000 });
      const offer = await page.evaluate((k) => [...window.solworld.registry.state.offers.values()].find((o) => o.key === k && o.status === 'open'), empireKey);
      assert.equal(offer.buyer, alice);
      // Bob accepts from his side (any client can: the offer is fully pre-signed).
      const sale = buildSaleMessage({ buyer: alice, seller: bob.address, treasury: treasuryAddr, reference, key: empireKey, price: offer.price, feeBps: 500, nonce: offer.nonce, nonceValue: offer.nonceValue });
      const wire = serializeUnsignedTransaction(sale);
      placeSignature(wire, sale, alice, bs58.decode(offer.buyerSig));
      await bob.signInto(wire, sale);
      await rpc.sendRawTransaction(wire);
      await waitTone(page, 'mine', 20_000);
    });

    await step('live: holders verify their meme-coin wallet and take a building with credit', async () => {
      const holder = nacl.sign.keyPair();
      const holderAddr = bs58.encode(holder.publicKey);
      chain.airdrop(holderAddr, SOL);
      chain.setTokenAccount(bs58.encode(nacl.randomBytes(32)), { mint, owner: holderAddr, uiAmount: 2_000_000 }); // 2 SOL of credit
      harness.setKeypair(holder);
      await closePanel(page);
      await openWalletMenu(page);
      await page.getByRole('button', { name: /Use your \$MEME/ }).click();
      await page.locator('.modal .field-input').fill(holderAddr);
      await page.waitForSelector('.holder-preview >> text=2.00 SOL', { timeout: 10_000 });
      await page.getByRole('button', { name: 'Verify with my wallet' }).click();
      await page.getByRole('button', { name: /Harness Wallet/ }).click();
      await page.waitForSelector('.toast >> text=$MEME linked', { timeout: 30_000 });
      await clickBuildingAt(page, [-73.975311, 40.751652]); // Chrysler: famous, 3 SOL > 2 SOL credit
      assert.equal(await page.getByRole('button', { name: /Use \$MEME credit/ }).count(), 0);
      await openAvailable(page, [[0.0022, 0.0006], [-0.0016, -0.0012], [0.0019, -0.0004]]);
      const before = chain.balance(treasuryAddr);
      await page.getByRole('button', { name: /Use \$MEME credit/ }).click();
      await waitTone(page, 'mine', 30_000);
      assert.equal(chain.balance(treasuryAddr), before, 'credit moves no SOL');
      const key = await page.evaluate(() => location.hash.split('/').pop());
      assert.equal(await page.evaluate((k) => window.solworld.registry.state.buildings.get(k).holder, key), holderAddr);
      await stopMotion(page);
      await shot(page, '24-live-credit');
    });

    await step('live: operator enters the meme coin on the site, signed by the treasury', async () => {
      harness.setKeypair(treasury);
      await closePanel(page);
      await page.goto(`${env.origin}/#/operator`);
      await page.waitForSelector('.modal-title >> text=Operator tools', { timeout: 20_000 });
      const form = page.locator('.op-coin');
      const newMint = bs58.encode(nacl.randomBytes(32));
      await form.getByPlaceholder('Token mint address').fill(newMint);
      await form.getByPlaceholder('Ticker (e.g. SOLW)').fill('SOLW');
      await form.locator('input[type=number]').fill('2');
      await form.getByRole('button', { name: /Update coin|Save coin/ }).click();
      await page.getByRole('button', { name: /Harness Wallet/ }).click();
      await page.waitForSelector('.toast >> text=$SOLW is live', { timeout: 30_000 });
      assert.match(chain.sent.at(-1).memo, new RegExp(`^solworld:coin:${newMint};s=SOLW;p=2000$`));
      assert.equal(await page.evaluate(() => window.solworld.registry.state.coin.symbol), 'SOLW');
      await shot(page, '26-live-coin');
      await page.keyboard.press('Escape');
    });

    await step('live: withdraw sends SOL out of the Solworld wallet', async () => {
      const dest = bs58.encode(nacl.sign.keyPair().publicKey);
      await openWalletMenu(page);
      await page.getByRole('button', { name: 'Withdraw' }).first().click();
      await page.locator('.modal input.field-input').first().fill(dest);
      await page.locator('.modal input.field-input').nth(1).fill('0.5');
      await page.locator('.modal-actions').getByRole('button', { name: 'Withdraw' }).click();
      await page.waitForSelector('.toast >> text=Withdrawal sent', { timeout: 20_000 });
      await page.waitForFunction(() => true);
      for (let i = 0; i < 20 && chain.balance(dest) === 0; i++) await page.waitForTimeout(250);
      assert.equal(chain.balance(dest), 0.5 * SOL);
    });

    await step('live: leaderboard reflects chain state', async () => {
      const board = await page.evaluate(() => window.solworld.registry.state.leaderboard.map((o) => [o.address, o.count]));
      assert.deepEqual(board, [[alice, 2]]);
      await page.evaluate(() => document.querySelector('.rail-opener:not(.is-hidden)')?.click());
      await page.waitForTimeout(700);
      await shot(page, '25-live-leaderboard');
    });

    await step('live: no page errors', async () => {
      assert.deepEqual(log.errors, []);
      assert.deepEqual(log.console.filter((l) => /^error/.test(l)), []);
    });
  } finally {
    await browser.close();
  }
}

async function real3d(env) {
  const config = { realistic3d: { googleKey: 'AIzaHarnessKey000000000000000000000000' } };
  const { page, log, browser } = await launch({ ...env, config });
  activePage = page;
  const idle = () => page.evaluate(() => window.solworld.map.settled());
  try {
    await step('real3d: street life — cars and people move through Midtown', async () => {
      await ready(page, env.origin);
      await page.getByRole('button', { name: 'Start exploring' }).click({ force: true });
      await page.waitForTimeout(800);
      await settle(page);
      await stopMotion(page);
      await page.evaluate(() => window.solworld.map.map.jumpTo({ center: [-73.9794, 40.7515], zoom: 16.3, pitch: 55, bearing: 20 }));
      await idle();
      await page.waitForFunction(() => window.solworld.traffic.agents.length > 50, null, { timeout: 20_000 });
      const before = await page.evaluate(() => window.solworld.traffic.snapshot()[0]);
      await page.waitForTimeout(1500);
      const after = await page.evaluate(() => window.solworld.traffic.snapshot()[0]);
      assert.ok(before.lng !== after.lng || before.lat !== after.lat, 'agents move');
      await shot(page, '40-street-life');
    });

    await step('real3d: zooming in switches to real 3D buildings', async () => {
      await page.evaluate(() => window.solworld.map.map.jumpTo({ center: [-73.9794, 40.7515], zoom: 16.9, pitch: 60, bearing: 20 }));
      await page.waitForFunction(() => window.solworld.r3d.active, null, { timeout: 60_000 });
      await page.waitForTimeout(8000);
      assert.ok(await page.evaluate(() => window.solworld.r3d.tileset?.tilesLoaded || window.solworld.r3d.tileset?.root), 'photogrammetry tileset loaded');
      await page.screenshot({ path: path.join(OUT, '41-real3d.png'), timeout: 120_000 });
    });

    await step('real3d: at night the real windows glow', async () => {
      await page.evaluate(() => {
        window.solworld.r3d.glowUniforms.nightAmount = 1;
        window.solworld.r3d.glowUniforms.duskAmount = 0;
      });
      await page.waitForTimeout(2500);
      await page.screenshot({ path: path.join(OUT, '42-real3d-night.png'), timeout: 120_000 });
    });

    await step('real3d: tapping a building in 3D opens it', async () => {
      await page.mouse.click(880, 520);
      await page.waitForFunction(() => document.querySelector('#panel.is-open') && document.querySelector('#panel').dataset.tone !== 'resolving', null, { timeout: 30_000 });
    });

    await step('real3d: zooming far out returns to the map', async () => {
      await page.evaluate(() => {
        const C = window.Cesium;
        window.solworld.r3d.stopOrbit(); // a real drag/scroll stops the orbit too
        window.solworld.r3d.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(-73.98, 40.74, 6000) });
      });
      await page.waitForFunction(() => !window.solworld.r3d.active, null, { timeout: 60_000 });
    });

    await step('real3d: the middle of nowhere has no traffic', async () => {
      await page.evaluate(() => window.solworld.map.map.jumpTo({ center: [-100.5, 45.2], zoom: 15.6, pitch: 0 }));
      await idle();
      await page.waitForTimeout(800);
      assert.equal(await page.evaluate(() => window.solworld.traffic.agents.length), 0);
    });

    await step('real3d: no page errors', async () => {
      assert.deepEqual(log.errors, []);
      assert.deepEqual(log.console.filter((l) => /^error/.test(l)), []);
    });
  } finally {
    await browser.close();
  }
}

async function mobile(env) {
  const { page, log, browser } = await launch({ ...env, config: {}, viewport: { width: 390, height: 844 }, mobile: true });
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
  if (which === 'real3d' || which === 'all') await real3d(env);
  if (which === 'mobile' || which === 'all') await mobile(env);
} finally {
  env.server.close();
  console.log(`\n${results.join('\n')}`);
}
