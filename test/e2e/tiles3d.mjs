// A stand-in for Google Photorealistic 3D Tiles: the synthetic world's
// buildings around Midtown, extruded into one glTF (walls textured with a
// facade "photo", like photogrammetry), served as a 3D Tiles 1.1 tileset.
import zlib from 'node:zlib';

const A = 6378137;
const E2 = 6.69437999014e-3;
const ORIGIN = [-73.9794, 40.7527]; // between Grand Central and the Chrysler Building

function ecef(lng, lat, h = 0) {
  const l = (lng * Math.PI) / 180;
  const p = (lat * Math.PI) / 180;
  const n = A / Math.sqrt(1 - E2 * Math.sin(p) ** 2);
  return [(n + h) * Math.cos(p) * Math.cos(l), (n + h) * Math.cos(p) * Math.sin(l), (n * (1 - E2) + h) * Math.sin(p)];
}

function enuMatrix(lng, lat) {
  const l = (lng * Math.PI) / 180;
  const p = (lat * Math.PI) / 180;
  const east = [-Math.sin(l), Math.cos(l), 0];
  const north = [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)];
  const up = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
  const o = ecef(lng, lat);
  return [...east, 0, ...north, 0, ...up, 0, ...o, 1];
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) raw.set(pixel(x, y), y * (size * 3 + 1) + 1 + x * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Daytime facade photo: light stone, darker glass windows in a grid, like a real texture.
const FACADE = png(256, (x, y) => {
  const n = ((x * 7 + y * 13) % 11) - 5;
  const wx = x % 32;
  const wy = y % 32;
  if (wx > 8 && wx < 24 && wy > 6 && wy < 26) return [58 + n, 72 + n, 88 + n];
  return [188 + n, 176 + n, 156 + n];
});
const ROOF = png(64, (x, y) => {
  const n = ((x * 5 + y * 3) % 9) - 4;
  return [96 + n, 94 + n, 90 + n];
});

export function createTiles3d(world) {
  const [lng0, lat0] = ORIGIN;
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110_574;
  const local = ([lng, lat]) => [(lng - lng0) * kx, (lat - lat0) * ky];
  const pos = [];
  const uv = [];
  const idx = [];
  const roofPos = [];
  const roofUv = [];
  const roofIdx = [];
  for (const b of world.buildings) {
    const pts = b.ring.slice(0, -1).map(local);
    if (!pts.every(([x, y]) => Math.abs(x) < 450 && Math.abs(y) < 450)) continue;
    const h = parseFloat(b.tags.height) || (parseFloat(b.tags['building:levels']) || 1.4) * 3.66;
    let along = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      const len = Math.hypot(x1 - x0, y1 - y0);
      const base = pos.length / 3;
      // glTF is y-up: (east, up, -north)
      pos.push(x0, 0, -y0, x1, 0, -y1, x1, h, -y1, x0, h, -y0);
      uv.push(along / 12, h / 12, (along + len) / 12, h / 12, (along + len) / 12, 0, along / 12, 0);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      along += len;
    }
    const rb = roofPos.length / 3;
    for (const [x, y] of pts) {
      roofPos.push(x, h, -y);
      roofUv.push(x / 20, y / 20);
    }
    for (let i = 1; i < pts.length - 1; i++) roofIdx.push(rb, rb + i, rb + i + 1);
  }
  const glb = buildGlb([
    { pos, uv, idx, image: FACADE },
    { pos: roofPos, uv: roofUv, idx: roofIdx, image: ROOF },
  ]);
  const root = {
    asset: { version: '1.1' },
    geometricError: 800,
    root: {
      transform: enuMatrix(lng0, lat0),
      boundingVolume: { sphere: [0, 0, 150, 700] },
      geometricError: 0,
      refine: 'ADD',
      content: { uri: 'harness/city.glb' },
    },
  };
  return { rootJson: root, glb };
}

function buildGlb(meshes) {
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
  const primitives = [];
  const images = [];
  const textures = [];
  const materials = [];
  meshes.forEach((m, i) => {
    const P = Buffer.from(new Float32Array(m.pos).buffer);
    const T = Buffer.from(new Float32Array(m.uv).buffer);
    const I = Buffer.from(new Uint32Array(m.idx).buffer);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < m.pos.length; k += 3) for (let j = 0; j < 3; j++) {
      min[j] = Math.min(min[j], m.pos[k + j]);
      max[j] = Math.max(max[j], m.pos[k + j]);
    }
    accessors.push({ bufferView: push(P, 34962), componentType: 5126, count: m.pos.length / 3, type: 'VEC3', min, max });
    const aPos = accessors.length - 1;
    accessors.push({ bufferView: push(T, 34962), componentType: 5126, count: m.uv.length / 2, type: 'VEC2' });
    const aUv = accessors.length - 1;
    accessors.push({ bufferView: push(I, 34963), componentType: 5125, count: m.idx.length, type: 'SCALAR' });
    const aIdx = accessors.length - 1;
    images.push({ bufferView: push(m.image), mimeType: 'image/png' });
    textures.push({ source: i, sampler: 0 });
    materials.push({ pbrMetallicRoughness: { baseColorTexture: { index: i }, metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true, extensions: { KHR_materials_unlit: {} } });
    primitives.push({ attributes: { POSITION: aPos, TEXCOORD_0: aUv }, indices: aIdx, material: i });
  });
  const bin = Buffer.concat(chunks);
  const json = {
    asset: { version: '2.0', generator: 'solworld-harness' },
    extensionsUsed: ['KHR_materials_unlit'],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: views,
    accessors,
    images,
    textures,
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    materials,
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
  return Buffer.concat([header, jh, jsonBuf, bh, bin]);
}
