(() => {
  "use strict";

  const WIDTH = 1080;
  const HEIGHT = 1920;
  const SOURCE_WIDTH = 941;
  const SOURCE_HEIGHT = 1672;
  const VERSION = 2;
  const MASTER_LOOP_MS = 12000;
  const TARGET_FRAME_MS = 1000 / 30;
  const FRAME_TOLERANCE_MS = 1.4;
  const WATCHDOG_MS = 250;
  const TAU = Math.PI * 2;
  const EDGE_GUARD = 5;
  const SAFE_RECT = Object.freeze({ x: 190, y: 320, width: 700, height: 1280 });

  const params = new URLSearchParams(window.location.search);
  const root = document.documentElement;
  const requestedSpeed = Number(params.get("speed"));
  const speed = params.has("speed") && Number.isFinite(requestedSpeed)
    ? Math.max(1, Math.min(4, requestedSpeed))
    : 1;
  const motionEnabled = params.get("motion") !== "0";

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  function clamp01(value) {
    return clamp(value, 0, 1);
  }

  function fract(value) {
    return value - Math.floor(value);
  }

  function mix(from, to, amount) {
    return from + (to - from) * amount;
  }

  function smoothstep(from, to, value) {
    const amount = clamp01((value - from) / (to - from));
    return amount * amount * (3 - 2 * amount);
  }

  function circularPulse(phase, center, radius) {
    let distance = Math.abs(phase - center);
    distance = Math.min(distance, 1 - distance);
    if (distance >= radius) return 0;
    const amount = 1 - distance / radius;
    return Math.sin(amount * Math.PI * 0.5) ** 3;
  }

  function parseFixedPhase() {
    if (!params.has("phase")) return null;
    const raw = params.get("phase");
    if (raw === null || raw.trim() === "") return null;
    const normalized = raw.trim();
    const fractionMatch = normalized.match(/^(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
    let parsed;
    if (fractionMatch) {
      const numerator = Number(fractionMatch[1]);
      const denominator = Number(fractionMatch[2]);
      if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
      parsed = numerator / denominator;
    } else {
      parsed = Number(normalized);
    }
    if (!Number.isFinite(parsed)) return null;
    const bounded = clamp(parsed, 0, 1);
    return bounded === 1 ? 0 : bounded;
  }

  const fixedPhase = parseFixedPhase();

  root.dataset.xfgReady = "false";
  root.dataset.xfgVersion = String(VERSION);
  root.dataset.xfgLoopTime = String(MASTER_LOOP_MS);
  root.dataset.xfgLoopMs = String(MASTER_LOOP_MS);
  root.dataset.xfgEffectiveLoopMs = String(MASTER_LOOP_MS / speed);
  root.dataset.xfgSpeed = String(speed);
  root.dataset.xfgMotion = motionEnabled ? "1" : "0";
  if (motionEnabled) root.dataset.xfgForceMotion = "true";
  if (fixedPhase !== null) root.dataset.xfgFixedPhase = String(fixedPhase);
  if (params.get("preview") === "checker") root.dataset.xfgPreview = "checker";

  const shellCanvas = document.getElementById("xfg-shell-canvas");
  const lifeCanvas = document.getElementById("xfg-life-canvas");

  if (!(shellCanvas instanceof HTMLCanvasElement) || !(lifeCanvas instanceof HTMLCanvasElement)) {
    throw new Error("XFG Carnage overlay canvases are missing.");
  }

  shellCanvas.width = WIDTH;
  shellCanvas.height = HEIGHT;
  lifeCanvas.width = WIDTH;
  lifeCanvas.height = HEIGHT;

  let shellContext = shellCanvas.getContext("2d", { alpha: true, desynchronized: true });
  let lifeContext = lifeCanvas.getContext("2d", { alpha: true, desynchronized: true });

  if (!shellContext || !lifeContext) {
    throw new Error("XFG Carnage overlay requires a 2D canvas context.");
  }

  const shellCache = document.createElement("canvas");
  shellCache.width = WIDTH;
  shellCache.height = HEIGHT;
  const shellCacheContext = shellCache.getContext("2d", {
    alpha: true,
    willReadFrequently: true,
  });

  if (!shellCacheContext) {
    throw new Error("XFG Carnage overlay could not allocate its static cache.");
  }

  let shellBitmap = null;
  let shellReady = false;
  let shellContextLost = false;
  let lifeContextLost = false;
  let rafId = 0;
  let watchdogId = 0;
  let lastFrameAt = -Infinity;
  let lastPaintWallTime = 0;

  function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  class PolylineTrack {
    constructor(points, closed = false) {
      this.points = points.map(([x, y]) => ({ x, y }));
      this.closed = closed;
      this.segments = [];
      this.length = 0;

      const segmentCount = this.points.length - (closed ? 0 : 1);
      for (let index = 0; index < segmentCount; index += 1) {
        const start = this.points[index];
        const end = this.points[(index + 1) % this.points.length];
        const length = Math.hypot(end.x - start.x, end.y - start.y);
        this.segments.push({ start, end, length, offset: this.length });
        this.length += length;
      }
    }

    sample(progress) {
      const normalized = this.closed ? fract(progress) : clamp01(progress);
      const distance = normalized * this.length;
      let segment = this.segments[this.segments.length - 1];

      for (const candidate of this.segments) {
        if (distance <= candidate.offset + candidate.length) {
          segment = candidate;
          break;
        }
      }

      const local = segment.length > 0
        ? clamp01((distance - segment.offset) / segment.length)
        : 0;
      const dx = segment.end.x - segment.start.x;
      const dy = segment.end.y - segment.start.y;
      const magnitude = Math.hypot(dx, dy) || 1;

      return {
        x: mix(segment.start.x, segment.end.x, local),
        y: mix(segment.start.y, segment.end.y, local),
        tx: dx / magnitude,
        ty: dy / magnitude,
        nx: -dy / magnitude,
        ny: dx / magnitude,
      };
    }
  }

  const perimeter = new PolylineTrack([
    [164, 92], [326, 72], [448, 108], [540, 154], [632, 108], [754, 72],
    [916, 92], [1002, 184], [976, 610], [982, 1060], [974, 1510],
    [1000, 1774], [890, 1850], [710, 1835], [540, 1870], [370, 1835],
    [190, 1850], [80, 1774], [106, 1510], [98, 1060], [104, 610], [78, 184],
  ], true);

  const protectedCenter = [
    [198, 316], [272, 266], [358, 253], [408, 292], [672, 292],
    [722, 253], [808, 266], [882, 316], [898, 430], [898, 1588],
    [868, 1678], [768, 1724], [666, 1704], [414, 1704], [312, 1724],
    [212, 1678], [182, 1588], [182, 430],
  ];

  const tendrils = [
    {
      seed: 0.03, anchor: [433, 154], c1: [402, 172], c2: [352, 212], tip: [312, 275],
      width: 30, amp: 28, cycles: 2, tipCycles: 3,
      branches: [{ at: 0.45, side: -1, length: 65, amp: 20 }, { at: 0.68, side: 1, length: 48, amp: 16 }],
    },
    {
      seed: 0.12, anchor: [480, 176], c1: [456, 207], c2: [446, 246], tip: [410, 294],
      width: 25, amp: 19, cycles: 3, tipCycles: 2,
      branches: [{ at: 0.54, side: 1, length: 44, amp: 14 }],
    },
    {
      seed: 0.21, anchor: [600, 176], c1: [624, 207], c2: [634, 246], tip: [670, 294],
      width: 25, amp: 19, cycles: 3, tipCycles: 2,
      branches: [{ at: 0.54, side: -1, length: 44, amp: 14 }],
    },
    {
      seed: 0.31, anchor: [647, 154], c1: [678, 172], c2: [728, 212], tip: [768, 275],
      width: 30, amp: 28, cycles: 2, tipCycles: 3,
      branches: [{ at: 0.45, side: 1, length: 65, amp: 20 }, { at: 0.68, side: -1, length: 48, amp: 16 }],
    },
    {
      seed: 0.39, anchor: [264, 116], c1: [232, 145], c2: [208, 196], tip: [192, 264],
      width: 22, amp: 16, cycles: 2, tipCycles: 4,
      branches: [{ at: 0.48, side: -1, length: 50, amp: 14 }],
    },
    {
      seed: 0.47, anchor: [816, 116], c1: [848, 145], c2: [872, 196], tip: [888, 264],
      width: 22, amp: 16, cycles: 2, tipCycles: 4,
      branches: [{ at: 0.48, side: 1, length: 50, amp: 14 }],
    },
    {
      seed: 0.08, anchor: [120, 320], c1: [170, 370], c2: [109, 486], tip: [171, 570],
      width: 28, amp: 38, cycles: 2, tipCycles: 3,
      branches: [{ at: 0.40, side: -1, length: 68, amp: 22 }, { at: 0.70, side: 1, length: 57, amp: 19 }],
    },
    {
      seed: 0.19, anchor: [118, 660], c1: [166, 716], c2: [106, 818], tip: [174, 900],
      width: 25, amp: 42, cycles: 3, tipCycles: 2,
      branches: [{ at: 0.52, side: 1, length: 60, amp: 21 }],
    },
    {
      seed: 0.30, anchor: [118, 1010], c1: [165, 1078], c2: [105, 1190], tip: [174, 1284],
      width: 27, amp: 48, cycles: 2, tipCycles: 3,
      branches: [{ at: 0.38, side: -1, length: 65, amp: 25 }, { at: 0.67, side: 1, length: 52, amp: 18 }],
    },
    {
      seed: 0.41, anchor: [124, 1375], c1: [170, 1434], c2: [110, 1532], tip: [184, 1638],
      width: 32, amp: 55, cycles: 2, tipCycles: 2,
      branches: [{ at: 0.46, side: -1, length: 74, amp: 27 }, { at: 0.72, side: 1, length: 60, amp: 20 }],
    },
    {
      seed: 0.58, anchor: [960, 320], c1: [910, 370], c2: [971, 486], tip: [909, 570],
      width: 28, amp: 38, cycles: 2, tipCycles: 3,
      branches: [{ at: 0.40, side: 1, length: 68, amp: 22 }, { at: 0.70, side: -1, length: 57, amp: 19 }],
    },
    {
      seed: 0.69, anchor: [962, 660], c1: [914, 716], c2: [974, 818], tip: [906, 900],
      width: 25, amp: 42, cycles: 3, tipCycles: 2,
      branches: [{ at: 0.52, side: -1, length: 60, amp: 21 }],
    },
    {
      seed: 0.80, anchor: [962, 1010], c1: [915, 1078], c2: [975, 1190], tip: [906, 1284],
      width: 27, amp: 48, cycles: 2, tipCycles: 3,
      branches: [{ at: 0.38, side: 1, length: 65, amp: 25 }, { at: 0.67, side: -1, length: 52, amp: 18 }],
    },
    {
      seed: 0.91, anchor: [956, 1375], c1: [910, 1434], c2: [970, 1532], tip: [896, 1638],
      width: 32, amp: 55, cycles: 2, tipCycles: 2,
      branches: [{ at: 0.46, side: 1, length: 74, amp: 27 }, { at: 0.72, side: -1, length: 60, amp: 20 }],
    },
    {
      seed: 0.17, anchor: [224, 1798], c1: [278, 1762], c2: [342, 1768], tip: [410, 1714],
      width: 31, amp: 32, cycles: 3, tipCycles: 2,
      branches: [{ at: 0.50, side: 1, length: 56, amp: 18 }],
    },
    {
      seed: 0.33, anchor: [856, 1798], c1: [802, 1762], c2: [738, 1768], tip: [670, 1714],
      width: 31, amp: 32, cycles: 3, tipCycles: 2,
      branches: [{ at: 0.50, side: -1, length: 56, amp: 18 }],
    },
    {
      seed: 0.52, anchor: [404, 1818], c1: [452, 1805], c2: [470, 1754], tip: [520, 1700],
      width: 24, amp: 26, cycles: 2, tipCycles: 4,
      branches: [{ at: 0.58, side: -1, length: 42, amp: 13 }],
    },
    {
      seed: 0.76, anchor: [676, 1818], c1: [628, 1805], c2: [610, 1754], tip: [560, 1700],
      width: 24, amp: 26, cycles: 2, tipCycles: 4,
      branches: [{ at: 0.58, side: 1, length: 42, amp: 13 }],
    },
  ];

  const drips = [
    { x: 385, y: 213, length: 110, width: 14, sway: 22, offset: 0.04, cycles: 2 },
    { x: 540, y: 230, length: 138, width: 18, sway: 17, offset: 0.27, cycles: 2 },
    { x: 695, y: 213, length: 110, width: 14, sway: 22, offset: 0.55, cycles: 2 },
    { x: 137, y: 562, length: 105, width: 12, sway: 20, offset: 0.16, cycles: 3 },
    { x: 943, y: 562, length: 105, width: 12, sway: -20, offset: 0.66, cycles: 3 },
    { x: 260, y: 1798, length: 60, width: 13, sway: 18, offset: 0.35, cycles: 2 },
    { x: 820, y: 1798, length: 60, width: 13, sway: -18, offset: 0.85, cycles: 2 },
  ];

  function makeEyeMask(side) {
    const path = new Path2D();
    if (side < 0) {
      path.moveTo(342, 70);
      path.bezierCurveTo(361, 80, 410, 123, 459, 165);
      path.bezierCurveTo(485, 188, 499, 207, 504, 220);
      path.bezierCurveTo(500, 228, 492, 230, 480, 229);
      path.bezierCurveTo(431, 223, 398, 208, 378, 187);
      path.bezierCurveTo(365, 169, 354, 125, 342, 70);
    } else {
      path.moveTo(738, 69);
      path.bezierCurveTo(720, 80, 675, 122, 630, 166);
      path.bezierCurveTo(607, 190, 591, 213, 584, 226);
      path.bezierCurveTo(588, 231, 598, 230, 612, 228);
      path.bezierCurveTo(658, 221, 689, 203, 706, 178);
      path.bezierCurveTo(720, 157, 731, 116, 738, 69);
    }
    path.closePath();
    return path;
  }

  function makeEyeRestoreMask(side) {
    const path = new Path2D();
    if (side < 0) {
      path.moveTo(334, 62);
      path.bezierCurveTo(354, 73, 409, 116, 465, 160);
      path.bezierCurveTo(493, 183, 508, 207, 513, 224);
      path.bezierCurveTo(508, 236, 498, 239, 479, 237);
      path.bezierCurveTo(426, 231, 390, 215, 369, 191);
      path.bezierCurveTo(354, 170, 344, 121, 334, 62);
    } else {
      path.moveTo(746, 61);
      path.bezierCurveTo(726, 73, 674, 115, 628, 160);
      path.bezierCurveTo(604, 185, 588, 211, 579, 227);
      path.bezierCurveTo(584, 237, 597, 238, 615, 235);
      path.bezierCurveTo(663, 228, 699, 209, 715, 181);
      path.bezierCurveTo(730, 158, 740, 111, 746, 61);
    }
    path.closePath();
    return path;
  }

  const eyeShapes = [
    {
      center: [412, 167], angle: 0.786, halfSpan: 44,
      mask: makeEyeMask(-1), restoreMask: makeEyeRestoreMask(-1),
    },
    {
      center: [667, 168], angle: -0.820, halfSpan: 42,
      mask: makeEyeMask(1), restoreMask: makeEyeRestoreMask(1),
    },
  ];

  const random = seededRandom(0x58464743);
  const motes = Array.from({ length: 42 }, (_, index) => ({
    offset: random(),
    direction: random() > 0.5 ? 1 : -1,
    lane: mix(-38, 45, random()),
    radius: mix(0.8, 2.7, random()),
    bob: mix(6, 18, random()),
    frequency: 1 + Math.floor(random() * 4),
    twinkle: random(),
    pale: index % 7 === 0 || random() > 0.86,
  }));

  function cubicPoint(definition, t) {
    const inverse = 1 - t;
    const inverse2 = inverse * inverse;
    const t2 = t * t;
    return {
      x: inverse2 * inverse * definition.anchor[0]
        + 3 * inverse2 * t * definition.c1[0]
        + 3 * inverse * t2 * definition.c2[0]
        + t2 * t * definition.tip[0],
      y: inverse2 * inverse * definition.anchor[1]
        + 3 * inverse2 * t * definition.c1[1]
        + 3 * inverse * t2 * definition.c2[1]
        + t2 * t * definition.tip[1],
    };
  }

  function cubicTangent(definition, t) {
    const inverse = 1 - t;
    const dx = 3 * inverse * inverse * (definition.c1[0] - definition.anchor[0])
      + 6 * inverse * t * (definition.c2[0] - definition.c1[0])
      + 3 * t * t * (definition.tip[0] - definition.c2[0]);
    const dy = 3 * inverse * inverse * (definition.c1[1] - definition.anchor[1])
      + 6 * inverse * t * (definition.c2[1] - definition.c1[1])
      + 3 * t * t * (definition.tip[1] - definition.c2[1]);
    const magnitude = Math.hypot(dx, dy) || 1;
    return { x: dx / magnitude, y: dy / magnitude };
  }

  function buildTendrilPoints(definition, phase, steps = 20) {
    const points = [];
    const bodyClock = TAU * (phase * definition.cycles + definition.seed);
    const tipClock = TAU * (phase * definition.tipCycles + definition.seed * 1.713);

    for (let index = 0; index <= steps; index += 1) {
      const t = index / steps;
      const base = cubicPoint(definition, t);
      const tangent = cubicTangent(definition, t);
      const normal = { x: -tangent.y, y: tangent.x };
      const bodyEnvelope = Math.sin(Math.PI * t);
      const tipEnvelope = smoothstep(0.22, 1, t) ** 1.35;
      const bodyWave = Math.sin(bodyClock + t * TAU * 1.45) * bodyEnvelope * 0.25;
      const tipWave = Math.sin(tipClock) * tipEnvelope * 0.40;
      const livingQuiver = Math.cos(TAU * (phase * 4 + definition.seed * 2.3 + t * 0.7))
        * bodyEnvelope * 0.03;
      const displacement = clamp(bodyWave + tipWave + livingQuiver, -1, 1) * definition.amp * 0.72;
      points.push({
        x: base.x + normal.x * displacement,
        y: base.y + normal.y * displacement,
        tx: tangent.x,
        ty: tangent.y,
      });
    }

    return points;
  }

  function sampleCubic(from, control1, control2, to, steps = 11) {
    const points = [];
    for (let index = 0; index <= steps; index += 1) {
      const t = index / steps;
      const inverse = 1 - t;
      const inverse2 = inverse * inverse;
      const t2 = t * t;
      points.push({
        x: inverse2 * inverse * from.x + 3 * inverse2 * t * control1.x
          + 3 * inverse * t2 * control2.x + t2 * t * to.x,
        y: inverse2 * inverse * from.y + 3 * inverse2 * t * control1.y
          + 3 * inverse * t2 * control2.y + t2 * t * to.y,
      });
    }
    return points;
  }

  function buildBranchPoints(parentPoints, branch, definition, phase) {
    const anchorIndex = clamp(Math.round(branch.at * (parentPoints.length - 1)), 1, parentPoints.length - 2);
    const anchor = parentPoints[anchorIndex];
    const previous = parentPoints[anchorIndex - 1];
    const next = parentPoints[anchorIndex + 1];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const magnitude = Math.hypot(dx, dy) || 1;
    const tangent = { x: dx / magnitude, y: dy / magnitude };
    const normal = { x: -tangent.y, y: tangent.x };
    const clock = TAU * (phase * (definition.cycles + 1) + definition.seed + branch.at);
    const reach = branch.length;
    const tipMotion = Math.sin(clock) * branch.amp;
    const tip = {
      x: anchor.x + tangent.x * reach * 0.32 + normal.x * (branch.side * reach + tipMotion),
      y: anchor.y + tangent.y * reach * 0.32 + normal.y * (branch.side * reach + tipMotion),
    };
    const control1 = {
      x: anchor.x + tangent.x * reach * 0.22 + normal.x * branch.side * reach * 0.18,
      y: anchor.y + tangent.y * reach * 0.22 + normal.y * branch.side * reach * 0.18,
    };
    const control2 = {
      x: anchor.x + tangent.x * reach * 0.30 + normal.x * branch.side * reach * 0.68,
      y: anchor.y + tangent.y * reach * 0.30 + normal.y * branch.side * reach * 0.68,
    };
    return sampleCubic(anchor, control1, control2, tip, 11);
  }

  const tendrilLayers = [
    { scale: 1.00, color: "rgba(2, 1, 2, 0.98)", glow: 0 },
    { scale: 0.64, color: "rgba(51, 3, 10, 0.94)", glow: 0 },
    { scale: 0.36, color: "rgba(8, 2, 4, 0.94)", glow: 0 },
  ];

  function strokeTaperedPath(context, points, startWidth, opacity = 1, textureSeed = 0) {
    if (points.length < 2) return;
    const segmentCount = points.length - 1;
    const chunkCount = Math.min(points.length >= 18 ? 8 : 6, segmentCount);
    context.save();
    context.lineCap = "butt";
    context.lineJoin = "bevel";
    context.globalAlpha = opacity;

    for (const layer of tendrilLayers) {
      context.strokeStyle = layer.color;
      context.shadowColor = layer.glow ? "rgba(255, 18, 43, 0.76)" : "transparent";
      context.shadowBlur = layer.glow;

      for (let chunk = 0; chunk < chunkCount; chunk += 1) {
        const startIndex = Math.floor(chunk * segmentCount / chunkCount);
        const endIndex = Math.floor((chunk + 1) * segmentCount / chunkCount);
        const t = ((startIndex + endIndex) * 0.5) / segmentCount;
        const organic = 0.88
          + Math.sin(t * 37 + textureSeed * 9) * 0.08
          + Math.sin(t * 83 + textureSeed * 17) * 0.04;
        const tapered = Math.max(0.35, startWidth * ((1 - t) ** 0.95) * organic);
        context.lineWidth = Math.max(0.3, tapered * layer.scale);
        context.beginPath();
        context.moveTo(points[startIndex].x, points[startIndex].y);
        for (let index = startIndex + 1; index <= endIndex; index += 1) {
          context.lineTo(points[index].x, points[index].y);
        }
        context.stroke();
      }
    }

    context.shadowColor = "transparent";
    context.shadowBlur = 0;
    context.setLineDash([
      3.5 + fract(textureSeed * 7.1) * 3,
      7 + fract(textureSeed * 11.7) * 6,
    ]);
    context.lineDashOffset = -textureSeed * 37;
    context.strokeStyle = "rgba(163, 10, 27, 0.38)";
    context.lineWidth = Math.max(0.45, startWidth * 0.045);
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) {
      context.lineTo(points[index].x, points[index].y);
    }
    context.stroke();

    context.setLineDash([]);
    context.strokeStyle = "rgba(92, 4, 18, 0.46)";
    context.lineWidth = 0.65;
    for (let index = 2; index < points.length - 2; index += 3) {
      if (Math.sin(textureSeed * 31 + index * 2.17) < -0.28) continue;
      const point = points[index];
      const previous = points[index - 1];
      const next = points[index + 1];
      const dx = next.x - previous.x;
      const dy = next.y - previous.y;
      const magnitude = Math.hypot(dx, dy) || 1;
      const normalX = -dy / magnitude;
      const normalY = dx / magnitude;
      const t = index / segmentCount;
      const halfRidge = Math.max(0.55, startWidth * ((1 - t) ** 0.95) * 0.23);
      context.beginPath();
      context.moveTo(point.x - normalX * halfRidge, point.y - normalY * halfRidge);
      context.quadraticCurveTo(
        point.x + dx / magnitude * 1.2,
        point.y + dy / magnitude * 1.2,
        point.x + normalX * halfRidge,
        point.y + normalY * halfRidge,
      );
      context.stroke();
    }

    context.restore();
  }

  function drawTendrilPulse(context, points, definition, phase) {
    const head = fract(phase * 2 + definition.seed * 1.37);
    const edgeFade = smoothstep(0, 0.08, head) * (1 - smoothstep(0.92, 1, head));
    if (edgeFade <= 0.002) return;
    const span = 0.09;

    const segmentCount = points.length - 1;
    const startIndex = clamp(Math.floor((head - span) * segmentCount), 0, segmentCount - 1);
    const endIndex = clamp(Math.ceil(head * segmentCount), startIndex + 1, segmentCount);
    const start = points[startIndex];
    const end = points[endIndex];
    const pulseGradient = context.createLinearGradient(start.x, start.y, end.x, end.y);
    pulseGradient.addColorStop(0, "rgba(89, 2, 17, 0)");
    pulseGradient.addColorStop(0.62, `rgba(151, 7, 26, ${0.30 * edgeFade})`);
    pulseGradient.addColorStop(1, `rgba(218, 28, 43, ${0.68 * edgeFade})`);

    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    context.globalCompositeOperation = "source-over";
    context.beginPath();
    context.moveTo(start.x, start.y);
    for (let index = startIndex + 1; index <= endIndex; index += 1) {
      context.lineTo(points[index].x, points[index].y);
    }
    context.shadowColor = "rgba(177, 8, 28, 0.45)";
    context.shadowBlur = 1.5;
    context.strokeStyle = pulseGradient;
    context.lineWidth = Math.max(0.8, definition.width * 0.085 * edgeFade);
    context.stroke();
    context.shadowColor = "transparent";
    context.shadowBlur = 0;
    context.strokeStyle = `rgba(239, 74, 78, ${0.34 * edgeFade})`;
    context.lineWidth = Math.max(0.45, definition.width * 0.026 * edgeFade);
    context.stroke();
    context.restore();
  }

  function drawTendrils(context, phase) {
    for (const definition of tendrils) {
      const points = buildTendrilPoints(definition, phase);

      for (const branch of definition.branches) {
        const branchPoints = buildBranchPoints(points, branch, definition, phase);
        strokeTaperedPath(
          context,
          branchPoints,
          definition.width * 0.30,
          0.88,
          definition.seed + branch.at * 0.73,
        );
      }

      strokeTaperedPath(context, points, definition.width * 0.68, 0.94, definition.seed);
      drawTendrilPulse(context, points, definition, phase);
    }
  }

  function drawCounterflows(context, phase) {
    const flows = [
      { direction: 1, lane: -9, offset: 0.04 },
      { direction: 1, lane: -9, offset: 0.54 },
      { direction: -1, lane: 9, offset: 0.27 },
      { direction: -1, lane: 9, offset: 0.77 },
    ];

    context.save();
    context.globalCompositeOperation = "source-over";
    context.lineCap = "round";

    for (const flow of flows) {
      const head = fract(flow.offset + phase * flow.direction);
      const tailPoints = [];
      for (let tail = 10; tail >= 0; tail -= 1) {
        const progress = head - flow.direction * tail * 0.0032;
        const current = perimeter.sample(progress);
        tailPoints.push({
          x: current.x + current.nx * flow.lane,
          y: current.y + current.ny * flow.lane,
        });
      }

      const first = tailPoints[0];
      const last = tailPoints[tailPoints.length - 1];
      const flowGradient = context.createLinearGradient(first.x, first.y, last.x, last.y);
      flowGradient.addColorStop(0, "rgba(68, 2, 13, 0)");
      flowGradient.addColorStop(0.68, "rgba(127, 7, 24, 0.42)");
      flowGradient.addColorStop(1, "rgba(207, 28, 43, 0.72)");
      context.beginPath();
      context.moveTo(first.x, first.y);
      for (let index = 1; index < tailPoints.length; index += 1) {
        context.lineTo(tailPoints[index].x, tailPoints[index].y);
      }
      context.shadowColor = "rgba(143, 4, 26, 0.42)";
      context.shadowBlur = 1.25;
      context.strokeStyle = flowGradient;
      context.lineWidth = 2.4;
      context.stroke();
      context.shadowColor = "transparent";
      context.shadowBlur = 0;
      context.strokeStyle = "rgba(232, 65, 68, 0.32)";
      context.lineWidth = 0.65;
      context.stroke();
    }

    context.restore();
  }

  function drawMotes(context, phase) {
    context.save();
    context.globalCompositeOperation = "source-over";

    for (const mote of motes) {
      const trackSample = perimeter.sample(fract(mote.offset + phase * mote.direction));
      const clock = TAU * (phase * mote.frequency + mote.twinkle);
      const lane = mote.lane + Math.sin(clock) * mote.bob;
      const tangentBob = Math.cos(clock + mote.twinkle * TAU * 0.37) * mote.bob * 0.45;
      const x = trackSample.x + trackSample.nx * lane + trackSample.tx * tangentBob;
      const y = trackSample.y + trackSample.ny * lane + trackSample.ty * tangentBob;
      const shimmer = 0.58 + 0.42 * Math.sin(clock + mote.twinkle * TAU) ** 2;
      const radius = mote.radius * shimmer;
      const edgeDistance = Math.min(x, WIDTH - x, y, HEIGHT - y) - EDGE_GUARD;
      const edgeFade = smoothstep(3, 28, edgeDistance);
      if (edgeFade <= 0.002) continue;

      context.globalAlpha = edgeFade;
      context.shadowColor = "rgba(128, 5, 22, 0.28)";
      context.shadowBlur = 0.8;
      context.fillStyle = mote.pale
        ? `rgba(197, 74, 73, ${0.24 + shimmer * 0.30})`
        : `rgba(132, 8, 27, ${0.34 + shimmer * 0.36})`;
      context.beginPath();
      context.ellipse(
        x,
        y,
        Math.max(0.45, radius * 0.48),
        Math.max(0.9, radius * 1.45),
        Math.atan2(trackSample.ty, trackSample.tx) + mote.twinkle * 0.65,
        0,
        TAU,
      );
      context.fill();
    }

    context.globalAlpha = 1;
    context.restore();
  }

  function drawDrips(context, phase) {
    for (const drip of drips) {
      const local = fract(phase * drip.cycles + drip.offset);
      const extension = 0.5 - 0.5 * Math.cos(TAU * local);
      const recoil = Math.sin(TAU * local);
      const length = 18 + drip.length * extension;
      const sway = drip.sway * Math.sin(TAU * (phase + drip.offset)) * (0.35 + extension * 0.65);
      const anchor = { x: drip.x, y: drip.y };
      const control1 = { x: drip.x + sway * 0.18, y: drip.y + length * 0.28 };
      const control2 = { x: drip.x + sway * 0.78, y: drip.y + length * 0.74 };
      const tip = { x: drip.x + sway, y: drip.y + length };
      const points = sampleCubic(anchor, control1, control2, tip, 13);
      strokeTaperedPath(context, points, drip.width * 0.72, 0.90, drip.offset);

      const beadStrength = smoothstep(0.30, 0.92, extension);
      const beadRadius = 2.5 + beadStrength * 5 + Math.abs(recoil) * 0.8;
      context.save();
      context.shadowColor = "rgba(128, 4, 22, 0.48)";
      context.shadowBlur = 2;
      context.fillStyle = "rgba(22, 1, 5, 0.98)";
      context.beginPath();
      context.ellipse(tip.x, tip.y, beadRadius * 0.76, beadRadius * 1.20, 0, 0, TAU);
      context.fill();
      context.fillStyle = `rgba(132, 7, 24, ${0.56 + beadStrength * 0.22})`;
      context.beginPath();
      context.ellipse(tip.x - 1, tip.y - 1, beadRadius * 0.44, beadRadius * 0.72, 0, 0, TAU);
      context.fill();
      context.fillStyle = "rgba(222, 65, 69, 0.34)";
      context.beginPath();
      context.arc(tip.x - beadRadius * 0.18, tip.y - beadRadius * 0.30, Math.max(0.55, beadRadius * 0.10), 0, TAU);
      context.fill();
      context.restore();
    }
  }

  function eyeBlinkAmount(phase) {
    return Math.max(
      circularPulse(phase, 0.238, 0.022),
      circularPulse(phase, 0.566, 0.019),
      circularPulse(phase, 0.596, 0.015),
      circularPulse(phase, 0.842, 0.021),
    );
  }

  function drawEye(context, eye, phase, blink) {
    if (blink <= 0.001) return;

    const amount = smoothstep(0.01, 0.86, blink);
    const gap = eye.halfSpan * (1 - amount);
    const [centerX, centerY] = eye.center;
    const tissueShift = Math.sin(TAU * (phase * 2 + centerX * 0.001)) * 1.15 * amount;
    const closureOverlap = smoothstep(0.72, 0.96, amount) * 2.4;
    const upperEdge = -gap + tissueShift + closureOverlap;
    const lowerEdge = gap + tissueShift - closureOverlap;

    context.save();
    context.clip(eye.mask);
    context.translate(centerX, centerY);
    context.rotate(eye.angle);
    context.shadowBlur = 0;
    const tissue = context.createLinearGradient(0, -58, 0, 58);
    tissue.addColorStop(0, "rgba(3, 1, 2, 0.995)");
    tissue.addColorStop(0.46, "rgba(19, 1, 6, 0.992)");
    tissue.addColorStop(0.54, "rgba(31, 2, 9, 0.988)");
    tissue.addColorStop(1, "rgba(3, 1, 2, 0.995)");
    context.fillStyle = tissue;

    context.beginPath();
    context.moveTo(-155, -62);
    context.lineTo(155, -62);
    context.lineTo(155, upperEdge + 1.2);
    context.bezierCurveTo(92, upperEdge - 1.5, 34, upperEdge + 2.1, 0, upperEdge);
    context.bezierCurveTo(-39, upperEdge - 2.0, -96, upperEdge + 1.4, -155, upperEdge - 0.8);
    context.closePath();
    context.fill();

    context.beginPath();
    context.moveTo(-155, 62);
    context.lineTo(155, 62);
    context.lineTo(155, lowerEdge - 1.0);
    context.bezierCurveTo(94, lowerEdge + 1.7, 37, lowerEdge - 2.0, 0, lowerEdge + 0.4);
    context.bezierCurveTo(-42, lowerEdge + 2.2, -98, lowerEdge - 1.5, -155, lowerEdge + 0.9);
    context.closePath();
    context.fill();

    if (amount > 0.12) {
      context.globalAlpha = smoothstep(0.12, 0.72, amount);
      context.strokeStyle = "rgba(89, 4, 17, 0.46)";
      context.lineWidth = 0.65;
      context.beginPath();
      context.moveTo(-138, upperEdge - 0.8);
      context.bezierCurveTo(-75, upperEdge + 1.5, 73, upperEdge - 1.7, 138, upperEdge + 0.7);
      context.stroke();
      context.beginPath();
      context.moveTo(-138, lowerEdge + 0.8);
      context.bezierCurveTo(-72, lowerEdge - 1.6, 76, lowerEdge + 1.5, 138, lowerEdge - 0.6);
      context.stroke();
    }
    context.restore();
  }

  function drawEyes(context, phase) {
    const blink = eyeBlinkAmount(phase);
    for (const eye of eyeShapes) {
      context.save();
      context.clip(eye.restoreMask);
      context.clearRect(0, 0, WIDTH, HEIGHT);
      context.restore();
      drawEye(context, eye, phase, blink);
    }
  }

  function drawBottomKnot(context, phase) {
    const contractionWave = smoothstep(0.18, 0.92, 0.5 - 0.5 * Math.cos(TAU * phase * 3));
    const contraction = 1 - contractionWave * 0.17;
    const vertical = 1 - contractionWave * 0.11;
    const center = { x: 540, y: 1796 };
    const localCurves = [
      [[0, 0], [-80, -72], [-150, 32], [-214, -42]],
      [[0, -4], [80, -72], [150, 32], [214, -42]],
      [[-8, 8], [-45, 72], [-108, 46], [-142, 94]],
      [[8, 8], [45, 72], [108, 46], [142, 94]],
      [[0, 4], [-62, -28], [62, -56], [0, -112]],
    ];

    context.save();
    context.translate(center.x, center.y);
    context.scale(contraction, vertical);
    context.rotate(Math.sin(TAU * phase * 2) * 0.025);

    localCurves.forEach((curve, index) => {
      const sway = Math.sin(TAU * (phase * (2 + (index % 2)) + index * 0.19)) * (12 + index * 2);
      const points = sampleCubic(
        { x: curve[0][0], y: curve[0][1] },
        { x: curve[1][0] + sway * 0.25, y: curve[1][1] },
        { x: curve[2][0] + sway * 0.70, y: curve[2][1] },
        { x: curve[3][0] + sway, y: curve[3][1] },
        14,
      );
      strokeTaperedPath(context, points, (25 - index * 1.5) * 0.62, 0.92, 0.17 + index * 0.19);
    });

    context.shadowColor = "rgba(137, 5, 24, 0.52)";
    context.shadowBlur = 2.5;
    const core = context.createRadialGradient(0, 0, 3, 0, 0, 34);
    core.addColorStop(0, "rgba(183, 16, 37, 0.82)");
    core.addColorStop(0.18, "rgba(104, 5, 22, 0.96)");
    core.addColorStop(0.64, "rgba(38, 2, 9, 0.98)");
    core.addColorStop(1, "rgba(3, 1, 2, 0.99)");
    context.fillStyle = core;
    context.beginPath();
    context.moveTo(0, -32);
    context.bezierCurveTo(28, -14, 30, 17, 0, 36);
    context.bezierCurveTo(-30, 17, -28, -14, 0, -32);
    context.fill();
    context.restore();
  }

  function drawNodeBreathing(context, phase) {
    const nodes = [
      [175, 113, 0.02], [905, 113, 0.21], [120, 610, 0.39],
      [960, 610, 0.57], [116, 1794, 0.73], [964, 1794, 0.89],
    ];

    context.save();
    context.globalCompositeOperation = "source-over";
    for (const [x, y, offset] of nodes) {
      const breath = 0.5 + 0.5 * Math.sin(TAU * (phase * 2 + offset));
      const radius = 6 + breath * 3.5;
      context.shadowColor = "rgba(136, 5, 24, 0.46)";
      context.shadowBlur = 1.5 + breath * 1.5;
      context.strokeStyle = `rgba(151, 10, 30, ${0.18 + breath * 0.26})`;
      context.lineWidth = 1;
      context.beginPath();
      context.arc(x, y, radius, 0, TAU);
      context.stroke();
      context.fillStyle = `rgba(177, 18, 36, ${0.36 + breath * 0.34})`;
      context.beginPath();
      context.arc(x, y, 1.4 + breath * 1.2, 0, TAU);
      context.fill();
    }
    context.restore();
  }

  function tracePolygon(context, points) {
    context.beginPath();
    context.moveTo(points[0][0], points[0][1]);
    for (let index = 1; index < points.length; index += 1) {
      context.lineTo(points[index][0], points[index][1]);
    }
    context.closePath();
  }

  function hardClearCameraAndEdges(context) {
    context.save();
    tracePolygon(context, protectedCenter);
    context.clip();
    context.clearRect(0, 0, WIDTH, HEIGHT);
    context.restore();

    context.clearRect(SAFE_RECT.x, SAFE_RECT.y, SAFE_RECT.width, SAFE_RECT.height);

    context.clearRect(0, 0, WIDTH, EDGE_GUARD);
    context.clearRect(0, HEIGHT - EDGE_GUARD, WIDTH, EDGE_GUARD);
    context.clearRect(0, 0, EDGE_GUARD, HEIGHT);
    context.clearRect(WIDTH - EDGE_GUARD, 0, EDGE_GUARD, HEIGHT);
  }

  function renderLife(phase) {
    if (!shellReady || lifeContextLost) return;
    const normalizedPhase = fract(phase);
    lifeContext.clearRect(0, 0, WIDTH, HEIGHT);
    lifeContext.globalCompositeOperation = "source-over";
    lifeContext.globalAlpha = 1;
    lifeContext.shadowBlur = 0;
    lifeContext.setTransform(1, 0, 0, 1, 0, 0);

    drawMotes(lifeContext, normalizedPhase);
    drawCounterflows(lifeContext, normalizedPhase);
    drawDrips(lifeContext, normalizedPhase);
    drawTendrils(lifeContext, normalizedPhase);
    drawBottomKnot(lifeContext, normalizedPhase);
    drawNodeBreathing(lifeContext, normalizedPhase);
    drawEyes(lifeContext, normalizedPhase);
    hardClearCameraAndEdges(lifeContext);

    root.dataset.xfgPhase = normalizedPhase.toFixed(6);
    lastPaintWallTime = Date.now();
  }

  function clearLifeLayer() {
    if (lifeContextLost) return;
    lifeContext.setTransform(1, 0, 0, 1, 0, 0);
    lifeContext.globalAlpha = 1;
    lifeContext.globalCompositeOperation = "source-over";
    lifeContext.shadowBlur = 0;
    lifeContext.clearRect(0, 0, WIDTH, HEIGHT);
    root.dataset.xfgPhase = "0.000000";
    lastPaintWallTime = Date.now();
  }

  function isBackdropPixel(data, pixelIndex) {
    const offset = pixelIndex * 4;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const alpha = data[offset + 3];
    const minimum = Math.min(red, green, blue);
    const maximum = Math.max(red, green, blue);
    return alpha < 8 || (minimum >= 202 && maximum - minimum <= 18);
  }

  function removeConnectedBackdrop(context) {
    const imageData = context.getImageData(0, 0, WIDTH, HEIGHT);
    const { data } = imageData;
    const pixelCount = WIDTH * HEIGHT;
    const visited = new Uint8Array(pixelCount);
    const queue = new Int32Array(pixelCount);
    let head = 0;
    let tail = 0;

    function enqueue(pixelIndex) {
      if (pixelIndex < 0 || pixelIndex >= pixelCount || visited[pixelIndex]) return;
      visited[pixelIndex] = 1;
      if (!isBackdropPixel(data, pixelIndex)) return;
      data[pixelIndex * 4 + 3] = 0;
      queue[tail] = pixelIndex;
      tail += 1;
    }

    for (let x = 0; x < WIDTH; x += 1) {
      enqueue(x);
      enqueue((HEIGHT - 1) * WIDTH + x);
    }
    for (let y = 1; y < HEIGHT - 1; y += 1) {
      enqueue(y * WIDTH);
      enqueue(y * WIDTH + WIDTH - 1);
    }

    // The closed shell separates its checkerboard center from the exterior.
    // Multiple safe center seeds tolerate small artifacts without touching the enclosed eyes.
    for (let y = 460; y <= 1520; y += 96) {
      for (let x = 330; x <= 750; x += 84) enqueue(y * WIDTH + x);
    }
    enqueue(Math.floor(HEIGHT * 0.5) * WIDTH + Math.floor(WIDTH * 0.5));

    // The source art contains a few checker islands completely enclosed by outer coils.
    // Seed only those known background pockets; the enclosed face eyes/highlights stay untouched.
    const sourceBackdropPockets = [
      [67.5, 395.5], [870.5, 394.5],
      [69, 1321], [869, 1321],
      [127, 1611], [810.5, 1611],
      [213, 199], [726, 199],
      [172, 1492], [761, 1497],
      [53, 1533], [37, 314], [897, 313], [885, 1509],
      [282, 1622], [659, 1625],
    ];
    for (const [sourceX, sourceY] of sourceBackdropPockets) {
      const x = clamp(Math.round(sourceX * WIDTH / SOURCE_WIDTH), 0, WIDTH - 1);
      const y = clamp(Math.round(sourceY * HEIGHT / SOURCE_HEIGHT), 0, HEIGHT - 1);
      enqueue(y * WIDTH + x);
    }

    while (head < tail) {
      const pixelIndex = queue[head];
      head += 1;
      const x = pixelIndex % WIDTH;
      const y = (pixelIndex - x) / WIDTH;
      if (x > 0) enqueue(pixelIndex - 1);
      if (x < WIDTH - 1) enqueue(pixelIndex + 1);
      if (y > 0) enqueue(pixelIndex - WIDTH);
      if (y < HEIGHT - 1) enqueue(pixelIndex + WIDTH);
    }

    context.putImageData(imageData, 0, 0);
    context.clearRect(SAFE_RECT.x, SAFE_RECT.y, SAFE_RECT.width, SAFE_RECT.height);
    context.clearRect(0, 0, WIDTH, EDGE_GUARD);
    context.clearRect(0, HEIGHT - EDGE_GUARD, WIDTH, EDGE_GUARD);
    context.clearRect(0, 0, EDGE_GUARD, HEIGHT);
    context.clearRect(WIDTH - EDGE_GUARD, 0, EDGE_GUARD, HEIGHT);
  }

  async function loadSourceImage() {
    const image = new Image();
    image.decoding = "async";
    const loaded = new Promise((resolve, reject) => {
      image.addEventListener("load", resolve, { once: true });
      image.addEventListener("error", () => reject(new Error("Carnage frame PNG failed to load.")), { once: true });
    });

    image.src = "./xfg-tiktok-carnage-frame.png?v=2";

    if (typeof image.decode === "function") {
      try {
        await image.decode();
      } catch (error) {
        await loaded;
      }
    } else {
      await loaded;
    }
    await loaded;

    if (!image.complete || image.naturalWidth < 1 || image.naturalHeight < 1) {
      throw new Error("Carnage frame PNG decoded without valid dimensions.");
    }
    const isOriginalSize = image.naturalWidth === SOURCE_WIDTH && image.naturalHeight === SOURCE_HEIGHT;
    const isTargetSize = image.naturalWidth === WIDTH && image.naturalHeight === HEIGHT;
    if (!isOriginalSize && !isTargetSize) {
      console.warn(
        `XFG Carnage expected ${SOURCE_WIDTH}x${SOURCE_HEIGHT}, received ${image.naturalWidth}x${image.naturalHeight}.`,
      );
    }
    return image;
  }

  async function buildStaticShell() {
    const image = await loadSourceImage();
    shellCacheContext.clearRect(0, 0, WIDTH, HEIGHT);
    shellCacheContext.imageSmoothingEnabled = true;
    shellCacheContext.imageSmoothingQuality = "high";
    shellCacheContext.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight, 0, 0, WIDTH, HEIGHT);
    const probePoints = [
      [0, 0],
      [WIDTH - 1, 0],
      [0, HEIGHT - 1],
      [WIDTH - 1, HEIGHT - 1],
      [Math.floor(WIDTH * 0.5), Math.floor(HEIGHT * 0.5)],
    ];
    const alreadyTransparent = probePoints.every(([x, y]) => (
      shellCacheContext.getImageData(x, y, 1, 1).data[3] < 8
    ));
    if (!alreadyTransparent) removeConnectedBackdrop(shellCacheContext);
    shellCacheContext.clearRect(SAFE_RECT.x, SAFE_RECT.y, SAFE_RECT.width, SAFE_RECT.height);

    if (typeof createImageBitmap === "function") {
      try {
        shellBitmap = await createImageBitmap(shellCache);
      } catch (error) {
        console.warn("XFG Carnage retained its canvas cache because ImageBitmap creation failed.", error);
      }
    }
  }

  function paintStaticShell() {
    if (!shellReady || shellContextLost) return;
    shellContext.clearRect(0, 0, WIDTH, HEIGHT);
    shellContext.setTransform(1, 0, 0, 1, 0, 0);
    shellContext.globalAlpha = 1;
    shellContext.globalCompositeOperation = "source-over";
    shellContext.drawImage(shellBitmap || shellCache, 0, 0, WIDTH, HEIGHT);
    shellContext.clearRect(SAFE_RECT.x, SAFE_RECT.y, SAFE_RECT.width, SAFE_RECT.height);
    shellContext.clearRect(0, 0, WIDTH, EDGE_GUARD);
    shellContext.clearRect(0, HEIGHT - EDGE_GUARD, WIDTH, EDGE_GUARD);
    shellContext.clearRect(0, 0, EDGE_GUARD, HEIGHT);
    shellContext.clearRect(WIDTH - EDGE_GUARD, 0, EDGE_GUARD, HEIGHT);
  }

  function wallClockPhase() {
    return fract((Date.now() * speed) / MASTER_LOOP_MS);
  }

  function currentPhase() {
    if (fixedPhase !== null) return fixedPhase;
    if (!motionEnabled) return 0;
    return wallClockPhase();
  }

  function paintCurrentFrame() {
    if (!shellReady) return;
    if (!motionEnabled) {
      clearLifeLayer();
      return;
    }
    renderLife(currentPhase());
  }

  function animationFrame(now) {
    rafId = 0;
    if (!shellReady || fixedPhase !== null || !motionEnabled || lifeContextLost) return;

    if (now - lastFrameAt >= TARGET_FRAME_MS - FRAME_TOLERANCE_MS) {
      renderLife(wallClockPhase());
      lastFrameAt = now;
    }
    rafId = window.requestAnimationFrame(animationFrame);
  }

  function ensureScheduler() {
    if (!shellReady || fixedPhase !== null || !motionEnabled || lifeContextLost) return;
    if (!rafId) rafId = window.requestAnimationFrame(animationFrame);
    if (!watchdogId) {
      watchdogId = window.setInterval(() => {
        if (!shellReady || fixedPhase !== null || !motionEnabled || lifeContextLost) return;
        if (Date.now() - lastPaintWallTime >= WATCHDOG_MS - 8) {
          renderLife(wallClockPhase());
        }
        if (!rafId) rafId = window.requestAnimationFrame(animationFrame);
      }, WATCHDOG_MS);
    }
  }

  function recoverRenderer() {
    if (!shellReady) return;
    paintStaticShell();
    paintCurrentFrame();
    lastFrameAt = -Infinity;
    ensureScheduler();
  }

  function bindContextRecovery(canvas, kind) {
    canvas.addEventListener("contextlost", (event) => {
      event.preventDefault();
      if (kind === "shell") shellContextLost = true;
      if (kind === "life") lifeContextLost = true;
      if (kind === "life" && rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
    });

    canvas.addEventListener("contextrestored", () => {
      if (kind === "shell") {
        shellContext = shellCanvas.getContext("2d", { alpha: true, desynchronized: true });
        shellContextLost = !shellContext;
      } else {
        lifeContext = lifeCanvas.getContext("2d", { alpha: true, desynchronized: true });
        lifeContextLost = !lifeContext;
      }
      recoverRenderer();
    });
  }

  bindContextRecovery(shellCanvas, "shell");
  bindContextRecovery(lifeCanvas, "life");

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) recoverRenderer();
  });
  window.addEventListener("focus", recoverRenderer);
  window.addEventListener("pageshow", recoverRenderer);

  async function initialize() {
    try {
      await buildStaticShell();
      shellReady = true;
      paintStaticShell();
      paintCurrentFrame();
      root.dataset.xfgReady = "true";
      ensureScheduler();
    } catch (error) {
      root.dataset.xfgReady = "error";
      console.error("XFG Carnage overlay could not initialize.", error);
    }
  }

  window.XFGOverlay = Object.freeze({
    width: WIDTH,
    height: HEIGHT,
    version: VERSION,
    loopDurationMs: MASTER_LOOP_MS,
    effectiveLoopDurationMs: MASTER_LOOP_MS / speed,
    speedMultiplier: speed,
    motionEnabled,
    fixedPhase,
    renderPhase(value) {
      if (!shellReady || !Number.isFinite(Number(value))) return false;
      renderLife(fract(Number(value)));
      return true;
    },
  });

  initialize();
})();
