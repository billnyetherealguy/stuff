// Procedural night-time facades for close-up buildings: a dark wall with rows
// of windows, some lit. Drawn once into a canvas and handed to MapLibre as
// fill-extrusion patterns (no image downloads).

export const FACADE_IDS = ['facade-0', 'facade-1', 'facade-2', 'facade-3'];

// wall, glass, lit colors, share of lit windows, columns, rows
const STYLES = [
  { wall: [26, 28, 34], glass: [12, 16, 26], lit: [[255, 214, 150], [255, 236, 200]], share: 0.32, cols: 8, rows: 8 }, // offices
  { wall: [30, 27, 25], glass: [16, 14, 13], lit: [[255, 196, 120], [255, 170, 90]], share: 0.42, cols: 6, rows: 8 }, // homes
  { wall: [16, 22, 32], glass: [20, 32, 52], lit: [[190, 220, 255], [230, 240, 255]], share: 0.22, cols: 12, rows: 10 }, // glass towers
  { wall: [22, 23, 26], glass: [10, 11, 14], lit: [[255, 222, 170], [210, 225, 255]], share: 0.18, cols: 10, rows: 8 }, // mixed
];

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Returns { width, height, data } (RGBA) for one facade id. */
export function facadeImage(id, size = 128) {
  const index = Math.max(0, FACADE_IDS.indexOf(id));
  const st = STYLES[index];
  const rand = rng(0x9e3779b9 * (index + 1));
  const data = new Uint8ClampedArray(size * size * 4);
  const put = (x, y, [r, g, b], a = 255) => {
    const i = (y * size + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = (rand() - 0.5) * 6;
      put(x, y, st.wall.map((c) => c + n));
    }
  }
  const cw = size / st.cols;
  const rh = size / st.rows;
  const padX = Math.max(2, Math.round(cw * 0.3));
  const padY = Math.max(2, Math.round(rh * 0.34));
  for (let r = 0; r < st.rows; r++) {
    for (let c = 0; c < st.cols; c++) {
      const lit = rand() < st.share;
      const color = lit ? st.lit[rand() < 0.7 ? 0 : 1] : st.glass;
      const dim = lit ? 0.7 + rand() * 0.3 : 1;
      const x0 = Math.round(c * cw + padX / 2);
      const x1 = Math.round((c + 1) * cw - padX / 2);
      const y0 = Math.round(r * rh + padY / 2);
      const y1 = Math.round((r + 1) * rh - padY / 2);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          // a soft vertical falloff makes lit windows read as rooms, not pixels
          const t = lit ? 1 - ((y - y0) / Math.max(1, y1 - y0)) * 0.35 : 1;
          put(x, y, color.map((v) => v * dim * t));
        }
      }
    }
  }
  return { width: size, height: size, data };
}
