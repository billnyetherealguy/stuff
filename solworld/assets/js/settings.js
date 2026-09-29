// Normalizes config.js into the settings the app runs on, and decides between
// live mode (real SOL, treasury configured) and demo mode (simulated).

import { base58Length, isAddress } from './solana.js';

const DEFAULT_RPC = {
  'mainnet-beta': ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'],
  devnet: ['https://api.devnet.solana.com'],
  testnet: ['https://api.testnet.solana.com'],
  localnet: ['http://127.0.0.1:8899'],
};

const DEFAULTS = {
  treasury: '',
  cluster: 'mainnet-beta',
  marketFeePercent: 5,
  memecoin: { mint: '', symbol: '', solPerToken: [] },
  rpc: DEFAULT_RPC,
  priorityFeeMicroLamports: 50_000,
  pollSeconds: 20,
  map: {
    tiles: 'https://tiles.openfreemap.org/planet',
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    satelliteMaxZoom: 19,
    satelliteAttribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    attribution:
      '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> · <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>',
  },
  services: {
    overpass: [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.private.coffee/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    ],
    photon: 'https://photon.komoot.io',
    wikipedia: 'https://en.wikipedia.org/w/api.php',
    wikidata: 'https://www.wikidata.org/w/api.php',
    commonsFile: 'https://commons.wikimedia.org/wiki/Special:FilePath/',
    commonsApi: 'https://commons.wikimedia.org/w/api.php',
    solPrice: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
    dexscreener: 'https://api.dexscreener.com/latest/dex/tokens/',
  },
};

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

export function loadSettings(raw = {}) {
  const cfg = merge(DEFAULTS, raw);
  const problems = [];
  const treasury = String(raw.treasury || '').trim();

  // A 64-byte base58 string is a keypair / private key. Refuse to run with it:
  // the site is public, so anything in config.js is visible to everyone.
  if (treasury && base58Length(treasury) === 64) {
    return {
      fatal: {
        title: 'Remove your private key from config.js now',
        body:
          'The value in "treasury" is 88 characters long, which is the size of a Solana private key, not a wallet address. ' +
          'Anyone who opens this site can read config.js. Delete it, redeploy, and move your funds to a new wallet. ' +
          'Then paste your PUBLIC wallet address (32–44 characters) instead.',
      },
    };
  }

  let mode = 'demo';
  if (treasury) {
    if (isAddress(treasury)) mode = 'live';
    else problems.push('The treasury in config.js is not a valid Solana address, so Solworld is running in demo mode.');
  }

  const cluster = DEFAULT_RPC[cfg.cluster] ? cfg.cluster : 'mainnet-beta';
  const rpcList = Array.isArray(cfg.rpc) ? cfg.rpc : cfg.rpc?.[cluster] || DEFAULT_RPC[cluster];

  const feeBps = Math.round(Math.min(50, Math.max(0, Number(cfg.marketFeePercent) || 0)) * 100);
  const coin = cfg.memecoin || {};
  const mint = isAddress(String(coin.mint || '').trim()) ? String(coin.mint).trim() : '';
  const memecoin = mint
    ? {
        mint,
        symbol: String(coin.symbol || 'TOKEN').replace(/^\$/, '').slice(0, 12),
        prices: (Array.isArray(coin.solPerToken) ? coin.solPerToken : [])
          .map((p) => ({ from: Math.floor(new Date(p.from || 0).getTime() / 1000) || 0, lamportsPerToken: Number(p.sol) * 1e9 }))
          .filter((p) => p.lamportsPerToken > 0)
          .sort((a, b) => a.from - b.from),
      }
    : null;

  return {
    mode,
    live: mode === 'live',
    treasury: mode === 'live' ? treasury : null,
    cluster,
    rpc: rpcList,
    feeBps,
    memecoin,
    rules: { treasury: mode === 'live' ? treasury : null, feeBps, memecoin },
    priorityFeeMicroLamports: Math.max(0, Number(cfg.priorityFeeMicroLamports) || 0),
    pollMs: Math.max(5, Number(cfg.pollSeconds) || 20) * 1000,
    map: cfg.map,
    services: cfg.services,
    problems,
    explorer: {
      tx: (sig) => `https://solscan.io/tx/${sig}${cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`}`,
      account: (a) => `https://solscan.io/account/${a}${cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`}`,
    },
  };
}
