// Wallet button, wallet picker and account menu.
import { WALLET_LINKS } from '../wallet.js';
import { avatar, copyText, fmtSol, h, isTouch, shortAddr } from '../util.js';
import { icon } from './icons.js';
import { openModal } from './feedback.js';

export class WalletUI {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.menuOpen = false;
    document.addEventListener('pointerdown', (e) => {
      if (this.menuOpen && !this.root.contains(e.target)) this.toggleMenu(false);
    });
  }

  render() {
    const { wallet, registry, settings } = this.ctx;
    if (!wallet.connected) {
      this.root.replaceChildren(
        h('button', { class: 'btn btn--primary btn--sm wallet-btn', onclick: () => this.pick() }, h('span', { svg: icon('wallet', { size: 16 }) }), h('span', { class: 'wallet-btn-label' }, 'Connect')),
      );
      return;
    }
    const address = wallet.address;
    const claimed = registry.state.claimed.has(address);
    const eligible = !claimed && wallet.balance != null && wallet.balance > settings.freeClaimMinLamports;
    const owned = registry.state.owners.get(address);
    const pill = h(
      'button',
      { class: 'wallet-pill', 'aria-haspopup': 'menu', 'aria-expanded': String(this.menuOpen), onclick: () => this.toggleMenu() },
      avatar(address, 24),
      h('span', { class: 'wallet-pill-main' }, h('span', { class: 'mono' }, shortAddr(address)), h('small', null, wallet.balance == null ? '— SOL' : `${fmtSol(wallet.balance)} SOL`)),
      eligible ? h('span', { class: 'gift-badge', title: 'You can claim one building for free', svg: icon('gift', { size: 13 }) }) : null,
      h('span', { class: 'wallet-pill-caret', svg: icon('chevronDown', { size: 14 }) }),
    );
    const menu = h(
      'div',
      { class: 'wallet-menu', role: 'menu' },
      h(
        'div',
        { class: 'wallet-menu-head' },
        avatar(address, 40),
        h('div', null, h('div', { class: 'mono wallet-menu-addr' }, shortAddr(address, 6, 6)), h('div', { class: 'wallet-menu-sub' }, wallet.isDemo ? 'Demo wallet · simulated SOL' : `${wallet.name} · ${settings.cluster === 'mainnet-beta' ? 'Mainnet' : settings.cluster}`)),
      ),
      h(
        'div',
        { class: `claim-card${eligible ? ' is-eligible' : ''}` },
        h('span', { svg: icon('gift', { size: 16 }) }),
        h(
          'div',
          null,
          h('b', null, claimed ? 'Free building claimed' : eligible ? '1 free building available' : 'Free building locked'),
          h('small', null, claimed ? 'Thanks for joining Solworld.' : eligible ? 'Pick any building and choose “Claim for free”.' : `Hold more than ${settings.freeClaimMinSol} SOL to unlock it.`),
        ),
      ),
      menuItem('building', `My buildings (${owned?.count || 0})`, () => {
        this.toggleMenu(false);
        this.ctx.onMine();
      }),
      menuItem('copy', 'Copy address', async () => {
        await copyText(address);
        this.toggleMenu(false);
        this.ctx.toast({ title: 'Address copied', tone: 'success', duration: 1800 });
      }),
      wallet.isDemo ? null : menuItem('external', 'View on Solscan', () => window.open(settings.explorer.account(address), '_blank', 'noopener')),
      menuItem('logout', 'Disconnect', async () => {
        this.toggleMenu(false);
        await wallet.disconnect();
      }),
    );
    this.root.replaceChildren(pill, menu);
    this.root.classList.toggle('menu-open', this.menuOpen);
  }

  toggleMenu(force) {
    this.menuOpen = force ?? !this.menuOpen;
    this.root.classList.toggle('menu-open', this.menuOpen);
    this.root.querySelector('.wallet-pill')?.setAttribute('aria-expanded', String(this.menuOpen));
  }

  /** Wallet picker. Resolves true once connected. */
  pick() {
    const { wallet, settings } = this.ctx;
    return new Promise((resolve) => {
      let done = false;
      const list = h('div', { class: 'wallet-list' });
      const renderList = () => {
        const wallets = wallet.wallets;
        const rows = wallets.map((w) =>
          h(
            'button',
            {
              class: 'wallet-row',
              onclick: async (e) => {
                const btn = e.currentTarget;
                btn.classList.add('is-busy');
                try {
                  await wallet.connect(w);
                  done = true;
                  close(true);
                } catch (err) {
                  btn.classList.remove('is-busy');
                  this.ctx.toast({ title: 'Connection cancelled', body: err?.message || '', tone: 'error', duration: 3500 });
                }
              },
            },
            w.icon ? h('img', { src: w.icon, alt: '', class: 'wallet-row-icon' }) : h('span', { class: 'wallet-row-icon', svg: icon('wallet') }),
            h('span', { class: 'wallet-row-name' }, w.name),
            h('span', { class: 'wallet-row-tag' }, 'Detected'),
          ),
        );
        if (!wallets.length) {
          const mobile = isTouch();
          const here = location.href;
          rows.push(
            h('p', { class: 'wallet-none' }, mobile ? 'Open Solworld inside your wallet app to connect:' : 'No Solana wallet found in this browser. Install one to continue:'),
            ...WALLET_LINKS.map((l) =>
              h(
                'a',
                { class: 'wallet-row', href: mobile && l.browse ? l.browse(here, location.origin) : l.url, target: '_blank', rel: 'noopener' },
                h('span', { class: 'wallet-row-icon wallet-row-icon--letter' }, l.name[0]),
                h('span', { class: 'wallet-row-name' }, mobile && l.browse ? `Open in ${l.name}` : `Get ${l.name}`),
                h('span', { svg: icon('external', { size: 14 }) }),
              ),
            ),
          );
        }
        if (settings.mode === 'demo') {
          rows.push(
            h(
              'button',
              {
                class: 'wallet-row wallet-row--demo',
                onclick: async () => {
                  await wallet.connectDemo();
                  done = true;
                  close(true);
                },
              },
              h('span', { class: 'wallet-row-icon', svg: icon('sparkle') }),
              h('span', { class: 'wallet-row-name' }, 'Use a demo wallet'),
              h('span', { class: 'wallet-row-tag' }, 'No SOL needed'),
            ),
          );
        }
        list.replaceChildren(...rows);
      };
      renderList();
      const off = wallet.on('wallets', renderList);
      const close = openModal({
        eyebrow: settings.mode === 'demo' ? 'Demo mode' : 'Solana',
        title: 'Connect a wallet',
        size: 'sm',
        content: h('div', null, list, h('p', { class: 'modal-fine' }, 'Solworld never asks for your seed phrase or private key. Every purchase is a transaction you approve in your wallet.')),
        onClose: () => {
          off();
          resolve(done);
        },
      });
    });
  }
}

function menuItem(ic, label, onClick) {
  return h('button', { class: 'menu-item', role: 'menuitem', onclick: onClick }, h('span', { svg: icon(ic, { size: 16 }) }), label);
}
