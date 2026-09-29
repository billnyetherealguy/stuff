// Procedural building facades for close-ups: real-looking materials (concrete,
// brick, glass curtain wall, stone) with window grids, drawn in three lighting
// phases that follow the real sun: day (sky reflected in the glass), golden hour,
// and night (dark walls, some rooms lit with a soft glow spilling out).
// Drawn once into pixel buffers and handed to MapLibre as fill-extrusion patterns.

export const FACADE_IDS = ['facade-0', 'facade-1', 'facade-2', 'facade-3'];

// cols/rows = window grid per tile; frame = window size share of its cell
const MATERIALS = [
  { name: 'concrete', wall: [168, 164, 156], cols: 8, rows: 8, frameX: 0.62, frameY: 0.55, lit: 0.34, grain: 14 }, // offices
  { name: 'brick', wall: [150, 78, 58], cols: 6, rows: 8, frameX: 0.5, frameY: 0.52, lit: 0.44, grain: 10, bricks: true }, // homes
  { name: 'glass', wall: [96, 112, 128], cols: 12, rows: 10, frameX: 0.9, frameY: 0.82, lit: 0.24, grain: 4, curtain: true }, // towers
  { name: 'stone', wall: [190, 176, 150], cols: 10, rows: 8, frameX: 0.46, frameY: 0.56, lit: 0.2, grain: 18 }, // classic/mixed
];

const WARM = [[255, 206, 138], [255, 226, 176], [255, 188, 110]];
const COOL = [[196, 222, 255], [236, 244, 255]];

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const scale = (c, k) => c.map((v) => v * k);

/** Returns { width, height, data } (RGBA) for one facade id in a lighting phase. */
export function facadeImage(id, phase = 'night', size = 128) {
  const index = Math.max(0, FACADE_IDS.indexOf(id));
  const m = MATERIALS[index];
  const rand = rng(0x9e3779b9 * (index + 1)); // same windows lit in every phase
  const px = new Float32Array(size * size * 3);
  const set = (x, y, c) => {
    const i = (y * size + x) * 3;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
  };
  const add = (x, y, c, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 3;
    px[i] += c[0] * a;
    px[i + 1] += c[1] * a;
    px[i + 2] += c[2] * a;
  };

  // Light on the walls for this phase.
  const wallLight = { day: 1, dusk: 0.62, night: 0.16 }[phase];
  const wallTint = { day: [1, 1, 1], dusk: [1.12, 0.9, 0.74], night: [0.62, 0.72, 1] }[phase];
  const wall = m.wall.map((v, i) => v * wallLight * wallTint[i]);

  // 1. Wall material.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let c = wall.map((v) => v + (rand() - 0.5) * m.grain * wallLight);
      if (m.bricks) {
        const row = Math.floor(y / 3);
        const offset = row % 2 ? 3 : 0;
        const mortar = y % 3 === 2 || (x + offset) % 6 === 5;
        c = mortar ? scale(c, 1.25) : scale(c, 0.9 + ((row * 7 + Math.floor((x + offset) / 6) * 13) % 5) * 0.04);
      }
      set(x, y, c);
    }
  }

  // 2. Windows.
  const cw = size / m.cols;
  const rh = size / m.rows;
  const winW = Math.max(2, Math.round(cw * m.frameX));
  const winH = Math.max(2, Math.round(rh * m.frameY));
  const glows = [];
  for (let r = 0; r < m.rows; r++) {
    for (let c = 0; c < m.cols; c++) {
      const on = rand() < m.lit;
      const tone = rand() < 0.75 ? WARM[Math.floor(rand() * WARM.length)] : COOL[Math.floor(rand() * COOL.length)];
      const dim = 0.72 + rand() * 0.28;
      const blind = rand(); // curtains/blinds vary how much light gets out
      const x0 = Math.round(c * cw + (cw - winW) / 2);
      const y0 = Math.round(r * rh + (rh - winH) / 2);
      for (let y = y0; y < y0 + winH; y++) {
        const v = (y - y0) / winH; // 0 top .. 1 bottom
        for (let x = x0; x < x0 + winW; x++) {
          let col;
          if (phase === 'day') {
            // Sky reflection: brighter at the top of each pane, a diagonal glint.
            const glint = ((x - x0 + (y - y0)) % 9 === 0 ? 26 : 0) * (m.curtain ? 1 : 0.5);
            col = mix([150, 184, 214], [58, 76, 96], v).map((q) => q + glint);
          } else if (phase === 'dusk') {
            col = on ? scale(tone, 0.8 * dim) : mix([232, 160, 108], [70, 60, 72], v);
          } else {
            col = on ? scale(tone, dim * (1 - v * 0.3) * (0.75 + blind * 0.25)) : mix([22, 28, 44], [10, 12, 20], v);
          }
          set(x, y, col);
        }
      }
      // Frame / sill line under each window.
      const sill = phase === 'day' ? scale(m.wall, 1.15) : scale(wall, 1.3);
      for (let x = x0 - 1; x <= x0 + winW; x++) if (x >= 0 && x < size && y0 + winH < size) set(x, y0 + winH, sill);
      if (on && phase !== 'day') glows.push({ x: x0 + winW / 2, y: y0 + winH / 2, w: winW, h: winH, tone, k: dim });
    }
  }

  // 3. Curtain wall: mullions and floor spandrels.
  if (m.curtain) {
    const line = phase === 'day' ? [70, 84, 98] : scale(wall, 0.7);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x += Math.round(cw)) set(x, y, line);
    for (let y = 0; y < size; y += Math.round(rh)) for (let x = 0; x < size; x++) set(x, y, line);
  }

  // 4. Night/dusk: light spilling out of lit rooms onto the wall around them.
  if (glows.length) {
    const strength = phase === 'night' ? 0.34 : 0.16;
    for (const g of glows) {
      const rx = g.w * 1.3;
      const ry = g.h * 1.3;
      for (let y = Math.floor(g.y - ry); y <= g.y + ry; y++) {
        for (let x = Math.floor(g.x - rx); x <= g.x + rx; x++) {
          const d = Math.hypot((x - g.x) / rx, (y - g.y) / ry);
          if (d < 1) add(((x % size) + size) % size, ((y % size) + size) % size, g.tone, strength * g.k * (1 - d) ** 2);
        }
      }
    }
  }

  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) {
    data[j] = px[i];
    data[j + 1] = px[i + 1];
    data[j + 2] = px[i + 2];
    data[j + 3] = 255;
  }
  return { width: size, height: size, data };
}
