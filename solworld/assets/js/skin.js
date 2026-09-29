// Turns a real photo of a building into a texture for its 3D walls: the
// facade is cropped out of the photo (dropping sky and street), and after dark
// the lit windows glow (a bloom from the photo's own bright spots for night
// photos, or a soft window-light overlay on a darkened day photo).

const SIZE = 256;

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // needed to read pixels; Wikimedia allows it
    img.referrerPolicy = 'no-referrer';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('photo failed to load'));
    img.src = url;
  });
}

/** Soft blur without ctx.filter (Safari): shrink, then scale back up smoothly. */
function softBlur(source, factor = 10) {
  const small = canvas(Math.max(2, Math.round(source.width / factor)), Math.max(2, Math.round(source.height / factor)));
  const sctx = small.getContext('2d');
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(source, 0, 0, small.width, small.height);
  const out = canvas(source.width, source.height);
  const octx = out.getContext('2d');
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(small, 0, 0, out.width, out.height);
  return out;
}

/**
 * @param url      a CORS-enabled image URL
 * @param phase    'day' | 'dusk' | 'night' at the building right now
 * @param nightPhoto  whether the photo itself was taken at night
 * @returns ImageData-like { width, height, data }
 */
export async function buildingSkin(url, { phase = 'day', nightPhoto = false } = {}) {
  const img = await loadImage(url);
  const c = canvas(SIZE, SIZE);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  // Most building photos have sky on top and street at the bottom: keep the middle.
  const sx = img.naturalWidth * 0.16;
  const sy = img.naturalHeight * 0.14;
  ctx.drawImage(img, sx, sy, img.naturalWidth * 0.68, img.naturalHeight * 0.72, 0, 0, SIZE, SIZE);
  let pixels = ctx.getImageData(0, 0, SIZE, SIZE); // throws if the photo isn't CORS-readable

  const dark = phase !== 'day';
  if (dark && !nightPhoto) {
    // A day photo shown at night: darken and cool it down…
    const d = pixels.data;
    const k = phase === 'night' ? 0.34 : 0.62;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i] * k * 0.9;
      d[i + 1] = d[i + 1] * k * 0.95;
      d[i + 2] = Math.min(255, d[i + 2] * k * 1.15 + 6);
    }
    ctx.putImageData(pixels, 0, 0);
    // …then light some windows: a warm glow over a grid of window spots.
    let seed = url.length * 7919 + 17;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const cols = 10;
    const rows = 12;
    ctx.globalCompositeOperation = 'screen';
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        if (rnd() > (phase === 'night' ? 0.3 : 0.16)) continue;
        const x = ((col + 0.5) / cols) * SIZE;
        const y = ((r + 0.5) / rows) * SIZE;
        const warm = rnd() < 0.78;
        const g = ctx.createRadialGradient(x, y, 0, x, y, 11);
        g.addColorStop(0, warm ? 'rgba(255,214,150,0.95)' : 'rgba(210,228,255,0.9)');
        g.addColorStop(0.35, warm ? 'rgba(255,180,100,0.45)' : 'rgba(170,200,255,0.4)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - 11, y - 11, 22, 22);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  if (dark) {
    // Bloom: the brightest spots (lit windows, signs) glow softly into their surroundings.
    const bright = canvas(SIZE, SIZE);
    const bctx = bright.getContext('2d');
    const src = ctx.getImageData(0, 0, SIZE, SIZE);
    const d = src.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const keep = lum > 150 ? Math.min(1, (lum - 150) / 60) : 0;
      d[i] *= keep;
      d[i + 1] *= keep;
      d[i + 2] *= keep;
    }
    bctx.putImageData(src, 0, 0);
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.9;
    ctx.drawImage(softBlur(bright, 8), 0, 0);
    ctx.globalAlpha = 0.6;
    ctx.drawImage(softBlur(bright, 24), 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  pixels = ctx.getImageData(0, 0, SIZE, SIZE);
  return { width: SIZE, height: SIZE, data: new Uint8Array(pixels.data.buffer.slice(0)) };
}
