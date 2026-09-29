// Wallet connectivity via the Wallet Standard (Phantom, Solflare, Backpack and
// most modern Solana wallets register themselves this way). No adapter library:
// the registration handshake is a pair of window events.

import { Emitter } from './emitter.js';
import { base58Encode, isAddress } from './solana.js';

const CHAINS = {
  'mainnet-beta': 'solana:mainnet',
  devnet: 'solana:devnet',
  testnet: 'solana:testnet',
  localnet: 'solana:localnet',
};

const LAST_WALLET_KEY = 'solworld:last-wallet';

export const WALLET_LINKS = [
  { name: 'Phantom', url: 'https://phantom.com/download', browse: (u, ref) => `https://phantom.app/ul/browse/${encodeURIComponent(u)}?ref=${encodeURIComponent(ref)}` },
  { name: 'Solflare', url: 'https://solflare.com/download', browse: (u, ref) => `https://solflare.com/ul/v1/browse/${encodeURIComponent(u)}?ref=${encodeURIComponent(ref)}` },
  { name: 'Backpack', url: 'https://backpack.app/downloads', browse: null },
];

function isUsable(wallet) {
  const f = wallet?.features || {};
  return (
    !!f['standard:connect'] &&
    (!!f['solana:signAndSendTransaction'] || !!f['solana:signTransaction']) &&
    Array.isArray(wallet.chains) &&
    wallet.chains.some((c) => String(c).startsWith('solana:'))
  );
}

export class WalletManager extends Emitter {
  constructor({ cluster, rpc, storage, allowDemo = false }) {
    super();
    this.chain = CHAINS[cluster] || 'solana:mainnet';
    this.rpc = rpc;
    this.storage = storage;
    this.allowDemo = allowDemo;
    this.registered = new Set();
    this.wallet = null;
    this.account = null;
    this.demo = null;
    this.balance = null;
    this._offEvents = null;
    this._listen();
  }

  _listen() {
    if (typeof window === 'undefined') return;
    const api = Object.freeze({
      register: (...wallets) => {
        for (const w of wallets) this.registered.add(w);
        this.emit('wallets', this.wallets);
        this._maybeAutoConnect();
        return () => {
          for (const w of wallets) this.registered.delete(w);
          this.emit('wallets', this.wallets);
        };
      },
    });
    window.addEventListener('wallet-standard:register-wallet', ({ detail: callback }) => {
      try {
        callback(api);
      } catch (err) {
        console.warn('[solworld] wallet registration failed', err);
      }
    });
    try {
      window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
    } catch (err) {
      console.warn('[solworld] wallet discovery unavailable', err);
    }
  }

  /** Wallets that can connect and send Solana transactions, de-duplicated by name. */
  get wallets() {
    const seen = new Set();
    return [...this.registered].filter((w) => {
      if (!isUsable(w) || seen.has(w.name)) return false;
      seen.add(w.name);
      return true;
    });
  }

  get connected() {
    return !!(this.account || this.demo);
  }

  get address() {
    return this.account?.address || this.demo?.address || null;
  }

  get name() {
    return this.wallet?.name || (this.demo ? 'Demo wallet' : null);
  }

  get icon() {
    return this.wallet?.icon || null;
  }

  get isDemo() {
    return !!this.demo;
  }

  async _maybeAutoConnect() {
    if (this.connected || this._autoTried) return;
    const last = this.storage?.get(LAST_WALLET_KEY);
    if (!last) return;
    const wallet = this.wallets.find((w) => w.name === last);
    if (!wallet) return;
    this._autoTried = true;
    try {
      await this.connect(wallet, { silent: true });
    } catch {
      // silent reconnect is best-effort
    }
  }

  async connect(wallet, { silent = false } = {}) {
    const result = await wallet.features['standard:connect'].connect(silent ? { silent: true } : undefined);
    const accounts = result?.accounts?.length ? result.accounts : wallet.accounts;
    const account = accounts.find((a) => !a.chains?.length || a.chains.includes(this.chain)) || accounts[0];
    if (!account || !isAddress(account.address)) {
      if (silent) return null;
      throw new Error('The wallet did not share an account.');
    }
    this._detach();
    this.wallet = wallet;
    this.account = account;
    this.demo = null;
    this.storage?.set(LAST_WALLET_KEY, wallet.name);
    const events = wallet.features['standard:events'];
    if (events) {
      this._offEvents = events.on('change', ({ accounts: changed }) => {
        if (!changed) return;
        const next = changed[0];
        if (!next) {
          this._clear();
        } else if (next.address !== this.account?.address) {
          this.account = next;
          this.balance = null;
          this.emit('change', this.snapshot());
          this.refreshBalance();
        }
      });
    }
    this.emit('change', this.snapshot());
    this.refreshBalance();
    return account;
  }

  /** Demo mode only: a throwaway local identity with a pretend 1 SOL balance. */
  async connectDemo() {
    if (!this.allowDemo) throw new Error('Demo wallets are only available in demo mode.');
    let address = this.storage?.get('solworld:demo-wallet');
    if (!isAddress(address)) {
      const bytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(bytes);
      address = base58Encode(bytes);
      this.storage?.set('solworld:demo-wallet', address);
    }
    this._detach();
    this.wallet = null;
    this.account = null;
    this.demo = { address };
    this.balance = 1_000_000_000;
    this.emit('change', this.snapshot());
    return this.demo;
  }

  async disconnect() {
    try {
      await this.wallet?.features['standard:disconnect']?.disconnect();
    } catch {
      // some wallets throw if already disconnected
    }
    this.storage?.remove?.(LAST_WALLET_KEY);
    this._clear();
  }

  _detach() {
    this._offEvents?.();
    this._offEvents = null;
  }

  _clear() {
    this._detach();
    this.wallet = null;
    this.account = null;
    this.demo = null;
    this.balance = null;
    this.emit('change', this.snapshot());
  }

  snapshot() {
    return { connected: this.connected, address: this.address, name: this.name, balance: this.balance, demo: this.isDemo };
  }

  async refreshBalance() {
    if (this.demo) return this.balance;
    const address = this.address;
    if (!address) return null;
    try {
      const lamports = await this.rpc.getBalance(address);
      if (this.address === address) {
        this.balance = lamports;
        this.emit('balance', lamports);
        this.emit('change', this.snapshot());
      }
      return lamports;
    } catch (err) {
      console.warn('[solworld] balance lookup failed', err);
      return this.balance;
    }
  }

  /** Signs and submits a serialized transaction. Returns the base58 signature. */
  async signAndSend(transactionBytes) {
    if (!this.wallet || !this.account) throw new Error('Connect a wallet first.');
    const features = this.wallet.features;
    const signAndSend = features['solana:signAndSendTransaction'];
    if (signAndSend) {
      const [output] = await signAndSend.signAndSendTransaction({
        account: this.account,
        chain: this.chain,
        transaction: transactionBytes,
        options: { preflightCommitment: 'confirmed', skipPreflight: false, maxRetries: 5 },
      });
      return base58Encode(output.signature);
    }
    const [signed] = await features['solana:signTransaction'].signTransaction({
      account: this.account,
      chain: this.chain,
      transaction: transactionBytes,
    });
    return this.rpc.sendRawTransaction(signed.signedTransaction);
  }
}

/** Asks the connected external wallet to sign (not send). Returns signed wire bytes. */
WalletManager.prototype.signTransaction = async function signTransaction(transactionBytes) {
  if (!this.wallet || !this.account) throw new Error('Connect a wallet first.');
  const feature = this.wallet.features['solana:signTransaction'];
  if (!feature) throw new Error(`${this.wallet.name} can’t co-sign transactions. Try Phantom or Solflare.`);
  const [out] = await feature.signTransaction({ account: this.account, chain: this.chain, transaction: transactionBytes });
  return out.signedTransaction;
};

export function isUserRejection(err) {
  const msg = `${err?.name || ''} ${err?.message || ''}`.toLowerCase();
  return err?.code === 4001 || /reject|denied|declined|cancel|user closed|not approved/.test(msg);
}
