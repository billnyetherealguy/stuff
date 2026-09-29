# Solworld

**Every building on Earth. Own it on Solana.**

Solworld is a black, Tesla-style 3D map of the whole planet where every building is clickable. Tap one to see what it actually looks like (a satellite close-up, a real photo when there is one, and a Street View link), who owns it, and buy it with SOL. Wallets holding more than 0.2 SOL can claim one building of their choice for free. A live leaderboard shows who owns the most.

![Solworld](solworld/og.png)

- **The whole world:** hundreds of millions of OpenStreetMap buildings on a spinning globe, extruded in 3D.
- **Real ownership:** every purchase is a Solana transaction. There is no database and no server, so anyone can verify who owns what.
- **Instant to host:** it's a static website with nothing to build or install. Put it on Netlify, Vercel, Cloudflare Pages or any web host.

---

## Go live

### 1. Put your wallet address in `solworld/config.js`

Open [`solworld/config.js`](solworld/config.js) on GitHub, click the pencil icon, and paste your **public** Solana wallet address into `treasury`:

```js
treasury: "YOUR_WALLET_ADDRESS",
```

Every purchase is paid straight to this wallet. Copy the address from your wallet app ("Copy address"); it's 32–44 characters long.

> **Never put a private key or seed phrase in this file.** Everyone can read it. Solworld refuses to start if it spots a private key there.

If you leave `treasury` empty, the site runs in **demo mode**. Everything works, but purchases are simulated and no SOL moves. That's a good way to try it first.

### 2. Deploy (pick one)

**Netlify (recommended)**
1. Go to [app.netlify.com](https://app.netlify.com), then **Add new site → Import an existing project → GitHub**.
2. Pick this repository and the branch with Solworld on it.
3. Click **Deploy**. Nothing else is needed: [`netlify.toml`](netlify.toml) tells Netlify to publish the `solworld` folder.

You get a live URL like `https://solworld-xyz.netlify.app` in about 30 seconds. Rename it under *Site configuration → Change site name*, or attach your own domain.

**Netlify Drop (no GitHub connection)**
Download this repo as a ZIP (**Code → Download ZIP**), unzip it, and drag the `solworld` folder onto [app.netlify.com/drop](https://app.netlify.com/drop).

**Vercel**
Go to [vercel.com/new](https://vercel.com/new), import this repository, and click **Deploy**. [`vercel.json`](vercel.json) already points Vercel at the `solworld` folder.

**Anywhere else**
Upload the contents of `solworld/` to any static host (Cloudflare Pages, GitHub Pages, S3…). It must be served over HTTPS.

### 3. Before real traffic (recommended)

Add your own Solana RPC endpoint in `config.js`. The free public endpoint is rate-limited, and a free [Helius](https://helius.dev) key is plenty to start:

```js
rpc: ["https://mainnet.helius-rpc.com/?api-key=YOUR_KEY"],
```

---

## How it works

### Buying and claiming

Every action is **one Solana transaction** that the buyer approves in their own wallet (Phantom, Solflare, Backpack or any Wallet Standard wallet). It contains:

1. a SOL transfer from the buyer to your treasury. It's 0 SOL for a free claim, which costs only the ~0.00001 SOL network fee.
2. a "registry" reference key on that transfer, derived from your treasury address, so every Solworld transaction can be listed from the chain.
3. a memo such as `solworld:buy:w34633854@40.748440,-73.985664`: the action, the OpenStreetMap building ID and its location.

Each visitor's browser reads those transactions from Solana and applies the same rules, so everyone sees the same owners:

| Rule | Detail |
| --- | --- |
| One owner per building | The first valid transaction on-chain wins. |
| Price | `prices` in `config.js` (default **0.05 SOL**). Paying less doesn't count. |
| Free building | Once per wallet, for wallets holding **more than** `freeClaimMinSol` (default 0.2 SOL). This is checked against the balance recorded in the transaction itself. |
| Void payments | If two people pay for the same building at the same moment, the second payment is listed under **Operator & refunds** (in *How it works*, or at `/#/operator`) so you can send it back. |

To **change the price** later, add a new line with the date it starts. Don't edit old lines, because past purchases are checked against the price that applied at the time:

```js
prices: [
  { from: "2026-01-01T00:00:00Z", sol: 0.05 },
  { from: "2026-12-01T00:00:00Z", sol: 0.1 },
],
```

### The map and the buildings

- **Map:** vector tiles from [OpenFreeMap](https://openfreemap.org) (free, no API key), with a custom near-black style and MapLibre GL's globe projection.
- **Buildings:** every building in [OpenStreetMap](https://www.openstreetmap.org). A building's ID is its OSM element (`w…` for a way, `r…` for a relation). The map merges same-height buildings into one shape, so clicks are resolved to the exact building with the [Overpass API](https://overpass-api.de), including a 3D ray test that picks the building you actually clicked.
- **What it looks like:** a satellite close-up with the footprint traced on top ([Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9)), a real photo from Wikidata/Wikimedia Commons when the building has one, and a one-tap Google Street View link.
- **Search:** [Photon](https://photon.komoot.io) (OpenStreetMap geocoding). You can also paste a building ID or coordinates.

---

## Good to know

- **Free-claim farming:** someone can move 0.2 SOL between wallets to claim one free building per wallet. If that becomes a problem, raise `freeClaimMinSol` before launch or remove the free claim.
- **Shared public services:** OpenFreeMap, Overpass, Photon and Esri imagery are free services with fair-use limits. They're fine for a launch; for heavy traffic, consider paid tiers or your own instances. For commercial use of the satellite imagery, check Esri's terms, or set `map.satellite` in `config.js` to another provider.
- **Scale:** each visitor rebuilds ownership from the chain and caches it. That's quick for thousands of purchases. At tens of thousands, add an indexer that publishes a snapshot.
- **Legal:** buildings are virtual collectibles with no rights to the real property. The site says so in *How it works* and before the first purchase. Selling digital items for crypto has rules that vary by country, so get advice for yours.

---

## Project layout

```
solworld/                 the website (deploy this folder)
  index.html              page shell
  config.js               ← your settings
  assets/js/app.js        wires everything together; buy/claim flow
  assets/js/registry.js   on-chain registry: memo format + ownership rules
  assets/js/solana.js     base58, transaction building, JSON-RPC (no dependencies)
  assets/js/wallet.js     Wallet Standard connection
  assets/js/map.js        globe, 3D buildings, picking, highlights, camera
  assets/js/mapstyle.js   the dark map style
  assets/js/osm.js        building lookups (Overpass)
  assets/js/info.js       addresses, photos, satellite close-up, SOL price
  assets/js/ui/           panel, leaderboard, search, wallet, modals
  vendor/                 MapLibre GL JS 6.11.2 (BSD-3)
test/                     development only (not deployed)
  unit/                   protocol, geometry and style tests
  e2e/                    browser tests against a local Solana runtime
```

## Tests

```bash
cd test
npm install
npm test          # unit tests: transactions checked against @solana/web3.js and run on a real SVM (LiteSVM)
npm run e2e       # headless Chromium: demo, live (LiteSVM chain + test wallet) and mobile scenarios
```

The end-to-end suite runs the real site against a local Solana runtime, synthetic map tiles and stand-ins for every external service. Screenshots are written to `test/artifacts/`.

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors · Tiles by [OpenFreeMap](https://openfreemap.org) · © [OpenMapTiles](https://openmaptiles.org).
