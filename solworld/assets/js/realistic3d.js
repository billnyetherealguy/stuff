// Realistic 3D: up close, the map hands over to real photogrammetry — Google's
// Photorealistic 3D Tiles (the same 3D city meshes as Google Earth, textured
// with real photos on every wall and roof), drawn with CesiumJS.
//
// At night a post-process "window glow" pass darkens the scene and then adds a
// transparent glow only where windows are in the real textures: on walls, the
// darker-than-surroundings patches of the photo texture (glass) are found per
// pixel, a stable random share of them (per ~3 m cell in world space, so they
// don't flicker as you move) is "switched on", and the glow is blurred and
// added on top — the real texture stays visible underneath.
//
// CesiumJS (~4 MB) is only downloaded the first time someone zooms in.

import { Emitter } from './emitter.js';
import { sunPosition } from './sun.js';

const CESIUM_VERSION = '1.145.0';

let loading = null;
function loadCesium(base) {
  if (globalThis.Cesium) return Promise.resolve(globalThis.Cesium);
  if (loading) return loading;
  globalThis.CESIUM_BASE_URL = base;
  loading = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${base}Widgets/widgets.css`;
    document.head.append(css);
    const script = document.createElement('script');
    script.src = `${base}Cesium.js`;
    script.async = true;
    script.onload = () => (globalThis.Cesium ? resolve(globalThis.Cesium) : reject(new Error('Cesium failed to start')));
    script.onerror = () => reject(new Error('Could not download the 3D engine'));
    document.head.append(script);
  });
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/* ------------------------------------------------------------- shaders */

// Pass 1: which pixels are lit windows (output: glow color, black elsewhere).
const MASK_SHADER = /* glsl */ `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform float nightAmount;
uniform float windowShare;
in vec2 v_textureCoordinates;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec2 uv = v_textureCoordinates;
  float depth = czm_readDepth(depthTexture, uv);
  if (nightAmount < 0.01 || depth >= 1.0) {
    out_FragColor = vec4(0.0);
    return;
  }
  // (this helper decodes Cesium's log depth itself, so pass the raw value)
  vec4 eye = czm_windowToEyeCoordinates(uv * czm_viewport.zw, texture(depthTexture, uv).r);
  vec3 p = eye.xyz / eye.w;
  float dist = length(p);
  // Surface orientation from depth: glow only on walls (not roofs or streets).
  vec3 n = normalize(cross(dFdx(p), dFdy(p)));
  vec4 world = czm_inverseView * vec4(p, 1.0);
  vec3 upEye = normalize(czm_viewRotation * normalize(world.xyz));
  float wall = 1.0 - smoothstep(0.25, 0.45, abs(dot(n, upEye)));

  // A window in a real facade photo: darker (glass) than the wall around it.
  // Compare each pixel with the wall ~1.3 m away (about half a window plus a
  // bit), converted to pixels from the real surface scale, so whole panes
  // light up, not just their edges.
  vec2 px = 1.0 / czm_viewport.zw;
  // Meters per pixel at this distance (from the camera's field of view).
  float metersPerPx = dist * 2.0 / (czm_projection[1][1] * czm_viewport.w);
  float r = clamp(1.3 / max(metersPerPx, 1e-4), 2.0, 48.0);
  vec3 c = texture(colorTexture, uv).rgb;
  float ring = 0.0;
  float ring2 = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398;
    vec2 d = vec2(cos(a), sin(a));
    ring = max(ring, luma(texture(colorTexture, uv + d * r * px).rgb));
    ring2 = max(ring2, luma(texture(colorTexture, uv + d * r * 1.7 * px).rgb));
  }
  float wallLuma = min(ring, ring2) * 0.6 + max(ring, ring2) * 0.4;
  float darker = wallLuma - luma(c);
  float window = smoothstep(0.07, 0.2, darker) * (1.0 - smoothstep(0.5, 0.75, luma(c)));

  // Which windows have the lights on: stable per ~3 m cell of the real world.
  // (wrapped to small integers: Earth-sized coordinates break the hash precision)
  vec3 cell = mod(floor(world.xyz / 2.6), 4096.0);
  float on = step(hash13(cell), windowShare);
  // Mostly warm interior light, a few cooler rooms; each window a little dimmer or brighter.
  float cool = step(0.92, hash13(cell + 17.0));
  vec3 tint = mix(vec3(1.0, 0.78, 0.5), vec3(0.86, 0.9, 1.0), cool) * (0.55 + 0.35 * hash13(cell + 41.0));
  float fade = (1.0 - smoothstep(300.0, 1800.0, dist) * 0.8) * (1.0 - smoothstep(1500.0, 2600.0, dist));
  float glow = window * on * wall * fade * nightAmount;
  out_FragColor = vec4(tint * glow, 1.0);
}
`;

// Pass 3: night grading of the real scene + the glow as a transparent overlay.
const COMPOSITE_SHADER = /* glsl */ `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform sampler2D maskTexture;
uniform sampler2D blurTexture;
uniform float nightAmount;
uniform float duskAmount;
in vec2 v_textureCoordinates;

void main() {
  vec2 uv = v_textureCoordinates;
  vec3 c = texture(colorTexture, uv).rgb;
  float depth = czm_readDepth(depthTexture, uv);
  // Dusk: warm, lower light. Night: dark blue, the texture still readable.
  vec3 dusk = c * vec3(1.02, 0.78, 0.62);
  vec3 night = c * vec3(0.24, 0.28, 0.4);
  if (depth >= 1.0) night = c * vec3(0.03, 0.04, 0.08); // sky
  vec3 graded = mix(mix(c, dusk, duskAmount), night, nightAmount);
  vec3 sharp = texture(maskTexture, uv).rgb;
  vec3 halo = texture(blurTexture, uv).rgb;
  // Soft and even: capped so no window blows out to white.
  out_FragColor = vec4(graded + min(sharp * 0.6 + halo * 0.55, vec3(0.5)), 1.0);
}
`;

/* --------------------------------------------------------------- view */

export class Realistic3D extends Emitter {
  constructor({ container, cdnBase, googleKey, ionToken }) {
    super();
    this.container = container;
    this.cdnBase = cdnBase || `https://cdn.jsdelivr.net/npm/cesium@${CESIUM_VERSION}/Build/Cesium/`;
    this.googleKey = googleKey || '';
    this.ionToken = ionToken || '';
    this.active = false;
    this.viewer = null;
    this.ground = new Map(); // "lng,lat" -> ellipsoid height of the ground there
  }

  get available() {
    return !!(this.googleKey || this.ionToken);
  }

  setKey(googleKey) {
    if (googleKey && googleKey !== this.googleKey) {
      this.googleKey = googleKey;
      this.tilesetPromise = null;
    }
  }

  async _init() {
    if (this.viewer) return this.viewer;
    const Cesium = await loadCesium(this.cdnBase);
    this.Cesium = Cesium;
    if (this.ionToken) Cesium.Ion.defaultAccessToken = this.ionToken;
    const viewer = new Cesium.Viewer(this.container, {
      baseLayer: false,
      globe: false,
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      requestRenderMode: false,
      shouldAnimate: true,
    });
    viewer.scene.skyAtmosphere.show = true;
    // Very dense screens: render a bit below native resolution (much faster, hardly visible).
    viewer.resolutionScale = Math.min(1, 1.5 / (window.devicePixelRatio || 1));
    viewer.scene.backgroundColor = Cesium.Color.BLACK;
    viewer.clock.currentTime = Cesium.JulianDate.now(); // real sun position
    viewer.scene.screenSpaceCameraController.enableCollisionDetection = true;
    this.viewer = viewer;
    this._installGlow();
    this._wire();
    return viewer;
  }

  async _tileset() {
    const Cesium = this.Cesium;
    if (!this.tilesetPromise) {
      this.tilesetPromise = (async () => {
        if (this.googleKey) Cesium.GoogleMaps.defaultApiKey = this.googleKey;
        const tileset = await Cesium.createGooglePhotorealistic3DTileset({ onlyUsingWithGoogleGeocoder: true }, {
          maximumScreenSpaceError: 16,
          // Less detail toward the horizon, where it can't be seen anyway: much lighter.
          dynamicScreenSpaceError: true,
          dynamicScreenSpaceErrorDensity: 0.0004,
          dynamicScreenSpaceErrorFactor: 6,
          foveatedScreenSpaceError: true,
          showCreditsOnScreen: true,
        });
        if (this.tileset) this.viewer.scene.primitives.remove(this.tileset);
        this.tileset = this.viewer.scene.primitives.add(tileset);
        return tileset;
      })();
      this.tilesetPromise.catch(() => {
        this.tilesetPromise = null;
      });
    }
    return this.tilesetPromise;
  }

  _installGlow() {
    const Cesium = this.Cesium;
    const stages = this.viewer.scene.postProcessStages;
    const uniforms = { nightAmount: 0, duskAmount: 0, windowShare: 0.2 };
    this.glowUniforms = uniforms;
    const mask = new Cesium.PostProcessStage({
      name: 'sw_window_mask',
      fragmentShader: MASK_SHADER,
      uniforms: {
        nightAmount: () => uniforms.nightAmount,
        windowShare: () => uniforms.windowShare,
      },
    });
    const blur = Cesium.PostProcessStageLibrary.createBlurStage();
    blur.uniforms.sigma = 2.2;
    blur.uniforms.stepSize = 1.6;
    const glow = new Cesium.PostProcessStageComposite({ name: 'sw_window_glow', stages: [mask, blur], inputPreviousStageTexture: true });
    const composite = new Cesium.PostProcessStage({
      name: 'sw_night_composite',
      fragmentShader: COMPOSITE_SHADER,
      uniforms: {
        maskTexture: mask.name,
        blurTexture: glow.name,
        nightAmount: () => uniforms.nightAmount,
        duskAmount: () => uniforms.duskAmount,
      },
    });
    this.glowStage = stages.add(new Cesium.PostProcessStageComposite({ name: 'sw_night', stages: [glow, composite], inputPreviousStageTexture: false }));
  }

  /** Night/dusk strength from the real sun at the view (smooth, not stepped). */
  _updateSun() {
    if (!this.viewer) return;
    const c = this._viewCenter();
    if (!c) return;
    const { altitude } = sunPosition(c[0], c[1]);
    this.glowUniforms.nightAmount = Math.min(1, Math.max(0, (-1 - altitude) / 9)); // full night by -10°
    this.glowUniforms.duskAmount = Math.max(0, 1 - Math.abs(altitude - 2) / 10) * (1 - this.glowUniforms.nightAmount);
    this.phase = altitude > 8 ? 'day' : altitude > -5 ? 'dusk' : 'night';
  }

  _wire() {
    const Cesium = this.Cesium;
    const viewer = this.viewer;
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((e) => {
      const cart = viewer.scene.pickPosition(e.position);
      if (!Cesium.defined(cart)) return;
      const carto = Cesium.Cartographic.fromCartesian(cart);
      this.emit('pick', { lngLat: [Cesium.Math.toDegrees(carto.longitude), Cesium.Math.toDegrees(carto.latitude)], height: carto.height });
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    for (const type of [Cesium.ScreenSpaceEventType.LEFT_DOWN, Cesium.ScreenSpaceEventType.WHEEL, Cesium.ScreenSpaceEventType.PINCH_START, Cesium.ScreenSpaceEventType.RIGHT_DOWN]) {
      handler.setInputAction(() => this.stopOrbit(), type);
    }
    viewer.camera.moveEnd.addEventListener(() => {
      if (!this.active) return;
      this._updateSun();
      this.emit('moveend', this.cameraState());
    });
    viewer.clock.onTick.addEventListener(() => {
      if (this.orbit) {
        const now = performance.now();
        const dt = (now - (this.orbit.last || now)) / 1000;
        this.orbit.last = now;
        viewer.camera.rotate(this.orbit.axis, -dt * 0.09);
      }
    });
    this.handler = handler;
  }

  /* ------------------------------------------------------------ camera */

  _viewCenter() {
    const Cesium = this.Cesium;
    const scene = this.viewer.scene;
    const canvas = scene.canvas;
    const mid = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const hit = scene.pickPositionSupported ? scene.pickPosition(mid) : undefined;
    const pos = Cesium.defined(hit) ? hit : this.viewer.camera.pickEllipsoid(mid);
    if (!Cesium.defined(pos)) return null;
    const c = Cesium.Cartographic.fromCartesian(pos);
    return [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude), c.height];
  }

  /** Our own things drawn in the scene, which ground sampling must look through. */
  _ours() {
    const out = [];
    for (const e of this.agentModels?.values() || []) if (e.model) out.push(e.model);
    for (const p of [this.labels, this.lights, this.selectionPrim, this.ownedPrim]) if (p) out.push(p);
    return out;
  }

  /**
   * Ground height (ellipsoid meters) under a point, sampled from the real 3D
   * city: the lowest of a few points around it, so a tree or parked car baked
   * into the photogrammetry doesn't count as the ground.
   */
  async groundAt([lng, lat]) {
    const id = `${lng.toFixed(4)},${lat.toFixed(4)}`;
    if (this.ground.has(id)) return this.ground.get(id);
    const Cesium = this.Cesium;
    let h = null;
    try {
      const d = 2.5 / 111_320;
      const pts = [[0, 0], [d, 0], [-d, 0], [0, d], [0, -d]].map(([x, y]) => Cesium.Cartographic.fromDegrees(lng + x / Math.cos((lat * Math.PI) / 180), lat + y));
      const got = await this.viewer.scene.sampleHeightMostDetailed(pts, this._ours());
      const hs = got.map((s) => s?.height).filter(Number.isFinite);
      if (hs.length) h = Math.min(...hs);
    } catch {
      // not loaded yet
    }
    if (h != null) this.ground.set(id, h);
    return h ?? this.lastGround ?? 0;
  }

  /**
   * Whether Google has real 3D buildings here or just flat photos draped on
   * the terrain: samples the surface on top of known buildings and on the
   * streets around them. `buildings`: [{ center: [lng, lat], height, radius }].
   * Returns the share (0–1) of buildings that stand up in the 3D tiles, or
   * null if it couldn't tell yet.
   */
  async coverage(buildings) {
    if (!this.viewer || !this.tileset || !buildings.length) return null;
    const Cesium = this.Cesium;
    const pts = [];
    for (const { center: [lng, lat], radius } of buildings) {
      const k = 1 / (111_320 * Math.cos((lat * Math.PI) / 180));
      const out = (radius || 10) + 12; // out on the street
      pts.push(Cesium.Cartographic.fromDegrees(lng, lat));
      for (const [x, y] of [[out, 0], [-out, 0], [0, out], [0, -out]]) pts.push(Cesium.Cartographic.fromDegrees(lng + x * k, lat + y / 110_574));
    }
    let got;
    try {
      got = await this.viewer.scene.sampleHeightMostDetailed(pts, this._ours());
    } catch {
      return null;
    }
    let tested = 0;
    let standing = 0;
    buildings.forEach((b, i) => {
      const [top, ...around] = got.slice(i * 5, i * 5 + 5).map((s) => s?.height);
      const street = around.filter(Number.isFinite);
      if (!Number.isFinite(top) || !street.length) return;
      tested++;
      if (top - Math.min(...street) > Math.max(2.5, b.height * 0.4)) standing++;
    });
    return tested >= 4 ? standing / tested : null;
  }

  /**
   * Street height for street-life agents, on a ~50 m grid blended between
   * cells. Each cell is measured where an agent actually is (on a street or
   * sidewalk, never inside a building), taking the lower of two nearby points
   * so a tree or parked car baked into the 3D city doesn't count as ground.
   * While a cell is pending, a measured cell close by stands in; with none
   * near, returns null and the agent stays hidden (never floating).
   */
  _streetHeight(lng, lat) {
    const G = 2000; // cells per degree (~42–55 m)
    this.patches ||= new Map();
    this.patchQueue ||= new Map();
    if (this.patches.size > 20_000) this.patches.clear();
    const fx = lng * G - 0.5;
    const fy = lat * G - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const own = `${Math.round(lng * G - 0.5)},${Math.round(lat * G - 0.5)}`;
    // (setAgents rebuilds the queue every frame, nearest to the camera first.)
    if (!this.patches.has(own) && !this.patchQueue.has(own)) this.patchQueue.set(own, [lng, lat]);
    this._samplePatches();
    const hs = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([dx, dy]) => this.patches.get(`${x0 + dx},${y0 + dy}`));
    if (hs.every(Number.isFinite)) {
      const tx = fx - x0;
      const ty = fy - y0;
      return (hs[0] * (1 - tx) + hs[1] * tx) * (1 - ty) + (hs[2] * (1 - tx) + hs[3] * tx) * ty;
    }
    // Nearest measured cell within ~2 cells.
    let best = null;
    let bestD = Infinity;
    for (let dx = -2; dx <= 3; dx++) {
      for (let dy = -2; dy <= 3; dy++) {
        const h = this.patches.get(`${x0 + dx},${y0 + dy}`);
        if (!Number.isFinite(h)) continue;
        const d = (fx - (x0 + dx)) ** 2 + (fy - (y0 + dy)) ** 2;
        if (d < bestD) {
          bestD = d;
          best = h;
        }
      }
    }
    return best;
  }

  _samplePatches() {
    if (this.sampleTimer || !this.patchQueue?.size || !this.tileset) return;
    this.sampleTimer = setTimeout(() => {
      this.sampleTimer = null;
      const Cesium = this.Cesium;
      const scene = this.viewer?.scene;
      if (!scene || !this.active) return;
      // Two cells per tick, from the tiles already on screen: cheap enough not to stall a frame.
      const batch = [...this.patchQueue.entries()].slice(0, 2);
      const ours = this._ours();
      const d = 1.6 / 110_574;
      for (const [key, [lng, lat]] of batch) {
        this.patchQueue.delete(key);
        const hs = [[lng, lat], [lng, lat + d]].map(([x, y]) => scene.sampleHeight(Cesium.Cartographic.fromDegrees(x, y), ours)).filter(Number.isFinite);
        if (!hs.length) continue; // not on screen / loaded yet: asked again later
        const h = Math.min(...hs);
        // A rooftop or awning isn't the street: compare with the cells around it.
        const [cx, cy] = key.split(',').map(Number);
        const around = [];
        for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) if (dx || dy) around.push(this.patches.get(`${cx + dx},${cy + dy}`));
        const known = around.filter(Number.isFinite).sort((x, y) => x - y);
        if (known.length >= 2 && h > known[Math.floor(known.length / 2)] + 6) continue;
        this.patches.set(key, h);
      }
      this._samplePatches();
    }, 90);
  }

  /** Matches the flat map's camera (center/zoom/pitch/bearing) in 3D. */
  async matchMap({ center, zoom, pitch, bearing, fovDeg = 36.87, heightPx }) {
    const Cesium = this.Cesium;
    const camera = this.viewer.camera;
    const aspect = this.viewer.scene.canvas.clientWidth / Math.max(1, this.viewer.scene.canvas.clientHeight);
    const vfov = (fovDeg * Math.PI) / 180;
    camera.frustum.fov = aspect > 1 ? 2 * Math.atan(Math.tan(vfov / 2) * aspect) : vfov;
    const mpp = (40_075_016.686 * Math.cos((center[1] * Math.PI) / 180)) / (512 * 2 ** zoom);
    const range = (0.5 / Math.tan(vfov / 2)) * heightPx * mpp;
    const ground = this.lastGround ?? 0;
    const target = Cesium.Cartesian3.fromDegrees(center[0], center[1], ground);
    camera.lookAt(target, new Cesium.HeadingPitchRange(Cesium.Math.toRadians(bearing), Cesium.Math.toRadians(pitch - 90), range));
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    // Once the real ground height is known, lift the camera to match it.
    const h = await this.groundAt(center);
    if (Number.isFinite(h) && Math.abs(h - ground) > 1) {
      this.lastGround = h;
      const t2 = Cesium.Cartesian3.fromDegrees(center[0], center[1], h);
      camera.lookAt(t2, new Cesium.HeadingPitchRange(camera.heading, camera.pitch, range));
      camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    }
  }

  /** The flat-map equivalent of the current 3D camera. */
  cameraState() {
    const Cesium = this.Cesium;
    const camera = this.viewer.camera;
    const c = this._viewCenter();
    const carto = camera.positionCartographic;
    if (!c) return null;
    const target = Cesium.Cartesian3.fromDegrees(c[0], c[1], c[2]);
    const range = Cesium.Cartesian3.distance(camera.positionWC, target);
    const vfov = (36.87 * Math.PI) / 180;
    const heightPx = this.viewer.scene.canvas.clientHeight;
    const mpp = range / ((0.5 / Math.tan(vfov / 2)) * heightPx);
    const zoom = Math.log2((40_075_016.686 * Math.cos((c[1] * Math.PI) / 180)) / (512 * mpp));
    return {
      center: [c[0], c[1]],
      zoom,
      pitch: Math.max(0, Math.min(85, 90 + Cesium.Math.toDegrees(camera.pitch))),
      bearing: Cesium.Math.toDegrees(camera.heading),
      heightAboveGround: carto.height - (c[2] ?? 0),
    };
  }

  /* ------------------------------------------------------------ public */

  /** Switches the 3D view on, starting from the flat map's camera. */
  async enter(mapCamera) {
    const viewer = await this._init();
    await this._tileset();
    this.active = true;
    viewer.resize();
    await this.matchMap(mapCamera);
    // Keep showing the map's buildings until the real 3D city has streamed in,
    // then fade over to it (rather than showing the blurry half-loaded tiles).
    const t0 = performance.now();
    while (this.active && !this.tileset?.tilesLoaded && performance.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 120));
    if (!this.active) return;
    this.container.classList.add('is-active');
    this._updateSun();
    this._sunTimer ||= setInterval(() => this._updateSun(), 60_000);
    this.emit('enter');
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    this.stopOrbit();
    for (const entry of this.agentModels?.values() || []) if (entry.model) this.viewer.scene.primitives.remove(entry.model);
    this.agentModels?.clear();
    this.lights?.removeAll();
    this.container.classList.remove('is-active');
    this.emit('exit');
  }

  /** Flies to a building and slowly circles it. */
  async focus({ center, height = 20, polygons, tone }) {
    if (!this.viewer) return;
    const Cesium = this.Cesium;
    const ground = (await this.groundAt(center)) ?? 0;
    this.lastGround = ground;
    this.setSelection({ polygons, height, ground, tone });
    const target = Cesium.Cartesian3.fromDegrees(center[0], center[1], ground + height / 2);
    const range = Math.max(120, height * 2.6);
    this.stopOrbit();
    const flight = (this.flight = {});
    this.viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(target, Math.max(20, height / 2)), {
      offset: new Cesium.HeadingPitchRange(this.viewer.camera.heading, Cesium.Math.toRadians(-28), range),
      duration: 2.2,
      // Only start circling if nobody took over the camera during the flight.
      complete: () => this.flight === flight && this.startOrbit(target),
    });
  }

  /** Swoops the camera down to eye level in front of `target` (before dropping into Street View). */
  async swoopTo([lng, lat]) {
    if (!this.viewer) return;
    const Cesium = this.Cesium;
    this.stopOrbit();
    const ground = (await this.groundAt([lng, lat])) ?? this.lastGround ?? 0;
    const heading = this.viewer.camera.heading;
    const back = 28;
    const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
    const eye = Cesium.Cartesian3.fromDegrees(lng - (Math.sin(heading) * back) / kx, lat - (Math.cos(heading) * back) / 110_574, ground + 2.2);
    await new Promise((resolve) => {
      this.viewer.camera.flyTo({ destination: eye, orientation: { heading, pitch: Cesium.Math.toRadians(4), roll: 0 }, duration: 1.6, complete: resolve, cancel: resolve });
    });
  }

  startOrbit(target) {
    const Cesium = this.Cesium;
    if (!target) return;
    this.orbit = { axis: Cesium.Cartesian3.normalize(target, new Cesium.Cartesian3()), last: 0 };
  }

  /** Stops circling (and any fly-in in progress): the user has taken the camera. */
  stopOrbit() {
    this.orbit = null;
    if (this.flight) {
      this.flight = null;
      this.viewer?.camera.cancelFlight();
    }
  }

  /** Tints the real building mesh (classification) — the selected one brighter. */
  setSelection({ polygons, height = 20, ground = this.lastGround ?? 0, tone } = {}) {
    if (!this.viewer) return;
    const Cesium = this.Cesium;
    if (this.selectionPrim) this.viewer.scene.primitives.remove(this.selectionPrim);
    this.selectionPrim = null;
    if (!polygons?.length) return;
    const color = tone === 'mine' ? '#2af5a8' : tone === 'owned' ? '#8f6bff' : '#ffffff';
    this.selectionPrim = this.viewer.scene.primitives.add(this._classify(polygons, ground, height, Cesium.Color.fromCssColorString(color).withAlpha(0.45)));
  }

  /** Owned buildings nearby, tinted in their owner color. */
  setOwned(list) {
    if (!this.viewer) return;
    const Cesium = this.Cesium;
    if (this.ownedPrim) this.viewer.scene.primitives.remove(this.ownedPrim);
    this.ownedPrim = null;
    if (!list.length) return;
    const instances = [];
    for (const b of list.slice(0, 80)) {
      for (const polygon of b.polygons) {
        instances.push(this._instance(polygon, (this.lastGround ?? 0) - 20, (this.lastGround ?? 0) + (b.height || 30) + 40, Cesium.Color.fromCssColorString(b.mine ? '#2af5a8' : '#8f6bff').withAlpha(0.22)));
      }
    }
    this.ownedPrim = this.viewer.scene.primitives.add(
      new Cesium.ClassificationPrimitive({ geometryInstances: instances, appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }), classificationType: Cesium.ClassificationType.CESIUM_3D_TILE, asynchronous: true }),
    );
  }

  _instance(polygon, bottom, top, color) {
    const Cesium = this.Cesium;
    const outer = polygon[0].map(([x, y]) => Cesium.Cartesian3.fromDegrees(x, y));
    const holes = polygon.slice(1).map((r) => new Cesium.PolygonHierarchy(r.map(([x, y]) => Cesium.Cartesian3.fromDegrees(x, y))));
    return new Cesium.GeometryInstance({
      geometry: new Cesium.PolygonGeometry({ polygonHierarchy: new Cesium.PolygonHierarchy(outer, holes), height: bottom, extrudedHeight: top }),
      attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color) },
    });
  }

  _classify(polygons, ground, height, color) {
    const Cesium = this.Cesium;
    return new Cesium.ClassificationPrimitive({
      geometryInstances: polygons.map((p) => this._instance(p, ground - 20, ground + height + 40, color)),
      appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }),
      classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
      asynchronous: true,
    });
  }

  /**
   * Moves the simulated cars and people (traffic.js) through the real 3D city
   * as real 3D models (assets/models: cars with lit head/taillights, people),
   * each standing on the real street under it. Only the ones nearest the
   * camera are drawn.
   */
  setAgents(agents) {
    if (!this.viewer || !this.active) return;
    const Cesium = this.Cesium;
    const scene = this.viewer.scene;
    this.agentModels ||= new Map(); // agent id -> { model, kind }
    if (!this.lights) this.lights = scene.primitives.add(new Cesium.PointPrimitiveCollection());
    const ground = this.lastGround ?? 0;
    const night = this.phase && this.phase !== 'day';
    const cam = Cesium.Cartographic.fromCartesian(this.viewer.camera.positionWC);
    const camLng = Cesium.Math.toDegrees(cam.longitude);
    const camLat = Cesium.Math.toDegrees(cam.latitude);
    const kx = 111_320 * Math.cos((camLat * Math.PI) / 180);
    const dist2 = (a) => ((a.lng - camLng) * kx) ** 2 + ((a.lat - camLat) * 110_574) ** 2;
    const nearest = (kind, n) => agents.filter((a) => a.kind === kind).sort((x, y) => dist2(x) - dist2(y)).slice(0, n);
    const shown = [...nearest('car', 70), ...nearest('person', 90)].sort((x, y) => dist2(x) - dist2(y));
    this.patchQueue?.clear(); // re-asked below, nearest first
    const keep = new Set();
    const base = this.modelBase || new URL('../models/', import.meta.url).href;
    for (const a of shown) {
      keep.add(a.id);
      let entry = this.agentModels.get(a.id);
      if (!entry) {
        entry = { kind: a.kind, model: null };
        this.agentModels.set(a.id, entry);
        Cesium.Model.fromGltfAsync({ url: `${base}${a.model}.glb`, scene, incrementallyLoadTextures: false })
          .then((model) => {
            if (!this.agentModels.has(a.id)) return model.destroy();
            entry.model = scene.primitives.add(model);
            if (a.kind === 'person') {
              model.readyEvent.addEventListener(() => {
                model.activeAnimations.addAll({ loop: Cesium.ModelAnimationLoop.REPEAT, multiplier: 1.1 + (a.id % 5) * 0.08 });
              });
            }
          })
          .catch(() => {});
      }
      if (entry.model) {
        // Stand on the real street under this agent; hidden until we know where that is.
        const h = this._streetHeight(a.lng, a.lat);
        a.ground = h;
        if (h == null || Math.abs(h - ground) > 60) {
          entry.model.show = false;
          continue;
        }
        // Walkers: a small bob and sway with each step (the models aren't rigged).
        const step = a.kind === 'person' && !a.paused ? (a.stride / 0.72) * Math.PI : 0;
        const bob = a.kind === 'person' ? Math.abs(Math.sin(step)) * 0.035 : 0;
        const roll = a.kind === 'person' ? Math.sin(step) * 0.035 : 0;
        const pos = Cesium.Cartesian3.fromDegrees(a.lng, a.lat, h + 0.03 + bob);
        // Our heading is clockwise from north; Cesium's is clockwise from east.
        entry.model.modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(pos, new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(a.heading - 90), 0, roll));
        entry.model.show = true;
      }
    }
    for (const [id, entry] of this.agentModels) {
      if (keep.has(id)) continue;
      if (entry.model) scene.primitives.remove(entry.model);
      this.agentModels.delete(id);
    }
    this.lights.removeAll();
    if (night) {
      // A soft halo in front of headlights and behind taillights (the lamps themselves glow in the models).
      for (const a of shown) {
        if (a.kind !== 'car' || a.ground == null) continue;
        const h = Cesium.Math.toRadians(a.heading);
        const k = 111_320 * Math.cos(Cesium.Math.toRadians(a.lat));
        for (const [d, color, size] of [[a.length / 2 + 0.6, '#fff4d6', 9], [-(a.length / 2 + 0.3), '#ff3b30', 5]]) {
          this.lights.add({
            position: Cesium.Cartesian3.fromDegrees(a.lng + (Math.sin(h) * d) / k, a.lat + (Math.cos(h) * d) / 110_574, a.ground + 0.7),
            color: Cesium.Color.fromCssColorString(color).withAlpha(0.85),
            pixelSize: size,
            scaleByDistance: new Cesium.NearFarScalar(20, 1.8, 800, 0.25),
          });
        }
      }
    }
  }

  /**
   * Floating text: owners' billboards (always, bright) and shop / bar /
   * restaurant names where they really are (muted, up close).
   */
  setLabels({ billboards = [], signs = [] }) {
    if (!this.viewer) return;
    const Cesium = this.Cesium;
    if (!this.labels) this.labels = this.viewer.scene.primitives.add(new Cesium.LabelCollection());
    this.labels.removeAll();
    const ground = this.lastGround ?? 0;
    for (const b of billboards) {
      this.labels.add({
        position: Cesium.Cartesian3.fromDegrees(b.lng, b.lat, ground + (b.height || 30) + 14),
        text: b.text,
        font: '700 20px Geist, system-ui, sans-serif',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.fromCssColorString(b.color).withAlpha(0.9),
        outlineWidth: 5,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    // Shop names where they really are: calm, muted labels (owners' billboards are what stand out).
    for (const s of signs.slice(0, 80)) {
      const c = Cesium.Color.fromCssColorString(s.color);
      const soft = new Cesium.Color(c.red + (0.78 - c.red) * 0.55, c.green + (0.8 - c.green) * 0.55, c.blue + (0.84 - c.blue) * 0.55, 0.85);
      this.labels.add({
        position: Cesium.Cartesian3.fromDegrees(s.lng, s.lat, ground + 6),
        text: s.name,
        font: '500 13px Geist, system-ui, sans-serif',
        fillColor: soft,
        outlineColor: Cesium.Color.fromCssColorString('#080a10').withAlpha(0.8),
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 450),
      });
    }
  }
}
