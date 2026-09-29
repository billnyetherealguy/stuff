// Browser harness: serves the real site, points every external service at the
// local fakes (same URLs the production config uses), and installs a Wallet
// Standard wallet whose keys live in Node.
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { createTiles } from './tiles.mjs';
import { createServices } from './services.mjs';
import { Chain } from './chain.mjs';
import { createTiles3d } from './tiles3d.mjs';
import { FAKE_MAPS_JS } from './fakemaps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '..', '..', 'solworld');
const CESIUM = path.resolve(HERE, '..', 'node_modules', 'cesium', 'Build', 'Cesium');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain',
};

export function startServer(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = path.join(SITE, decodeURIComponent(url.pathname));
    if (!file.startsWith(SITE)) {
      res.writeHead(403).end();
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

const WALLET_ICON =
  'data:image/svg+xml;base64,' +
  Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#6c4dff"/><path d="M9 16h14M16 9v14" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>').toString('base64');

// Runs in the page before any site script.
function walletInit(icon) {
  const accounts = [];
  const listeners = new Set();
  const chains = ['solana:mainnet', 'solana:devnet'];
  const emit = () => listeners.forEach((l) => l({ accounts: [...accounts] }));
  const wallet = {
    version: '1.0.0',
    name: 'Harness Wallet',
    icon,
    chains,
    get accounts() {
      return [...accounts];
    },
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async () => {
          const a = await window.__harnessAccount();
          accounts.splice(0, accounts.length, { address: a.address, publicKey: new Uint8Array(a.publicKey), chains, features: ['solana:signAndSendTransaction', 'solana:signTransaction'] });
          emit();
          return { accounts: [...accounts] };
        },
      },
      'standard:disconnect': {
        version: '1.0.0',
        disconnect: async () => {
          accounts.length = 0;
          emit();
        },
      },
      'standard:events': {
        version: '1.0.0',
        on: (event, listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs) =>
          Promise.all(
            inputs.map(async (input) => {
              const result = await window.__harnessSign(Array.from(input.transaction));
              if (result.error) throw Object.assign(new Error(result.error), { code: result.code });
              return { signedTransaction: new Uint8Array(result.bytes) };
            }),
          ),
      },
      'solana:signAndSendTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signAndSendTransaction: async (...inputs) =>
          Promise.all(
            inputs.map(async (input) => {
              const result = await window.__harnessSignAndSend(Array.from(input.transaction), input.chain);
              if (result.error) throw Object.assign(new Error(result.error), { code: result.code });
              return { signature: new Uint8Array(result.signature) };
            }),
          ),
      },
    },
  };
  const callback = ({ register }) => register(wallet);
  try {
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: callback }));
  } catch {}
  window.addEventListener('wallet-standard:app-ready', ({ detail: api }) => callback(api));
}

// Signs a legacy wire transaction in place for `keypair` (its slot is found in the account keys).
function readLen(bytes, at) {
  let len = 0;
  let shift = 0;
  let i = at;
  for (;;) {
    const b = bytes[i++];
    len |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [len, i];
    shift += 7;
  }
}
function signInPlace(wire, keypair) {
  const [sigCount, sigStart] = readLen(wire, 0);
  const msgStart = sigStart + sigCount * 64;
  const message = wire.subarray(msgStart);
  const [keyCount, keysStart] = readLen(message, 3);
  const me = Buffer.from(keypair.publicKey);
  for (let k = 0; k < Math.min(keyCount, sigCount); k++) {
    if (Buffer.from(message.subarray(keysStart + k * 32, keysStart + (k + 1) * 32)).equals(me)) {
      wire.set(nacl.sign.detached(message, keypair.secretKey), sigStart + k * 64);
      return wire;
    }
  }
  throw new Error('This wallet is not a signer of the transaction.');
}

function encodePng(size, pixel) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let row = 0; row < size; row++) {
    raw[row * (size * 3 + 1)] = 0;
    for (let col = 0; col < size; col++) {
      const [r, g, b] = pixel(col, row);
      const o = row * (size * 3 + 1) + 1 + col * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// A stand-in "photo" of a stone facade (sky on top), by day or by night.
function facadePhotoPng(night) {
  return encodePng(320, (x, y) => {
    if (y < 40) return night ? [10, 14, 30] : [150, 190, 230];
    const wx = x % 26;
    const wy = (y - 40) % 30;
    const win = wx > 7 && wx < 19 && wy > 6 && wy < 22;
    const lit = night && ((Math.floor(x / 26) * 7 + Math.floor((y - 40) / 30) * 13) % 5 < 2);
    if (win) return lit ? [255, 214, 150] : night ? [20, 26, 40] : [70, 92, 112];
    return night ? [48, 42, 38] : [196, 178, 150];
  });
}

// A small, dim "satellite" tile: textured ground with a tile-dependent tint.
const pngCache = new Map();
function groundPng(z, y, x) {
  const id = `${(x * 7 + y * 13) % 5}`;
  if (pngCache.has(id)) return pngCache.get(id);
  const size = 64;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let seed = 1 + Number(id) * 7919;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let row = 0; row < size; row++) {
    raw[row * (size * 3 + 1)] = 0;
    for (let col = 0; col < size; col++) {
      const n = rnd() * 40;
      const tree = (row * 3 + col * 5 + Number(id)) % 23 < 4;
      const o = row * (size * 3 + 1) + 1 + col * 3;
      raw[o] = tree ? 40 + n / 2 : 90 + n;
      raw[o + 1] = tree ? 70 + n / 2 : 92 + n;
      raw[o + 2] = tree ? 40 + n / 2 : 84 + n;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  pngCache.set(id, png);
  return png;
}

/**
 * Launches Chromium with every Solworld dependency routed to local fakes.
 * `config` overrides config.js (undefined = ship the real file untouched).
 */
export async function launch({ origin, tiles, services, chain, config, viewport = { width: 1440, height: 900 }, mobile = false, wallet: walletOn = true }) {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
  });
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    userAgent: mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' : undefined,
  });
  const page = await context.newPage();
  const log = { console: [], errors: [], requests: [], blocked: new Set() };
  page.on('console', (m) => log.console.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => log.errors.push(e.message));

  const state = { keypair: nacl.sign.keyPair(), rejectNext: false, overpassDown: false };
  const harness = {
    setOverpassDown(down) {
      state.overpassDown = down;
    },
    setKeypair(kp) {
      state.keypair = kp;
    },
    get address() {
      return bs58.encode(state.keypair.publicKey);
    },
    rejectNext() {
      state.rejectNext = true;
    },
  };
  if (walletOn) {
    await page.exposeFunction('__harnessAccount', () => ({ address: bs58.encode(state.keypair.publicKey), publicKey: Array.from(state.keypair.publicKey) }));
    await page.exposeFunction('__harnessSignAndSend', (bytes) => {
      if (state.rejectNext) {
        state.rejectNext = false;
        return { error: 'User rejected the request.', code: 4001 };
      }
      try {
        const sig = chain.signAndSubmit(Uint8Array.from(bytes), state.keypair);
        return { signature: Array.from(bs58.decode(sig)) };
      } catch (e) {
        return { error: e.message };
      }
    });
    await page.exposeFunction('__harnessSign', (bytes) => {
      if (state.rejectNext) {
        state.rejectNext = false;
        return { error: 'User rejected the request.', code: 4001 };
      }
      return { bytes: Array.from(signInPlace(Uint8Array.from(bytes), state.keypair)) };
    });
    await page.addInitScript(walletInit, WALLET_ICON);
  }

  const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    log.requests.push(`${req.method()} ${url.host}${url.pathname}`);
    if (url.origin === origin) {
      if (url.pathname === '/config.js' && config !== undefined) {
        return route.fulfill({ status: 200, contentType: 'text/javascript', body: `window.SOLWORLD_CONFIG = ${JSON.stringify(config)};` });
      }
      return route.continue();
    }
    const host = url.host;
    if (host === 'tiles.openfreemap.org') {
      if (url.pathname === '/planet') return json(route, tiles.tileJson('https://tiles.openfreemap.org/planet/harness'));
      const t = /^\/planet\/harness\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(url.pathname);
      if (t) {
        const buf = tiles.tile(+t[1], +t[2], +t[3]);
        if (!buf) return route.fulfill({ status: 204, body: '' });
        return route.fulfill({ status: 200, contentType: 'application/x-protobuf', headers: { 'access-control-allow-origin': '*' }, body: buf });
      }
      const g = /^\/fonts\/([^/]+)\/(\d+-\d+)\.pbf$/.exec(url.pathname);
      if (g) {
        const buf = await services.glyph(decodeURIComponent(g[1]), g[2]);
        return buf ? route.fulfill({ status: 200, contentType: 'application/x-protobuf', headers: { 'access-control-allow-origin': '*' }, body: buf }) : route.fulfill({ status: 404, body: '' });
      }
    }
    if (/^api\.(mainnet-beta|devnet)\.solana\.com$/.test(host) || host === 'solana-rpc.publicnode.com') {
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' } });
      return json(route, chain.handle(JSON.parse(req.postData() || '{}')));
    }
    if (/overpass/.test(host) || host === 'maps.mail.ru') {
      if (state.overpassDown) return route.fulfill({ status: 504, body: 'Gateway Timeout' });
      const body = new URLSearchParams(req.postData() || '');
      return json(route, services.overpass(body.get('data') || url.searchParams.get('data') || ''));
    }
    if (host === 'photon.komoot.io') {
      if (url.pathname.startsWith('/reverse')) return json(route, services.photonReverse(+url.searchParams.get('lon'), +url.searchParams.get('lat')));
      return json(route, services.photonSearch(url.searchParams.get('q') || ''));
    }
    if (host === 'www.wikidata.org') return json(route, services.wikidata(url.searchParams.get('entity'), url.searchParams.get('property') || 'P18'));
    if (host.endsWith('wikipedia.org')) return json(route, { batchcomplete: '', query: { pages: {} } });
    if (host === 'commons.wikimedia.org' && url.pathname === '/w/api.php') {
      const title = url.searchParams.get('titles');
      if (!title) return json(route, { batchcomplete: '', query: { pages: {} } });
      const name = title.replace(/^File:/, '').replace(/ /g, '_');
      return json(route, { query: { pages: { 1: { title, imageinfo: [{ thumburl: `https://upload.wikimedia.org/harness/${encodeURIComponent(name)}.png`, url: '' }] } } } });
    }
    if (host === 'upload.wikimedia.org') {
      return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: facadePhotoPng(/night/i.test(decodeURIComponent(url.pathname))) });
    }
    if (host === 'api.dexscreener.com') return json(route, { pairs: [] });
    if (host === 'commons.wikimedia.org') {
      const name = url.pathname.split('/').pop();
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: services.photoSvg(name) });
    }
    if (host === 'server.arcgisonline.com') {
      const e = /\/tile\/(\d+)\/(\d+)\/(\d+)$/.exec(url.pathname);
      // <img> tiles (panel close-up) get the SVG render; the map's raster layer fetches PNGs.
      if (e && req.resourceType() === 'image') return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: services.esriTile(+e[1], +e[2], +e[3]) });
      if (e) return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: groundPng(+e[1], +e[2], +e[3]) });
    }
    if (host === 'cdn.jsdelivr.net' && url.pathname.startsWith('/npm/cesium@')) {
      const rel = decodeURIComponent(url.pathname.replace(/^\/npm\/cesium@[^/]+\/Build\/Cesium\//, ''));
      const file = path.join(CESIUM, rel);
      if (!file.startsWith(CESIUM) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || (file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'), headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(file) });
    }
    if (host === 'maps.googleapis.com' && url.pathname === '/maps/api/js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_MAPS_JS });
    if (host === 'assets.ion.cesium.com') return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: encodePng(16, () => [255, 255, 255]) });
    if (host === 'tile.googleapis.com') {
      const t3 = (services.tiles3d ||= createTiles3d(tiles.world));
      if (url.searchParams.get('key') === 'bad-key') return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":{"code":403}}' });
      if (url.pathname.endsWith('/root.json')) return json(route, t3.rootJson);
      if (url.pathname.endsWith('/city.glb')) return route.fulfill({ status: 200, contentType: 'model/gltf-binary', headers: { 'access-control-allow-origin': '*' }, body: t3.glb });
    }
    if (host === 'api.coingecko.com') return json(route, { solana: { usd: 187.42 } });
    if (host === 'fonts.googleapis.com' || host === 'fonts.gstatic.com') {
      try {
        const res = await fetch(url.href, { headers: { 'user-agent': req.headers()['user-agent'] || 'Mozilla/5.0 Chrome/140' } });
        const body = Buffer.from(await res.arrayBuffer());
        return route.fulfill({ status: res.status, contentType: res.headers.get('content-type') || undefined, headers: { 'access-control-allow-origin': '*' }, body });
      } catch {
        return route.abort();
      }
    }
    log.blocked.add(host);
    return route.abort();
  });

  return { browser, context, page, log, harness };
}

export async function setup() {
  const tiles = createTiles();
  const services = createServices(tiles.world);
  const chain = new Chain();
  const { server, origin } = await startServer();
  return { tiles, services, chain, server, origin };
}

// `node e2e/harness.mjs` serves the site with fakes for manual poking (prints the URL).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { origin } = await startServer(8765);
  console.log(`Solworld at ${origin} (external services are NOT faked in this mode)`);
}
