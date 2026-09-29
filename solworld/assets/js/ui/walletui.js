// The Solworld wallet UI: a per-visitor wallet that lives in this browser.
// Deposit (QR / address / from Phantom), withdraw, back up, restore, and
// link a meme-coin holder wallet for building credit.

import { renderSVG } from '../../../vendor/uqr-0.1.3/uqr.mjs';
import { WALLET_LINKS, isUserRejection } from '../wallet.js';
import { isAddress } from '../solana.js';
import { avatar, copyText, fmtInt, fmtSol, h, isTouch, shortAddr } from '../util.js';
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
    if (!wallet.exists) {
      this.root.replaceChildren(
        h('button', { class: 'btn btn--primary btn--sm wallet-btn', onclick: () => this.open() }, h('span', { svg: icon('wallet', { size: 16 }) }), h('span', { class: 'wallet-btn-label' }, 'Get a wallet')),
      );
      return;
    }
    const address = wallet.address;
    const owned = registry.state.owners.get(address);
    const credit = this.ctx.creditLeft();
    const pill = h(
      'button',
      { class: 'wallet-pill', 'aria-haspopup': 'menu', 'aria-expanded': String(this.menuOpen), onclick: () => this.toggleMenu() },
      avatar(address, 24),
      h('span', { class: 'wallet-pill-main' }, h('span', { class: 'mono' }, wallet.balance == null ? '— SOL' : `${fmtSol(wallet.balance)} SOL`), h('small', null, shortAddr(address))),
      credit > 0 ? h('span', { class: 'gift-badge', title: `${fmtSol(credit)} SOL of ${settings.memecoinView.symbol} credit`, svg: icon('gift', { size: 13 }) }) : null,
      h('span', { class: 'wallet-pill-caret', svg: icon('chevronDown', { size: 14 }) }),
    );
    const myOffers = this.ctx.myOffers();
    const incoming = this.ctx.incomingOffers();
    const menu = h(
      'div',
      { class: 'wallet-menu', role: 'menu' },
      h(
        'div',
        { class: 'wallet-menu-head' },
        avatar(address, 40),
        h('div', null, h('div', { class: 'wallet-menu-bal' }, wallet.balance == null ? '—' : fmtSol(wallet.balance), h('small', null, ' SOL')), h('div', { class: 'wallet-menu-sub mono' }, shortAddr(address, 6, 6))),
      ),
      h(
        'div',
        { class: 'wallet-actions' },
        h('button', { class: 'btn btn--primary btn--sm', onclick: () => (this.toggleMenu(false), this.deposit()) }, h('span', { svg: icon('plus', { size: 15 }) }), 'Deposit'),
        h('button', { class: 'btn btn--ghost btn--sm', onclick: () => (this.toggleMenu(false), this.withdraw()) }, 'Withdraw'),
      ),
      wallet.backedUp ? null : h('button', { class: 'claim-card is-warning', onclick: () => (this.toggleMenu(false), this.backup()) }, h('span', { svg: icon('alert', { size: 16 }) }), h('div', null, h('b', null, 'Back up your wallet'), h('small', null, 'It lives only in this browser. Save the key so you never lose your buildings.'))),
      settings.memecoinView
        ? h(
            'button',
            { class: `claim-card${credit > 0 ? ' is-eligible' : ''}`, onclick: () => (this.toggleMenu(false), this.holder()) },
            h('span', { svg: icon('gift', { size: 16 }) }),
            h('div', null, h('b', null, credit > 0 ? `${fmtSol(credit)} SOL of $${settings.memecoinView.symbol} credit` : `Use your $${settings.memecoinView.symbol}`), h('small', null, credit > 0 ? 'Take buildings with your holdings — no SOL needed.' : `Holding $${settings.memecoinView.symbol}? Its value becomes building credit.`)),
          )
        : null,
      menuItem('building', `My buildings (${owned?.count || 0})`, () => (this.toggleMenu(false), this.ctx.onMine())),
      incoming.length ? menuItem('sparkle', `Offers on my buildings (${incoming.length})`, () => (this.toggleMenu(false), this.ctx.onOpenOffer(incoming[0]))) : null,
      myOffers.length ? menuItem('clock', `My open offers (${myOffers.length})`, () => (this.toggleMenu(false), this.ctx.onOpenOffer(myOffers[0]))) : null,
      menuItem('copy', 'Copy address', async () => {
        await copyText(address);
        this.toggleMenu(false);
        this.ctx.toast({ title: 'Address copied', tone: 'success', duration: 1800 });
      }),
      menuItem('shield', 'Back up key', () => (this.toggleMenu(false), this.backup())),
      menuItem('refresh', 'Restore another wallet', () => (this.toggleMenu(false), this.restore())),
      settings.live ? menuItem('external', 'View on Solscan', () => window.open(settings.explorer.account(address), '_blank', 'noopener')) : null,
    );
    this.root.replaceChildren(pill, menu);
    this.root.classList.toggle('menu-open', this.menuOpen);
  }

  toggleMenu(force) {
    this.menuOpen = force ?? !this.menuOpen;
    this.root.classList.toggle('menu-open', this.menuOpen);
    this.root.querySelector('.wallet-pill')?.setAttribute('aria-expanded', String(this.menuOpen));
  }

  /** First-run: explain, create the wallet, then show deposit. Resolves true when a wallet exists. */
  async open() {
    const { wallet } = this.ctx;
    if (wallet.exists) {
      this.toggleMenu(true);
      return true;
    }
    const ok = await new Promise((resolve) => {
      let created = false;
      openModal({
        eyebrow: 'Solworld wallet',
        title: 'Your own wallet, made for you',
        size: 'sm',
        content: h(
          'ul',
          { class: 'consent' },
          h('li', null, h('span', { svg: icon('wallet', { size: 16 }) }), 'We create a fresh Solana wallet in this browser. Only you have its key — not us, not anyone.'),
          h('li', null, h('span', { svg: icon('plus', { size: 16 }) }), 'Deposit SOL to it from any wallet or exchange, then buy and sell buildings with one tap — no pop-ups.'),
          h('li', null, h('span', { svg: icon('shield', { size: 16 }) }), 'Back up the key (Wallet menu → Back up key). You can withdraw any time, or import it into Phantom.'),
        ),
        actions: [
          { label: 'Not now', kind: 'ghost' },
          {
            label: 'Create my wallet',
            kind: 'primary',
            onClick: async (close) => {
              await wallet.create();
              created = true;
              close();
            },
          },
        ],
        onClose: () => resolve(created),
      });
    });
    if (ok) this.deposit();
    return ok;
  }

  /** Deposit screen. `need` (lamports) highlights how much more is required. */
  deposit({ need } = {}) {
    const { wallet, settings } = this.ctx;
    const address = wallet.address;
    const balance = h('b', { class: 'mono' }, wallet.balance == null ? '—' : fmtSol(wallet.balance));
    const qr = h('div', { class: 'qr', svg: renderSVG(`solana:${address}`, { whiteColor: '#ffffff', blackColor: '#05060a', border: 2 }) });
    const off = wallet.on('change', () => {
      balance.textContent = wallet.balance == null ? '—' : fmtSol(wallet.balance);
    });
    const poll = setInterval(() => wallet.refreshBalance(), 4000);
    const amount = h('input', { class: 'field-input', type: 'number', min: '0.001', step: '0.01', value: need ? (need / 1e9).toFixed(3) : '0.1', 'aria-label': 'Amount in SOL' });
    openModal({
      eyebrow: settings.live ? 'Solworld wallet' : 'Demo wallet',
      title: 'Deposit SOL',
      size: 'sm',
      content: h(
        'div',
        { class: 'deposit' },
        need ? h('p', { class: 'deposit-need' }, `You need ${fmtSol(need)} more SOL for that.`) : null,
        settings.live
          ? [
              h('div', { class: 'deposit-row' }, qr, h('div', { class: 'deposit-side' }, h('small', null, 'Send SOL to'), h('code', { class: 'deposit-addr' }, address), h('button', { class: 'btn btn--ghost btn--sm', onclick: () => copyText(address).then(() => this.ctx.toast({ title: 'Address copied', tone: 'success', duration: 1600 })) }, h('span', { svg: icon('copy', { size: 14 }) }), 'Copy address'))),
              h('p', { class: 'modal-fine' }, 'Scan with Phantom or Solflare on your phone, or paste the address in any wallet or exchange. Only send SOL on Solana.'),
              h(
                'div',
                { class: 'deposit-ext' },
                h('span', null, 'Or send from a browser wallet'),
                h('div', { class: 'field-row' }, amount, h('span', { class: 'field-unit' }, 'SOL'), h('button', { class: 'btn btn--primary btn--sm', onclick: () => this.depositFromExternal(Math.round(Number(amount.value) * 1e9)) }, 'Send')),
              ),
            ]
          : h(
              'div',
              null,
              h('p', null, 'Demo mode: your wallet starts with 5 pretend SOL.'),
              h('button', { class: 'btn btn--ghost btn--sm', onclick: () => wallet.adjustDemoBalance(5_000_000_000) }, '+5 demo SOL'),
            ),
        h('div', { class: 'deposit-bal' }, h('span', null, 'Balance'), balance, h('span', null, 'SOL'), settings.live ? h('span', { class: 'spinner deposit-live', title: 'Watching for deposits' }) : null),
      ),
      actions: [{ label: 'Done', kind: 'primary' }],
      onClose: () => {
        off();
        clearInterval(poll);
      },
    });
  }

  async depositFromExternal(lamports) {
    const { ext } = this.ctx;
    if (!(lamports > 0)) return;
    const account = await this.pickExternal({ title: 'Deposit from a wallet', reason: 'Choose the wallet to send SOL from.' });
    if (!account) return;
    try {
      const sig = await this.ctx.sendExternalTransfer(lamports);
      this.ctx.toast({ title: 'Deposit sent', body: `${fmtSol(lamports)} SOL is on its way.`, tone: 'success', link: { href: this.ctx.settings.explorer.tx(sig), label: 'View transaction' } });
    } catch (err) {
      this.ctx.toast({ title: isUserRejection(err) ? 'Cancelled' : 'Deposit failed', body: isUserRejection(err) ? '' : err.message, tone: isUserRejection(err) ? 'info' : 'error' });
    } finally {
      ext.disconnect().catch(() => {});
    }
  }

  withdraw() {
    const { wallet } = this.ctx;
    const to = h('input', { class: 'field-input', placeholder: 'Destination address', spellcheck: 'false', autocomplete: 'off' });
    const amount = h('input', { class: 'field-input', type: 'number', min: '0', step: '0.01', placeholder: 'Amount' });
    const err = h('p', { class: 'field-error' });
    openModal({
      eyebrow: 'Solworld wallet',
      title: 'Withdraw SOL',
      size: 'sm',
      content: h(
        'div',
        { class: 'form' },
        h('label', null, 'To', to),
        h('label', null, 'Amount', h('div', { class: 'field-row' }, amount, h('span', { class: 'field-unit' }, 'SOL'), h('button', { class: 'btn btn--ghost btn--sm', onclick: () => { amount.value = 'max'; amount.type = 'text'; } }, 'Max'))),
        h('p', { class: 'modal-fine' }, `Available: ${wallet.balance == null ? '—' : fmtSol(wallet.balance)} SOL. Buildings stay in this wallet.`),
        err,
      ),
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Withdraw',
          kind: 'primary',
          onClick: async (close) => {
            const dest = to.value.trim();
            if (!isAddress(dest)) return void (err.textContent = 'That is not a Solana address.');
            const value = amount.value.trim() === 'max' ? 'max' : Math.round(Number(amount.value) * 1e9);
            if (value !== 'max' && !(value > 0)) return void (err.textContent = 'Enter an amount.');
            err.textContent = '';
            try {
              const sig = await this.ctx.withdraw(dest, value);
              close();
              this.ctx.toast({ title: 'Withdrawal sent', tone: 'success', link: sig ? { href: this.ctx.settings.explorer.tx(sig), label: 'View transaction' } : null });
            } catch (e) {
              err.textContent = e.message;
            }
          },
        },
      ],
    });
  }

  backup() {
    const { wallet } = this.ctx;
    const secret = h('code', { class: 'secret is-hidden' }, wallet.exportSecret());
    const agree = h('input', { type: 'checkbox' });
    openModal({
      eyebrow: 'Keep this safe',
      title: 'Back up your wallet key',
      size: 'sm',
      content: h(
        'div',
        { class: 'form' },
        h('p', null, 'Anyone with this key controls the wallet and its buildings. Store it somewhere private (a password manager). Never share it — Solworld will never ask for it.'),
        secret,
        h(
          'div',
          { class: 'field-row' },
          h('button', { class: 'btn btn--ghost btn--sm', onclick: () => secret.classList.toggle('is-hidden') }, h('span', { svg: icon('eye', { size: 14 }) }), 'Show'),
          h('button', { class: 'btn btn--ghost btn--sm', onclick: () => copyText(wallet.exportSecret()).then(() => this.ctx.toast({ title: 'Key copied', body: 'Paste it somewhere safe, then clear your clipboard.', tone: 'success' })) }, h('span', { svg: icon('copy', { size: 14 }) }), 'Copy'),
        ),
        h('p', { class: 'modal-fine' }, 'This key also works in Phantom and Solflare (“Import private key”).'),
        h('label', { class: 'check' }, agree, 'I saved my key somewhere safe'),
      ),
      actions: [
        {
          label: 'Done',
          kind: 'primary',
          onClick: (close) => {
            if (agree.checked) wallet.markBackedUp();
            close();
          },
        },
      ],
    });
  }

  restore() {
    const { wallet } = this.ctx;
    const input = h('textarea', { class: 'field-input', rows: '3', placeholder: 'Paste a Solworld / Phantom private key', spellcheck: 'false' });
    const err = h('p', { class: 'field-error' });
    openModal({
      eyebrow: 'Solworld wallet',
      title: 'Restore a wallet',
      size: 'sm',
      content: h(
        'div',
        { class: 'form' },
        wallet.exists && !wallet.backedUp ? h('p', { class: 'deposit-need' }, 'Back up your current wallet first — restoring replaces it in this browser.') : h('p', null, 'This replaces the wallet in this browser. Keep a backup of the current one if it holds anything.'),
        input,
        err,
      ),
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Restore',
          kind: 'primary',
          onClick: async (close) => {
            try {
              await wallet.importSecret(input.value);
              close();
              this.ctx.toast({ title: 'Wallet restored', body: shortAddr(wallet.address, 6, 6), tone: 'success' });
            } catch (e) {
              err.textContent = e.message;
            }
          },
        },
      ],
    });
  }

  /** Meme-coin holder: paste the address, preview credit, verify by co-signing. */
  holder() {
    const { settings } = this.ctx;
    const coin = settings.memecoinView;
    const linked = this.ctx.linkedHolder();
    const input = h('input', { class: 'field-input', placeholder: `Wallet that holds your $${coin.symbol}`, spellcheck: 'false', autocomplete: 'off', value: linked || '' });
    const preview = h('div', { class: 'holder-preview' });
    const err = h('p', { class: 'field-error' });
    const check = async () => {
      err.textContent = '';
      const address = input.value.trim();
      if (!isAddress(address)) {
        preview.replaceChildren();
        return;
      }
      preview.replaceChildren(h('span', { class: 'spinner' }));
      try {
        const info = await this.ctx.holderPreview(address);
        preview.replaceChildren(
          h('div', { class: 'op-row' }, h('span', null, `$${coin.symbol} held`), h('b', null, fmtInt(info.tokens))),
          h('div', { class: 'op-row' }, h('span', null, 'Worth'), h('b', null, `${fmtSol(info.value)} SOL`)),
          h('div', { class: 'op-row' }, h('span', null, 'Credit left'), h('b', null, `${fmtSol(info.left)} SOL`)),
        );
      } catch (e) {
        preview.replaceChildren();
        err.textContent = e.message;
      }
    };
    input.addEventListener('input', check);
    if (linked) check();
    openModal({
      eyebrow: `$${coin.symbol} holders`,
      title: 'Buildings with your holdings',
      size: 'sm',
      content: h(
        'div',
        { class: 'form' },
        h('p', null, `Paste the wallet that holds your $${coin.symbol}. Its value in SOL becomes credit you can spend on buildings — no SOL needed. Example: $${coin.symbol} worth 0.56 SOL = 0.56 SOL of buildings.`),
        input,
        preview,
        linked
          ? h('p', { class: 'modal-fine' }, h('span', { svg: icon('check', { size: 13 }) }), ' Linked. Pick any building and choose “Use credit”.')
          : h('p', { class: 'modal-fine' }, 'To stop people pasting someone else’s wallet, you approve one signature with that wallet. It costs you nothing and moves no tokens.'),
        err,
      ),
      actions: linked
        ? [{ label: 'Close', kind: 'primary' }]
        : [
            { label: 'Cancel', kind: 'ghost' },
            {
              label: 'Verify with my wallet',
              kind: 'primary',
              onClick: async (close) => {
                const address = input.value.trim();
                if (!isAddress(address)) return void (err.textContent = 'Paste a Solana wallet address.');
                try {
                  const ok = await this.ctx.linkHolder(address, (opts) => this.pickExternal(opts));
                  if (ok) close();
                } catch (e) {
                  err.textContent = isUserRejection(e) ? 'Cancelled in the wallet.' : e.message;
                }
              },
            },
          ],
    });
  }

  /** Pick and connect an external (Phantom/Solflare/...) wallet. Resolves the account or null. */
  pickExternal({ title = 'Connect a wallet', reason = '' } = {}) {
    const { ext } = this.ctx;
    return new Promise((resolve) => {
      let account = null;
      const list = h('div', { class: 'wallet-list' });
      const renderList = () => {
        const rows = ext.wallets.map((w) =>
          h(
            'button',
            {
              class: 'wallet-row',
              onclick: async (e) => {
                const btn = e.currentTarget;
                btn.classList.add('is-busy');
                try {
                  account = await ext.connect(w);
                  close();
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
        if (!rows.length) {
          const mobile = isTouch();
          rows.push(
            h('p', { class: 'wallet-none' }, mobile ? 'Open Solworld inside your wallet app to do this:' : 'No Solana wallet found in this browser.'),
            ...WALLET_LINKS.map((l) =>
              h(
                'a',
                { class: 'wallet-row', href: mobile && l.browse ? l.browse(location.href, location.origin) : l.url, target: '_blank', rel: 'noopener' },
                h('span', { class: 'wallet-row-icon wallet-row-icon--letter' }, l.name[0]),
                h('span', { class: 'wallet-row-name' }, mobile && l.browse ? `Open in ${l.name}` : `Get ${l.name}`),
                h('span', { svg: icon('external', { size: 14 }) }),
              ),
            ),
          );
        }
        list.replaceChildren(...rows);
      };
      renderList();
      const off = ext.on('wallets', renderList);
      const close = openModal({
        eyebrow: 'Your wallet app',
        title,
        size: 'sm',
        content: h('div', null, reason ? h('p', null, reason) : null, list),
        onClose: () => {
          off();
          resolve(account);
        },
      });
    });
  }
}

function menuItem(ic, label, onClick) {
  return h('button', { class: 'menu-item', role: 'menuitem', onclick: onClick }, h('span', { svg: icon(ic, { size: 16 }) }), label);
}
