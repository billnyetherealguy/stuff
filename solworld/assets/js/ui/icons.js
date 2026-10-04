// Stroke icons (24×24, 1.75px). Static markup only.
const P = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  download: '<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 19h14"/>',
  share: '<path d="M12 3v12"/><path d="m7.5 7.5 4.5-4.5 4.5 4.5"/><path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5V6.2A1.7 1.7 0 0 0 13.8 4.5H6.2A1.7 1.7 0 0 0 4.5 6.2v7.6a1.7 1.7 0 0 0 1.7 1.7h2.3"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  wallet: '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v4"/><path d="M4 7.5v10A2.5 2.5 0 0 0 6.5 20H20v-11H6.5A2.5 2.5 0 0 1 4 7.5Z"/><circle cx="16" cy="14.5" r="1.2"/>',
  gift: '<rect x="3.5" y="8" width="17" height="4" rx="1"/><path d="M5 12v7.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V12"/><path d="M12 8v13"/><path d="M12 8S10.5 3.5 8 3.5a2.25 2.25 0 0 0 0 4.5h4Zm0 0s1.5-4.5 4-4.5a2.25 2.25 0 0 1 0 4.5h-4Z"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0V4Z"/><path d="M16 5.5h2.5a1.5 1.5 0 0 1 1.5 1.5c0 2.2-1.6 3.8-4 4"/><path d="M8 5.5H5.5A1.5 1.5 0 0 0 4 7c0 2.2 1.6 3.8 4 4"/><path d="M12 13v4"/><path d="M8.5 20.5h7M9.5 17h5"/>',
  activity: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
  cube: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5S9.6 5.8 12 3.5Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  compass: '<path d="m12 3 3.2 9H8.8L12 3Z" fill="currentColor" stroke="none"/><path d="m12 21-3.2-9h6.4L12 21Z" opacity=".45" fill="currentColor" stroke="none"/>',
  chevronLeft: '<path d="m15 5-7 7 7 7"/>',
  chevronRight: '<path d="m9 5 7 7-7 7"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.2"/>',
  sparkle: '<path d="M12 3.5c.6 3.9 2.6 5.9 6.5 6.5-3.9.6-5.9 2.6-6.5 6.5-.6-3.9-2.6-5.9-6.5-6.5 3.9-.6 5.9-2.6 6.5-6.5Z"/><path d="M18.5 15.5c.3 1.6 1 2.3 2.5 2.5-1.5.3-2.2 1-2.5 2.5-.3-1.5-1-2.2-2.5-2.5 1.5-.2 2.2-.9 2.5-2.5Z"/>',
  building: '<path d="M5 20.5V5a1.5 1.5 0 0 1 1.5-1.5h7A1.5 1.5 0 0 1 15 5v15.5"/><path d="M15 9.5h2.5A1.5 1.5 0 0 1 19 11v9.5"/><path d="M3.5 20.5h17"/><path d="M8.5 7.5h3M8.5 11h3M8.5 14.5h3"/>',
  pin: '<path d="M12 21s-6.5-5.4-6.5-11a6.5 6.5 0 0 1 13 0c0 5.6-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  alert: '<path d="M12 4 21 19.5H3L12 4Z"/><path d="M12 10v4.5M12 17.2v.2"/>',
  logout: '<path d="M14 4.5h3.5A1.5 1.5 0 0 1 19 6v12a1.5 1.5 0 0 1-1.5 1.5H14"/><path d="M10 16.5 5.5 12 10 7.5M5.5 12H15"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>',
  satellite: '<path d="m13.5 6.5 4 4"/><path d="m9 11 4-4 4 4-4 4-4-4Z"/><path d="m4 20 3-3"/><path d="M7 12.5a4.5 4.5 0 0 0 4.5 4.5"/><path d="M4.5 12.5a7 7 0 0 0 7 7"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.7"/><path d="m20.5 16-4.5-4.5L6 19.5"/>',
  street: '<circle cx="12" cy="5.5" r="2"/><path d="M12 8.5v5M9 11.5l3-3 3 3M10 21l2-7.5 2 7.5"/>',
  orbit: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4.5v4h-4"/><circle cx="12" cy="12" r="2.5"/>',
  shield: '<path d="M12 3.5 19 6v5.5c0 4.4-3 7.9-7 9-4-1.1-7-4.6-7-9V6l7-2.5Z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
};

export function icon(name, { size = 18, stroke = 1.75, className = '' } = {}) {
  const body = P[name] || P.info;
  return `<svg class="ic ${className}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export const BRAND_MARK = `<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
  <defs>
    <linearGradient id="sw-g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#9b7bff"/><stop offset="1" stop-color="#2af5a8"/>
    </linearGradient>
  </defs>
  <circle cx="16" cy="16" r="12.5" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="1.2"/>
  <ellipse cx="16" cy="16" rx="5.4" ry="12.5" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="1.2"/>
  <path d="M3.8 12.2h24.4M3.8 19.8h24.4" stroke="rgba(255,255,255,.16)" stroke-width="1.2"/>
  <path d="M16 3.5a12.5 12.5 0 0 1 12.5 12.5" fill="none" stroke="url(#sw-g)" stroke-width="2.4" stroke-linecap="round"/>
  <circle cx="22.6" cy="9.4" r="2.1" fill="#2af5a8"/>
</svg>`;
