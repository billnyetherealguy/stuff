// Left rail: leaderboard ("who owns the most"), live activity, owner profiles.
import { placeLabel } from '../cities.js';
import { buildingTitle } from '../info.js';
import { avatar, fmtInt, fmtSol, h, shortAddr, timeAgo } from '../util.js';
import { icon } from './icons.js';

export class Rail {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.tab = 'leaders';
    this.ownerView = null;
    this.build();
  }

  build() {
    this.tabs = h('div', { class: 'rail-tabs', role: 'tablist' });
    this.body = h('div', { class: 'rail-body' });
    this.foot = h('div', { class: 'rail-foot' });
    this.collapseBtn = h('button', {
      class: 'icon-btn icon-btn--ghost rail-collapse',
      'aria-label': 'Hide leaderboard',
      svg: icon('chevronLeft'),
      onclick: () => this.setOpen(false),
    });
    this.opener = h(
      'button',
      { class: 'rail-opener glass', 'aria-label': 'Show leaderboard', onclick: () => this.setOpen(true) },
      h('span', { svg: icon('trophy', { size: 16 }) }),
      h('span', { class: 'rail-opener-label' }, 'Leaderboard'),
    );
    this.root.replaceChildren(h('div', { class: 'rail-head' }, this.tabs, this.collapseBtn), this.body, this.foot);
    this.root.after(this.opener);
  }

  setOpen(open) {
    this.root.classList.toggle('is-open', open);
    this.opener.classList.toggle('is-hidden', open);
    this.ctx.onRailToggle?.(open);
  }

  get isOpen() {
    return this.root.classList.contains('is-open');
  }

  showOwner(address) {
    this.ownerView = address;
    this.setOpen(true);
    this.render();
  }

  render() {
    const { registry } = this.ctx;
    const state = registry.state;
    const tabs = [
      ['leaders', 'Leaderboard', 'trophy'],
      ['activity', 'Activity', 'activity'],
    ];
    this.tabs.replaceChildren(
      ...tabs.map(([id, label, ic]) =>
        h(
          'button',
          {
            class: `rail-tab${this.tab === id && !this.ownerView ? ' is-active' : ''}`,
            role: 'tab',
            'aria-selected': String(this.tab === id),
            onclick: () => {
              this.tab = id;
              this.ownerView = null;
              this.render();
            },
          },
          h('span', { svg: icon(ic, { size: 15 }) }),
          label,
        ),
      ),
    );
    if (this.ownerView) this.renderOwner(state, this.ownerView);
    else if (this.tab === 'activity') this.renderActivity(state);
    else this.renderLeaders(state);
    this.renderFoot(state);
  }

  renderLeaders(state) {
    const me = this.ctx.wallet.address;
    const list = state.leaderboard.slice(0, 100);
    if (!list.length) {
      this.body.replaceChildren(
        emptyState('trophy', 'No landowners yet', this.ctx.settings.live ? 'Every building on Earth is still available. Be the first on the board.' : 'Buy a building to put yourself on the board.'),
      );
      return;
    }
    const max = list[0].count;
    this.body.replaceChildren(
      h(
        'ol',
        { class: 'leaders' },
        list.map((o, i) =>
          h(
            'li',
            { style: { '--i': Math.min(i, 12) } },
            h(
              'button',
              { class: `leader${o.address === me ? ' is-me' : ''}`, onclick: () => this.showOwner(o.address) },
              h('span', { class: `rank rank--${o.rank <= 3 ? o.rank : 'n'}` }, o.rank),
              avatar(o.address, 28),
              h(
                'span',
                { class: 'leader-main' },
                h('span', { class: 'leader-name mono' }, o.address === me ? 'You' : shortAddr(o.address, 4, 4)),
                h('span', { class: 'leader-bar' }, h('i', { style: { width: `${Math.max(6, (o.count / max) * 100)}%` } })),
              ),
              h('span', { class: 'leader-count' }, h('b', null, fmtInt(o.count)), h('small', null, o.count === 1 ? 'building' : 'buildings')),
            ),
          ),
        ),
      ),
    );
  }

  renderActivity(state) {
    const items = state.activity.slice(0, 60);
    if (!items.length) {
      this.body.replaceChildren(emptyState('activity', 'Quiet so far', 'Purchases and free claims appear here the moment they land on Solana.'));
      return;
    }
    const me = this.ctx.wallet.address;
    this.body.replaceChildren(
      h(
        'ul',
        { class: 'feed' },
        items.map((r, i) =>
          h(
            'li',
            { style: { '--i': Math.min(i, 12) } },
            h(
              'button',
              { class: 'feed-item', onclick: () => this.ctx.onOpenRecord(r) },
              avatar(r.owner, 28),
              h(
                'span',
                { class: 'feed-main' },
                h('span', { class: 'feed-line' }, h('b', { class: 'mono' }, r.owner === me ? 'You' : shortAddr(r.owner)), r.kind === 'claim' ? ' claimed a building' : ' bought a building'),
                h('span', { class: 'feed-meta' }, h('span', { svg: icon('pin', { size: 12 }) }), this.label(r), h('span', { class: 'dot-sep' }, '·'), timeAgo(r.time)),
              ),
              h('span', { class: `feed-amt${r.kind === 'claim' ? ' is-free' : ''}` }, r.kind === 'claim' ? 'FREE' : `${fmtSol(r.paid)} SOL`),
            ),
          ),
        ),
      ),
    );
  }

  label(r) {
    const cached = this.ctx.osm.byKey.get(r.key);
    const name = cached && buildingTitle(cached.tags);
    const place = placeLabel(r.lat, r.lng);
    return name ? `${name}, ${place}` : place;
  }

  renderOwner(state, address) {
    const o = state.owners.get(address);
    const me = this.ctx.wallet.address;
    const records = (o?.keys || []).map((k) => state.buildings.get(k)).filter(Boolean).reverse();
    this.body.replaceChildren(
      h(
        'div',
        { class: 'owner-view' },
        h('button', { class: 'back-btn', onclick: () => { this.ownerView = null; this.render(); } }, h('span', { svg: icon('chevronLeft', { size: 16 }) }), 'Back'),
        h(
          'div',
          { class: 'owner-hero' },
          avatar(address, 56),
          h('div', { class: 'owner-hero-name mono' }, address === me ? 'You' : shortAddr(address, 6, 6)),
          h(
            'div',
            { class: 'owner-hero-actions' },
            h('a', { class: 'chip', href: this.ctx.settings.explorer.account(address), target: '_blank', rel: 'noopener' }, 'Solscan', h('span', { svg: icon('external', { size: 12 }) })),
          ),
          h(
            'div',
            { class: 'owner-stats' },
            stat(fmtInt(o?.count || 0), o?.count === 1 ? 'building' : 'buildings'),
            stat(o ? `#${o.rank}` : '—', 'rank'),
            stat(o ? fmtSol(o.spent) : '0', 'SOL spent'),
          ),
        ),
        records.length
          ? h(
              'ul',
              { class: 'feed' },
              records.map((r, i) =>
                h(
                  'li',
                  { style: { '--i': Math.min(i, 12) } },
                  h(
                    'button',
                    { class: 'feed-item', onclick: () => this.ctx.onOpenRecord(r) },
                    h('span', { class: 'feed-icon', svg: icon('building', { size: 16 }) }),
                    h('span', { class: 'feed-main' }, h('span', { class: 'feed-line' }, this.label(r)), h('span', { class: 'feed-meta' }, r.kind === 'claim' ? 'Claimed free' : `Bought for ${fmtSol(r.paid)} SOL`, h('span', { class: 'dot-sep' }, '·'), timeAgo(r.time))),
                    h('span', { svg: icon('chevronRight', { size: 16 }) }),
                  ),
                ),
              ),
            )
          : emptyState('building', 'No buildings yet', ''),
      ),
    );
    this.ctx.onOwnerViewed?.(records);
  }

  renderFoot(state) {
    const me = this.ctx.wallet.address;
    const mine = me && state.owners.get(me);
    if (!me) {
      this.foot.replaceChildren(h('button', { class: 'btn btn--ghost btn--block btn--sm', onclick: () => this.ctx.onConnect() }, h('span', { svg: icon('wallet', { size: 15 }) }), 'Connect to see your rank'));
      return;
    }
    this.foot.replaceChildren(
      h(
        'button',
        { class: 'me-row', onclick: () => this.showOwner(me) },
        avatar(me, 26),
        h('span', { class: 'me-main' }, h('b', null, 'You'), h('small', { class: 'mono' }, shortAddr(me))),
        h('span', { class: 'me-rank' }, mine ? `#${mine.rank} · ${fmtInt(mine.count)}` : 'Unranked'),
      ),
    );
  }
}

function stat(value, label) {
  return h('div', { class: 'stat' }, h('b', null, value), h('span', null, label));
}

function emptyState(ic, title, body) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-icon', svg: icon(ic, { size: 22 }) }), h('div', { class: 'empty-title' }, title), body ? h('p', null, body) : null);
}
