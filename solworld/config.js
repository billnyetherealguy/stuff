/*
 * ─────────────────────────────────────────────────────────────────────────
 *  SOLWORLD CONFIG — the only file you need to edit.
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  • `treasury` is your PUBLIC wallet address. Every building purchase and
 *    the market fee on every resale is paid straight to it.
 *    NEVER put a private key or seed phrase here: this file is public.
 *    Leave it empty ("") to run in DEMO MODE (nothing real moves).
 *
 *  • Building prices are automatic (0.001–3 SOL depending on how famous the
 *    building is and how busy the area is). Nothing to set.
 *
 *  • When your meme coin launches, fill in `memecoin` below and redeploy.
 *    Until then, the "use your meme coin" option stays hidden.
 */
window.SOLWORLD_CONFIG = {
  // Your public wallet address (receives all payments).
  treasury: "8tiwEgFFPdkMRhPMZtxHRwvopwf1PeqzgMpVMq7GKkpV",

  // "mainnet-beta" for real SOL. Use "devnet" to test with free devnet SOL.
  cluster: "mainnet-beta",

  // Tax on every resale between players, in percent, paid to your wallet.
  marketFeePercent: 1,

  // Your meme coin. Holders paste their wallet, sign once to prove it's theirs,
  // and get building credit equal to what their coins are worth in SOL.
  memecoin: {
    // The token's mint address (from pump.fun / your launch page).
    mint: "",
    // Ticker shown on the site, without the $.
    symbol: "",
    // What ONE token is worth in SOL. To change it later, ADD a line with the
    // date it starts — don't edit old lines (past credit is checked against them).
    // Example: 1 token = 0.0000001 SOL -> 5,600,000 tokens = 0.56 SOL of credit.
    solPerToken: [
      // { from: "2026-10-01T00:00:00Z", sol: 0.0000001 },
    ],
  },

  // Realistic 3D close-ups (real buildings with real textures, like Google
  // Earth). Paste a Google Maps Platform key with the "Map Tiles API" enabled,
  // restricted to your website. You can also set it in /#/operator instead.
  //
  // No Google billing? Use a free Cesium ion token instead (no card needed):
  // sign up at https://ion.cesium.com, add "Google Photorealistic 3D Tiles"
  // from the Asset Depot to your assets, then copy a token from
  // "Access Tokens" and paste it below. Leave googleKey empty.
  realistic3d: {
    googleKey: "",
    cesiumIonToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IjJuUHdCRVgzWUlOYUhnSm4iLCJqdGkiOiI4YmI5NzgwYS05MWQ0LTQyZDUtOWFkZS0zNjY1NWUwNWU5YzEiLCJpZCI6NTEyMzA1LCJzdWIiOiJiaWxsbnlldGhlcmVhbGd1eSIsImlzcyI6Imh0dHBzOi8vYXBpLmNlc2l1bS5jb20iLCJhdWQiOiJTb2xXb3JsZCIsImlhdCI6MTc5MDc5MDYwMH0.mE9UGx8su3PJWVxgeguj8ZXmJST_mJ776U_Pg0J0kEA",
  },

  // Optional: your own Solana RPC endpoint(s), tried in order. The public
  // endpoints work for a launch; for real traffic add a free one from
  // helius.dev, quicknode.com or triton.one, e.g.
  // rpc: ["https://mainnet.helius-rpc.com/?api-key=YOUR_KEY"],
  // rpc: [],
};
