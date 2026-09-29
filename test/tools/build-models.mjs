// Generates Solworld's own (license-free) low-poly 3D models for street life:
// cars (sedan, SUV, van, yellow cab) with glass, wheels and emissive lights,
// and people with a looping walk animation. Output: solworld/assets/models/*.glb
//
//   node tools/build-models.mjs
//
// glTF conventions: meters, +Y up, +Z forward (Cesium turns +Z into its heading).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', '..', 'solworld', 'assets', 'models');
fs.mkdirSync(OUT, { recursive: true });

/* ----------------------------------------------------------- geometry */

// Axis-aligned box centered at (cx, cy, cz) with size (sx, sy, sz); per-face normals.
function box([cx, cy, cz], [sx, sy, sz], taper = 0) {
  const x = sx / 2;
  const y = sy / 2;
  const z = sz / 2;
  // taper narrows the top face (for cabins / roofs)
  const t = taper;
  const faces = [
    [[1, 0, 0], [[x - t, y, -z + t], [x - t, y, z - t], [x, -y, z], [x, -y, -z]]],
    [[-1, 0, 0], [[-x + t, y, z - t], [-x + t, y, -z + t], [-x, -y, -z], [-x, -y, z]]],
    [[0, 1, 0], [[-x + t, y, -z + t], [-x + t, y, z - t], [x - t, y, z - t], [x - t, y, -z + t]]],
    [[0, -1, 0], [[-x, -y, z], [-x, -y, -z], [x, -y, -z], [x, -y, z]]],
    [[0, 0, 1], [[-x + t, y, z - t], [x - t, y, z - t], [x, -y, z], [-x, -y, z]]],
    [[0, 0, -1], [[x - t, y, -z + t], [-x + t, y, -z + t], [-x, -y, -z], [x, -y, -z]]],
  ];
  const pos = [];
  const nor = [];
  const idx = [];
  for (const [n, quad] of faces) {
    const b = pos.length / 3;
    for (const [px, py, pz] of quad) {
      pos.push(px + cx, py + cy, pz + cz);
      nor.push(...n);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  return fixWinding({ pos, nor, idx });
}

// Cylinder along X (wheels), centered at c.
function cylinderX([cx, cy, cz], radius, width, seg = 14) {
  const pos = [];
  const nor = [];
  const idx = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const [y0, z0, y1, z1] = [Math.cos(a0), Math.sin(a0), Math.cos(a1), Math.sin(a1)];
    const b = pos.length / 3;
    for (const [s, yy, zz] of [[-1, y0, z0], [1, y0, z0], [1, y1, z1], [-1, y1, z1]]) {
      pos.push(cx + (s * width) / 2, cy + yy * radius, cz + zz * radius);
      nor.push(0, yy, zz);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    for (const s of [-1, 1]) {
      const c = pos.length / 3;
      pos.push(cx + (s * width) / 2, cy, cz, cx + (s * width) / 2, cy + y0 * radius, cz + z0 * radius, cx + (s * width) / 2, cy + y1 * radius, cz + z1 * radius);
      nor.push(s, 0, 0, s, 0, 0, s, 0, 0);
      idx.push(c, c + 1, c + 2);
    }
  }
  return fixWinding({ pos, nor, idx });
}

// Make every triangle face along its normal (so back-face culling is safe).
function fixWinding(g) {
  const { pos, nor, idx } = g;
  for (let i = 0; i < idx.length; i += 3) {
    const [a, b, c] = [idx[i], idx[i + 1], idx[i + 2]];
    const p = (k) => [pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]];
    const [A, B, C] = [p(a), p(b), p(c)];
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const want = [nor[a * 3] + nor[b * 3] + nor[c * 3], nor[a * 3 + 1] + nor[b * 3 + 1] + nor[c * 3 + 1], nor[a * 3 + 2] + nor[b * 3 + 2] + nor[c * 3 + 2]];
    if (n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0) {
      idx[i + 1] = c;
      idx[i + 2] = b;
    }
  }
  return g;
}

function merge(...gs) {
  const out = { pos: [], nor: [], idx: [] };
  for (const g of gs) {
    const b = out.pos.length / 3;
    out.pos.push(...g.pos);
    out.nor.push(...g.nor);
    out.idx.push(...g.idx.map((i) => i + b));
  }
  return out;
}

/* ---------------------------------------------------------------- glb */

const mat = (color, { metal = 0, rough = 0.8, emissive = null, alpha = 1 } = {}) => ({
  pbrMetallicRoughness: { baseColorFactor: [...color, alpha], metallicFactor: metal, roughnessFactor: rough },
  ...(emissive ? { emissiveFactor: emissive } : {}),
  ...(alpha < 1 ? { alphaMode: 'BLEND' } : {}),
});
const hex = (h) => [1, 3, 5].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255) ** 2.2); // sRGB → linear

/**
 * parts: [{ geom, material, node?: { name, translation } }]
 * animation: [{ node: name, times: [...], rotations: [[x,y,z,w], ...] }]
 */
function writeGlb(file, parts, animations = []) {
  const chunks = [];
  let offset = 0;
  const views = [];
  const accessors = [];
  const push = (buf, target) => {
    const pad = (4 - (buf.length % 4)) % 4;
    chunks.push(buf, Buffer.alloc(pad));
    views.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, ...(target ? { target } : {}) });
    offset += buf.length + pad;
    return views.length - 1;
  };
  const materials = [];
  const matIndex = new Map();
  const meshes = [];
  const nodes = [{ name: 'root', children: [] }];
  const nodeByName = new Map();
  for (const part of parts) {
    const key = JSON.stringify(part.material);
    if (!matIndex.has(key)) {
      matIndex.set(key, materials.length);
      materials.push(part.material);
    }
    const { pos, nor, idx } = part.geom;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let j = 0; j < 3; j++) {
      min[j] = Math.min(min[j], pos[i + j]);
      max[j] = Math.max(max[j], pos[i + j]);
    }
    accessors.push({ bufferView: push(Buffer.from(new Float32Array(pos).buffer), 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
    const aPos = accessors.length - 1;
    accessors.push({ bufferView: push(Buffer.from(new Float32Array(nor).buffer), 34962), componentType: 5126, count: nor.length / 3, type: 'VEC3' });
    const aNor = accessors.length - 1;
    accessors.push({ bufferView: push(Buffer.from(new Uint16Array(idx).buffer), 34963), componentType: 5123, count: idx.length, type: 'SCALAR' });
    const aIdx = accessors.length - 1;
    meshes.push({ primitives: [{ attributes: { POSITION: aPos, NORMAL: aNor }, indices: aIdx, material: matIndex.get(key) }] });
    const nodeName = part.node?.name;
    if (nodeName) {
      let ni = nodeByName.get(nodeName);
      if (ni == null) {
        ni = nodes.length;
        nodes.push({ name: nodeName, translation: part.node.translation || [0, 0, 0], children: [] });
        nodeByName.set(nodeName, ni);
        nodes[0].children.push(ni);
      }
      nodes.push({ mesh: meshes.length - 1 });
      nodes[ni].children.push(nodes.length - 1);
    } else {
      nodes.push({ mesh: meshes.length - 1 });
      nodes[0].children.push(nodes.length - 1);
    }
  }
  for (const n of nodes) if (n.children && !n.children.length) delete n.children;
  const gltfAnims = [];
  if (animations.length) {
    const channels = [];
    const samplers = [];
    for (const a of animations) {
      accessors.push({ bufferView: push(Buffer.from(new Float32Array(a.times).buffer)), componentType: 5126, count: a.times.length, type: 'SCALAR', min: [a.times[0]], max: [a.times.at(-1)] });
      const input = accessors.length - 1;
      accessors.push({ bufferView: push(Buffer.from(new Float32Array(a.rotations.flat()).buffer)), componentType: 5126, count: a.rotations.length, type: 'VEC4' });
      samplers.push({ input, output: accessors.length - 1, interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: nodeByName.get(a.node), path: 'rotation' } });
    }
    gltfAnims.push({ name: 'walk', channels, samplers });
  }
  const bin = Buffer.concat(chunks);
  const json = {
    asset: { version: '2.0', generator: 'solworld build-models', copyright: 'Solworld — free to use (CC0)' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    meshes,
    materials,
    buffers: [{ byteLength: bin.length }],
    bufferViews: views,
    accessors,
    ...(gltfAnims.length ? { animations: gltfAnims } : {}),
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonBuf.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  const glb = Buffer.concat([header, jh, jsonBuf, bh, bin]);
  fs.writeFileSync(path.join(OUT, file), glb);
  return glb.length;
}

/* --------------------------------------------------------------- cars */

const GLASS = mat(hex('#1b2530'), { metal: 0.2, rough: 0.08 });
const TIRE = mat(hex('#141414'), { rough: 0.95 });
const RIM = mat(hex('#b9bcc2'), { metal: 0.9, rough: 0.3 });
const HEAD = mat(hex('#fff6dc'), { emissive: [1, 0.95, 0.8] });
const TAIL = mat(hex('#c0120c'), { emissive: [0.9, 0.05, 0.02] });
const TRIM = mat(hex('#202225'), { rough: 0.6 });

function car({ length, width, bodyH, cabinH, cabinLen, cabinOffset = 0, ground = 0.32, paint, wheelR = 0.33, sign = false }) {
  const body = mat(hex(paint), { metal: 0.55, rough: 0.32 });
  const L = length;
  const W = width;
  const parts = [
    { geom: box([0, ground + bodyH / 2, 0], [W, bodyH, L], 0.04), material: body },
    // cabin: glass box slightly narrower, tapered roof, with a painted roof on top
    { geom: box([0, ground + bodyH + cabinH / 2, cabinOffset], [W * 0.9, cabinH, cabinLen], 0.14), material: GLASS },
    { geom: box([0, ground + bodyH + cabinH + 0.02, cabinOffset], [W * 0.78, 0.04, cabinLen - 0.34]), material: body },
    // bumpers
    { geom: box([0, ground + 0.12, L / 2 + 0.03], [W * 0.96, 0.18, 0.08]), material: TRIM },
    { geom: box([0, ground + 0.12, -L / 2 - 0.03], [W * 0.96, 0.18, 0.08]), material: TRIM },
    // lights
    { geom: box([W * 0.34, ground + bodyH * 0.72, L / 2 + 0.005], [0.26, 0.1, 0.02]), material: HEAD },
    { geom: box([-W * 0.34, ground + bodyH * 0.72, L / 2 + 0.005], [0.26, 0.1, 0.02]), material: HEAD },
    { geom: box([W * 0.36, ground + bodyH * 0.75, -L / 2 - 0.005], [0.22, 0.1, 0.02]), material: TAIL },
    { geom: box([-W * 0.36, ground + bodyH * 0.75, -L / 2 - 0.005], [0.22, 0.1, 0.02]), material: TAIL },
  ];
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      const c = [sx * (W / 2 - 0.08), wheelR, sz * (L / 2 - 0.75)];
      parts.push({ geom: cylinderX(c, wheelR, 0.22), material: TIRE });
      parts.push({ geom: cylinderX([c[0] + sx * 0.115, c[1], c[2]], wheelR * 0.55, 0.01), material: RIM });
    }
  }
  if (sign) parts.push({ geom: box([0, ground + bodyH + cabinH + 0.14, cabinOffset], [0.5, 0.2, 0.18]), material: mat(hex('#fff3c4'), { emissive: [0.9, 0.8, 0.4] }) });
  return parts;
}

const sizes = {};
const PAINTS = ['#e9e9ec', '#16181c', '#8f959e', '#23324d', '#7c1c20', '#3d4652'];
PAINTS.forEach((paint, i) => {
  sizes[`sedan-${i}`] = writeGlb(`sedan-${i}.glb`, car({ length: 4.6, width: 1.85, bodyH: 0.62, cabinH: 0.5, cabinLen: 2.4, cabinOffset: -0.15, paint }));
});
['#1d1f22', '#f1f1f3', '#51607a'].forEach((paint, i) => {
  sizes[`suv-${i}`] = writeGlb(`suv-${i}.glb`, car({ length: 4.8, width: 1.95, bodyH: 0.8, cabinH: 0.62, cabinLen: 3.0, cabinOffset: -0.3, ground: 0.4, wheelR: 0.38, paint }));
});
sizes.taxi = writeGlb('taxi.glb', car({ length: 4.7, width: 1.85, bodyH: 0.64, cabinH: 0.5, cabinLen: 2.4, cabinOffset: -0.15, paint: '#f2b705', sign: true }));
sizes.van = writeGlb('van.glb', car({ length: 5.6, width: 2.0, bodyH: 1.35, cabinH: 0.55, cabinLen: 4.3, cabinOffset: -0.5, ground: 0.4, wheelR: 0.38, paint: '#eceff2' }));
sizes.bus = writeGlb('bus.glb', car({ length: 12, width: 2.55, bodyH: 1.1, cabinH: 1.2, cabinLen: 11.2, cabinOffset: 0, ground: 0.45, wheelR: 0.5, paint: '#2b5aa8' }));

/* ------------------------------------------------------------- people */

const SKIN = ['#f1c7a5', '#c68e62', '#8d5a3b', '#5a3825', '#e7b48f'];
const SHIRTS = ['#2e4a7a', '#8a2c2c', '#e8e4da', '#2d2d2d', '#3f6b45', '#b35d2c', '#6a4b8a', '#c9a24a'];
const PANTS = ['#1f2530', '#3b3b3b', '#556070', '#2a2a2a', '#6b5a45'];

const rotX = (deg) => {
  const r = (deg * Math.PI) / 360;
  return [Math.sin(r), 0, 0, Math.cos(r)];
};
const walk = (node, amp, phase = 0) => {
  const times = [0, 0.25, 0.5, 0.75, 1];
  const rotations = times.map((t) => rotX(amp * Math.sin((t + phase) * Math.PI * 2)));
  return { node, times, rotations };
};

for (let i = 0; i < 8; i++) {
  const skin = mat(hex(SKIN[i % SKIN.length]), { rough: 0.7 });
  const shirt = mat(hex(SHIRTS[i % SHIRTS.length]), { rough: 0.9 });
  const pants = mat(hex(PANTS[(i * 3) % PANTS.length]), { rough: 0.9 });
  const shoes = mat(hex('#1a1a1a'), { rough: 0.6 });
  const hair = mat(hex(['#1b1310', '#3b2a1c', '#6b4a2b', '#c9b79a'][i % 4]), { rough: 0.9 });
  const h = 1.62 + (i % 4) * 0.05; // height
  const hip = h * 0.53;
  const shoulder = h * 0.82;
  const parts = [
    { geom: box([0, (hip + shoulder) / 2, 0], [0.4, shoulder - hip, 0.22], 0.02), material: shirt },
    { geom: box([0, shoulder + 0.05, 0], [0.12, 0.1, 0.12]), material: skin }, // neck
    { geom: box([0, shoulder + 0.2, 0.01], [0.2, 0.24, 0.22], 0.02), material: skin }, // head
    { geom: box([0, shoulder + 0.33, -0.01], [0.21, 0.05, 0.23]), material: hair },
    // legs: pivot at the hip, geometry hangs down
    { geom: box([0, -hip / 2 + 0.05, 0], [0.15, hip - 0.1, 0.16]), material: pants, node: { name: 'legL', translation: [0.1, hip, 0] } },
    { geom: box([0, -hip + 0.04, 0.04], [0.14, 0.08, 0.26]), material: shoes, node: { name: 'legL' } },
    { geom: box([0, -hip / 2 + 0.05, 0], [0.15, hip - 0.1, 0.16]), material: pants, node: { name: 'legR', translation: [-0.1, hip, 0] } },
    { geom: box([0, -hip + 0.04, 0.04], [0.14, 0.08, 0.26]), material: shoes, node: { name: 'legR' } },
    // arms: pivot at the shoulder
    { geom: box([0, -0.28, 0], [0.1, 0.56, 0.11]), material: shirt, node: { name: 'armL', translation: [0.26, shoulder - 0.03, 0] } },
    { geom: box([0, -0.6, 0], [0.09, 0.1, 0.1]), material: skin, node: { name: 'armL' } },
    { geom: box([0, -0.28, 0], [0.1, 0.56, 0.11]), material: shirt, node: { name: 'armR', translation: [-0.26, shoulder - 0.03, 0] } },
    { geom: box([0, -0.6, 0], [0.09, 0.1, 0.1]), material: skin, node: { name: 'armR' } },
  ];
  sizes[`person-${i}`] = writeGlb(`person-${i}.glb`, parts, [walk('legL', 28), walk('legR', 28, 0.5), walk('armL', 22, 0.5), walk('armR', 22)]);
}

fs.writeFileSync(path.join(OUT, 'LICENSE.txt'), 'Solworld street-life models (cars, people), generated by test/tools/build-models.mjs.\nDedicated to the public domain (CC0 1.0).\n');
console.log(Object.entries(sizes).map(([k, v]) => `${k} ${(v / 1024).toFixed(1)}KB`).join('\n'));
