// Imports the Traffic Car Pack (FBX → glTF via FBX2glTF) into Solworld's car
// models: one .glb per car, real-world size, +Y up, +Z forward, origin at the
// ground under the middle of the car, with glowing head/tail lights.
//
//   FBX2glTF --binary --input TrafficCarPack.fbx --output pack
//   node test/tools/import-car-pack.mjs pack.glb textures/grill.jpg solworld/assets/models
//
// Needs @gltf-transform/{core,extensions,functions} and meshoptimizer. The
// grill texture is embedded as-is, so pass an already-small JPEG.

import fs from 'node:fs';
import path from 'node:path';
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMaterialsEmissiveStrength } from '@gltf-transform/extensions';
import { prune, dedup, weld, quantize, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

const [src, grillPath, outDir] = process.argv.slice(2);
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

const SKIP = /^(Shadow|Plane|Text|Ground)/;
const LENGTH = 4.45; // meters, a typical car
const MAX_WIDTH = 2.05; // stylized models run wide: cap it

// Which materials glow, and how.
const LAMPS = {
  LightW: { base: [1, 0.97, 0.9, 1], emissive: [1, 0.95, 0.82], strength: 4 },
  LightR: { base: [0.85, 0.02, 0.02, 1], emissive: [1, 0.04, 0.02], strength: 3 },
  LightO: { base: [1, 0.45, 0.05, 1], emissive: [1, 0.4, 0.03], strength: 1.2 },
};

function tune(doc) {
  const ext = doc.createExtension(KHRMaterialsEmissiveStrength);
  for (const m of doc.getRoot().listMaterials()) {
    const n = m.getName();
    if (LAMPS[n]) {
      m.setBaseColorFactor(LAMPS[n].base).setEmissiveFactor(LAMPS[n].emissive).setRoughnessFactor(0.3).setMetallicFactor(0);
      m.setExtension('KHR_materials_emissive_strength', ext.createEmissiveStrength().setEmissiveStrength(LAMPS[n].strength));
    } else if (n.startsWith('CarPaint')) {
      m.setRoughnessFactor(0.22).setMetallicFactor(0.55);
    } else if (n === 'Glass') {
      m.setBaseColorFactor([0.02, 0.03, 0.04, 1]).setRoughnessFactor(0.05).setMetallicFactor(0.7);
    } else if (n === 'LightGlass') {
      // Clear lamp covers (the pack's are opaque black, hiding the lamps).
      m.setBaseColorFactor([0.9, 0.92, 0.95, 0.18]).setAlphaMode('BLEND').setRoughnessFactor(0.05).setMetallicFactor(0);
    } else if (n === 'Rubber') {
      m.setBaseColorFactor([0.02, 0.02, 0.02, 1]).setRoughnessFactor(0.9).setMetallicFactor(0);
    } else if (n === 'Plastic' || n === 'DefaultMaterial') {
      m.setBaseColorFactor([0.03, 0.03, 0.03, 1]).setRoughnessFactor(0.6).setMetallicFactor(0);
    } else if (n === 'Rim') {
      m.setRoughnessFactor(0.25).setMetallicFactor(0.9);
    }
  }
}

function worldCenter(nodes) {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const n of nodes) {
    const b = getBounds(n);
    min = min.map((v, i) => Math.min(v, b.min[i]));
    max = max.map((v, i) => Math.max(v, b.max[i]));
  }
  return { min, max };
}

/** World-space centroid of the primitives using `matName` under `node`. */
function materialCentroid(node, matName) {
  const mesh = node.getMesh();
  if (!mesh) return null;
  const m = node.getWorldMatrix();
  let s = [0, 0, 0];
  let k = 0;
  for (const p of mesh.listPrimitives()) {
    if (p.getMaterial()?.getName() !== matName) continue;
    const a = p.getAttribute('POSITION');
    const v = [0, 0, 0];
    for (let i = 0; i < a.getCount(); i++) {
      a.getElement(i, v);
      s[0] += m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12];
      s[1] += m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
      s[2] += m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14];
      k++;
    }
  }
  return k ? s.map((x) => x / k) : null;
}

const base = await io.read(src);
const bodies = base.getRoot().listScenes()[0].listChildren()[0].listChildren().filter((n) => /^CarBody/.test(n.getName()));
console.log(`${bodies.length} cars`);
const grill = grillPath ? fs.readFileSync(grillPath) : null;

let idx = 0;
const made = [];
for (const body of bodies) {
  const name = body.getName();
  const doc = await io.read(src); // a fresh copy per car
  const root = doc.getRoot().listScenes()[0].listChildren()[0];
  const me = root.listChildren().find((n) => n.getName() === name);
  const bb = getBounds(me);
  const pad = 0.6;
  const inside = (n) => {
    const t = n.getWorldTranslation();
    return t[0] > bb.min[0] - pad && t[0] < bb.max[0] + pad && t[2] > bb.min[2] - pad && t[2] < bb.max[2] + pad;
  };
  const keep = root.listChildren().filter((n) => n === me || (!SKIP.test(n.getName()) && !/^CarBody/.test(n.getName()) && inside(n)));
  for (const n of root.listChildren()) if (!keep.includes(n)) n.dispose();

  const { min, max } = worldCenter(keep);
  const center = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2];
  const scale = Math.min(LENGTH / (max[2] - min[2]), MAX_WIDTH / (max[0] - min[0]));
  // Face +Z: headlights (LightW) must be at the +Z end.
  const head = materialCentroid(me, 'LightW');
  const flip = head && head[2] < center[2];
  // root: RootNode (identity) → wrap in a node that recenters, scales and turns.
  const shift = doc.createNode('recenter').setTranslation(center.map((v) => -v));
  for (const n of root.listChildren()) {
    root.removeChild(n);
    shift.addChild(n);
  }
  const wrap = doc.createNode(`car-${idx}`).setScale([scale, scale, scale]).setRotation(flip ? [0, 1, 0, 0] : [0, 0, 0, 1]);
  wrap.addChild(shift);
  root.addChild(wrap);

  tune(doc);
  if (grill) {
    for (const t of doc.getRoot().listTextures()) t.setImage(grill).setMimeType('image/jpeg');
  }
  await doc.transform(prune(), dedup(), weld(), quantize(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  const lengthM = (max[2] - min[2]) * scale;
  const file = `car-${idx}.glb`;
  fs.writeFileSync(path.join(outDir, file), await io.writeBinary(doc));
  const paint = doc.getRoot().listMaterials().find((m) => m.getName().startsWith('CarPaint'))?.getBaseColorFactor();
  made.push({ file, name, length: +lengthM.toFixed(2), paint: paint?.slice(0, 3).map((v) => +v.toFixed(2)) });
  idx++;
}
console.log(JSON.stringify(made, null, 1));
