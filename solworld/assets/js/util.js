// Small DOM, formatting and storage helpers used across the UI.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Hyperscript-style element builder. Strings become text nodes, so untrusted
 * data (OSM names, addresses, memo contents) can never inject markup.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'style' && typeof value === 'object') {
        for (const [prop, v] of Object.entries(value)) {
          if (prop.startsWith('--')) el.style.setProperty(prop, String(v));
          else el.style[prop] = v;
        }
      }
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'svg') el.innerHTML = value; // trusted, static icon markup only
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function rafThrottle(fn) {
  let queued = false;
  let lastArgs;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...lastArgs);
    });
  };
}

export const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const isTouch = () => typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;

/* ------------------------------------------------------------ formatting */

const nf = new Intl.NumberFormat('en-US');
export const fmtInt = (n) => nf.format(Math.round(n || 0));

export function fmtSol(lamports, { digits } = {}) {
  const sol = Number(lamports || 0) / 1e9;
  const d = digits ?? (sol === 0 ? 0 : sol < 0.01 ? 4 : sol < 10 ? 3 : 2);
  return sol.toLocaleString('en-US', { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d });
}

export function fmtUsd(value) {
  if (!Number.isFinite(value)) return '';
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value < 100 ? 2 : 0,
  });
}

// People can pick a display name (registry "name" action). `who()` shows it,
// falling back to the short wallet address.
let nameResolver = null;
export const setNameResolver = (fn) => {
  nameResolver = fn;
};
export const who = (a, head = 4, tail = 4) => (a && nameResolver?.(a)) || shortAddr(a, head, tail);

export const shortAddr = (a, head = 4, tail = 4) => (a && a.length > head + tail + 1 ? `${a.slice(0, head)}…${a.slice(-tail)}` : a || '');

export function timeAgo(unixSeconds) {
  if (!unixSeconds) return '';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtCoord(lat, lng) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}° ${ns}, ${Math.abs(lng).toFixed(4)}° ${ew}`;
}

export function titleCase(s) {
  return String(s || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/* --------------------------------------------------------------- storage */

export const storage = {
  get(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // storage unavailable (private mode, blocked site data)
    }
  },
};

/* -------------------------------------------------------------- identity */

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic gradient avatar for a wallet address. */
export function avatarStyle(address) {
  const h = hash32(address || 'solworld');
  const a = h % 360;
  const b = (a + 40 + ((h >> 9) % 100)) % 360;
  const angle = (h >> 17) % 360;
  return {
    background: `conic-gradient(from ${angle}deg, hsl(${a} 85% 62%), hsl(${b} 80% 55%), hsl(${a} 85% 62%))`,
  };
}

export function avatar(address, size = 28) {
  return h('span', {
    class: 'avatar',
    style: { ...avatarStyle(address), width: `${size}px`, height: `${size}px` },
    'aria-hidden': 'true',
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/** Fetch JSON with a timeout; throws on HTTP errors. */
export async function fetchJson(url, { timeoutMs = 12_000, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Animated number (count-up) for stats. */
export function countTo(el, value, { format = fmtInt, duration = 900 } = {}) {
  const from = Number(el.dataset.value || 0);
  el.dataset.value = String(value);
  if (prefersReducedMotion() || from === value) {
    el.textContent = format(value);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = format(from + (value - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
