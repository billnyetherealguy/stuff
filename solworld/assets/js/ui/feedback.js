// Toasts and modals.
import { h } from '../util.js';
import { icon } from './icons.js';

export class Toasts {
  constructor(root) {
    this.root = root;
  }

  /**
   * Shows a toast and returns a handle to update or dismiss it.
   * tone: 'info' | 'success' | 'error' | 'pending' | 'mine' | 'owned'
   */
  show({ title, body, tone = 'info', link, duration = 5200, iconName, action } = {}) {
    const glyph = iconName || { success: 'check', error: 'alert', pending: 'clock', mine: 'sparkle', owned: 'building' }[tone] || 'info';
    const titleEl = h('div', { class: 'toast-title' }, title);
    const bodyEl = h('div', { class: 'toast-body' }, body || '');
    const linkEl = h('div', { class: 'toast-link' });
    const iconEl = h('div', { class: 'toast-icon', svg: tone === 'pending' ? '<span class="spinner"></span>' : icon(glyph, { size: 16 }) });
    const el = h(
      'div',
      { class: `toast toast--${tone}`, role: tone === 'error' ? 'alert' : 'status' },
      iconEl,
      h('div', { class: 'toast-main' }, titleEl, bodyEl, linkEl),
      h('button', { class: 'toast-x', 'aria-label': 'Dismiss', svg: icon('close', { size: 14 }), onclick: () => dismiss() }),
    );
    let timer;
    const setLink = (l) => {
      linkEl.replaceChildren();
      if (l) linkEl.append(h('a', { href: l.href, target: '_blank', rel: 'noopener' }, l.label, h('span', { svg: icon('external', { size: 12 }) })));
    };
    const arm = (ms) => {
      clearTimeout(timer);
      if (ms) timer = setTimeout(() => dismiss(), ms);
    };
    const dismiss = () => {
      clearTimeout(timer);
      el.classList.add('toast--out');
      setTimeout(() => el.remove(), 320);
    };
    setLink(link);
    if (action) {
      linkEl.after(
        h('button', {
          class: 'toast-action',
          onclick: () => {
            dismiss();
            action.onClick();
          },
        }, action.label),
      );
    }
    this.root.append(el);
    while (this.root.children.length > 4) this.root.firstElementChild.remove();
    arm(tone === 'pending' ? 0 : duration);
    return {
      update: (next) => {
        if (next.title != null) titleEl.textContent = next.title;
        if (next.body != null) bodyEl.textContent = next.body;
        if (next.link !== undefined) setLink(next.link);
        if (next.tone) {
          el.className = `toast toast--${next.tone}`;
          const g = { success: 'check', error: 'alert', pending: 'clock', mine: 'sparkle' }[next.tone] || 'info';
          iconEl.innerHTML = next.tone === 'pending' ? '<span class="spinner"></span>' : icon(g, { size: 16 });
          arm(next.tone === 'pending' ? 0 : next.duration ?? duration);
        }
      },
      dismiss,
    };
  }
}

let openCount = 0;

/**
 * Opens a modal dialog. `content` is a Node; `actions` are { label, kind, onClick }.
 * Returns a close() function. Esc and backdrop clicks close it.
 */
export function openModal({ title, eyebrow, content, actions = [], size = 'md', onClose, dismissible = true }) {
  const root = document.getElementById('modal-root');
  const previouslyFocused = document.activeElement;
  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    overlay.classList.add('modal--out');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => {
      overlay.remove();
      openCount = Math.max(0, openCount - 1);
      if (!openCount) document.body.classList.remove('has-modal');
    }, 260);
    previouslyFocused?.focus?.();
    onClose?.(result);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissible) {
      e.stopPropagation();
      close();
    }
    if (e.key === 'Tab') {
      const items = [...dialog.querySelectorAll('button, a[href], input, [tabindex]:not([tabindex="-1"])')].filter((n) => !n.disabled);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  const titleId = `modal-title-${Math.random().toString(36).slice(2, 8)}`;
  const dialog = h(
    'div',
    { class: `modal modal--${size}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h(
      'div',
      { class: 'modal-head' },
      h('div', null, eyebrow ? h('div', { class: 'eyebrow' }, eyebrow) : null, h('h2', { id: titleId, class: 'modal-title' }, title)),
      dismissible ? h('button', { class: 'icon-btn icon-btn--ghost', 'aria-label': 'Close', svg: icon('close'), onclick: () => close() }) : null,
    ),
    h('div', { class: 'modal-body' }, content),
    actions.length
      ? h(
          'div',
          { class: 'modal-actions' },
          actions.map((a) =>
            h('button', { class: `btn btn--${a.kind || 'ghost'}`, onclick: () => (a.onClick ? a.onClick(close) : close(a.value)) }, a.label),
          ),
        )
      : null,
  );
  const overlay = h('div', { class: 'modal-overlay', onmousedown: (e) => e.target === overlay && dismissible && close() }, dialog);
  root.append(overlay);
  openCount++;
  document.body.classList.add('has-modal');
  document.addEventListener('keydown', onKey, true);
  requestAnimationFrame(() => (dialog.querySelector('.modal-actions .btn--primary') || dialog.querySelector('button'))?.focus());
  return close;
}
