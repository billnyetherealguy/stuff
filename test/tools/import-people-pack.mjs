// Imports the Low-Poly People pack (FBX → glTF via FBX2glTF) into Solworld's
// pedestrian models: one .glb per person and outfit, real size, +Y up,
// +Z forward, feet at the origin, dressed in flat colors (the pack only ships
// a blueprint grid texture): skin, hair, top, bottoms and shoes, split by
// height on the body.
//
//   FBX2glTF --binary --input temp_export.fbx --output people
//   node test/tools/import-people-pack.mjs people.glb solworld/assets/models [outfits=2]

import fs from 'node:fs';
import path from 'node:path';
import { NodeIO, Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptEncoder } from 'meshoptimizer';
import { quantize, meshopt } from '@gltf-transform/functions';

const [src, outDir, outfitsArg] = process.argv.slice(2);
const OUTFITS = Number(outfitsArg) || 2;
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(rand() * a.length)];
const hex = (h) => [1, 3, 5].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255) ** 2.2).concat(1); // sRGB → linear

const SKIN = ['#f1c7a5', '#e0ac85', '#c68863', '#9c6644', '#6f4630', '#4a2e21'];
const HAIR = ['#1b1512', '#3a2618', '#5a3a22', '#8a6a3f', '#c9a36b', '#6d6d6d', '#101010'];
const TOPS = ['#1f2a44', '#8c1c24', '#f2f2f2', '#2e5e3a', '#d8a31a', '#5b2b6e', '#141414', '#c65b28', '#3f6fb5', '#9aa3ad', '#e7d7c1', '#b8475a'];
const BOTTOMS = ['#1d2433', '#2b2b2b', '#3b4a63', '#6b5842', '#c7bba6', '#101318', '#4a4f55'];
const SHOES = ['#111111', '#f4f4f4', '#5a3a24', '#2a2f3a'];

/** Body part for a triangle from how high it sits (0 = soles, 1 = top of head). */
const partAt = (h) => (h < 0.05 ? 'shoes' : h < 0.46 ? 'bottoms' : h < 0.82 ? 'top' : h < 0.93 ? 'skin' : 'hair');

const base = await io.read(src);
const people = base.getRoot().listScenes()[0].listChildren()[0].listChildren().filter((n) => /^(Man|Woman)\d+$/.test(n.getName()));
const made = [];
for (const node of people) {
  const m = node.getWorldMatrix();
  const prim = node.getMesh().listPrimitives()[0];
  const P = prim.getAttribute('POSITION');
  const idx = prim.getIndices();
  // World positions (meters, Y up).
  const pos = [];
  const v = [0, 0, 0];
  for (let i = 0; i < P.getCount(); i++) {
    P.getElement(i, v);
    pos.push([m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]]);
  }
  const ys = pos.map((p) => p[1]);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const height = maxY - minY;
  if (height < 1.45) continue; // sitting figures: not walkers
  const cx = pos.reduce((s, p) => s + p[0], 0) / pos.length;
  const cz = pos.reduce((s, p) => s + p[2], 0) / pos.length;
  // Triangles into parts, flat-shaded (un-indexed, one normal per face).
  const tris = { shoes: [], bottoms: [], top: [], skin: [], hair: [] };
  const I = idx ? idx.getArray() : [...Array(P.getCount()).keys()];
  for (let t = 0; t < I.length; t += 3) {
    const a = pos[I[t]];
    const b = pos[I[t + 1]];
    const c = pos[I[t + 2]];
    const h = ((a[1] + b[1] + c[1]) / 3 - minY) / height;
    tris[partAt(h)].push(a, b, c);
  }
  for (let o = 0; o < OUTFITS; o++) {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const colors = { skin: pick(SKIN), hair: pick(HAIR), top: pick(TOPS), bottoms: pick(BOTTOMS), shoes: pick(SHOES) };
    const mesh = doc.createMesh(node.getName());
    for (const [part, list] of Object.entries(tris)) {
      if (!list.length) continue;
      const P2 = new Float32Array(list.length * 3);
      const N2 = new Float32Array(list.length * 3);
      for (let i = 0; i < list.length; i += 3) {
        const tri = list.slice(i, i + 3).map((p) => [p[0] - cx, p[1] - minY, p[2] - cz]);
        const u = tri[1].map((x, k) => x - tri[0][k]);
        const w = tri[2].map((x, k) => x - tri[0][k]);
        let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const len = Math.hypot(...n) || 1;
        n = n.map((x) => x / len);
        for (let k = 0; k < 3; k++) {
          P2.set(tri[k], (i + k) * 3);
          N2.set(n, (i + k) * 3);
        }
      }
      const mat = doc.createMaterial(part).setBaseColorFactor(hex(colors[part])).setRoughnessFactor(part === 'hair' ? 0.6 : 0.85).setMetallicFactor(0);
      mesh.addPrimitive(
        doc
          .createPrimitive()
          .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(P2).setBuffer(buffer))
          .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(N2).setBuffer(buffer))
          .setMaterial(mat),
      );
    }
    const file = `walker-${made.length}.glb`;
    doc.createScene().addChild(doc.createNode(node.getName()).setMesh(mesh));
    await doc.transform(quantize(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    fs.writeFileSync(path.join(outDir, file), await io.writeBinary(doc));
    made.push({ file, from: node.getName(), height: +height.toFixed(2), colors });
  }
}
console.log(JSON.stringify(made.map((x) => `${x.file} ${x.from} ${x.height}m`)));
