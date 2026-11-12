// P1S print settings for the 3D estimator (laser → 3D step 12, section S1, 2026-11-12).
// Numbers read from OrcaSlicer's BBL profiles (commit 7cb97a8, 12 Nov 2026):
//   machine "Bambu Lab P1S 0.4 nozzle", process "0.20mm Standard @BBL X1C" (lists P1S 0.4),
//   filament "Bambu PLA Basic @BBL P1S 0.4 nozzle". Only values are taken, no OrcaSlicer code.
// Lab overrides (User, 11–12 Nov): 2 walls, 10% gyroid infill, tree supports, PLA only.
// Units: mm, mm/s, mm/s², seconds.
window.P1S = {
  bed: { x: 256, y: 256, z: 250 },           // printable_area 256×256, printable_height 250
  nozzle: 0.4,
  layer: 0.20, firstLayer: 0.20,
  walls: 2, topLayers: 5, bottomLayers: 3,  // top_shell_thickness 1.0 mm → 5 × 0.2
  infill: { density: 0.10, pattern: "gyroid" }, // profile default is 15% grid: lab uses 10% gyroid
  lineWidth: { outer: 0.42, inner: 0.45, infill: 0.45, solid: 0.42, top: 0.42, support: 0.42, first: 0.50 },
  speed: { outer: 200, inner: 300, infill: 270, solid: 250, top: 200, support: 150, supportInterface: 80,
           bridge: 50, gap: 250, travel: 500, first: 50, firstInfill: 105 },
  accel: { default: 10000, outer: 5000, top: 2000, travel: 10000, first: 500, machineMax: 20000 },
  jerk: { xy: 9 },
  maxVolumetric: 21,                         // mm³/s, Bambu PLA Basic on P1S: caps every speed
  minLayerTime: 4, minSpeed: 20,             // slow_down_layer_time / slow_down_min_speed (cooling)
  support: {
    type: "tree",                            // support_type tree(auto)
    thresholdDeg: 30,                        // support_threshold_angle: faces flatter than 30° from horizontal get support
    zGap: 0.2, xyGap: 0.35, interfaceTopLayers: 2,
    branchAngleDeg: 45, branchDiameter: 2,   // tree_support_branch_angle / _diameter
  },
  filament: { diameter: 1.75, density: 1.26, costPerKg: 15.99 }, // g/cm³; Orca's default price, not the lab's
  // Start ritual (P1S start G-code): bed heats to 55 °C, nozzle to 250 °C and purges, cools to 140 °C
  // and wipes, homes, levels the bed over the print area, runs the vibration (resonance) test, heats to 220 °C.
  // Slicers can't time heating: one fixed value, to be timed by User on the lab P1S.
  startRitualS: 374,                         // 6 min 14 s = OrcaSlicer "Prepare time" (12 Nov); still worth timing on the real P1S
  endRitualS: 0,                             // OrcaSlicer total = prepare + printing
};
