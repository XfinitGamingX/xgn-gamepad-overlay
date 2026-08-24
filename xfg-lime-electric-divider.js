(() => {
  "use strict";

  const WIDTH = 1080;
  const HEIGHT = 240;
  const BASE_LOOP_MS = 4000;
  const TARGET_FRAME_MS = 1000 / 30;
  const WATCHDOG_INTERVAL_MS = 750;
  const STALE_FRAME_MS = 1400;
  const TAU = Math.PI * 2;
  const params = new URLSearchParams(window.location.search);
  const requestedSpeed = Number(params.get("speed"));
  const speed = params.has("speed") && Number.isFinite(requestedSpeed)
    ? Math.max(0.65, Math.min(2.5, requestedSpeed))
    : 1;
  const LOOP_MS = BASE_LOOP_MS / speed;
  const clamp01 = (value) => Math.max(0, Math.min(1, value));
  const fract = (value) => value - Math.floor(value);
  const mix = (from, to, amount) => from + (to - from) * amount;
  const smoothstep = (from, to, value) => {
    const amount = clamp01((value - from) / (to - from));
    return amount * amount * (3 - 2 * amount);
  };

  document.documentElement.dataset.xfgVersion = "1";
  document.documentElement.dataset.xfgSpeed = String(speed);
  document.documentElement.dataset.xfgLoopMs = String(LOOP_MS);
  document.documentElement.style.setProperty("--xfg-packet-duration", `${LOOP_MS / 2}ms`);

  if (params.get("preview") === "checker") {
    document.documentElement.dataset.xfgPreview = "checker";
  }

  function readFixedPhase() {
    if (params.get("preview") !== "checker" && params.get("qa") !== "1") return null;
    const raw = params.get("phase");
    if (raw === null || raw.trim() === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? fract(value) : null;
  }

  const fixedPhase = readFixedPhase();
  if (fixedPhase !== null) {
    document.documentElement.style.setProperty("--xfg-preview-delay", `${-fixedPhase * LOOP_MS}ms`);
    document.documentElement.style.setProperty("--xfg-preview-play-state", "paused");
  }

  const canvas = document.getElementById("xfg-divider-canvas");

  function acquireContext() {
    try {
      return canvas.getContext("2d", { alpha: true, desynchronized: true })
        || canvas.getContext("2d", { alpha: true });
    } catch (error) {
      console.warn("XFG divider optimized canvas unavailable; using CSS fallback.", error);
      return canvas.getContext("2d", { alpha: true });
    }
  }

  let ctx = acquireContext();
  if (!ctx) {
    document.documentElement.dataset.xfgState = "css-failsafe";
    document.documentElement.dataset.xfgReady = "true";
    return;
  }

  const leftCore = { startX: 61, endX: 480, direction: -1 };
  const rightCore = { startX: 600, endX: 1019, direction: 1 };
  const secondaryTracks = [
    [[75, 105], [198, 105], [210, 111], [448, 111]],
    [[75, 135], [198, 135], [210, 129], [448, 129]],
    [[1005, 105], [882, 105], [870, 111], [632, 111]],
    [[1005, 135], [882, 135], [870, 129], [632, 129]],
  ];

  const sparks = Array.from({ length: 28 }, (_, index) => ({
    side: index % 2,
    delay: fract(index * 0.381966),
    lane: index % 3 - 1,
    radius: 1.1 + ((index * 17) % 9) / 6,
    lift: 14 + ((index * 29) % 24),
  }));

  function tracePolygon(context, points) {
    context.beginPath();
    context.moveTo(points[0][0], points[0][1]);
    for (let index = 1; index < points.length; index += 1) {
      context.lineTo(points[index][0], points[index][1]);
    }
    context.closePath();
  }

  function traceRoundedRect(context, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.arcTo(x + width, y, x + width, y + r, r);
    context.lineTo(x + width, y + height - r);
    context.arcTo(x + width, y + height, x + width - r, y + height, r);
    context.lineTo(x + r, y + height);
    context.arcTo(x, y + height, x, y + height - r, r);
    context.lineTo(x, y + r);
    context.arcTo(x, y, x + r, y, r);
    context.closePath();
  }

  function railY(x, phase, sideOffset = 0) {
    const ratio = clamp01((x - 61) / 958);
    const edgeEnvelope = Math.sin(Math.PI * ratio);
    const movingKink = Math.sin(ratio * TAU * 13 - phase * TAU * 5 + sideOffset) * 1.8;
    const fineCurrent = Math.sin(ratio * TAU * 29 + phase * TAU * 7 + sideOffset * 1.7) * 0.9;
    return 120 + (movingKink + fineCurrent) * edgeEnvelope;
  }

  function traceCore(context, startX, endX, phase, sideOffset = 0) {
    const distance = Math.abs(endX - startX);
    const steps = Math.max(3, Math.ceil(distance / 13));
    context.beginPath();
    context.moveTo(startX, railY(startX, phase, sideOffset));
    for (let index = 1; index <= steps; index += 1) {
      const x = mix(startX, endX, index / steps);
      context.lineTo(x, railY(x, phase, sideOffset));
    }
  }

  function drawRailPlate(context, mirror = false) {
    const points = mirror
      ? [[1038, 120], [1021, 112], [610, 112], [592, 120], [610, 128], [1021, 128]]
      : [[42, 120], [59, 112], [470, 112], [488, 120], [470, 128], [59, 128]];
    tracePolygon(context, points);
    const plate = context.createLinearGradient(0, 108, 0, 132);
    plate.addColorStop(0, "rgba(12, 28, 12, 0.88)");
    plate.addColorStop(0.5, "rgba(3, 10, 5, 0.94)");
    plate.addColorStop(1, "rgba(8, 20, 9, 0.88)");
    context.fillStyle = plate;
    context.fill();
    context.strokeStyle = "rgba(104, 230, 0, 0.34)";
    context.lineWidth = 1.2;
    context.stroke();
  }

  function drawSecondaryTracks(context) {
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    context.shadowColor = "rgba(104, 230, 0, 0.32)";
    context.shadowBlur = 5;
    context.strokeStyle = "rgba(102, 201, 43, 0.62)";
    context.lineWidth = 1.25;
    for (const points of secondaryTracks) {
      context.beginPath();
      context.moveTo(points[0][0], points[0][1]);
      for (let index = 1; index < points.length; index += 1) {
        context.lineTo(points[index][0], points[index][1]);
      }
      context.stroke();
    }
    context.restore();
  }

  function samplePolyline(points, progress) {
    const segments = [];
    let total = 0;
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
      segments.push({ start, end, length, offset: total });
      total += length;
    }
    const target = clamp01(progress) * total;
    let active = segments[segments.length - 1];
    for (const segment of segments) {
      if (target <= segment.offset + segment.length) {
        active = segment;
        break;
      }
    }
    const local = active.length ? clamp01((target - active.offset) / active.length) : 0;
    return {
      x: mix(active.start[0], active.end[0], local),
      y: mix(active.start[1], active.end[1], local),
    };
  }

  function drawTrackTraffic(context, phase) {
    context.save();
    context.globalCompositeOperation = "lighter";
    for (let index = 0; index < secondaryTracks.length; index += 1) {
      const track = secondaryTracks[index];
      const fromCenter = index < 2 ? [...track].reverse() : [...track].reverse();
      const progress = fract(phase * 2 + index * 0.23 + 0.16);
      const point = samplePolyline(fromCenter, progress);
      const glow = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, 7);
      glow.addColorStop(0, "rgba(241, 255, 226, 0.95)");
      glow.addColorStop(0.35, "rgba(157, 255, 37, 0.72)");
      glow.addColorStop(1, "rgba(104, 230, 0, 0)");
      context.fillStyle = glow;
      context.beginPath();
      context.arc(point.x, point.y, 7, 0, TAU);
      context.fill();
    }
    context.restore();
  }

  function drawCore(context, core, phase, sideOffset) {
    context.save();
    context.globalCompositeOperation = "lighter";
    context.lineCap = "round";
    context.lineJoin = "round";
    traceCore(context, core.startX, core.endX, phase, sideOffset);
    context.shadowColor = "#7eff00";
    context.shadowBlur = 14;
    context.strokeStyle = "rgba(126, 255, 0, 0.24)";
    context.lineWidth = 16;
    context.stroke();
    context.shadowBlur = 8;
    context.strokeStyle = "rgba(104, 230, 0, 0.94)";
    context.lineWidth = 5;
    context.stroke();
    context.shadowBlur = 4;
    context.strokeStyle = "rgba(183, 255, 60, 0.98)";
    context.lineWidth = 2.2;
    context.stroke();
    context.shadowBlur = 2;
    context.strokeStyle = "rgba(241, 255, 226, 0.96)";
    context.lineWidth = 0.9;
    context.stroke();
    context.restore();
  }

  function drawEndpoint(context, mirror = false) {
    const direction = mirror ? -1 : 1;
    const x = mirror ? 1038 : 42;
    const innerX = x + direction * 17;
    const farX = x + direction * 59;
    context.save();
    context.globalCompositeOperation = "lighter";
    context.lineCap = "round";
    context.lineJoin = "round";
    context.shadowColor = "#8dff00";
    context.shadowBlur = 8;
    context.strokeStyle = "rgba(149, 255, 32, 0.88)";
    context.lineWidth = 2.25;
    context.beginPath();
    context.moveTo(x, 120);
    context.lineTo(innerX, 103);
    context.lineTo(farX, 103);
    context.moveTo(x, 120);
    context.lineTo(innerX, 137);
    context.lineTo(farX, 137);
    context.stroke();
    const node = context.createRadialGradient(x, 120, 0, x, 120, 11);
    node.addColorStop(0, "rgba(241, 255, 226, 1)");
    node.addColorStop(0.28, "rgba(183, 255, 60, 0.96)");
    node.addColorStop(0.58, "rgba(104, 230, 0, 0.55)");
    node.addColorStop(1, "rgba(104, 230, 0, 0)");
    context.fillStyle = node;
    context.beginPath();
    context.arc(x, 120, 11, 0, TAU);
    context.fill();
    context.restore();
  }

  function packetEnvelope(progress) {
    return smoothstep(0, 0.05, progress) * (1 - smoothstep(0.9, 1, progress));
  }

  function drawPacket(context, core, progress, phase, length, size, intensity, sideOffset) {
    const outwardStart = core.direction < 0 ? core.endX : core.startX;
    const outwardEnd = core.direction < 0 ? core.startX : core.endX;
    const headX = mix(outwardStart, outwardEnd, smoothstep(0, 1, progress));
    const trailX = headX - core.direction * length;
    const boundedTrail = core.direction < 0
      ? Math.min(core.endX, trailX)
      : Math.max(core.startX, trailX);
    const alpha = packetEnvelope(progress) * intensity;
    if (alpha <= 0.002) return;

    context.save();
    context.globalCompositeOperation = "lighter";
    context.lineCap = "round";
    context.lineJoin = "round";
    traceCore(context, boundedTrail, headX, phase, sideOffset);
    const trail = context.createLinearGradient(boundedTrail, 0, headX, 0);
    trail.addColorStop(0, "rgba(104, 230, 0, 0)");
    trail.addColorStop(0.7, `rgba(157, 255, 37, ${alpha * 0.82})`);
    trail.addColorStop(1, `rgba(241, 255, 226, ${alpha})`);
    context.shadowColor = "#8dff00";
    context.shadowBlur = 16;
    context.strokeStyle = trail;
    context.lineWidth = size;
    context.stroke();

    const headY = railY(headX, phase, sideOffset);
    const glow = context.createRadialGradient(headX, headY, 0, headX, headY, size * 2.3);
    glow.addColorStop(0, `rgba(255, 255, 240, ${alpha})`);
    glow.addColorStop(0.24, `rgba(183, 255, 60, ${alpha * 0.96})`);
    glow.addColorStop(0.56, `rgba(104, 230, 0, ${alpha * 0.48})`);
    glow.addColorStop(1, "rgba(104, 230, 0, 0)");
    context.fillStyle = glow;
    context.beginPath();
    context.arc(headX, headY, size * 2.3, 0, TAU);
    context.fill();
    context.restore();
  }

  function drawBranch(context, x, y, direction, lift, phase, seed, alpha) {
    const endX = x + direction * 64;
    const endY = y + lift;
    const dx = endX - x;
    const dy = endY - y;
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length;
    const ny = dx / length;
    context.save();
    context.globalCompositeOperation = "lighter";
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(x, y);
    for (let index = 1; index < 7; index += 1) {
      const ratio = index / 7;
      const jitter = Math.sin(seed * 9.7 + index * 12.3 + phase * TAU * 11) * 7 * Math.sin(Math.PI * ratio);
      context.lineTo(x + dx * ratio + nx * jitter, y + dy * ratio + ny * jitter);
    }
    context.lineTo(endX, endY);
    context.shadowColor = "#8dff00";
    context.shadowBlur = 10;
    context.strokeStyle = `rgba(157, 255, 37, ${alpha * 0.72})`;
    context.lineWidth = 3.2;
    context.stroke();
    context.shadowBlur = 4;
    context.strokeStyle = `rgba(241, 255, 226, ${alpha})`;
    context.lineWidth = 1.1;
    context.stroke();
    context.restore();
  }

  function drawBranchArcs(context, phase, primaryProgress) {
    const event = Math.sin(primaryProgress * Math.PI * 6) ** 12;
    if (event < 0.08 || primaryProgress < 0.12 || primaryProgress > 0.88) return;
    const leftX = mix(leftCore.endX, leftCore.startX, primaryProgress);
    const rightX = mix(rightCore.startX, rightCore.endX, primaryProgress);
    drawBranch(context, leftX, railY(leftX, phase, 0.4), -1, primaryProgress < 0.5 ? -34 : 31, phase, 2, event);
    drawBranch(context, rightX, railY(rightX, phase, 1.2), 1, primaryProgress < 0.5 ? 33 : -30, phase, 5, event);
  }

  function dischargeAmount(phase) {
    const local = fract(phase * 2);
    return 1 - smoothstep(0, 0.18, local);
  }

  function drawPowerCell(context, phase) {
    const discharge = dischargeAmount(phase);
    const glowBeat = 0.55 + 0.45 * Math.cos(phase * TAU * 2);
    const outer = [[488, 120], [508, 98], [572, 98], [592, 120], [572, 142], [508, 142]];
    const inner = [[500, 120], [515, 104], [565, 104], [580, 120], [565, 136], [515, 136]];

    context.save();
    tracePolygon(context, outer);
    const shell = context.createLinearGradient(0, 96, 0, 144);
    shell.addColorStop(0, "rgba(12, 28, 13, 0.98)");
    shell.addColorStop(0.52, "rgba(2, 8, 4, 0.99)");
    shell.addColorStop(1, "rgba(8, 19, 9, 0.98)");
    context.fillStyle = shell;
    context.fill();
    context.strokeStyle = "rgba(55, 106, 29, 0.96)";
    context.lineWidth = 1.5;
    context.stroke();

    tracePolygon(context, inner);
    context.shadowColor = "#8dff00";
    context.shadowBlur = 8 + glowBeat * 5;
    context.strokeStyle = "rgba(157, 255, 37, 0.94)";
    context.lineWidth = 2;
    context.stroke();

    const spread = 5.5 * discharge;
    context.shadowBlur = 8;
    context.strokeStyle = "rgba(185, 255, 81, 0.92)";
    context.lineWidth = 2.1;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(532 - spread, 111);
    context.lineTo(522 - spread, 120);
    context.lineTo(532 - spread, 129);
    context.moveTo(548 + spread, 111);
    context.lineTo(558 + spread, 120);
    context.lineTo(548 + spread, 129);
    context.stroke();

    const capsuleWidth = 14 + 18 * discharge;
    const capsuleX = 540 - capsuleWidth / 2;
    const capsule = context.createLinearGradient(capsuleX, 0, capsuleX + capsuleWidth, 0);
    capsule.addColorStop(0, "rgba(157, 255, 37, 0.72)");
    capsule.addColorStop(0.5, "rgba(241, 255, 226, 1)");
    capsule.addColorStop(1, "rgba(157, 255, 37, 0.72)");
    context.fillStyle = capsule;
    context.shadowColor = "#9dff25";
    context.shadowBlur = 12;
    traceRoundedRect(context, capsuleX, 116.5, capsuleWidth, 7, 3.5);
    context.fill();
    context.restore();
  }

  function drawSparks(context, phase) {
    context.save();
    context.globalCompositeOperation = "lighter";
    for (const spark of sparks) {
      const progress = fract(phase * 2 + spark.delay);
      const core = spark.side ? rightCore : leftCore;
      const start = core.direction < 0 ? core.endX : core.startX;
      const end = core.direction < 0 ? core.startX : core.endX;
      const x = mix(start, end, progress);
      const direction = (spark.lane || (spark.side ? 1 : -1));
      const lift = Math.sin(Math.PI * progress) * spark.lift * direction;
      const y = railY(x, phase, spark.delay * TAU) + lift;
      const alpha = Math.sin(Math.PI * progress) * 0.72;
      context.fillStyle = `rgba(${spark.radius > 2 ? "241, 255, 226" : "157, 255, 37"}, ${alpha})`;
      context.shadowColor = "#8dff00";
      context.shadowBlur = spark.radius * 4;
      context.beginPath();
      context.arc(x, y, spark.radius, 0, TAU);
      context.fill();
    }
    context.restore();
  }

  function render(phase) {
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    drawRailPlate(ctx, false);
    drawRailPlate(ctx, true);
    drawSecondaryTracks(ctx);
    drawCore(ctx, leftCore, phase, 0.4);
    drawCore(ctx, rightCore, phase, 1.2);
    drawEndpoint(ctx, false);
    drawEndpoint(ctx, true);
    drawTrackTraffic(ctx, phase);

    const primary = fract(phase * 2);
    const secondary = fract(phase * 2 + 0.58);
    drawPacket(ctx, leftCore, primary, phase, 92, 7.5, 1, 0.4);
    drawPacket(ctx, rightCore, primary, phase, 92, 7.5, 1, 1.2);
    drawPacket(ctx, leftCore, secondary, phase, 48, 4.2, 0.68, 0.4);
    drawPacket(ctx, rightCore, secondary, phase, 48, 4.2, 0.68, 1.2);
    drawBranchArcs(ctx, phase, primary);
    drawSparks(ctx, phase);
    drawPowerCell(ctx, phase);
  }

  let animationEpochWall = Date.now();
  let lastPaintWall = 0;
  let lastFrameWall = -Infinity;
  let rafId = 0;
  let watchdogId = 0;
  let contextReady = true;
  let lastErrorWall = 0;

  function livePhase() {
    return fract((Date.now() - animationEpochWall) / LOOP_MS);
  }

  function paint(phase) {
    try {
      render(phase);
      lastPaintWall = Date.now();
      document.documentElement.dataset.xfgState = "running";
      document.documentElement.dataset.xfgReady = "true";
      return true;
    } catch (error) {
      document.documentElement.dataset.xfgState = "canvas-error-css-failsafe";
      const now = Date.now();
      if (now - lastErrorWall > 5000) {
        console.error("XFG divider canvas recovered through its CSS fallback.", error);
        lastErrorWall = now;
      }
      return false;
    }
  }

  function publishCanvasMetrics() {
    const pixels = ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
    let minX = WIDTH;
    let minY = HEIGHT;
    let maxX = -1;
    let maxY = -1;
    let visible = 0;
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const alpha = pixels[(y * WIDTH + x) * 4 + 3];
        if (alpha === 0) continue;
        visible += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    const cornerAlpha = [
      pixels[3],
      pixels[(WIDTH - 1) * 4 + 3],
      pixels[((HEIGHT - 1) * WIDTH) * 4 + 3],
      pixels[(HEIGHT * WIDTH - 1) * 4 + 3],
    ];
    document.documentElement.dataset.xfgCanvasBounds = [minX, minY, maxX, maxY].join(",");
    document.documentElement.dataset.xfgCornerAlpha = cornerAlpha.join(",");
    document.documentElement.dataset.xfgTransparentPercent = String(
      Math.round(((WIDTH * HEIGHT - visible) / (WIDTH * HEIGHT)) * 100000) / 1000,
    );
  }

  function animationFrame(timestamp) {
    rafId = 0;
    if (!contextReady || fixedPhase !== null) return;
    if (timestamp - lastFrameWall >= TARGET_FRAME_MS - 1.5) {
      paint(livePhase());
      lastFrameWall = timestamp;
    }
    rafId = requestAnimationFrame(animationFrame);
  }

  function ensureAnimation() {
    if (!contextReady || fixedPhase !== null) return;
    const now = Date.now();
    if (now - lastPaintWall > STALE_FRAME_MS) paint(livePhase());
    if (!rafId) rafId = requestAnimationFrame(animationFrame);
  }

  function restartAnimation() {
    if (fixedPhase !== null) {
      paint(fixedPhase);
      return;
    }
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    paint(livePhase());
    ensureAnimation();
  }

  canvas.addEventListener("contextlost", (event) => {
    event.preventDefault();
    contextReady = false;
    document.documentElement.dataset.xfgState = "context-lost-css-failsafe";
  });

  canvas.addEventListener("contextrestored", () => {
    ctx = acquireContext();
    contextReady = Boolean(ctx);
    if (contextReady) restartAnimation();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) restartAnimation();
  });
  window.addEventListener("pageshow", restartAnimation);
  window.addEventListener("focus", ensureAnimation);

  if (fixedPhase !== null) {
    paint(fixedPhase);
    publishCanvasMetrics();
  } else {
    paint(0);
    rafId = requestAnimationFrame(animationFrame);
    watchdogId = window.setInterval(ensureAnimation, WATCHDOG_INTERVAL_MS);
  }

  window.XFGDivider = Object.freeze({
    width: WIDTH,
    height: HEIGHT,
    loopDurationMs: LOOP_MS,
    speedMultiplier: speed,
    ensureRunning: ensureAnimation,
    version: 1,
    watchdogId,
  });
})();
