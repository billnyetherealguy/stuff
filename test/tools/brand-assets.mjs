// Renders solworld/og.png (social preview) and solworld/icon-512.png.
// Usage: NODE_USE_ENV_PROXY=1 node tools/brand-assets.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { geoOrthographic, geoPath, geoGraticule10 } from 'd3-geo';
import * as topojson from 'topojson-client';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '..', '..', 'solworld');
const land = require('world-atlas/land-110m.json');
const countries = require('world-atlas/countries-110m.json');

function globeSvg(size, rotate) {
  const r = size / 2 - 6;
  const projection = geoOrthographic().rotate(rotate).translate([size / 2, size / 2]).scale(r).clipAngle(90);
  const path = geoPath(projection);
  const landPath = path(topojson.feature(land, land.objects.land));
  const borders = path(topojson.mesh(countries, countries.objects.countries, (a, b) => a !== b));
  const grat = path(geoGraticule10());
  const lights = [
    [-74.0, 40.71, 'v'], [-0.13, 51.5, 'v'], [2.35, 48.86, 'm'], [55.27, 25.2, 'v'], [-122.42, 37.77, 'm'], [-87.63, 41.88, 'v'],
    [-99.13, 19.43, 'm'], [-46.63, -23.55, 'v'], [-58.38, -34.6, 'm'], [-43.17, -22.9, 'v'], [13.4, 52.52, 'm'], [12.5, 41.9, 'v'],
    [-3.7, 40.42, 'v'], [-79.38, 43.65, 'm'], [-118.24, 34.05, 'v'], [-80.19, 25.76, 'm'], [18.42, -33.92, 'v'], [3.38, 6.52, 'm'],
    [31.24, 30.04, 'v'], [-9.14, 38.72, 'm'], [-73.57, 45.5, 'v'], [-77.04, -12.05, 'm'], [-70.67, -33.45, 'v'], [-66.9, 10.48, 'm'],
  ]
    .map(([lng, lat, c]) => {
      const p = projection([lng, lat]);
      const visible = geoPath(projection)({ type: 'Point', coordinates: [lng, lat] });
      if (!p || !visible) return '';
      const col = c === 'v' ? '#9b7bff' : '#2af5a8';
      return `<circle cx="${p[0]}" cy="${p[1]}" r="${size / 55}" fill="${col}" opacity=".35" filter="url(#blur)"/><circle cx="${p[0]}" cy="${p[1]}" r="${size / 260}" fill="#fff"/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs>
      <radialGradient id="sea" cx="38%" cy="32%" r="75%"><stop offset="0" stop-color="#0b0e16"/><stop offset="1" stop-color="#020306"/></radialGradient>
      <radialGradient id="rim" cx="50%" cy="50%" r="50%"><stop offset=".86" stop-color="#6f86ff" stop-opacity="0"/><stop offset=".965" stop-color="#8fb0ff" stop-opacity=".38"/><stop offset="1" stop-color="#c9dcff" stop-opacity="0"/></radialGradient>
      <filter id="blur" x="-2" y="-2" width="5" height="5"><feGaussianBlur stdDeviation="${size / 110}"/></filter>
    </defs>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="url(#sea)"/>
    <path d="${grat}" fill="none" stroke="#ffffff" stroke-opacity=".035" stroke-width="1"/>
    <path d="${landPath}" fill="#11141b" stroke="#2a2f3a" stroke-width="${size / 900}"/>
    <path d="${borders}" fill="none" stroke="#2c313b" stroke-width="${size / 1100}"/>
    ${lights}
    <circle cx="${size / 2}" cy="${size / 2}" r="${r + 5}" fill="url(#rim)"/>
  </svg>`;
}

const og = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap">
<style>
  html,body{margin:0;background:#000;width:1200px;height:630px;overflow:hidden;font-family:Geist,system-ui,sans-serif;color:#f3f4f6}
  .bg{position:absolute;inset:0;background:radial-gradient(ellipse 60% 70% at 78% 55%,rgba(60,40,160,.28),transparent 70%),radial-gradient(ellipse 40% 40% at 10% 100%,rgba(42,245,168,.08),transparent 70%)}
  .globe{position:absolute;right:-70px;top:25px}
  .copy{position:absolute;left:72px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;width:640px}
  .brand{display:flex;align-items:center;gap:14px;font-weight:600;letter-spacing:.36em;font-size:22px}
  h1{font-size:72px;line-height:.98;letter-spacing:-.048em;font-weight:600;margin:34px 0 24px}
  .g{background:linear-gradient(95deg,#b39cff 0%,#8f6bff 22%,#2af5a8 70%,#5ad1ff 100%);-webkit-background-clip:text;color:transparent}
  p{font-size:24px;color:#a9afba;margin:0;line-height:1.45}
  p b{color:#fff;font-weight:600}
</style></head><body><div class="bg"></div>
<div class="globe">${globeSvg(640, [72, -18, 0])}</div>
<div class="copy">
  <div class="brand">${fs.readFileSync(path.join(SITE, 'favicon.svg'), 'utf8').replace('<svg ', '<svg width="44" height="44" ')}SOLWORLD</div>
  <h1>Every building on Earth.<br><span class="g">Own it on Solana.</span></h1>
  <p>Tap any building, see who owns it, make it yours.<br><b>Hold 0.2 SOL</b> and your first one is free.</p>
</div></body></html>`;

const icon = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000;width:512px;height:512px}</style></head><body>
${fs.readFileSync(path.join(SITE, 'favicon.svg'), 'utf8').replace('<svg ', '<svg width="512" height="512" ')}</body></html>`;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.route(/fonts\.(googleapis|gstatic)\.com/, async (route) => {
  try {
    const res = await fetch(route.request().url(), { headers: { 'user-agent': 'Mozilla/5.0 Chrome/140' } });
    await route.fulfill({ status: res.status, contentType: res.headers.get('content-type') || undefined, body: Buffer.from(await res.arrayBuffer()) });
  } catch {
    await route.abort();
  }
});
await page.goto('about:blank');
await page.setContent(og, { waitUntil: 'networkidle' });
await page.evaluate(async () => {
  await document.fonts.load('600 72px Geist');
  await document.fonts.ready;
});
const fontOk = await page.evaluate(() => document.fonts.check('600 72px Geist'));
console.log('Geist loaded:', fontOk);
await page.screenshot({ path: path.join(SITE, 'og.png') });
await page.setViewportSize({ width: 512, height: 512 });
await page.setContent(icon);
await page.screenshot({ path: path.join(SITE, 'icon-512.png'), omitBackground: false });
await browser.close();
console.log('wrote og.png and icon-512.png');
