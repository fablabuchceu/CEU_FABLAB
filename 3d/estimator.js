// Rough P1S print estimate in the browser (laser → 3D step 12, section S2, 2026-11-12).
// Own maths, no slicer code. Needs window.P1S (p1s-settings.js). Works offline; also loads in node for tests.
// estimate(mesh) → material (walls, top/bottom skins, gyroid infill, tree supports) in mm³, grams and metres.
// Accuracy target: about ±15% after calibration against Bambu Studio (constants marked CAL, section S4).
(function (root) {
  "use strict";

  // ---------- Parsers: STL (binary/ASCII), OBJ, STEP → { pos: Float32Array (9 per triangle) } ----------
  function parseSTL(buf) {
    const dv = new DataView(buf);
    if (buf.byteLength >= 84) {
      const n = dv.getUint32(80, true);
      if (84 + n * 50 === buf.byteLength) {                 // binary
        const pos = new Float32Array(n * 9);
        for (let i = 0; i < n; i++) { const o = 84 + i * 50 + 12; for (let k = 0; k < 9; k++) pos[i * 9 + k] = dv.getFloat32(o + k * 4, true); }
        return { pos };
      }
    }
    const txt = new TextDecoder().decode(buf), v = [], re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g; let m;
    while ((m = re.exec(txt))) v.push(+m[1], +m[2], +m[3]);
    return { pos: new Float32Array(v.slice(0, v.length - (v.length % 9))) };
  }
  function parseOBJ(txt) {
    const vs = [], out = [];
    for (const line of txt.split(/\r?\n/)) {
      const p = line.trim().split(/\s+/);
      if (p[0] === "v") vs.push([+p[1], +p[2], +p[3]]);
      else if (p[0] === "f") {
        const idx = p.slice(1).map(s => { const i = parseInt(s, 10); return i < 0 ? vs.length + i : i - 1; });
        for (let k = 1; k + 1 < idx.length; k++) out.push(...vs[idx[0]], ...vs[idx[k]], ...vs[idx[k + 1]]);
      }
    }
    return { pos: new Float32Array(out) };
  }
  // STEP (.step/.stp): OpenCascade importer (occt-import-js 0.0.23, LGPL-2.1) kept in vendor/occt, loaded only when needed.
  // The page must load vendor/occt/occt-import-js.js (global occtimportjs); the 7.6 MB wasm is fetched from the same folder.
  let occtP = null;
  function occt() {
    if (!occtP) {
      if (typeof root.occtimportjs !== "function") throw new Error("STEP reader not loaded");
      const dir = root.OCCT_DIR || "vendor/occt/";
      occtP = root.occtimportjs({ locateFile: f => dir + f });
    }
    return occtP;
  }
  async function parseSTEP(buf) {
    const o = await occt(), r = o.ReadStepFile(new Uint8Array(buf), null);
    if (!r || !r.success) throw new Error("Could not read the STEP file");
    const out = [];
    for (const m of r.meshes || []) {
      const p = m.attributes.position.array, idx = m.index ? m.index.array : null;
      if (idx) for (let i = 0; i < idx.length; i++) { const k = idx[i] * 3; out.push(p[k], p[k + 1], p[k + 2]); }
      else for (let i = 0; i < p.length; i++) out.push(p[i]);
    }
    return { pos: new Float32Array(out) };
  }
  async function parseFile(name, buf) {
    const ext = name.toLowerCase().split(".").pop();
    if (ext === "stl") return parseSTL(buf);
    if (ext === "obj") return parseOBJ(new TextDecoder().decode(buf));
    if (ext === "step" || ext === "stp") return parseSTEP(buf);
    throw new Error("Unsupported file type: " + ext);
  }

  // ---------- Geometry ----------
  function bounds(pos) {
    const b = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { const v = pos[i + k]; if (v < b.min[k]) b.min[k] = v; if (v > b.max[k]) b.max[k] = v; }
    b.size = [0, 1, 2].map(k => b.max[k] - b.min[k]); return b;
  }
  // Area sums by orientation + signed volume.
  function measure(pos) {
    let V = 0, A = 0, side = 0, up = 0, down = 0;
    for (let i = 0; i < pos.length; i += 9) {
      const ax = pos[i], ay = pos[i+1], az = pos[i+2], bx = pos[i+3] - ax, by = pos[i+4] - ay, bz = pos[i+5] - az, cx = pos[i+6] - ax, cy = pos[i+7] - ay, cz = pos[i+8] - az;
      const nx = by*cz - bz*cy, ny = bz*cx - bx*cz, nz = bx*cy - by*cx, n2 = Math.hypot(nx, ny, nz), a = n2 / 2;
      V += (ax * (pos[i+4]*pos[i+8] - pos[i+5]*pos[i+7]) - ay * (pos[i+3]*pos[i+8] - pos[i+5]*pos[i+6]) + az * (pos[i+3]*pos[i+7] - pos[i+4]*pos[i+6])) / 6;
      if (!a) continue;
      A += a; side += a * Math.hypot(nx, ny) / n2;
      const z = nz / n2; if (z > 0) up += a * z; else down -= a * z;
    }
    const s = V < 0 ? -1 : 1;                                       // inside-out files: flip
    return { V: Math.abs(V), A, side, up: s > 0 ? up : down, down: s > 0 ? down : up, flip: s < 0 };
  }

  // ---------- Supports (heightfield on an XY grid) ----------
  // A downward face flatter than thresholdDeg from horizontal needs support, unless it sits on the bed.
  // Each grid cell under such a face gets a column down to the next surface below it (or the bed).
  function supports(pos, b, P, flip) {
    const S = P.support, cos = Math.cos(S.thresholdDeg * Math.PI / 180), z0 = b.min[2];
    const cell = Math.max(0.5, Math.max(b.size[0], b.size[1]) / 256), nx = Math.ceil(b.size[0] / cell) + 1, ny = Math.ceil(b.size[1] / cell) + 1;
    const hits = new Map();                                        // cell → [{z, up}]
    let overhangArea = 0;
    for (let i = 0; i < pos.length; i += 9) {
      const ax = pos[i], ay = pos[i+1], az = pos[i+2], bx = pos[i+3], by = pos[i+4], bz = pos[i+5], cx = pos[i+6], cy = pos[i+7], cz = pos[i+8];
      let nzr = (bx-ax)*(cy-ay) - (by-ay)*(cx-ax); if (flip) nzr = -nzr;   // 2 × projected area, signed
      const n = Math.hypot((by-ay)*(cz-az) - (bz-az)*(cy-ay), (bz-az)*(cx-ax) - (bx-ax)*(cz-az), nzr);
      if (!n || Math.abs(nzr) < 1e-9) continue;
      const nz = nzr / n, needs = nz < -cos && Math.min(az, bz, cz) > z0 + P.layer;
      if (needs) overhangArea += n / 2 * -nz;
      // rasterize: cells whose centre is inside the triangle's XY footprint
      const x0 = Math.floor((Math.min(ax, bx, cx) - b.min[0]) / cell), x1 = Math.floor((Math.max(ax, bx, cx) - b.min[0]) / cell),
            y0 = Math.floor((Math.min(ay, by, cy) - b.min[1]) / cell), y1 = Math.floor((Math.max(ay, by, cy) - b.min[1]) / cell);
      const d = (bx-ax)*(cy-ay) - (by-ay)*(cx-ax);
      for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
        const px = b.min[0] + (gx + .5) * cell, py = b.min[1] + (gy + .5) * cell;
        const u = ((bx-px)*(cy-py) - (by-py)*(cx-px)) / d, v = ((cx-px)*(ay-py) - (cy-py)*(ax-px)) / d, w = 1 - u - v;
        if (u < 0 || v < 0 || w < 0) continue;
        const k = gx * ny + gy; let l = hits.get(k); if (!l) hits.set(k, l = []);
        l.push({ z: u*az + v*bz + w*cz, up: nz > 0, needs });
      }
    }
    let colVol = 0, interfaceArea = 0;
    const ca = cell * cell, step = Math.max(1, Math.round((S.tipPitch || 4) / cell)), tips = [];   // tips: drawn branches, ~every 4 mm
    for (const [k, l] of hits) {
      l.sort((p, q) => p.z - q.z);
      const gx = Math.floor(k / ny), gy = k % ny, drawn = gx % step === 0 && gy % step === 0;
      for (let i = 0; i < l.length; i++) {
        if (!l[i].needs) continue;
        let below = z0; for (let j = i - 1; j >= 0; j--) if (l[j].up) { below = l[j].z; break; }
        const h = l[i].z - below - S.zGap; if (h <= 0) continue;
        colVol += h * ca; interfaceArea += ca;
        if (drawn) tips.push(b.min[0] + (gx + .5) * cell, b.min[1] + (gy + .5) * cell, below, l[i].z - S.zGap);
      }
    }
    // Tree supports fill only a fraction of the column volume. CAL: treeFill.
    // Calibrated 12 Nov against OrcaSlicer (P1S, tree supports): small fill fraction + a fixed volume per drawn branch.
    const treeFill = S.treeFill ?? 0.022, tipVol = S.tipVol ?? 38, ifaceVol = interfaceArea * S.interfaceTopLayers * P.layer * 0.7;
    return { overhangArea, columnVolume: colVol, volume: colVol * treeFill + (tips.length / 4) * tipVol + ifaceVol, interfaceArea, tips };
  }

  // ---------- Estimate ----------
  function estimate(mesh, P) {
    P = P || root.P1S;
    const pos = mesh.pos, b = bounds(pos), m = measure(pos);
    const wallT = P.lineWidth.outer + (P.walls - 1) * P.lineWidth.inner;           // 0.87 mm
    const topT = P.topLayers * P.layer, botT = P.bottomLayers * P.layer;
    let walls = m.side * wallT, skins = m.up * topT + m.down * botT;
    // CAL (OrcaSlicer, 12 Nov): extrusion ≈ 95% of the geometric shell; thin parts never more than 80% of the volume.
    const shell = walls + skins, infill = Math.max(0, m.V - shell) * P.infill.density;
    const want = Math.min(shell * CAL.flow + infill, m.V * CAL.thinFill), k = (want - infill) / Math.max(1e-9, shell);
    walls *= k; skins *= k;
    const sup = supports(pos, b, P, m.flip);
    const model = walls + skins + infill, total = model + sup.volume;
    const fil = P.filament, g = v => v / 1000 * fil.density, len = v => v / (Math.PI * (fil.diameter / 2) ** 2) / 1000;
    const fits = b.size[0] <= P.bed.x && b.size[1] <= P.bed.y && b.size[2] <= P.bed.z;
    return {
      size: b.size, fits, triangles: pos.length / 9, layers: Math.ceil(b.size[2] / P.layer),
      volume: m.V, area: m.A, sideArea: m.side, upArea: m.up, downArea: m.down,
      mm3: { walls, skins, infill, supports: sup.volume, model, total },
      grams: { model: g(model), supports: g(sup.volume), total: g(total) },
      metres: len(total),
      support: { overhangArea: sup.overhangArea, interfaceArea: sup.interfaceArea, columnVolume: sup.columnVolume, needed: sup.overhangArea > 1, tips: sup.tips },
    };
  }

  // ---------- Time (section S3) ----------
  // Per feature: path length = extruded volume ÷ (line width × layer height); moves split into typical
  // segments that accelerate/decelerate (trapezoid, no jerk); speed capped by maxVolumetric.
  // CAL constants: segment lengths, travel per layer; motion = OrcaSlicer ÷ raw estimate (overhang/small-perimeter
  // slowdowns, seams, retractions the simple model misses). flow/thinFill: material. Calibrated 12 Nov on 3 lab models.
  const CAL = { seg: { outer: 8, inner: 8, top: 15, solid: 15, infill: 6, support: 5, iface: 10, first: 15 },
                travelPerLayerS: 0.6, motion: 2.0, flow: 0.95, thinFill: 0.80 };
  function segTime(L, v, a, s) {                                   // L mm of path in segments of s mm
    if (L <= 0) return 0;
    const n = Math.max(1, L / s), d = L / n;
    const t = d >= v * v / a ? d / v + v / a : 2 * Math.sqrt(d / a);
    return n * t;
  }
  function estimateTime(mesh, r, P) {
    P = P || root.P1S; r = r || estimate(mesh, P);
    const h = P.layer, w = P.lineWidth, sp = P.speed, ac = P.accel, cap = (v, lw) => Math.min(v, P.maxVolumetric / (lw * h));
    const m = r.mm3, wallT = w.outer + (P.walls - 1) * w.inner;
    const topV = m.skins * (r.upArea * P.topLayers) / Math.max(1e-9, r.upArea * P.topLayers + r.downArea * P.bottomLayers);
    let botV = m.skins - topV;
    const firstV = Math.min(botV, (botV / Math.max(1, P.bottomLayers)));       // ≈ one bottom layer on the plate
    botV -= firstV;
    const ifaceV = Math.min(m.supports, r.support.interfaceArea * P.support.interfaceTopLayers * h * 0.7);
    const F = {                                                    // [volume, line width, speed, accel, segment]
      outer:   [m.walls * w.outer / wallT, w.outer, sp.outer, ac.outer, CAL.seg.outer],
      inner:   [m.walls * (wallT - w.outer) / wallT, w.inner, sp.inner, ac.default, CAL.seg.inner],
      top:     [topV, w.top, sp.top, ac.top, CAL.seg.top],
      bottom:  [botV, w.solid, sp.solid, ac.default, CAL.seg.solid],
      infill:  [m.infill, w.infill, sp.infill, ac.default, CAL.seg.infill],
      support: [m.supports - ifaceV, w.support, sp.support, ac.default, CAL.seg.support],
      interface: [ifaceV, w.support, sp.supportInterface, ac.default, CAL.seg.iface],
      first:   [firstV, w.first, sp.first, ac.first, CAL.seg.first],
    };
    const by = {}; let print = 0;
    for (const [k, [V, lw, v, a, s]] of Object.entries(F)) { by[k] = segTime(V / (lw * (k === "first" ? P.firstLayer : h)), cap(v, lw), a, s) * CAL.motion; print += by[k]; }
    const layers = Math.max(1, r.layers), travel = layers * CAL.travelPerLayerS * CAL.motion;
    // Cooling: each layer takes at least minLayerTime (small parts print slower).
    const perLayer = (print + travel) / layers, cooling = perLayer < P.minLayerTime ? (P.minLayerTime - perLayer) * layers : 0;
    const ritual = P.startRitualS + P.endRitualS, total = ritual + print + travel + cooling;
    return { seconds: { total, ritual, print, travel, cooling, byFeature: by }, text: fmt(total), printText: fmt(print + travel + cooling) };
  }
  function fmt(s) { const m = Math.round(s / 60), h = Math.floor(m / 60); return h ? h + " h " + (m % 60) + " min" : m + " min"; }

  const api = { parseSTL, parseOBJ, parseSTEP, parseFile, bounds, measure, estimate, estimateTime, fmt, CAL };
  root.P1SEstimator = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
