/*
 * ─────────────────────────────────────────────────────────────────────────
 *  SOLWORLD CONFIG — the only file you need to edit.
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  1. Paste your PUBLIC Solana wallet address into `treasury` below.
 *     Every purchase is paid straight to that wallet.
 *     • Copy it from your wallet app ("Copy address"). It is 32–44 letters
 *       and numbers long.
 *     • NEVER put a private key or seed phrase here. This file is public:
 *       anyone visiting the site can read it.
 *
 *  2. Leave `treasury` empty to run in DEMO MODE: everything works, but
 *     purchases are simulated and no SOL moves. Great for trying it out.
 *
 *  3. Redeploy (or just save, if your host auto-deploys from GitHub).
 */
window.SOLWORLD_CONFIG = {
  // Your public wallet address. Empty = demo mode.
  treasury: "",

  // "mainnet-beta" for real SOL. Use "devnet" to test with free devnet SOL.
  cluster: "mainnet-beta",

  // Price of one building, in SOL.
  // To change the price later, ADD a new line with the date it starts.
  // Don't edit old lines: past purchases are checked against the price at the time.
  prices: [
    { from: "2026-01-01T00:00:00Z", sol: 0.05 },
  ],

  // Wallets holding MORE than this much SOL can claim one building for free.
  // Pick it before launch and leave it: changing it re-judges past claims.
  freeClaimMinSol: 0.2,

  // Optional: your own Solana RPC endpoint(s), tried in order. The public
  // endpoints work for a launch; for real traffic add a free one from
  // helius.dev, quicknode.com or triton.one, e.g.
  // rpc: ["https://mainnet.helius-rpc.com/?api-key=YOUR_KEY"],
  // rpc: [],
};
