'use strict';

// ─── Canvas setup ────────────────────────────────────────────────────────────
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

let W, H, scale;

function resize() {
  W = canvas.width  = window.innerWidth;
  H = canvas.height = window.innerHeight;
  // base design at 1280×720; scale everything proportionally
  scale = Math.min(W / 1280, H / 720);
}
window.addEventListener('resize', resize);
resize();

// ─── Room geometry (in design-space, scaled at draw time) ────────────────────
// The room is defined as a 3/4 cutaway isometric-ish projection.
// All coords are in 1280×720 design space.
//
// Room corners (floor quad):
//   floorTL  floorTR   ← back edge of floor (where back wall meets floor)
//   floorBL  floorBR   ← front edge of floor (closest to viewer)
//
const ROOM = {
  // floor quad
  floorTL: { x: 260, y: 270 },
  floorTR: { x: 1020, y: 270 },
  floorBL: { x: 80,  y: 640 },
  floorBR: { x: 1200, y: 640 },

  // ceiling / top of back wall
  ceilTL: { x: 260, y: 60 },
  ceilTR: { x: 1020, y: 60 },

  // left wall top-inner edge (same x as floorTL, up to ceiling)
  leftWallTop: { x: 80, y: 130 },   // top of left side wall outer edge
  rightWallTop: { x: 1200, y: 130 },
};

// ─── Perspective helpers ──────────────────────────────────────────────────────
// Map a (u,v) in [0,1]×[0,1] floor space → screen XY via bilinear interp
function floorToScreen(u, v) {
  const { floorTL, floorTR, floorBL, floorBR } = ROOM;
  const tx = (1 - u) * (1 - v) * floorTL.x
           + u       * (1 - v) * floorTR.x
           + (1 - u) * v       * floorBL.x
           + u       * v       * floorBR.x;
  const ty = (1 - u) * (1 - v) * floorTL.y
           + u       * (1 - v) * floorTR.y
           + (1 - u) * v       * floorBL.y
           + u       * v       * floorBR.y;
  return { x: tx, y: ty };
}

// ─── Input ────────────────────────────────────────────────────────────────────
const keys = {};
window.addEventListener('keydown', e => { keys[e.key] = true; });
window.addEventListener('keyup',   e => { keys[e.key] = false; });

// ─── Player ───────────────────────────────────────────────────────────────────
const player = {
  u: 0.5,   // horizontal position in floor space [0..1]
  v: 0.75,  // depth position in floor space [0..1]  (0=back, 1=front)
  speed: 0.28,   // floor-space units per second
  facing: 'down', // 'left' | 'right' | 'up' | 'down'
};

// ─── Drawing helpers ──────────────────────────────────────────────────────────
function s(x) { return x * scale; }  // scale a design-space value

function sp(p) { return { x: p.x * scale, y: p.y * scale }; }

function roomPath(points) {
  ctx.beginPath();
  const p0 = sp(points[0]);
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < points.length; i++) {
    const p = sp(points[i]);
    ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
}

// ─── Room draw ────────────────────────────────────────────────────────────────

function drawRoom() {
  const { floorTL, floorTR, floorBL, floorBR,
          ceilTL, ceilTR, leftWallTop, rightWallTop } = ROOM;

  // ── Back wall ──────────────────────────────────────────────────────────────
  const backWallGrad = ctx.createLinearGradient(
    s(260), s(60), s(1020), s(270)
  );
  backWallGrad.addColorStop(0,   '#c8b99a');
  backWallGrad.addColorStop(0.4, '#d4c6a8');
  backWallGrad.addColorStop(1,   '#bfb090');

  roomPath([ceilTL, ceilTR, floorTR, floorTL]);
  ctx.fillStyle = backWallGrad;
  ctx.fill();

  // subtle horizontal wallpaper lines on back wall
  ctx.save();
  ctx.beginPath();
  roomPath([ceilTL, ceilTR, floorTR, floorTL]);
  ctx.clip();
  ctx.strokeStyle = 'rgba(160,140,110,0.35)';
  ctx.lineWidth = s(1);
  const lineCount = 14;
  for (let i = 0; i <= lineCount; i++) {
    const t = i / lineCount;
    const lx1 = ceilTL.x + (floorTL.x - ceilTL.x) * t;
    const ly1 = ceilTL.y + (floorTL.y - ceilTL.y) * t;
    const lx2 = ceilTR.x + (floorTR.x - ceilTR.x) * t;
    const ly2 = ceilTR.y + (floorTR.y - ceilTR.y) * t;
    ctx.beginPath();
    ctx.moveTo(s(lx1), s(ly1));
    ctx.lineTo(s(lx2), s(ly2));
    ctx.stroke();
  }
  ctx.restore();

  // ── Left side wall ─────────────────────────────────────────────────────────
  const leftGrad = ctx.createLinearGradient(s(80), s(130), s(260), s(270));
  leftGrad.addColorStop(0, '#9e9080');
  leftGrad.addColorStop(1, '#b5a690');

  roomPath([leftWallTop, ceilTL, floorTL, floorBL]);
  ctx.fillStyle = leftGrad;
  ctx.fill();

  // subtle vertical planks on left wall
  ctx.save();
  ctx.beginPath();
  roomPath([leftWallTop, ceilTL, floorTL, floorBL]);
  ctx.clip();
  ctx.strokeStyle = 'rgba(80,65,50,0.18)';
  ctx.lineWidth = s(1.2);
  const leftWallPlanks = 7;
  for (let i = 0; i <= leftWallPlanks; i++) {
    const t = i / leftWallPlanks;
    // interpolate top edge → bottom edge
    const tx1 = leftWallTop.x + (ceilTL.x - leftWallTop.x) * t;
    const ty1 = leftWallTop.y + (ceilTL.y - leftWallTop.y) * t;
    const tx2 = floorBL.x    + (floorTL.x - floorBL.x)    * t;
    const ty2 = floorBL.y    + (floorTL.y - floorBL.y)    * t;
    ctx.beginPath();
    ctx.moveTo(s(tx1), s(ty1));
    ctx.lineTo(s(tx2), s(ty2));
    ctx.stroke();
  }
  ctx.restore();

  // ── Right side wall ────────────────────────────────────────────────────────
  const rightGrad = ctx.createLinearGradient(s(1020), s(270), s(1200), s(130));
  rightGrad.addColorStop(0, '#b5a690');
  rightGrad.addColorStop(1, '#9a8c7c');

  roomPath([ceilTR, rightWallTop, floorBR, floorTR]);
  ctx.fillStyle = rightGrad;
  ctx.fill();

  // ── Floor ──────────────────────────────────────────────────────────────────
  // Base floor color
  const floorGrad = ctx.createLinearGradient(
    s(640), s(270), s(640), s(640)
  );
  floorGrad.addColorStop(0,   '#c49a6c');
  floorGrad.addColorStop(0.5, '#b8895c');
  floorGrad.addColorStop(1,   '#a07848');

  roomPath([floorTL, floorTR, floorBR, floorBL]);
  ctx.fillStyle = floorGrad;
  ctx.fill();

  // Wood plank lines — running left-to-right (parallel to back wall)
  ctx.save();
  ctx.beginPath();
  roomPath([floorTL, floorTR, floorBR, floorBL]);
  ctx.clip();

  const plankCount = 18;
  for (let i = 0; i <= plankCount; i++) {
    const t = i / plankCount;
    const lx1 = floorTL.x + (floorBL.x - floorTL.x) * t;
    const ly1 = floorTL.y + (floorBL.y - floorTL.y) * t;
    const lx2 = floorTR.x + (floorBR.x - floorTR.x) * t;
    const ly2 = floorTR.y + (floorBR.y - floorTR.y) * t;
    const alpha = 0.12 + t * 0.10;
    ctx.strokeStyle = `rgba(60,35,15,${alpha})`;
    ctx.lineWidth = s(i % 3 === 0 ? 1.5 : 0.7);
    ctx.beginPath();
    ctx.moveTo(s(lx1), s(ly1));
    ctx.lineTo(s(lx2), s(ly2));
    ctx.stroke();
  }
  ctx.restore();

  // ── Floor AO shadows (ambient occlusion at wall-floor junctions) ─────────
  drawFloorAO();

  // ── Wall corner shadows (where side walls meet back wall) ───────────────
  drawWallCornerShadows();

  // ── Baseboards ────────────────────────────────────────────────────────────
  ctx.strokeStyle = '#7a6a55';
  ctx.lineWidth = s(3);
  // back baseboard
  ctx.beginPath();
  ctx.moveTo(s(floorTL.x), s(floorTL.y));
  ctx.lineTo(s(floorTR.x), s(floorTR.y));
  ctx.stroke();
  // left baseboard
  ctx.beginPath();
  ctx.moveTo(s(floorTL.x), s(floorTL.y));
  ctx.lineTo(s(floorBL.x), s(floorBL.y));
  ctx.stroke();
  // right baseboard
  ctx.beginPath();
  ctx.moveTo(s(floorTR.x), s(floorTR.y));
  ctx.lineTo(s(floorBR.x), s(floorBR.y));
  ctx.stroke();

  // ── Crown molding at top of walls ────────────────────────────────────────
  drawCrownMolding();

  // ── Window on back wall ───────────────────────────────────────────────────
  drawWindow();

  // ── Painting on back wall ──────────────────────────────────────────────
  drawPainting();

  // ── Room objects ──────────────────────────────────────────────────────────
  drawRug();
  drawWardrobe();
  drawSideTable();
}

function drawFloorAO() {
  const { floorTL, floorTR, floorBL, floorBR } = ROOM;

  // Clip to floor quad so shadows don't bleed outside
  ctx.save();
  ctx.beginPath();
  roomPath([floorTL, floorTR, floorBR, floorBL]);
  ctx.clip();

  // ── Back wall base: linear gradient darkening along the back edge ──────
  const backAO = ctx.createLinearGradient(
    s(640), s(floorTL.y), s(640), s(floorTL.y + 60)
  );
  backAO.addColorStop(0, 'rgba(0,0,0,0.22)');
  backAO.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = backAO;
  ctx.fillRect(s(floorTL.x), s(floorTL.y), s(floorTR.x - floorTL.x), s(65));

  // ── Left wall base: linear gradient from left edge inward ──────────────
  const leftAO = ctx.createLinearGradient(
    s(floorTL.x), s(floorTL.y),
    s(floorTL.x + 55), s(floorTL.y + 30)
  );
  leftAO.addColorStop(0, 'rgba(0,0,0,0.18)');
  leftAO.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = leftAO;
  ctx.beginPath();
  ctx.moveTo(s(floorTL.x), s(floorTL.y));
  ctx.lineTo(s(floorBL.x), s(floorBL.y));
  ctx.lineTo(s(floorBL.x + 60), s(floorBL.y));
  ctx.lineTo(s(floorTL.x + 55), s(floorTL.y));
  ctx.closePath();
  ctx.fill();

  // ── Right wall base: linear gradient from right edge inward ────────────
  const rightAO = ctx.createLinearGradient(
    s(floorTR.x), s(floorTR.y),
    s(floorTR.x - 55), s(floorTR.y + 30)
  );
  rightAO.addColorStop(0, 'rgba(0,0,0,0.18)');
  rightAO.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rightAO;
  ctx.beginPath();
  ctx.moveTo(s(floorTR.x), s(floorTR.y));
  ctx.lineTo(s(floorBR.x), s(floorBR.y));
  ctx.lineTo(s(floorBR.x - 60), s(floorBR.y));
  ctx.lineTo(s(floorTR.x - 55), s(floorTR.y));
  ctx.closePath();
  ctx.fill();

  // ── Corner radials: back-left and back-right floor corners ─────────────
  const cornerRadius = 80;

  // Back-left corner radial
  const blAO = ctx.createRadialGradient(
    s(floorTL.x), s(floorTL.y), 0,
    s(floorTL.x), s(floorTL.y), s(cornerRadius)
  );
  blAO.addColorStop(0, 'rgba(0,0,0,0.25)');
  blAO.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = blAO;
  ctx.fillRect(s(floorTL.x), s(floorTL.y), s(cornerRadius), s(cornerRadius));

  // Back-right corner radial
  const brAO = ctx.createRadialGradient(
    s(floorTR.x), s(floorTR.y), 0,
    s(floorTR.x), s(floorTR.y), s(cornerRadius)
  );
  brAO.addColorStop(0, 'rgba(0,0,0,0.25)');
  brAO.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = brAO;
  ctx.fillRect(s(floorTR.x - cornerRadius), s(floorTR.y), s(cornerRadius), s(cornerRadius));

  ctx.restore();
}

function drawWallCornerShadows() {
  const { floorTL, floorTR, ceilTL, ceilTR } = ROOM;

  // ── Left wall-back wall junction: vertical shadow strip ────────────────
  // Gradient from the junction edge outward onto the back wall (rightward)
  const leftJunctionGrad = ctx.createLinearGradient(
    s(ceilTL.x), s(ceilTL.y), s(ceilTL.x + 30), s(ceilTL.y)
  );
  leftJunctionGrad.addColorStop(0, 'rgba(0,0,0,0.20)');
  leftJunctionGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = leftJunctionGrad;
  ctx.beginPath();
  ctx.moveTo(s(ceilTL.x), s(ceilTL.y));
  ctx.lineTo(s(ceilTL.x + 30), s(ceilTL.y));
  ctx.lineTo(s(floorTL.x + 30), s(floorTL.y));
  ctx.lineTo(s(floorTL.x), s(floorTL.y));
  ctx.closePath();
  ctx.fill();

  // Also darken the left wall side near the junction
  const leftWallJGrad = ctx.createLinearGradient(
    s(ceilTL.x), s(ceilTL.y), s(ceilTL.x - 25), s(ceilTL.y)
  );
  leftWallJGrad.addColorStop(0, 'rgba(0,0,0,0.15)');
  leftWallJGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = leftWallJGrad;
  ctx.beginPath();
  ctx.moveTo(s(ceilTL.x), s(ceilTL.y));
  ctx.lineTo(s(ceilTL.x - 25), s(ceilTL.y + 5));
  ctx.lineTo(s(floorTL.x - 25), s(floorTL.y + 5));
  ctx.lineTo(s(floorTL.x), s(floorTL.y));
  ctx.closePath();
  ctx.fill();

  // ── Right wall-back wall junction: vertical shadow strip ───────────────
  const rightJunctionGrad = ctx.createLinearGradient(
    s(ceilTR.x), s(ceilTR.y), s(ceilTR.x - 30), s(ceilTR.y)
  );
  rightJunctionGrad.addColorStop(0, 'rgba(0,0,0,0.20)');
  rightJunctionGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rightJunctionGrad;
  ctx.beginPath();
  ctx.moveTo(s(ceilTR.x), s(ceilTR.y));
  ctx.lineTo(s(ceilTR.x - 30), s(ceilTR.y));
  ctx.lineTo(s(floorTR.x - 30), s(floorTR.y));
  ctx.lineTo(s(floorTR.x), s(floorTR.y));
  ctx.closePath();
  ctx.fill();

  // Also darken the right wall side near the junction
  const rightWallJGrad = ctx.createLinearGradient(
    s(ceilTR.x), s(ceilTR.y), s(ceilTR.x + 25), s(ceilTR.y)
  );
  rightWallJGrad.addColorStop(0, 'rgba(0,0,0,0.15)');
  rightWallJGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rightWallJGrad;
  ctx.beginPath();
  ctx.moveTo(s(ceilTR.x), s(ceilTR.y));
  ctx.lineTo(s(ceilTR.x + 25), s(ceilTR.y + 5));
  ctx.lineTo(s(floorTR.x + 25), s(floorTR.y + 5));
  ctx.lineTo(s(floorTR.x), s(floorTR.y));
  ctx.closePath();
  ctx.fill();
}

function drawCrownMolding() {
  const { ceilTL, ceilTR, leftWallTop, rightWallTop } = ROOM;
  const moldH = 8; // molding height in design space

  // ── Back wall crown molding ────────────────────────────────────────────
  const backMoldGrad = ctx.createLinearGradient(
    s(ceilTL.x), s(ceilTL.y), s(ceilTL.x), s(ceilTL.y + moldH)
  );
  backMoldGrad.addColorStop(0, '#e8dcc8');
  backMoldGrad.addColorStop(0.4, '#d8ccb4');
  backMoldGrad.addColorStop(1, '#c8b89e');
  ctx.fillStyle = backMoldGrad;
  ctx.fillRect(s(ceilTL.x), s(ceilTL.y), s(ceilTR.x - ceilTL.x), s(moldH));
  // highlight line at top
  ctx.strokeStyle = '#f0e8d8';
  ctx.lineWidth = s(1);
  ctx.beginPath();
  ctx.moveTo(s(ceilTL.x), s(ceilTL.y + 1));
  ctx.lineTo(s(ceilTR.x), s(ceilTR.y + 1));
  ctx.stroke();
  // shadow line at bottom
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.beginPath();
  ctx.moveTo(s(ceilTL.x), s(ceilTL.y + moldH));
  ctx.lineTo(s(ceilTR.x), s(ceilTR.y + moldH));
  ctx.stroke();

  // ── Left wall crown molding ────────────────────────────────────────────
  ctx.save();
  // clip to left wall shape
  ctx.beginPath();
  roomPath([leftWallTop, ceilTL, ROOM.floorTL, ROOM.floorBL]);
  ctx.clip();

  const leftMoldGrad = ctx.createLinearGradient(
    s(leftWallTop.x), s(leftWallTop.y), s(leftWallTop.x), s(leftWallTop.y + moldH + 2)
  );
  leftMoldGrad.addColorStop(0, '#d8cbb4');
  leftMoldGrad.addColorStop(0.4, '#c8bca4');
  leftMoldGrad.addColorStop(1, '#b8a890');
  ctx.fillStyle = leftMoldGrad;
  // draw as a quad following the top edge of left wall
  ctx.beginPath();
  ctx.moveTo(s(leftWallTop.x), s(leftWallTop.y));
  ctx.lineTo(s(ceilTL.x), s(ceilTL.y));
  ctx.lineTo(s(ceilTL.x), s(ceilTL.y + moldH));
  ctx.lineTo(s(leftWallTop.x), s(leftWallTop.y + moldH + 2));
  ctx.closePath();
  ctx.fill();
  // shadow line
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = s(1);
  ctx.beginPath();
  ctx.moveTo(s(leftWallTop.x), s(leftWallTop.y + moldH + 2));
  ctx.lineTo(s(ceilTL.x), s(ceilTL.y + moldH));
  ctx.stroke();
  ctx.restore();

  // ── Right wall crown molding ───────────────────────────────────────────
  ctx.save();
  ctx.beginPath();
  roomPath([ceilTR, rightWallTop, ROOM.floorBR, ROOM.floorTR]);
  ctx.clip();

  const rightMoldGrad = ctx.createLinearGradient(
    s(rightWallTop.x), s(rightWallTop.y), s(rightWallTop.x), s(rightWallTop.y + moldH + 2)
  );
  rightMoldGrad.addColorStop(0, '#d0c4a8');
  rightMoldGrad.addColorStop(0.4, '#c0b498');
  rightMoldGrad.addColorStop(1, '#b0a488');
  ctx.fillStyle = rightMoldGrad;
  ctx.beginPath();
  ctx.moveTo(s(ceilTR.x), s(ceilTR.y));
  ctx.lineTo(s(rightWallTop.x), s(rightWallTop.y));
  ctx.lineTo(s(rightWallTop.x), s(rightWallTop.y + moldH + 2));
  ctx.lineTo(s(ceilTR.x), s(ceilTR.y + moldH));
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = s(1);
  ctx.beginPath();
  ctx.moveTo(s(ceilTR.x), s(ceilTR.y + moldH));
  ctx.lineTo(s(rightWallTop.x), s(rightWallTop.y + moldH + 2));
  ctx.stroke();
  ctx.restore();
}

function drawPainting() {
  // Framed painting on back wall, left-center area (between wardrobe and window)
  const px = 570, py = 110;  // top-left of painting
  const pw = 100, ph = 75;

  // ── Shadow behind frame ────────────────────────────────────────────────
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(s(px + 3), s(py + 3), s(pw), s(ph));

  // ── Outer frame (dark wood) ────────────────────────────────────────────
  const frameW = 6;
  ctx.fillStyle = '#4a3520';
  ctx.fillRect(s(px - frameW), s(py - frameW), s(pw + frameW * 2), s(ph + frameW * 2));

  // ── Inner frame highlight ─────────────────────────────────────────────
  ctx.fillStyle = '#6a5535';
  ctx.fillRect(s(px - 2), s(py - 2), s(pw + 4), s(ph + 4));

  // ── Canvas / painting content (abstract landscape) ────────────────────
  // Sky
  const skyGrad = ctx.createLinearGradient(s(px), s(py), s(px), s(py + ph * 0.55));
  skyGrad.addColorStop(0, '#4a6a8a');
  skyGrad.addColorStop(1, '#8aaaba');
  ctx.fillStyle = skyGrad;
  ctx.fillRect(s(px), s(py), s(pw), s(ph * 0.55));

  // Hills / ground
  const groundGrad = ctx.createLinearGradient(s(px), s(py + ph * 0.45), s(px), s(py + ph));
  groundGrad.addColorStop(0, '#4a7a3a');
  groundGrad.addColorStop(1, '#3a5a2a');
  ctx.fillStyle = groundGrad;
  ctx.fillRect(s(px), s(py + ph * 0.5), s(pw), s(ph * 0.5));

  // Rolling hill line
  ctx.strokeStyle = '#5a8a4a';
  ctx.lineWidth = s(2);
  ctx.beginPath();
  ctx.moveTo(s(px), s(py + ph * 0.55));
  ctx.quadraticCurveTo(s(px + pw * 0.3), s(py + ph * 0.42), s(px + pw * 0.5), s(py + ph * 0.5));
  ctx.quadraticCurveTo(s(px + pw * 0.75), s(py + ph * 0.58), s(px + pw), s(py + ph * 0.48));
  ctx.stroke();

  // Small sun/moon circle
  ctx.fillStyle = '#e8d890';
  ctx.beginPath();
  ctx.arc(s(px + pw * 0.75), s(py + ph * 0.22), s(8), 0, Math.PI * 2);
  ctx.fill();

  // ── Frame edge highlights ─────────────────────────────────────────────
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = s(1);
  // top highlight
  ctx.beginPath();
  ctx.moveTo(s(px - frameW), s(py - frameW));
  ctx.lineTo(s(px + pw + frameW), s(py - frameW));
  ctx.stroke();
  // left highlight
  ctx.beginPath();
  ctx.moveTo(s(px - frameW), s(py - frameW));
  ctx.lineTo(s(px - frameW), s(py + ph + frameW));
  ctx.stroke();
}

function drawWindow() {
  // Window sits on the back wall, roughly center-right
  // back wall spans x:[260..1020], y:[60..270] (top) and [60..270] (base)
  // pick a spot at u=0.62 on the back wall
  const wx = 750, wy = 100, ww = 180, wh = 110;

  // window frame (dark wood)
  ctx.fillStyle = '#5a4530';
  ctx.fillRect(s(wx - 4), s(wy - 4), s(ww + 8), s(wh + 8));

  // glass — light sky tint
  const glassGrad = ctx.createLinearGradient(s(wx), s(wy), s(wx), s(wy + wh));
  glassGrad.addColorStop(0,   '#a8c8e8');
  glassGrad.addColorStop(0.6, '#c8e0f0');
  glassGrad.addColorStop(1,   '#e0eff8');
  ctx.fillStyle = glassGrad;
  ctx.fillRect(s(wx), s(wy), s(ww), s(wh));

  // window cross bars
  ctx.strokeStyle = '#5a4530';
  ctx.lineWidth = s(4);
  // vertical bar
  ctx.beginPath();
  ctx.moveTo(s(wx + ww / 2), s(wy));
  ctx.lineTo(s(wx + ww / 2), s(wy + wh));
  ctx.stroke();
  // horizontal bar
  ctx.beginPath();
  ctx.moveTo(s(wx), s(wy + wh / 2));
  ctx.lineTo(s(wx + ww), s(wy + wh / 2));
  ctx.stroke();

  // window light spill on floor — subtle ellipse
  ctx.save();
  const spill = ctx.createRadialGradient(
    s(820), s(400), s(10),
    s(820), s(400), s(130)
  );
  spill.addColorStop(0,   'rgba(220,210,170,0.22)');
  spill.addColorStop(1,   'rgba(220,210,170,0)');
  ctx.fillStyle = spill;
  ctx.beginPath();
  ctx.ellipse(s(820), s(430), s(150), s(90), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // ── Curtain drapes flanking the window ─────────────────────────────────
  const curtainW = 28;
  const curtainTop = wy - 18;
  const curtainBot = wy + wh + 24;
  const curtainH = curtainBot - curtainTop;

  // Curtain rod
  ctx.strokeStyle = '#6a5035';
  ctx.lineWidth = s(4);
  ctx.beginPath();
  ctx.moveTo(s(wx - curtainW - 8), s(curtainTop));
  ctx.lineTo(s(wx + ww + curtainW + 8), s(curtainTop));
  ctx.stroke();
  // rod finials
  ctx.fillStyle = '#6a5035';
  ctx.beginPath();
  ctx.arc(s(wx - curtainW - 8), s(curtainTop), s(4), 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(s(wx + ww + curtainW + 8), s(curtainTop), s(4), 0, Math.PI * 2);
  ctx.fill();

  // Left curtain
  const lcx = wx - 4;
  const leftCurtainGrad = ctx.createLinearGradient(
    s(lcx - curtainW), s(curtainTop), s(lcx), s(curtainTop)
  );
  leftCurtainGrad.addColorStop(0, '#6a2828');
  leftCurtainGrad.addColorStop(0.4, '#8a3838');
  leftCurtainGrad.addColorStop(0.7, '#7a3030');
  leftCurtainGrad.addColorStop(1, '#5a2020');
  ctx.fillStyle = leftCurtainGrad;
  ctx.beginPath();
  ctx.moveTo(s(lcx - curtainW), s(curtainTop));
  ctx.lineTo(s(lcx + 2), s(curtainTop));
  ctx.lineTo(s(lcx + 4), s(curtainBot));
  ctx.lineTo(s(lcx - curtainW + 4), s(curtainBot));
  ctx.closePath();
  ctx.fill();
  // fold lines
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = s(1);
  for (let i = 1; i <= 3; i++) {
    const fx = lcx - curtainW + i * (curtainW / 4);
    ctx.beginPath();
    ctx.moveTo(s(fx), s(curtainTop + 4));
    ctx.lineTo(s(fx + 1), s(curtainBot - 2));
    ctx.stroke();
  }

  // Right curtain
  const rcx = wx + ww + 4;
  const rightCurtainGrad = ctx.createLinearGradient(
    s(rcx), s(curtainTop), s(rcx + curtainW), s(curtainTop)
  );
  rightCurtainGrad.addColorStop(0, '#5a2020');
  rightCurtainGrad.addColorStop(0.3, '#7a3030');
  rightCurtainGrad.addColorStop(0.6, '#8a3838');
  rightCurtainGrad.addColorStop(1, '#6a2828');
  ctx.fillStyle = rightCurtainGrad;
  ctx.beginPath();
  ctx.moveTo(s(rcx - 2), s(curtainTop));
  ctx.lineTo(s(rcx + curtainW), s(curtainTop));
  ctx.lineTo(s(rcx + curtainW - 4), s(curtainBot));
  ctx.lineTo(s(rcx - 4), s(curtainBot));
  ctx.closePath();
  ctx.fill();
  // fold lines
  for (let i = 1; i <= 3; i++) {
    const fx = rcx + i * (curtainW / 4);
    ctx.beginPath();
    ctx.moveTo(s(fx), s(curtainTop + 4));
    ctx.lineTo(s(fx - 1), s(curtainBot - 2));
    ctx.stroke();
  }
}

function drawRug() {
  // A persian-ish rug centered in the room floor
  // floor-space center: u=0.48, v=0.55
  const c  = floorToScreen(0.48, 0.55);
  // rug extends ~0.32 in u, ~0.24 in v
  const tl = floorToScreen(0.48 - 0.16, 0.55 - 0.12);
  const tr = floorToScreen(0.48 + 0.16, 0.55 - 0.12);
  const br = floorToScreen(0.48 + 0.16, 0.55 + 0.12);
  const bl = floorToScreen(0.48 - 0.16, 0.55 + 0.12);

  // outer rug
  ctx.beginPath();
  ctx.moveTo(s(tl.x), s(tl.y));
  ctx.lineTo(s(tr.x), s(tr.y));
  ctx.lineTo(s(br.x), s(br.y));
  ctx.lineTo(s(bl.x), s(bl.y));
  ctx.closePath();
  ctx.fillStyle = '#7b3030';
  ctx.fill();

  // inner rug border
  const itl = floorToScreen(0.48 - 0.13, 0.55 - 0.09);
  const itr = floorToScreen(0.48 + 0.13, 0.55 - 0.09);
  const ibr = floorToScreen(0.48 + 0.13, 0.55 + 0.09);
  const ibl = floorToScreen(0.48 - 0.13, 0.55 + 0.09);
  ctx.beginPath();
  ctx.moveTo(s(itl.x), s(itl.y));
  ctx.lineTo(s(itr.x), s(itr.y));
  ctx.lineTo(s(ibr.x), s(ibr.y));
  ctx.lineTo(s(ibl.x), s(ibl.y));
  ctx.closePath();
  ctx.fillStyle = '#9b4040';
  ctx.fill();

  // center medallion
  ctx.beginPath();
  ctx.ellipse(s(c.x), s(c.y), s(28), s(16), 0, 0, Math.PI * 2);
  ctx.fillStyle = '#c06060';
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(s(c.x), s(c.y), s(14), s(8), 0, 0, Math.PI * 2);
  ctx.fillStyle = '#e08080';
  ctx.fill();
}

function drawWardrobe() {
  // Wardrobe against the back-left area of the back wall
  // Placed at u≈0.18 on back wall
  const bx = 370, by = 120;  // top-left of wardrobe front face
  const bw = 140, bh = 170;
  const topDepth = 18;  // perspective depth for 3D top face
  const topShearX = -12; // horizontal offset for perspective skew

  // ── Cast shadow on floor — perspective-correct trapezoid ────────────────
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  // shadow base at wardrobe feet, extending forward and slightly right
  ctx.moveTo(s(bx + 4), s(by + bh));
  ctx.lineTo(s(bx + bw - 4), s(by + bh));
  ctx.lineTo(s(bx + bw + 18), s(by + bh + 22));
  ctx.lineTo(s(bx - 6), s(by + bh + 22));
  ctx.closePath();
  ctx.fill();
  // softer outer penumbra
  const shadowGrad = ctx.createLinearGradient(
    s(bx + bw / 2), s(by + bh), s(bx + bw / 2), s(by + bh + 28)
  );
  shadowGrad.addColorStop(0, 'rgba(0,0,0,0.12)');
  shadowGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = shadowGrad;
  ctx.beginPath();
  ctx.moveTo(s(bx - 6), s(by + bh + 18));
  ctx.lineTo(s(bx + bw + 18), s(by + bh + 18));
  ctx.lineTo(s(bx + bw + 24), s(by + bh + 32));
  ctx.lineTo(s(bx - 10), s(by + bh + 32));
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // ── Front face (body) ──────────────────────────────────────────────────
  const bodyGrad = ctx.createLinearGradient(s(bx), s(by), s(bx + bw), s(by));
  bodyGrad.addColorStop(0,   '#4a3520');
  bodyGrad.addColorStop(0.5, '#6b5030');
  bodyGrad.addColorStop(1,   '#3e2c18');
  ctx.fillStyle = bodyGrad;
  ctx.fillRect(s(bx), s(by), s(bw), s(bh));

  // ── 3D top face (perspective parallelogram) ────────────────────────────
  const topGrad = ctx.createLinearGradient(
    s(bx), s(by - topDepth), s(bx), s(by)
  );
  topGrad.addColorStop(0, '#8a7050');
  topGrad.addColorStop(1, '#7a6040');
  ctx.fillStyle = topGrad;
  ctx.beginPath();
  // front-left of top → front-right → back-right → back-left
  ctx.moveTo(s(bx - 4), s(by - 4));
  ctx.lineTo(s(bx + bw + 4), s(by - 4));
  ctx.lineTo(s(bx + bw + 4 + topShearX), s(by - 4 - topDepth));
  ctx.lineTo(s(bx - 4 + topShearX), s(by - 4 - topDepth));
  ctx.closePath();
  ctx.fill();
  // top face edge highlight
  ctx.strokeStyle = '#9a8060';
  ctx.lineWidth = s(1);
  ctx.stroke();

  // ── Front cap strip (cornice) ──────────────────────────────────────────
  ctx.fillStyle = '#7a6040';
  ctx.fillRect(s(bx - 4), s(by - 4), s(bw + 8), s(6));

  // center split line
  ctx.strokeStyle = '#2a1e0f';
  ctx.lineWidth = s(2);
  ctx.beginPath();
  ctx.moveTo(s(bx + bw / 2), s(by));
  ctx.lineTo(s(bx + bw / 2), s(by + bh));
  ctx.stroke();

  // door panels (left door)
  ctx.strokeStyle = '#3a2a14';
  ctx.lineWidth = s(1.5);
  ctx.strokeRect(s(bx + 8), s(by + 12), s(bw / 2 - 14), s(bh - 24));
  // door panels (right door)
  ctx.strokeRect(s(bx + bw / 2 + 6), s(by + 12), s(bw / 2 - 14), s(bh - 24));

  // handles
  ctx.fillStyle = '#c8a040';
  ctx.beginPath();
  ctx.arc(s(bx + bw / 2 - 10), s(by + bh / 2), s(4), 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(s(bx + bw / 2 + 10), s(by + bh / 2), s(4), 0, Math.PI * 2);
  ctx.fill();
}

function drawSideTable() {
  // Small side table, right wall area, floor-space u≈0.82, v≈0.38
  const pos = floorToScreen(0.82, 0.38);
  const tw = 76, tth = 8;     // top face: width and visible thickness
  const legH = 48;             // leg height
  const sideH = tth;           // visible side face height
  const tx = pos.x - tw / 2;
  const topY = pos.y - legH - sideH;  // top surface Y

  // ── Shadow on floor ────────────────────────────────────────────────────
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  ctx.moveTo(s(tx + 4), s(pos.y));
  ctx.lineTo(s(tx + tw - 4), s(pos.y));
  ctx.lineTo(s(tx + tw + 8), s(pos.y + 10));
  ctx.lineTo(s(tx - 4), s(pos.y + 10));
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // ── Table legs (four, two visible in front) ────────────────────────────
  ctx.strokeStyle = '#5a4020';
  ctx.lineWidth = s(5);
  // back-left leg (partially hidden)
  ctx.beginPath();
  ctx.moveTo(s(tx + 6), s(topY + sideH));
  ctx.lineTo(s(tx + 4), s(pos.y));
  ctx.stroke();
  // back-right leg (partially hidden)
  ctx.beginPath();
  ctx.moveTo(s(tx + tw - 6), s(topY + sideH));
  ctx.lineTo(s(tx + tw - 4), s(pos.y));
  ctx.stroke();
  // front-left leg
  ctx.strokeStyle = '#4a3518';
  ctx.beginPath();
  ctx.moveTo(s(tx + 8), s(topY + sideH + 2));
  ctx.lineTo(s(tx + 5), s(pos.y + 2));
  ctx.stroke();
  // front-right leg
  ctx.beginPath();
  ctx.moveTo(s(tx + tw - 8), s(topY + sideH + 2));
  ctx.lineTo(s(tx + tw - 5), s(pos.y + 2));
  ctx.stroke();

  // ── Visible front side face of the table top ───────────────────────────
  const sideFaceGrad = ctx.createLinearGradient(
    s(tx), s(topY + 2), s(tx), s(topY + sideH + 2)
  );
  sideFaceGrad.addColorStop(0, '#6a4a28');
  sideFaceGrad.addColorStop(1, '#54391c');
  ctx.fillStyle = sideFaceGrad;
  ctx.fillRect(s(tx), s(topY + 2), s(tw), s(sideH));
  // side face edge
  ctx.strokeStyle = '#3e2a10';
  ctx.lineWidth = s(1);
  ctx.strokeRect(s(tx), s(topY + 2), s(tw), s(sideH));

  // ── Solid rectangular top surface ──────────────────────────────────────
  const topGrad = ctx.createLinearGradient(s(tx), s(topY), s(tx + tw), s(topY));
  topGrad.addColorStop(0, '#8a6838');
  topGrad.addColorStop(0.5, '#9a7844');
  topGrad.addColorStop(1, '#7a5a30');
  ctx.fillStyle = topGrad;
  ctx.fillRect(s(tx), s(topY - 2), s(tw), s(6));
  // top edge highlight
  ctx.strokeStyle = '#a08050';
  ctx.lineWidth = s(1);
  ctx.beginPath();
  ctx.moveTo(s(tx), s(topY - 2));
  ctx.lineTo(s(tx + tw), s(topY - 2));
  ctx.stroke();

  // ── Lamp on table ──────────────────────────────────────────────────────
  ctx.fillStyle = '#3a5070';
  ctx.fillRect(s(pos.x - 10), s(topY - 16), s(20), s(14));
  ctx.fillStyle = '#2a3a50';
  ctx.beginPath();
  ctx.arc(s(pos.x), s(topY - 18), s(7), Math.PI, 0);
  ctx.fill();
  // lamp glow
  ctx.save();
  const lampGlow = ctx.createRadialGradient(
    s(pos.x), s(topY - 18), s(2),
    s(pos.x), s(topY - 18), s(40)
  );
  lampGlow.addColorStop(0,   'rgba(255,230,150,0.18)');
  lampGlow.addColorStop(1,   'rgba(255,230,150,0)');
  ctx.fillStyle = lampGlow;
  ctx.beginPath();
  ctx.arc(s(pos.x), s(topY - 18), s(40), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ─── Character draw ──────────────────────────────────────────────────────────
function drawCharacter(pos, facing) {
  const cx = s(pos.x);
  const cy = s(pos.y);
  const sc = scale;

  // shadow under feet
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + sc * 2, sc * 14, sc * 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // character scale relative to room — slightly larger for readability
  const csc = sc * 1.0;

  // ── legs ──────────────────────────────────────────────────────────────────
  const legColor   = '#2a3a6a';
  const legShadow  = '#1a2a4a';
  const legOffsetX = facing === 'left' ? -2 : facing === 'right' ? 2 : 0;

  // left leg
  ctx.fillStyle = legColor;
  ctx.beginPath();
  ctx.roundRect(cx - 9 * csc, cy - 24 * csc, 9 * csc, 24 * csc, 3 * csc);
  ctx.fill();
  // right leg
  ctx.beginPath();
  ctx.roundRect(cx + 1 * csc, cy - 24 * csc, 9 * csc, 24 * csc, 3 * csc);
  ctx.fill();
  // shoes
  ctx.fillStyle = '#1a1a1a';
  ctx.beginPath();
  ctx.ellipse(cx - 5 * csc, cy - 1 * csc, 8 * csc, 4 * csc, -0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx + 5 * csc, cy - 1 * csc, 8 * csc, 4 * csc, 0.2, 0, Math.PI * 2);
  ctx.fill();

  // ── torso ─────────────────────────────────────────────────────────────────
  const torsoGrad = ctx.createLinearGradient(cx - 13 * csc, cy - 56 * csc, cx + 13 * csc, cy - 24 * csc);
  torsoGrad.addColorStop(0, '#5080c0');
  torsoGrad.addColorStop(1, '#3060a0');
  ctx.fillStyle = torsoGrad;
  ctx.beginPath();
  ctx.roundRect(cx - 13 * csc, cy - 56 * csc, 26 * csc, 32 * csc, [4 * csc, 4 * csc, 2 * csc, 2 * csc]);
  ctx.fill();

  // ── arms ──────────────────────────────────────────────────────────────────
  // left arm
  ctx.fillStyle = '#4070b0';
  ctx.beginPath();
  ctx.roundRect(cx - 21 * csc, cy - 55 * csc, 9 * csc, 22 * csc, 4 * csc);
  ctx.fill();
  // right arm
  ctx.beginPath();
  ctx.roundRect(cx + 12 * csc, cy - 55 * csc, 9 * csc, 22 * csc, 4 * csc);
  ctx.fill();
  // hands
  ctx.fillStyle = '#d4956a';
  ctx.beginPath();
  ctx.arc(cx - 16 * csc, cy - 34 * csc, 5 * csc, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + 16 * csc, cy - 34 * csc, 5 * csc, 0, Math.PI * 2);
  ctx.fill();

  // ── neck ──────────────────────────────────────────────────────────────────
  ctx.fillStyle = '#d4956a';
  ctx.beginPath();
  ctx.roundRect(cx - 5 * csc, cy - 64 * csc, 10 * csc, 10 * csc, 2 * csc);
  ctx.fill();

  // ── head ──────────────────────────────────────────────────────────────────
  // head shape
  ctx.fillStyle = '#e0a878';
  ctx.beginPath();
  ctx.ellipse(cx, cy - 78 * csc, 16 * csc, 18 * csc, 0, 0, Math.PI * 2);
  ctx.fill();

  // hair
  ctx.fillStyle = '#3a2810';
  ctx.beginPath();
  ctx.ellipse(cx, cy - 88 * csc, 15 * csc, 10 * csc, 0, Math.PI, 0);
  ctx.fill();
  // side hair
  ctx.beginPath();
  ctx.arc(cx - 15 * csc, cy - 80 * csc, 6 * csc, 0.8, 2.4);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + 15 * csc, cy - 80 * csc, 6 * csc, 0.7, 2.3);
  ctx.fill();

  // eyes — direction-aware
  const eyeY = cy - 78 * csc;
  if (facing === 'left') {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(cx - 8 * csc, eyeY, 5 * csc, 4 * csc, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2a1a0a';
    ctx.beginPath();
    ctx.arc(cx - 10 * csc, eyeY, 2.5 * csc, 0, Math.PI * 2);
    ctx.fill();
  } else if (facing === 'right') {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(cx + 8 * csc, eyeY, 5 * csc, 4 * csc, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2a1a0a';
    ctx.beginPath();
    ctx.arc(cx + 10 * csc, eyeY, 2.5 * csc, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // front-facing or back — two eyes
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(cx - 6 * csc, eyeY, 4 * csc, 3.5 * csc, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx + 6 * csc, eyeY, 4 * csc, 3.5 * csc, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2a1a0a';
    ctx.beginPath();
    ctx.arc(cx - 6 * csc, eyeY, 2 * csc, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + 6 * csc, eyeY, 2 * csc, 0, Math.PI * 2);
    ctx.fill();
  }

  // mouth — tiny smile
  if (facing !== 'up') {
    ctx.strokeStyle = '#a0604a';
    ctx.lineWidth = sc * 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy - 70 * csc, 5 * csc, 0.2, Math.PI - 0.2);
    ctx.stroke();
  }
}

// ─── Game loop ────────────────────────────────────────────────────────────────
let lastTime = 0;

// Clamp player to floor bounds with a small margin
const U_MIN = 0.06, U_MAX = 0.94;
const V_MIN = 0.06, V_MAX = 0.96;

function update(dt) {
  const spd = player.speed * dt;
  let moved = false;

  if (keys['ArrowLeft']  || keys['a'] || keys['A']) {
    player.u -= spd;
    player.facing = 'left';
    moved = true;
  }
  if (keys['ArrowRight'] || keys['d'] || keys['D']) {
    player.u += spd;
    player.facing = 'right';
    moved = true;
  }
  if (keys['ArrowUp']    || keys['w'] || keys['W']) {
    player.v -= spd * 0.7;
    if (!moved) player.facing = 'up';
    moved = true;
  }
  if (keys['ArrowDown']  || keys['s'] || keys['S']) {
    player.v += spd * 0.7;
    if (!moved) player.facing = 'down';
    moved = true;
  }

  player.u = Math.max(U_MIN, Math.min(U_MAX, player.u));
  player.v = Math.max(V_MIN, Math.min(V_MAX, player.v));
}

function render() {
  // Clear
  ctx.fillStyle = '#0a0a0f';
  ctx.fillRect(0, 0, W, H);

  // Center the design-space view
  ctx.save();
  ctx.translate((W - 1280 * scale) / 2, (H - 720 * scale) / 2);

  // Room
  drawRoom();

  // Player — convert floor-space to screen
  const pScreen = floorToScreen(player.u, player.v);
  drawCharacter(pScreen, player.facing);

  ctx.restore();
}

function loop(timestamp) {
  const dt = Math.min((timestamp - lastTime) / 1000, 0.05);
  lastTime = timestamp;
  update(dt);
  render();
  requestAnimationFrame(loop);
}

requestAnimationFrame(ts => { lastTime = ts; requestAnimationFrame(loop); });
