(() => {
  "use strict";

  const WIDTH = 1080;
  const HEIGHT = 1920;
  const LOOP_MS = 12000;
  const TARGET_FRAME_MS = 1000 / 30;
  const TAU = Math.PI * 2;
  const searchParams = new URLSearchParams(window.location.search);

  if (searchParams.get("preview") === "checker") {
    document.documentElement.dataset.xfgPreview = "checker";
  }

  const canvas = document.getElementById("xfg-energy-canvas");
  const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
  const effectsCanvas = document.createElement("canvas");
  const effects = effectsCanvas.getContext("2d", { alpha: true, desynchronized: true });
  const mask = new Image();

  effectsCanvas.width = WIDTH;
  effectsCanvas.height = HEIGHT;

  const clamp01 = (value) => Math.max(0, Math.min(1, value));
  const fract = (value) => value - Math.floor(value);
  const mix = (from, to, amount) => from + (to - from) * amount;
  const smoothstep = (from, to, value) => {
    const amount = clamp01((value - from) / (to - from));
    return amount * amount * (3 - 2 * amount);
  };

  function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  class Track {
    constructor(points, closed = false) {
      this.points = points.map(([x, y]) => ({ x, y }));
      this.closed = closed;
      this.segments = [];
      this.length = 0;

      const count = this.points.length - (closed ? 0 : 1);
      for (let index = 0; index < count; index += 1) {
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

      const local = segment.length === 0
        ? 0
        : clamp01((distance - segment.offset) / segment.length);
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

    stroke(context) {
      context.beginPath();
      context.moveTo(this.points[0].x, this.points[0].y);
      for (let index = 1; index < this.points.length; index += 1) {
        context.lineTo(this.points[index].x, this.points[index].y);
      }
      if (this.closed) context.closePath();
      context.stroke();
    }
  }

  const perimeter = new Track([
    [180, 118], [430, 118], [470, 164], [610, 164], [650, 118], [900, 118],
    [985, 208], [985, 1645], [918, 1764], [720, 1798], [620, 1838],
    [460, 1838], [360, 1798], [162, 1764], [92, 1645], [92, 208],
  ], true);

  const topLeft = new Track([
    [122, 176], [180, 132], [294, 132], [334, 177], [414, 177], [456, 220], [486, 220],
  ]);
  const topRight = new Track([
    [958, 176], [900, 132], [786, 132], [746, 177], [666, 177], [624, 220], [594, 220],
  ]);
  const leftRail = new Track([
    [178, 144], [105, 228], [105, 566], [126, 622], [116, 892], [116, 1270],
    [96, 1518], [96, 1645], [166, 1742], [354, 1794], [500, 1832],
  ]);
  const rightRail = new Track([
    [902, 144], [975, 228], [975, 566], [954, 622], [964, 892], [964, 1270],
    [984, 1518], [984, 1645], [914, 1742], [726, 1794], [580, 1832],
  ]);
  const bottomLeft = new Track([
    [92, 1640], [142, 1732], [242, 1778], [356, 1778], [398, 1818], [516, 1818], [540, 1850],
  ]);
  const bottomRight = new Track([
    [988, 1640], [938, 1732], [838, 1778], [724, 1778], [682, 1818], [564, 1818], [540, 1850],
  ]);
  const topReservoir = new Track([
    [84, 198], [160, 104], [354, 104], [408, 148], [476, 148],
    [540, 182], [604, 148], [672, 148], [726, 104], [920, 104], [996, 198],
  ]);

  const tracks = [perimeter, topLeft, topRight, leftRail, rightRail, bottomLeft, bottomRight, topReservoir];
  const eyeShapes = [
    {
      center: { x: 476, y: 222 },
      points: [[446, 201], [478, 207], [500, 230], [475, 239], [451, 227]],
      direction: 1,
    },
    {
      center: { x: 604, y: 222 },
      points: [[634, 201], [602, 207], [580, 230], [605, 239], [629, 227]],
      direction: -1,
    },
  ];

  const nodePositions = [
    { x: 184, y: 135, delay: 0.00 },
    { x: 896, y: 135, delay: 0.17 },
    { x: 116, y: 608, delay: 0.31 },
    { x: 964, y: 608, delay: 0.48 },
    { x: 108, y: 1780, delay: 0.63 },
    { x: 972, y: 1780, delay: 0.79 },
  ];

  const rng = seededRandom(0x58464739);
  const particles = Array.from({ length: 96 }, (_, index) => ({
    track: tracks[index % tracks.length],
    offset: rng(),
    speed: 1 + Math.floor(rng() * 3),
    lane: (rng() - 0.5) * 18,
    radius: 3.1 + rng() * 4.7,
    hue: rng(),
    twinkle: rng() * TAU,
  }));

  function rgba(alpha, hot = false) {
    return hot
      ? `rgba(246, 255, 225, ${alpha})`
      : `rgba(166, 255, 27, ${alpha})`;
  }

  function drawStaticCircuitBed(context) {
    context.save();
    context.globalCompositeOperation = "lighter";
    context.lineCap = "round";
    context.lineJoin = "round";

    for (const track of tracks) {
      context.strokeStyle = "rgba(91, 200, 0, 0.10)";
      context.lineWidth = track === perimeter ? 5 : 3;
      track.stroke(context);
    }
    context.restore();
  }

  function drawFlowBlob(context, sample, radius, alpha, stretch = 2.8) {
    context.save();
    context.translate(sample.x, sample.y);
    context.rotate(Math.atan2(sample.ty, sample.tx));
    context.scale(stretch, 1);
    const gradient = context.createRadialGradient(0, 0, 0, 0, 0, radius);
    gradient.addColorStop(0, rgba(alpha, true));
    gradient.addColorStop(0.18, `rgba(214, 255, 107, ${alpha * 0.84})`);
    gradient.addColorStop(0.5, `rgba(108, 239, 0, ${alpha * 0.42})`);
    gradient.addColorStop(1, "rgba(40, 142, 0, 0)");
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(0, 0, radius, 0, TAU);
    context.fill();
    context.restore();
  }

  function drawLiquidEnergy(context, phase) {
    context.save();
    context.globalCompositeOperation = "lighter";

    const lanes = [
      { track: perimeter, count: 7, speed: 1, radius: 30, alpha: 0.28, offset: 0.03 },
      { track: leftRail, count: 5, speed: 2, radius: 26, alpha: 0.34, offset: 0.09 },
      { track: rightRail, count: 5, speed: -2, radius: 26, alpha: 0.34, offset: 0.14 },
      { track: topReservoir, count: 4, speed: 2, radius: 34, alpha: 0.32, offset: 0.21 },
      { track: bottomLeft, count: 3, speed: 2, radius: 30, alpha: 0.31, offset: 0.27 },
      { track: bottomRight, count: 3, speed: 2, radius: 30, alpha: 0.31, offset: 0.61 },
    ];

    for (const lane of lanes) {
      for (let index = 0; index < lane.count; index += 1) {
        const progress = fract(lane.offset + index / lane.count + phase * lane.speed);
        const sample = lane.track.sample(progress);
        const wave = 0.76 + 0.24 * Math.sin(TAU * (phase * 4 + index / lane.count));
        const lateral = Math.sin(TAU * (phase * lane.speed + index / lane.count)) * 7;
        drawFlowBlob(context, {
          ...sample,
          x: sample.x + sample.nx * lateral,
          y: sample.y + sample.ny * lateral,
        }, lane.radius * wave, lane.alpha, 4.1);
      }
    }

    context.restore();
  }

  function drawRailScanners(context, phase) {
    const scanners = [
      { track: perimeter, speed: 1, offset: 0.16, width: 28 },
      { track: perimeter, speed: 1, offset: 0.66, width: 28 },
      { track: leftRail, speed: 2, offset: 0.02, width: 34 },
      { track: leftRail, speed: 2, offset: 0.52, width: 34 },
      { track: rightRail, speed: -2, offset: 0.24, width: 34 },
      { track: rightRail, speed: -2, offset: 0.74, width: 34 },
      { track: topReservoir, speed: 2, offset: 0.38, width: 30 },
      { track: bottomLeft, speed: 2, offset: 0.44, width: 30 },
      { track: bottomRight, speed: 2, offset: 0.82, width: 30 },
    ];

    context.save();
    context.globalCompositeOperation = "lighter";
    context.lineCap = "round";

    for (const scanner of scanners) {
      const direction = scanner.speed < 0 ? -1 : 1;
      const head = fract(scanner.offset + phase * scanner.speed);

      for (let index = 10; index >= 0; index -= 1) {
        const strength = 1 - index / 11;
        const progress = head - direction * index * 0.0065;
        const sample = scanner.track.sample(scanner.track.closed ? fract(progress) : clamp01(progress));
        const halfWidth = scanner.width * (0.45 + strength * 0.55);

        context.shadowColor = strength > 0.78 ? "#f4ffdf" : "#8cff00";
        context.shadowBlur = 8 + strength * 18;
        context.strokeStyle = strength > 0.78
          ? `rgba(251, 255, 239, ${0.38 + strength * 0.58})`
          : `rgba(158, 255, 18, ${strength * strength * 0.62})`;
        context.lineWidth = 2.5 + strength * 5.5;
        context.beginPath();
        context.moveTo(sample.x - sample.nx * halfWidth, sample.y - sample.ny * halfWidth);
        context.lineTo(sample.x + sample.nx * halfWidth, sample.y + sample.ny * halfWidth);
        context.stroke();
      }
    }

    context.restore();
  }

  function drawComet(context, track, progress, options = {}) {
    const tailCount = options.tailCount ?? 26;
    const tailSpan = options.tailSpan ?? 0.095;
    const radius = options.radius ?? 8;
    const reverse = options.reverse ?? false;
    const direction = reverse ? -1 : 1;

    context.save();
    context.globalCompositeOperation = "lighter";

    for (let index = tailCount - 1; index >= 0; index -= 1) {
      const amount = 1 - index / tailCount;
      const tailProgress = progress - direction * (index / tailCount) * tailSpan;
      const sample = track.sample(track.closed ? fract(tailProgress) : clamp01(tailProgress));
      const size = radius * (0.28 + amount * 0.72);
      const alpha = amount * amount * 0.94;

      context.fillStyle = rgba(alpha, index < 4);
      context.shadowColor = index < 5 ? "#ecffd0" : "#85ff00";
      context.shadowBlur = 6 + amount * 15;
      context.beginPath();
      context.arc(sample.x, sample.y, size, 0, TAU);
      context.fill();
    }

    const head = track.sample(track.closed ? fract(progress) : clamp01(progress));
    context.shadowColor = "#f5ffe2";
    context.shadowBlur = 24;
    context.fillStyle = "rgba(255, 255, 244, 0.98)";
    context.beginPath();
    context.arc(head.x, head.y, radius * 0.8, 0, TAU);
    context.fill();
    context.restore();
  }

  function drawCircuitTraffic(context, phase) {
    const traffic = [
      { track: perimeter, speed: 1, offset: 0.00, radius: 8.8, span: 0.078 },
      { track: perimeter, speed: 1, offset: 0.50, radius: 8.2, span: 0.072 },
      { track: topLeft, speed: 2, offset: 0.04, radius: 8.4, span: 0.18 },
      { track: topRight, speed: 2, offset: 0.28, radius: 8.4, span: 0.18 },
      { track: leftRail, speed: 1, offset: 0.16, radius: 9.2, span: 0.11 },
      { track: rightRail, speed: -1, offset: 0.66, radius: 9.2, span: 0.11 },
      { track: bottomLeft, speed: 2, offset: 0.12, radius: 8.8, span: 0.15 },
      { track: bottomRight, speed: 2, offset: 0.62, radius: 8.8, span: 0.15 },
      { track: topReservoir, speed: 2, offset: 0.48, radius: 8.2, span: 0.12 },
    ];

    for (const item of traffic) {
      drawComet(context, item.track, fract(item.offset + phase * item.speed), {
        radius: item.radius,
        tailSpan: item.span,
        reverse: item.speed < 0,
      });
    }
  }

  function drawParticles(context, phase) {
    context.save();
    context.globalCompositeOperation = "lighter";

    for (const particle of particles) {
      const progress = fract(particle.offset + phase * particle.speed);
      const sample = particle.track.sample(progress);
      const x = sample.x + sample.nx * particle.lane;
      const y = sample.y + sample.ny * particle.lane;
      const shimmer = 0.68 + 0.32 * Math.sin(particle.twinkle + phase * TAU * 6);
      const radius = particle.radius * shimmer;

      context.shadowColor = particle.hue > 0.7 ? "#efffd1" : "#8cff00";
      context.shadowBlur = 5 + radius * 1.8;
      context.fillStyle = particle.hue > 0.7
        ? `rgba(244, 255, 223, ${0.62 + shimmer * 0.30})`
        : `rgba(151, 255, 19, ${0.52 + shimmer * 0.30})`;
      context.beginPath();
      context.arc(x, y, radius, 0, TAU);
      context.fill();
    }

    context.restore();
  }

  function drawNodeSparks(context, phase) {
    context.save();
    context.globalCompositeOperation = "lighter";
    context.lineCap = "round";

    for (const node of nodePositions) {
      const nodePhase = fract(phase * 3 + node.delay);
      const ring = 7 + nodePhase * 24;
      const ringAlpha = (1 - nodePhase) * 0.55;

      context.strokeStyle = `rgba(218, 255, 115, ${ringAlpha})`;
      context.lineWidth = 2.2;
      context.shadowColor = "#9cff00";
      context.shadowBlur = 12;
      context.beginPath();
      context.arc(node.x, node.y, ring, 0, TAU);
      context.stroke();

      for (let sparkIndex = 0; sparkIndex < 4; sparkIndex += 1) {
        const sparkPhase = fract(nodePhase + sparkIndex * 0.22);
        const angle = sparkIndex * (TAU / 4) + node.delay * TAU + phase * TAU;
        const distance = 8 + sparkPhase * 38;
        const x = node.x + Math.cos(angle) * distance;
        const y = node.y + Math.sin(angle) * distance;
        const alpha = (1 - sparkPhase) * 0.9;

        context.fillStyle = rgba(alpha, sparkIndex === 0);
        context.beginPath();
        context.arc(x, y, 2.5 + (1 - sparkPhase) * 2.4, 0, TAU);
        context.fill();
      }
    }

    context.restore();
  }

  function arcWindow(phase, start, duration) {
    let local = phase - start;
    if (local < 0) local += 1;
    return local >= 0 && local <= duration ? local / duration : -1;
  }

  function hashNoise(value) {
    const sine = Math.sin(value * 127.1) * 43758.5453123;
    return fract(sine) * 2 - 1;
  }

  function drawArc(context, from, to, amount, seed) {
    if (amount < 0) return;

    const travel = smoothstep(0.02, 0.68, amount);
    const fade = 1 - smoothstep(0.72, 1, amount);
    const end = {
      x: mix(from.x, to.x, travel),
      y: mix(from.y, to.y, travel),
    };
    const dx = end.x - from.x;
    const dy = end.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length;
    const ny = dx / length;
    const steps = Math.max(8, Math.floor(length / 16));
    const jitterFrame = Math.floor(amount * 52);

    const path = new Path2D();
    path.moveTo(from.x, from.y);
    for (let index = 1; index < steps; index += 1) {
      const ratio = index / steps;
      const envelope = Math.sin(Math.PI * ratio);
      const jitter = hashNoise(seed * 97 + jitterFrame * 17 + index * 13) * 11 * envelope;
      path.lineTo(
        mix(from.x, end.x, ratio) + nx * jitter,
        mix(from.y, end.y, ratio) + ny * jitter,
      );
    }
    path.lineTo(end.x, end.y);

    context.save();
    context.globalCompositeOperation = "lighter";
    context.lineCap = "round";
    context.lineJoin = "round";
    context.shadowColor = "#8dff00";
    context.shadowBlur = 24;
    context.strokeStyle = `rgba(94, 255, 0, ${0.32 * fade})`;
    context.lineWidth = 12;
    context.stroke(path);
    context.shadowBlur = 13;
    context.strokeStyle = `rgba(190, 255, 55, ${0.72 * fade})`;
    context.lineWidth = 5;
    context.stroke(path);
    context.shadowBlur = 5;
    context.strokeStyle = `rgba(255, 255, 238, ${0.96 * fade})`;
    context.lineWidth = 1.8;
    context.stroke(path);
    context.restore();
  }

  function drawElectricalArcs(context, phase) {
    const arcs = [
      { from: { x: 180, y: 134 }, to: { x: 448, y: 214 }, start: 0.05, duration: 0.085 },
      { from: { x: 900, y: 134 }, to: { x: 632, y: 214 }, start: 0.21, duration: 0.085 },
      { from: { x: 116, y: 608 }, to: { x: 104, y: 780 }, start: 0.37, duration: 0.075 },
      { from: { x: 964, y: 608 }, to: { x: 974, y: 790 }, start: 0.52, duration: 0.075 },
      { from: { x: 108, y: 1780 }, to: { x: 355, y: 1800 }, start: 0.68, duration: 0.09 },
      { from: { x: 972, y: 1780 }, to: { x: 725, y: 1800 }, start: 0.84, duration: 0.09 },
    ];

    arcs.forEach((arc, index) => {
      drawArc(context, arc.from, arc.to, arcWindow(phase, arc.start, arc.duration), index + 1);
    });
  }

  function pulse(center, halfWidth, phase) {
    let distance = Math.abs(phase - center);
    distance = Math.min(distance, 1 - distance);
    if (distance >= halfWidth) return 0;
    const normalized = 1 - distance / halfWidth;
    return Math.sin(normalized * Math.PI * 0.5) ** 3;
  }

  function eyeBlinkAmount(phase) {
    return Math.max(
      pulse(0.348, 0.018, phase),
      pulse(0.760, 0.016, phase),
      pulse(0.789, 0.014, phase),
    );
  }

  function tracePolygon(context, points) {
    context.beginPath();
    context.moveTo(points[0][0], points[0][1]);
    for (let index = 1; index < points.length; index += 1) {
      context.lineTo(points[index][0], points[index][1]);
    }
    context.closePath();
  }

  function drawEye(context, eye, phase, blink) {
    const { center, points, direction } = eye;
    const energyX = center.x + Math.sin(phase * TAU * 3 + direction) * 5;
    const energyY = center.y + Math.cos(phase * TAU * 2 + direction) * 2.5;

    context.save();
    tracePolygon(context, points);
    context.clip();
    context.globalCompositeOperation = "lighter";
    context.translate(energyX, energyY);
    context.scale(1.15, 1.55);
    const iris = context.createRadialGradient(0, 0, 0, 0, 0, 17);
    iris.addColorStop(0, `rgba(255, 255, 240, ${0.96 * (1 - blink)})`);
    iris.addColorStop(0.18, `rgba(213, 255, 76, ${0.95 * (1 - blink)})`);
    iris.addColorStop(0.5, `rgba(121, 255, 0, ${0.72 * (1 - blink)})`);
    iris.addColorStop(1, "rgba(54, 185, 0, 0)");
    context.fillStyle = iris;
    context.beginPath();
    context.arc(0, 0, 17, 0, TAU);
    context.fill();
    context.restore();

    if (blink <= 0.002) return;

    const minY = 199;
    const maxY = 241;
    const gap = (maxY - minY) * (1 - blink);
    const upperEdge = center.y - gap / 2;
    const lowerEdge = center.y + gap / 2;

    context.save();
    tracePolygon(context, points);
    context.clip();
    const lidGradient = context.createLinearGradient(0, minY, 0, maxY);
    lidGradient.addColorStop(0, "rgba(4, 8, 5, 0.98)");
    lidGradient.addColorStop(0.48, "rgba(15, 22, 13, 0.99)");
    lidGradient.addColorStop(0.52, "rgba(7, 12, 7, 0.99)");
    lidGradient.addColorStop(1, "rgba(2, 5, 3, 0.99)");
    context.fillStyle = lidGradient;
    context.fillRect(438, minY - 3, 204, upperEdge - minY + 3);
    context.fillRect(438, lowerEdge, 204, maxY - lowerEdge + 3);

    context.lineCap = "round";
    context.shadowColor = "rgba(138, 255, 24, 0.55)";
    context.shadowBlur = 5;
    context.strokeStyle = `rgba(91, 145, 37, ${0.34 + blink * 0.28})`;
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(points[0][0], upperEdge);
    context.quadraticCurveTo(center.x, upperEdge + direction * 1.5, points[2][0], upperEdge);
    context.stroke();
    context.beginPath();
    context.moveTo(points[4][0], lowerEdge);
    context.quadraticCurveTo(center.x, lowerEdge - direction * 1.5, points[3][0], lowerEdge);
    context.stroke();
    context.restore();
  }

  function render(phase) {
    effects.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    drawStaticCircuitBed(effects);
    drawLiquidEnergy(effects, phase);
    drawRailScanners(effects, phase);
    drawCircuitTraffic(effects, phase);
    drawParticles(effects, phase);
    drawNodeSparks(effects, phase);
    drawElectricalArcs(effects, phase);

    effects.save();
    effects.globalCompositeOperation = "destination-in";
    effects.drawImage(mask, 0, 0, WIDTH, HEIGHT);
    effects.restore();

    ctx.drawImage(effectsCanvas, 0, 0);

    const blink = eyeBlinkAmount(phase);
    for (const eye of eyeShapes) {
      drawEye(ctx, eye, phase, blink);
    }
  }

  function readFixedPhase() {
    const value = searchParams.get("phase");
    if (value === null || value.trim() === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? fract(parsed) : null;
  }

  let startedAt = 0;
  let lastFrameAt = -Infinity;
  const fixedPhase = readFixedPhase();

  function animate(now) {
    if (!startedAt) startedAt = now;
    if (now - lastFrameAt >= TARGET_FRAME_MS) {
      render(fract((now - startedAt) / LOOP_MS));
      lastFrameAt = now;
    }
    window.requestAnimationFrame(animate);
  }

  mask.addEventListener("load", () => {
    if (fixedPhase !== null) {
      render(fixedPhase);
      document.documentElement.dataset.xfgReady = "true";
      return;
    }

    render(0);
    document.documentElement.dataset.xfgReady = "true";
    window.requestAnimationFrame(animate);
  }, { once: true });

  mask.addEventListener("error", () => {
    console.error("XFG overlay glow mask failed to load.");
  }, { once: true });

  mask.src = "./xfg-tiktok-lime-glow-mask.png?v=9";

  window.XFGOverlay = Object.freeze({
    width: WIDTH,
    height: HEIGHT,
    loopDurationMs: LOOP_MS,
    version: 9,
  });
})();
