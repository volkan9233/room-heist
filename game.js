'use strict';

// ─── Canvas setup ────────────────────────────────────────────────────────────
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

let W, H, scale;

function resize() {
  W = canvas.width  = window.innerWidth;
  H = canvas.height = window.innerHeight;
  scale = Math.min(W / 1280, H / 720);
}
window.addEventListener('resize', resize);
resize();

// ─── Room geometry (in design-space, scaled at draw time) ────────────────────
const ROOM = {
  floorTL: { x: 260, y: 270 },
  floorTR: { x: 1020, y: 270 },
  floorBL: { x: 80,  y: 640 },
  floorBR: { x: 1200, y: 640 },
  ceilTL: { x: 260, y: 60 },
  ceilTR: { x: 1020, y: 60 },
  leftWallTop: { x: 80, y: 130 },
  rightWallTop: { x: 1200, y: 130 },
};

// ─── Perspective helpers ──────────────────────────────────────────────────────
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
  u: 0.15,
  v: 0.85,
  speed: 0.28,
  facing: 'up',
};

// ─── Guard ───────────────────────────────────────────────────────────────────
const PATROL = [
  { u: 0.60, v: 0.22 },
  { u: 0.60, v: 0.72 },
  { u: 0.22, v: 0.72 },
  { u: 0.22, v: 0.42 },
];

const guard = {
  u: PATROL[0].u,
  v: PATROL[0].v,
  speed: 0.13,
  facing: 'down',
  waypointIdx: 0,
  waitTimer: 1.0,
};

// ─── Collision boxes (UV floor space) ────────────────────────────────────────
const COLLIDERS = [
  { id: 'rack1',  uMin: 0.06, vMin: 0.15, uMax: 0.21, vMax: 0.38 },
  { id: 'rack2',  uMin: 0.41, vMin: 0.10, uMax: 0.55, vMax: 0.34 },
  { id: 'desk',   uMin: 0.66, vMin: 0.08, uMax: 0.92, vMax: 0.30 },
  { id: 'crates', uMin: 0.27, vMin: 0.50, uMax: 0.42, vMax: 0.67 },
];

// ─── Game state ──────────────────────────────────────────────────────────────
let detected = false;
let hasKeycard = false;
let won = false;
let gameTime = 0;

// ─── Drawing helpers ─────────────────────────────────────────────────────────
function s(x) { return x * scale; }
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

// ─── Collision ───────────────────────────────────────────────────────────────
const PLAYER_R = 0.02;

function collidesWithAny(u, v) {
  for (const b of COLLIDERS) {
    if (u + PLAYER_R > b.uMin && u - PLAYER_R < b.uMax &&
        v + PLAYER_R > b.vMin && v - PLAYER_R < b.vMax) {
      return true;
    }
  }
  return false;
}

// ─── LOS helpers ─────────────────────────────────────────────────────────────
function facingAngle(facing) {
  switch (facing) {
    case 'right': return 0;
    case 'down':  return Math.PI * 0.5;
    case 'left':  return Math.PI;
    case 'up':    return -Math.PI * 0.5;
    default:      return Math.PI * 0.5;
  }
}

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

function rayBlocked(fromU, fromV, toU, toV) {
  const steps = 30;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const ru = fromU + (toU - fromU) * t;
    const rv = fromV + (toV - fromV) * t;
    for (const b of COLLIDERS) {
      if (ru > b.uMin && ru < b.uMax && rv > b.vMin && rv < b.vMax) {
        return true;
      }
    }
  }
  return false;
}

function guardCanSeePlayer() {
  const du = player.u - guard.u;
  const dv = player.v - guard.v;
  const dist = Math.hypot(du, dv);
  if (dist > 0.35) return false;
  const angleToPlayer = Math.atan2(dv, du);
  const gAngle = facingAngle(guard.facing);
  if (angleDiff(gAngle, angleToPlayer) > Math.PI * 0.42) return false;
  return !rayBlocked(guard.u, guard.v, player.u, player.v);
}

// ─── Facility room: walls, floor, structure ──────────────────────────────────

function drawRoom() {
  const { floorTL, floorTR, floorBL, floorBR,
          ceilTL, ceilTR, leftWallTop, rightWallTop } = ROOM;

  // ── Back wall ──
  const backGrad = ctx.createLinearGradient(s(260), s(60), s(260), s(270));
  backGrad.addColorStop(0, '#464950');
  backGrad.addColorStop(0.6, '#3c3f46');
  backGrad.addColorStop(1, '#35383e');
  roomPath([ceilTL, ceilTR, floorTR, floorTL]);
  ctx.fillStyle = backGrad;
  ctx.fill();

  // Concrete panel lines on back wall
  ctx.save();
  roomPath([ceilTL, ceilTR, floorTR, floorTL]);
  ctx.clip();
  // Horizontal seams
  ctx.strokeStyle = 'rgba(0,0,0,0.10)';
  ctx.lineWidth = s(1);
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const lx1 = ceilTL.x + (floorTL.x - ceilTL.x) * t;
    const ly1 = ceilTL.y + (floorTL.y - ceilTL.y) * t;
    const lx2 = ceilTR.x + (floorTR.x - ceilTR.x) * t;
    const ly2 = ceilTR.y + (floorTR.y - ceilTR.y) * t;
    ctx.beginPath();
    ctx.moveTo(s(lx1), s(ly1));
    ctx.lineTo(s(lx2), s(ly2));
    ctx.stroke();
    // Highlight line just below each seam
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.beginPath();
    ctx.moveTo(s(lx1), s(ly1 + 1.5));
    ctx.lineTo(s(lx2), s(ly2 + 1.5));
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.10)';
  }
  // Vertical seams
  for (let i = 1; i <= 5; i++) {
    const t = i / 6;
    const tx1 = ceilTL.x + (ceilTR.x - ceilTL.x) * t;
    const tx2 = floorTL.x + (floorTR.x - floorTL.x) * t;
    ctx.beginPath();
    ctx.moveTo(s(tx1), s(ceilTL.y));
    ctx.lineTo(s(tx2), s(floorTL.y));
    ctx.stroke();
  }
  // Subtle stain/variation overlay on back wall
  const stainGrad = ctx.createRadialGradient(
    s(500), s(180), 0, s(500), s(180), s(120)
  );
  stainGrad.addColorStop(0, 'rgba(0,0,0,0.04)');
  stainGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = stainGrad;
  ctx.fillRect(s(ceilTL.x), s(ceilTL.y), s(ceilTR.x - ceilTL.x), s(floorTL.y - ceilTL.y));
  ctx.restore();

  // ── Left side wall ──
  const leftGrad = ctx.createLinearGradient(s(80), s(130), s(260), s(270));
  leftGrad.addColorStop(0, '#2e3138');
  leftGrad.addColorStop(0.5, '#34373e');
  leftGrad.addColorStop(1, '#383b42');
  roomPath([leftWallTop, ceilTL, floorTL, floorBL]);
  ctx.fillStyle = leftGrad;
  ctx.fill();
  // Left wall panel seams
  ctx.save();
  roomPath([leftWallTop, ceilTL, floorTL, floorBL]);
  ctx.clip();
  ctx.strokeStyle = 'rgba(0,0,0,0.08)';
  ctx.lineWidth = s(0.8);
  for (let i = 1; i <= 3; i++) {
    const t = i / 4;
    const x1 = leftWallTop.x + (ceilTL.x - leftWallTop.x) * t;
    const y1 = leftWallTop.y + (ceilTL.y - leftWallTop.y) * t;
    const x2 = floorBL.x + (floorTL.x - floorBL.x) * t;
    const y2 = floorBL.y + (floorTL.y - floorBL.y) * t;
    ctx.beginPath();
    ctx.moveTo(s(x1), s(y1));
    ctx.lineTo(s(x2), s(y2));
    ctx.stroke();
  }
  ctx.restore();

  // ── Right side wall ──
  const rightGrad = ctx.createLinearGradient(s(1020), s(270), s(1200), s(130));
  rightGrad.addColorStop(0, '#383b42');
  rightGrad.addColorStop(0.5, '#34373e');
  rightGrad.addColorStop(1, '#30333a');
  roomPath([ceilTR, rightWallTop, floorBR, floorTR]);
  ctx.fillStyle = rightGrad;
  ctx.fill();
  // Right wall panel seams
  ctx.save();
  roomPath([ceilTR, rightWallTop, floorBR, floorTR]);
  ctx.clip();
  ctx.strokeStyle = 'rgba(0,0,0,0.08)';
  ctx.lineWidth = s(0.8);
  for (let i = 1; i <= 3; i++) {
    const t = i / 4;
    const x1 = ceilTR.x + (rightWallTop.x - ceilTR.x) * t;
    const y1 = ceilTR.y + (rightWallTop.y - ceilTR.y) * t;
    const x2 = floorTR.x + (floorBR.x - floorTR.x) * t;
    const y2 = floorTR.y + (floorBR.y - floorTR.y) * t;
    ctx.beginPath();
    ctx.moveTo(s(x1), s(y1));
    ctx.lineTo(s(x2), s(y2));
    ctx.stroke();
  }
  ctx.restore();

  // ── Exit door on right wall ──
  drawExitDoor();

  // ── Floor ──
  const floorGrad = ctx.createLinearGradient(s(640), s(270), s(640), s(640));
  floorGrad.addColorStop(0, '#44474e');
  floorGrad.addColorStop(0.5, '#3e4148');
  floorGrad.addColorStop(1, '#383b42');
  roomPath([floorTL, floorTR, floorBR, floorBL]);
  ctx.fillStyle = floorGrad;
  ctx.fill();

  // Floor tile grid
  ctx.save();
  roomPath([floorTL, floorTR, floorBR, floorBL]);
  ctx.clip();
  const gridH = 12;
  const gridV = 16;
  // Tile groove (dark line)
  ctx.strokeStyle = 'rgba(0,0,0,0.10)';
  ctx.lineWidth = s(1);
  for (let i = 0; i <= gridH; i++) {
    const t = i / gridH;
    const lx1 = floorTL.x + (floorBL.x - floorTL.x) * t;
    const ly1 = floorTL.y + (floorBL.y - floorTL.y) * t;
    const lx2 = floorTR.x + (floorBR.x - floorTR.x) * t;
    const ly2 = floorTR.y + (floorBR.y - floorTR.y) * t;
    ctx.beginPath();
    ctx.moveTo(s(lx1), s(ly1));
    ctx.lineTo(s(lx2), s(ly2));
    ctx.stroke();
  }
  for (let i = 0; i <= gridV; i++) {
    const t = i / gridV;
    const lx1 = floorTL.x + (floorTR.x - floorTL.x) * t;
    const lx2 = floorBL.x + (floorBR.x - floorBL.x) * t;
    ctx.beginPath();
    ctx.moveTo(s(lx1), s(floorTL.y));
    ctx.lineTo(s(lx2), s(floorBL.y));
    ctx.stroke();
  }
  // Tile highlight (light line offset by 1px from each groove)
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = s(0.6);
  for (let i = 0; i <= gridH; i++) {
    const t = i / gridH;
    const lx1 = floorTL.x + (floorBL.x - floorTL.x) * t;
    const ly1 = floorTL.y + (floorBL.y - floorTL.y) * t + 1.2;
    const lx2 = floorTR.x + (floorBR.x - floorTR.x) * t;
    const ly2 = floorTR.y + (floorBR.y - floorTR.y) * t + 1.2;
    ctx.beginPath();
    ctx.moveTo(s(lx1), s(ly1));
    ctx.lineTo(s(lx2), s(ly2));
    ctx.stroke();
  }
  ctx.restore();

  // ── Floor AO ──
  drawFloorAO();

  // ── Metal baseboard strips ──
  // Dark groove
  ctx.strokeStyle = '#2a2d34';
  ctx.lineWidth = s(3);
  ctx.beginPath();
  ctx.moveTo(s(floorTL.x), s(floorTL.y));
  ctx.lineTo(s(floorTR.x), s(floorTR.y));
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s(floorTL.x), s(floorTL.y));
  ctx.lineTo(s(floorBL.x), s(floorBL.y));
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s(floorTR.x), s(floorTR.y));
  ctx.lineTo(s(floorBR.x), s(floorBR.y));
  ctx.stroke();
  // Metal highlight
  ctx.strokeStyle = '#5e6168';
  ctx.lineWidth = s(1.2);
  ctx.beginPath();
  ctx.moveTo(s(floorTL.x), s(floorTL.y + 1));
  ctx.lineTo(s(floorTR.x), s(floorTR.y + 1));
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s(floorTL.x + 0.5), s(floorTL.y + 1));
  ctx.lineTo(s(floorBL.x + 0.5), s(floorBL.y + 1));
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s(floorTR.x - 0.5), s(floorTR.y + 1));
  ctx.lineTo(s(floorBR.x - 0.5), s(floorBR.y + 1));
  ctx.stroke();

  // ── Ceiling fluorescent lights ──
  drawCeilingLights();
}

function drawFloorAO() {
  const { floorTL, floorTR, floorBL, floorBR } = ROOM;
  ctx.save();
  roomPath([floorTL, floorTR, floorBR, floorBL]);
  ctx.clip();

  // Back wall AO
  const backAO = ctx.createLinearGradient(s(640), s(floorTL.y), s(640), s(floorTL.y + 55));
  backAO.addColorStop(0, 'rgba(0,0,0,0.30)');
  backAO.addColorStop(0.5, 'rgba(0,0,0,0.10)');
  backAO.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = backAO;
  ctx.fillRect(s(floorTL.x), s(floorTL.y), s(floorTR.x - floorTL.x), s(60));

  // Left wall AO
  const leftAO = ctx.createLinearGradient(s(floorTL.x), s(floorTL.y), s(floorTL.x + 50), s(floorTL.y + 20));
  leftAO.addColorStop(0, 'rgba(0,0,0,0.22)');
  leftAO.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = leftAO;
  ctx.beginPath();
  ctx.moveTo(s(floorTL.x), s(floorTL.y));
  ctx.lineTo(s(floorBL.x), s(floorBL.y));
  ctx.lineTo(s(floorBL.x + 55), s(floorBL.y));
  ctx.lineTo(s(floorTL.x + 50), s(floorTL.y));
  ctx.closePath();
  ctx.fill();

  // Right wall AO
  const rightAO = ctx.createLinearGradient(s(floorTR.x), s(floorTR.y), s(floorTR.x - 50), s(floorTR.y + 20));
  rightAO.addColorStop(0, 'rgba(0,0,0,0.22)');
  rightAO.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rightAO;
  ctx.beginPath();
  ctx.moveTo(s(floorTR.x), s(floorTR.y));
  ctx.lineTo(s(floorBR.x), s(floorBR.y));
  ctx.lineTo(s(floorBR.x - 55), s(floorBR.y));
  ctx.lineTo(s(floorTR.x - 50), s(floorTR.y));
  ctx.closePath();
  ctx.fill();

  // Corner AO puddles (where walls meet floor)
  const cornerR = 40;
  // Back-left corner
  const blcGrad = ctx.createRadialGradient(s(floorTL.x), s(floorTL.y), 0, s(floorTL.x), s(floorTL.y), s(cornerR));
  blcGrad.addColorStop(0, 'rgba(0,0,0,0.18)');
  blcGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = blcGrad;
  ctx.fillRect(s(floorTL.x), s(floorTL.y), s(cornerR), s(cornerR));
  // Back-right corner
  const brcGrad = ctx.createRadialGradient(s(floorTR.x), s(floorTR.y), 0, s(floorTR.x), s(floorTR.y), s(cornerR));
  brcGrad.addColorStop(0, 'rgba(0,0,0,0.18)');
  brcGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = brcGrad;
  ctx.fillRect(s(floorTR.x - cornerR), s(floorTR.y), s(cornerR), s(cornerR));

  ctx.restore();
}

function drawCeilingLight(lx, ly) {
  const fixtW = 100, fixtH = 5;
  // Housing (dark metal surround)
  ctx.fillStyle = '#50535a';
  ctx.fillRect(s(lx - fixtW / 2 - 3), s(ly - 1), s(fixtW + 6), s(fixtH + 2));
  // Diffuser panel (bright)
  const diffGrad = ctx.createLinearGradient(s(lx - fixtW / 2), 0, s(lx + fixtW / 2), 0);
  diffGrad.addColorStop(0, '#c8cad0');
  diffGrad.addColorStop(0.3, '#e8eaf0');
  diffGrad.addColorStop(0.5, '#f0f2f8');
  diffGrad.addColorStop(0.7, '#e8eaf0');
  diffGrad.addColorStop(1, '#c8cad0');
  ctx.fillStyle = diffGrad;
  ctx.fillRect(s(lx - fixtW / 2), s(ly), s(fixtW), s(fixtH));
  // Center hotspot line
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = s(0.8);
  ctx.beginPath();
  ctx.moveTo(s(lx - fixtW / 2 + 8), s(ly + fixtH / 2));
  ctx.lineTo(s(lx + fixtW / 2 - 8), s(ly + fixtH / 2));
  ctx.stroke();
  // Glow cone
  const glow = ctx.createRadialGradient(s(lx), s(ly + 2), s(5), s(lx), s(ly + 2), s(90));
  glow.addColorStop(0, 'rgba(200,210,230,0.14)');
  glow.addColorStop(0.5, 'rgba(200,210,230,0.05)');
  glow.addColorStop(1, 'rgba(200,210,230,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(s(lx - 90), s(ly - 40), s(180), s(100));
}

function drawCeilingLights() {
  const { ceilTL, ceilTR } = ROOM;
  const ly = ceilTL.y + 15;
  drawCeilingLight(ceilTL.x + (ceilTR.x - ceilTL.x) * 0.3, ly);
  drawCeilingLight(ceilTL.x + (ceilTR.x - ceilTL.x) * 0.7, ly);
}

function drawExitDoor() {
  const { ceilTR, rightWallTop, floorTR, floorBR } = ROOM;

  function rightWallPoint(u, v) {
    const x = (1 - u) * (1 - v) * ceilTR.x + u * (1 - v) * rightWallTop.x
            + (1 - u) * v * floorTR.x + u * v * floorBR.x;
    const y = (1 - u) * (1 - v) * ceilTR.y + u * (1 - v) * rightWallTop.y
            + (1 - u) * v * floorTR.y + u * v * floorBR.y;
    return { x, y };
  }

  const doorU1 = 0.3, doorU2 = 0.55;
  const doorT1 = 0.35, doorT2 = 0.78;

  const dtl = rightWallPoint(doorU1, doorT1);
  const dtr = rightWallPoint(doorU2, doorT1);
  const dbr = rightWallPoint(doorU2, doorT2);
  const dbl = rightWallPoint(doorU1, doorT2);

  // Frame — outer metal surround with beveled look
  const framePad = 4;
  const frmGrad = ctx.createLinearGradient(s(dtl.x - framePad), 0, s(dtr.x + framePad), 0);
  frmGrad.addColorStop(0, '#484b52');
  frmGrad.addColorStop(0.15, '#5e6168');
  frmGrad.addColorStop(0.85, '#5e6168');
  frmGrad.addColorStop(1, '#484b52');
  ctx.fillStyle = frmGrad;
  ctx.beginPath();
  ctx.moveTo(s(dtl.x - framePad), s(dtl.y - framePad));
  ctx.lineTo(s(dtr.x + framePad), s(dtr.y - framePad));
  ctx.lineTo(s(dbr.x + framePad), s(dbr.y + framePad));
  ctx.lineTo(s(dbl.x - framePad), s(dbl.y + framePad));
  ctx.closePath();
  ctx.fill();
  // Frame inner edge (dark inset line)
  ctx.strokeStyle = '#2a2d34';
  ctx.lineWidth = s(1.2);
  ctx.beginPath();
  ctx.moveTo(s(dtl.x - 1), s(dtl.y - 1));
  ctx.lineTo(s(dtr.x + 1), s(dtr.y - 1));
  ctx.lineTo(s(dbr.x + 1), s(dbr.y + 1));
  ctx.lineTo(s(dbl.x - 1), s(dbl.y + 1));
  ctx.closePath();
  ctx.stroke();

  // Door surface — heavy steel gradient
  const doorGrad = ctx.createLinearGradient(s(dtl.x), s(dtl.y), s(dtr.x), s(dtr.y));
  doorGrad.addColorStop(0, '#585b62');
  doorGrad.addColorStop(0.2, '#686b72');
  doorGrad.addColorStop(0.5, '#727580');
  doorGrad.addColorStop(0.8, '#686b72');
  doorGrad.addColorStop(1, '#585b62');
  ctx.fillStyle = doorGrad;
  ctx.beginPath();
  ctx.moveTo(s(dtl.x), s(dtl.y));
  ctx.lineTo(s(dtr.x), s(dtr.y));
  ctx.lineTo(s(dbr.x), s(dbr.y));
  ctx.lineTo(s(dbl.x), s(dbl.y));
  ctx.closePath();
  ctx.fill();

  // Door panel inset (recessed rectangle)
  const pMid = 0.08;
  const ptl = rightWallPoint(doorU1 + pMid, doorT1 + 0.06);
  const ptr = rightWallPoint(doorU2 - pMid, doorT1 + 0.06);
  const pbr = rightWallPoint(doorU2 - pMid, doorT2 - 0.06);
  const pbl = rightWallPoint(doorU1 + pMid, doorT2 - 0.06);
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = s(1);
  ctx.beginPath();
  ctx.moveTo(s(ptl.x), s(ptl.y));
  ctx.lineTo(s(ptr.x), s(ptr.y));
  ctx.lineTo(s(pbr.x), s(pbr.y));
  ctx.lineTo(s(pbl.x), s(pbl.y));
  ctx.closePath();
  ctx.stroke();
  // Panel inner highlight
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = s(0.6);
  ctx.beginPath();
  ctx.moveTo(s(ptl.x + 1), s(ptl.y + 1));
  ctx.lineTo(s(ptr.x - 1), s(ptr.y + 1));
  ctx.stroke();

  // Handle — lever style
  const hBase = rightWallPoint(doorU1 + 0.05, (doorT1 + doorT2) * 0.52);
  const hEnd  = rightWallPoint(doorU1 + 0.05, (doorT1 + doorT2) * 0.52 + 0.05);
  // Handle plate
  ctx.fillStyle = '#8a8d95';
  ctx.beginPath();
  ctx.ellipse(s(hBase.x), s(hBase.y), s(6), s(8), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#6a6d75';
  ctx.lineWidth = s(0.8);
  ctx.stroke();
  // Handle bar
  ctx.strokeStyle = '#a0a3aa';
  ctx.lineWidth = s(2.5);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(s(hBase.x), s(hBase.y));
  ctx.lineTo(s(hEnd.x), s(hEnd.y));
  ctx.stroke();
  ctx.lineCap = 'butt';

  // Status light
  const lightPos = rightWallPoint(doorU1 + 0.06, doorT1 + 0.06);
  const litColor = hasKeycard ? '#40e040' : '#e04040';
  // Light housing
  ctx.fillStyle = '#2a2d34';
  ctx.beginPath();
  ctx.arc(s(lightPos.x), s(lightPos.y), s(5), 0, Math.PI * 2);
  ctx.fill();
  // Light bulb
  ctx.fillStyle = litColor;
  ctx.beginPath();
  ctx.arc(s(lightPos.x), s(lightPos.y), s(3), 0, Math.PI * 2);
  ctx.fill();
  // Specular dot
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.beginPath();
  ctx.arc(s(lightPos.x - 1), s(lightPos.y - 1), s(1), 0, Math.PI * 2);
  ctx.fill();
  // Glow
  ctx.save();
  const glowC = hasKeycard ? 'rgba(64,224,64,' : 'rgba(224,64,64,';
  const lightGlow = ctx.createRadialGradient(
    s(lightPos.x), s(lightPos.y), 0,
    s(lightPos.x), s(lightPos.y), s(18)
  );
  lightGlow.addColorStop(0, glowC + '0.35)');
  lightGlow.addColorStop(0.5, glowC + '0.10)');
  lightGlow.addColorStop(1, glowC + '0)');
  ctx.fillStyle = lightGlow;
  ctx.beginPath();
  ctx.arc(s(lightPos.x), s(lightPos.y), s(18), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // EXIT label — with backing sign
  const textPos = rightWallPoint((doorU1 + doorU2) * 0.5, doorT1 - 0.06);
  // Sign backing
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(s(textPos.x - 18), s(textPos.y - 7), s(36), s(12));
  ctx.fillStyle = '#e04040';
  ctx.font = `bold ${s(10)}px monospace`;
  ctx.textAlign = 'center';
  ctx.fillText('EXIT', s(textPos.x), s(textPos.y));
}

// ─── Facility objects ─────────────────────────────────────────────────────────

function drawServerRack(box) {
  const base = floorToScreen((box.uMin + box.uMax) / 2, box.vMax);
  const bl = floorToScreen(box.uMin, box.vMax);
  const br = floorToScreen(box.uMax, box.vMax);
  const tl = floorToScreen(box.uMin, box.vMin);
  const tr = floorToScreen(box.uMax, box.vMin);
  const screenW = br.x - bl.x;
  const rackH = 130;
  const bx = base.x - screenW / 2;
  const by = base.y - rackH;
  const sideW = 10;

  // Ground-plane footprint shadow — full collider area
  const footGrad = ctx.createRadialGradient(
    s(base.x), s((tl.y + base.y) / 2), 0,
    s(base.x), s((tl.y + base.y) / 2), s(Math.max(screenW, base.y - tl.y) * 0.8)
  );
  footGrad.addColorStop(0, 'rgba(0,0,0,0.18)');
  footGrad.addColorStop(0.7, 'rgba(0,0,0,0.08)');
  footGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = footGrad;
  ctx.beginPath();
  ctx.moveTo(s(tl.x - 4), s(tl.y - 2));
  ctx.lineTo(s(tr.x + 4), s(tr.y - 2));
  ctx.lineTo(s(br.x + 8), s(br.y + 6));
  ctx.lineTo(s(bl.x - 6), s(bl.y + 6));
  ctx.closePath();
  ctx.fill();

  // Contact shadow — wraps full base perimeter
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.moveTo(s(bx - 5), s(base.y - 1));
  ctx.lineTo(s(bx + screenW + 2), s(base.y - 1));
  ctx.lineTo(s(bx + screenW + 10), s(base.y + 10));
  ctx.lineTo(s(bx - 8), s(base.y + 10));
  ctx.closePath();
  ctx.fill();

  // Left side face — shows depth on left edge
  const lsGrad = ctx.createLinearGradient(s(bx - sideW), 0, s(bx), 0);
  lsGrad.addColorStop(0, '#12141a');
  lsGrad.addColorStop(1, '#1a1c22');
  ctx.fillStyle = lsGrad;
  ctx.beginPath();
  ctx.moveTo(s(bx), s(by));
  ctx.lineTo(s(bx - sideW), s(by - 8));
  ctx.lineTo(s(bx - sideW), s(base.y - 4));
  ctx.lineTo(s(bx), s(base.y));
  ctx.closePath();
  ctx.fill();

  // Right side face — shows depth on right edge
  const sideGrad = ctx.createLinearGradient(s(bx + screenW), 0, s(bx + screenW + sideW), 0);
  sideGrad.addColorStop(0, '#1e2028');
  sideGrad.addColorStop(1, '#15171e');
  ctx.fillStyle = sideGrad;
  ctx.beginPath();
  ctx.moveTo(s(bx + screenW), s(by));
  ctx.lineTo(s(bx + screenW + sideW), s(by - 8));
  ctx.lineTo(s(bx + screenW + sideW), s(base.y - 4));
  ctx.lineTo(s(bx + screenW), s(base.y));
  ctx.closePath();
  ctx.fill();

  // Front face — metallic body gradient
  const bodyGrad = ctx.createLinearGradient(s(bx), 0, s(bx + screenW), 0);
  bodyGrad.addColorStop(0, '#22252c');
  bodyGrad.addColorStop(0.15, '#32363e');
  bodyGrad.addColorStop(0.4, '#3a3e48');
  bodyGrad.addColorStop(0.6, '#3a3e48');
  bodyGrad.addColorStop(0.85, '#32363e');
  bodyGrad.addColorStop(1, '#22252c');
  ctx.fillStyle = bodyGrad;
  ctx.fillRect(s(bx), s(by), s(screenW), s(rackH));

  // Rack unit panels (3 sections with divider lines)
  const panelPad = 4;
  const panelCount = 3;
  const panelH = (rackH - 8) / panelCount;
  for (let p = 0; p < panelCount; p++) {
    const py = by + 4 + p * panelH;

    // Panel inset
    const panGrad = ctx.createLinearGradient(0, s(py), 0, s(py + panelH - 2));
    panGrad.addColorStop(0, 'rgba(255,255,255,0.04)');
    panGrad.addColorStop(0.5, 'rgba(0,0,0,0)');
    panGrad.addColorStop(1, 'rgba(0,0,0,0.08)');
    ctx.fillStyle = panGrad;
    ctx.fillRect(s(bx + panelPad), s(py), s(screenW - panelPad * 2), s(panelH - 2));

    // Divider line
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = s(0.8);
    ctx.beginPath();
    ctx.moveTo(s(bx + 2), s(py + panelH - 1));
    ctx.lineTo(s(bx + screenW - 2), s(py + panelH - 1));
    ctx.stroke();

    // Vent slits per panel
    const ventCount = 3;
    for (let v = 0; v < ventCount; v++) {
      const vy = py + 6 + v * ((panelH - 14) / ventCount);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = s(0.7);
      ctx.beginPath();
      ctx.moveTo(s(bx + 16), s(vy));
      ctx.lineTo(s(bx + screenW - 6), s(vy));
      ctx.stroke();
    }

    // LED per panel
    const ledC = p === 2 ? '#e04040' : (p === 1 ? '#e0a020' : '#40e040');
    ctx.fillStyle = ledC;
    ctx.beginPath();
    ctx.arc(s(bx + 9), s(py + panelH / 2), s(1.8), 0, Math.PI * 2);
    ctx.fill();
    // LED glow
    ctx.fillStyle = ledC + '30';
    ctx.beginPath();
    ctx.arc(s(bx + 9), s(py + panelH / 2), s(5), 0, Math.PI * 2);
    ctx.fill();
  }

  // Top face — symmetric, connects both side faces
  const topGrad = ctx.createLinearGradient(0, s(by - 12), 0, s(by));
  topGrad.addColorStop(0, '#484c58');
  topGrad.addColorStop(1, '#3a3e48');
  ctx.fillStyle = topGrad;
  ctx.beginPath();
  ctx.moveTo(s(bx), s(by));
  ctx.lineTo(s(bx + screenW), s(by));
  ctx.lineTo(s(bx + screenW + sideW), s(by - 8));
  ctx.lineTo(s(bx + screenW - 8), s(by - 12));
  ctx.lineTo(s(bx - 8), s(by - 12));
  ctx.lineTo(s(bx - sideW), s(by - 8));
  ctx.closePath();
  ctx.fill();
  // Top face edge lines
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = s(0.8);
  ctx.beginPath();
  ctx.moveTo(s(bx - sideW), s(by - 8));
  ctx.lineTo(s(bx - 8), s(by - 12));
  ctx.lineTo(s(bx + screenW - 8), s(by - 12));
  ctx.lineTo(s(bx + screenW + sideW), s(by - 8));
  ctx.stroke();

  // Mounting rail hints (vertical lines on edges)
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = s(1.2);
  ctx.beginPath();
  ctx.moveTo(s(bx + 3), s(by + 2));
  ctx.lineTo(s(bx + 3), s(base.y - 2));
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s(bx + screenW - 3), s(by + 2));
  ctx.lineTo(s(bx + screenW - 3), s(base.y - 2));
  ctx.stroke();

  // Frame outline
  ctx.strokeStyle = '#12141a';
  ctx.lineWidth = s(1.5);
  ctx.strokeRect(s(bx), s(by), s(screenW), s(rackH));
}

function drawDesk() {
  const box = COLLIDERS[2]; // desk collider
  const base = floorToScreen((box.uMin + box.uMax) / 2, box.vMax);
  const bl = floorToScreen(box.uMin, box.vMax);
  const br = floorToScreen(box.uMax, box.vMax);
  const deskW = br.x - bl.x;
  const legH = 50;
  const sideW = 10;
  const dx = base.x - deskW / 2;
  const topY = base.y - legH;

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.moveTo(s(dx - 2), s(base.y));
  ctx.lineTo(s(dx + deskW + 2), s(base.y));
  ctx.lineTo(s(dx + deskW + 14), s(base.y + 12));
  ctx.lineTo(s(dx - 6), s(base.y + 12));
  ctx.closePath();
  ctx.fill();

  // Legs — metal tube with highlight
  const legW = 3.5;
  const legs = [
    [dx + 8, dx + 6],
    [dx + deskW - 8, dx + deskW - 6]
  ];
  for (const [topX, botX] of legs) {
    // Leg shadow side
    ctx.strokeStyle = '#3e4148';
    ctx.lineWidth = s(legW + 2);
    ctx.beginPath(); ctx.moveTo(s(topX), s(topY + 10)); ctx.lineTo(s(botX), s(base.y)); ctx.stroke();
    // Leg body
    ctx.strokeStyle = '#5a5d65';
    ctx.lineWidth = s(legW);
    ctx.beginPath(); ctx.moveTo(s(topX), s(topY + 10)); ctx.lineTo(s(botX), s(base.y)); ctx.stroke();
    // Leg highlight
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = s(1);
    ctx.beginPath(); ctx.moveTo(s(topX - 1), s(topY + 12)); ctx.lineTo(s(botX - 1), s(base.y - 2)); ctx.stroke();
    // Foot pad
    ctx.fillStyle = '#3a3d44';
    ctx.beginPath();
    ctx.ellipse(s(botX), s(base.y), s(5), s(2), 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Side face for volume
  const sdGrad = ctx.createLinearGradient(s(dx + deskW), 0, s(dx + deskW + sideW), 0);
  sdGrad.addColorStop(0, '#484b52');
  sdGrad.addColorStop(1, '#3a3d44');
  ctx.fillStyle = sdGrad;
  ctx.beginPath();
  ctx.moveTo(s(dx + deskW), s(topY + 4));
  ctx.lineTo(s(dx + deskW + sideW), s(topY));
  ctx.lineTo(s(dx + deskW + sideW), s(topY + 10));
  ctx.lineTo(s(dx + deskW), s(topY + 12));
  ctx.closePath();
  ctx.fill();

  // Front face — metal apron with gradient
  const apronGrad = ctx.createLinearGradient(s(dx), 0, s(dx + deskW), 0);
  apronGrad.addColorStop(0, '#484b52');
  apronGrad.addColorStop(0.15, '#585b62');
  apronGrad.addColorStop(0.5, '#606368');
  apronGrad.addColorStop(0.85, '#585b62');
  apronGrad.addColorStop(1, '#484b52');
  ctx.fillStyle = apronGrad;
  ctx.fillRect(s(dx), s(topY + 4), s(deskW), s(8));
  // Bottom edge shadow
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = s(0.8);
  ctx.beginPath();
  ctx.moveTo(s(dx), s(topY + 12));
  ctx.lineTo(s(dx + deskW), s(topY + 12));
  ctx.stroke();

  // Top surface
  const topGrad = ctx.createLinearGradient(s(dx), 0, s(dx + deskW), 0);
  topGrad.addColorStop(0, '#60636a');
  topGrad.addColorStop(0.2, '#6e7178');
  topGrad.addColorStop(0.5, '#787b82');
  topGrad.addColorStop(0.8, '#6e7178');
  topGrad.addColorStop(1, '#60636a');
  ctx.fillStyle = topGrad;
  ctx.fillRect(s(dx), s(topY - 2), s(deskW), s(6));
  // Top surface connects to side
  ctx.fillStyle = '#6a6d74';
  ctx.beginPath();
  ctx.moveTo(s(dx + deskW), s(topY - 2));
  ctx.lineTo(s(dx + deskW + sideW), s(topY - 4));
  ctx.lineTo(s(dx + deskW + sideW), s(topY));
  ctx.lineTo(s(dx + deskW), s(topY + 4));
  ctx.closePath();
  ctx.fill();
  // Front edge highlight
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = s(0.8);
  ctx.beginPath();
  ctx.moveTo(s(dx), s(topY - 2));
  ctx.lineTo(s(dx + deskW), s(topY - 2));
  ctx.stroke();

  // Monitor 1
  drawMonitor(dx + deskW * 0.3, topY - 4);
  // Monitor 2
  drawMonitor(dx + deskW * 0.7, topY - 4);

  // Keycard on desk
  if (!hasKeycard) {
    drawKeycard(dx + deskW * 0.5, topY - 8);
  }
}

function drawMonitor(cx, baseY) {
  const mw = 44, mh = 30;
  const standH = 6;
  const standTop = baseY - standH;

  // Stand neck — tapered
  const nkGrad = ctx.createLinearGradient(s(cx - 3), 0, s(cx + 3), 0);
  nkGrad.addColorStop(0, '#2e3138');
  nkGrad.addColorStop(0.5, '#484b52');
  nkGrad.addColorStop(1, '#2e3138');
  ctx.fillStyle = nkGrad;
  ctx.beginPath();
  ctx.moveTo(s(cx - 3), s(standTop));
  ctx.lineTo(s(cx + 3), s(standTop));
  ctx.lineTo(s(cx + 4), s(baseY));
  ctx.lineTo(s(cx - 4), s(baseY));
  ctx.closePath();
  ctx.fill();
  // Base plate
  const bpGrad = ctx.createLinearGradient(s(cx - 10), 0, s(cx + 10), 0);
  bpGrad.addColorStop(0, '#2e3138');
  bpGrad.addColorStop(0.5, '#484b52');
  bpGrad.addColorStop(1, '#2e3138');
  ctx.fillStyle = bpGrad;
  ctx.beginPath();
  ctx.ellipse(s(cx), s(baseY), s(10), s(2.5), 0, 0, Math.PI * 2);
  ctx.fill();

  // Bezel (frame) — with gradient
  const bezGrad = ctx.createLinearGradient(s(cx - mw / 2 - 2), 0, s(cx + mw / 2 + 2), 0);
  bezGrad.addColorStop(0, '#1e2028');
  bezGrad.addColorStop(0.15, '#2e3138');
  bezGrad.addColorStop(0.85, '#2e3138');
  bezGrad.addColorStop(1, '#1e2028');
  ctx.fillStyle = bezGrad;
  ctx.fillRect(s(cx - mw / 2 - 2), s(standTop - mh - 3), s(mw + 4), s(mh + 5));

  // Screen
  const scrGrad = ctx.createLinearGradient(0, s(standTop - mh - 1), 0, s(standTop - 1));
  scrGrad.addColorStop(0, '#0e2a38');
  scrGrad.addColorStop(0.5, '#142e3e');
  scrGrad.addColorStop(1, '#0a1e2c');
  ctx.fillStyle = scrGrad;
  ctx.fillRect(s(cx - mw / 2), s(standTop - mh - 1), s(mw), s(mh));

  // Screen reflection (subtle top-edge highlight)
  const reflGrad = ctx.createLinearGradient(0, s(standTop - mh - 1), 0, s(standTop - mh + 8));
  reflGrad.addColorStop(0, 'rgba(100,160,200,0.08)');
  reflGrad.addColorStop(1, 'rgba(100,160,200,0)');
  ctx.fillStyle = reflGrad;
  ctx.fillRect(s(cx - mw / 2), s(standTop - mh - 1), s(mw), s(8));

  // Text lines on screen
  ctx.fillStyle = 'rgba(80,200,120,0.5)';
  const widths = [18, 26, 12, 22, 15];
  for (let i = 0; i < 5; i++) {
    ctx.fillRect(s(cx - mw / 2 + 4), s(standTop - mh + 4 + i * 5), s(widths[i]), s(2));
  }

  // Power LED on bezel
  ctx.fillStyle = '#40e04060';
  ctx.beginPath();
  ctx.arc(s(cx), s(standTop + 1), s(1), 0, Math.PI * 2);
  ctx.fill();
}

function drawKeycard(cx, baseY) {
  const kw = 30, kh = 18;
  const pulse = 0.55 + 0.45 * Math.sin(gameTime * 3.5);
  const glowR = 35 + 10 * pulse;

  // Outer pulsing glow
  const glow = ctx.createRadialGradient(s(cx), s(baseY - kh / 2), 0, s(cx), s(baseY - kh / 2), s(glowR));
  glow.addColorStop(0, `rgba(80,200,255,${0.35 * pulse})`);
  glow.addColorStop(0.6, `rgba(80,200,255,${0.15 * pulse})`);
  glow.addColorStop(1, 'rgba(80,200,255,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(s(cx), s(baseY - kh / 2), s(glowR), 0, Math.PI * 2);
  ctx.fill();

  // Card body — bright against dark desk
  ctx.fillStyle = '#30b0f0';
  ctx.beginPath();
  ctx.roundRect(s(cx - kw / 2), s(baseY - kh), s(kw), s(kh), s(3));
  ctx.fill();
  // Highlight edge
  ctx.strokeStyle = 'rgba(150,230,255,0.6)';
  ctx.lineWidth = s(1.5);
  ctx.beginPath();
  ctx.roundRect(s(cx - kw / 2), s(baseY - kh), s(kw), s(kh), s(3));
  ctx.stroke();
  // Stripe
  ctx.fillStyle = '#70d0ff';
  ctx.fillRect(s(cx - kw / 2 + 4), s(baseY - kh + 4), s(kw - 8), s(4));
  // Chip
  ctx.fillStyle = '#f0d060';
  ctx.fillRect(s(cx - 4), s(baseY - kh + 10), s(8), s(5));
}

function drawCrate(cx, cy, cw, ch, sideW, isTop) {
  const woodDk = isTop ? '#4e3c1e' : '#5a4525';
  const woodMd = isTop ? '#65502e' : '#6e5832';
  const woodLt = isTop ? '#78623a' : '#7c683e';
  const woodHi = isTop ? '#8a7448' : '#8e7848';
  const metalC  = '#5a5a5a';
  const metalDk = '#3a3a3a';

  // Left side face — darker, defines left depth edge
  const lsGrad = ctx.createLinearGradient(s(cx - sideW), 0, s(cx), 0);
  lsGrad.addColorStop(0, isTop ? '#2e2010' : '#362814');
  lsGrad.addColorStop(1, woodDk);
  ctx.fillStyle = lsGrad;
  ctx.beginPath();
  ctx.moveTo(s(cx), s(cy));
  ctx.lineTo(s(cx - sideW), s(cy - 5));
  ctx.lineTo(s(cx - sideW), s(cy + ch - 3));
  ctx.lineTo(s(cx), s(cy + ch));
  ctx.closePath();
  ctx.fill();

  // Right side face for volume
  const sdGrad = ctx.createLinearGradient(s(cx + cw), 0, s(cx + cw + sideW), 0);
  sdGrad.addColorStop(0, woodDk);
  sdGrad.addColorStop(1, isTop ? '#3a2c14' : '#42321a');
  ctx.fillStyle = sdGrad;
  ctx.beginPath();
  ctx.moveTo(s(cx + cw), s(cy));
  ctx.lineTo(s(cx + cw + sideW), s(cy - 5));
  ctx.lineTo(s(cx + cw + sideW), s(cy + ch - 3));
  ctx.lineTo(s(cx + cw), s(cy + ch));
  ctx.closePath();
  ctx.fill();

  // Front face — wood grain gradient (vertical)
  const fGrad = ctx.createLinearGradient(s(cx), 0, s(cx + cw), 0);
  fGrad.addColorStop(0, woodDk);
  fGrad.addColorStop(0.15, woodMd);
  fGrad.addColorStop(0.5, woodLt);
  fGrad.addColorStop(0.85, woodMd);
  fGrad.addColorStop(1, woodDk);
  ctx.fillStyle = fGrad;
  ctx.fillRect(s(cx), s(cy), s(cw), s(ch));

  // Plank lines (horizontal boards)
  const plankCount = isTop ? 3 : 4;
  ctx.strokeStyle = 'rgba(0,0,0,0.20)';
  ctx.lineWidth = s(0.7);
  for (let i = 1; i < plankCount; i++) {
    const py = cy + (ch / plankCount) * i;
    ctx.beginPath();
    ctx.moveTo(s(cx + 1), s(py));
    ctx.lineTo(s(cx + cw - 1), s(py));
    ctx.stroke();
  }

  // Wood grain hints (subtle vertical streaks)
  ctx.strokeStyle = 'rgba(0,0,0,0.06)';
  ctx.lineWidth = s(0.5);
  for (let g = 0; g < 3; g++) {
    const gx = cx + cw * (0.25 + g * 0.25);
    ctx.beginPath();
    ctx.moveTo(s(gx), s(cy + 2));
    ctx.lineTo(s(gx + 1), s(cy + ch - 2));
    ctx.stroke();
  }

  // Top face — symmetric, connects both side faces
  const topOff = isTop ? 8 : 10;
  const topGrad = ctx.createLinearGradient(0, s(cy - topOff), 0, s(cy));
  topGrad.addColorStop(0, woodHi);
  topGrad.addColorStop(1, woodLt);
  ctx.fillStyle = topGrad;
  ctx.beginPath();
  ctx.moveTo(s(cx), s(cy));
  ctx.lineTo(s(cx + cw), s(cy));
  ctx.lineTo(s(cx + cw + sideW), s(cy - 5));
  ctx.lineTo(s(cx + cw - (isTop ? 6 : 8)), s(cy - topOff));
  ctx.lineTo(s(cx - (isTop ? 6 : 8)), s(cy - topOff));
  ctx.lineTo(s(cx - sideW), s(cy - 5));
  ctx.closePath();
  ctx.fill();

  // Metal strap (horizontal band across middle)
  const strapY = cy + ch * 0.48;
  const strapH = isTop ? 4 : 5;
  const stGrad = ctx.createLinearGradient(s(cx), 0, s(cx + cw), 0);
  stGrad.addColorStop(0, metalDk);
  stGrad.addColorStop(0.3, metalC);
  stGrad.addColorStop(0.7, metalC);
  stGrad.addColorStop(1, metalDk);
  ctx.fillStyle = stGrad;
  ctx.fillRect(s(cx), s(strapY), s(cw), s(strapH));
  // Strap highlight
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = s(0.5);
  ctx.beginPath();
  ctx.moveTo(s(cx + 2), s(strapY + 1));
  ctx.lineTo(s(cx + cw - 2), s(strapY + 1));
  ctx.stroke();

  // Corner brackets (small L-shapes at corners)
  ctx.strokeStyle = metalDk;
  ctx.lineWidth = s(1.2);
  const bk = isTop ? 5 : 7;
  // top-left
  ctx.beginPath();
  ctx.moveTo(s(cx + 1), s(cy + bk)); ctx.lineTo(s(cx + 1), s(cy + 1)); ctx.lineTo(s(cx + bk), s(cy + 1));
  ctx.stroke();
  // top-right
  ctx.beginPath();
  ctx.moveTo(s(cx + cw - bk), s(cy + 1)); ctx.lineTo(s(cx + cw - 1), s(cy + 1)); ctx.lineTo(s(cx + cw - 1), s(cy + bk));
  ctx.stroke();
  // bottom-left
  ctx.beginPath();
  ctx.moveTo(s(cx + 1), s(cy + ch - bk)); ctx.lineTo(s(cx + 1), s(cy + ch - 1)); ctx.lineTo(s(cx + bk), s(cy + ch - 1));
  ctx.stroke();
  // bottom-right
  ctx.beginPath();
  ctx.moveTo(s(cx + cw - bk), s(cy + ch - 1)); ctx.lineTo(s(cx + cw - 1), s(cy + ch - 1)); ctx.lineTo(s(cx + cw - 1), s(cy + ch - bk));
  ctx.stroke();

  // Rivet dots at bracket corners
  ctx.fillStyle = '#6e6e6e';
  const rv = 1;
  [[cx + 2, cy + 2], [cx + cw - 3, cy + 2], [cx + 2, cy + ch - 3], [cx + cw - 3, cy + ch - 3]].forEach(([rx, ry]) => {
    ctx.beginPath();
    ctx.arc(s(rx), s(ry), s(rv), 0, Math.PI * 2);
    ctx.fill();
  });

  // Edge outline
  ctx.strokeStyle = isTop ? '#2e2010' : '#362814';
  ctx.lineWidth = s(1.2);
  ctx.strokeRect(s(cx), s(cy), s(cw), s(ch));
}

function drawCrates() {
  const box = COLLIDERS[3];
  const base = floorToScreen((box.uMin + box.uMax) / 2, box.vMax);
  const bl = floorToScreen(box.uMin, box.vMax);
  const br = floorToScreen(box.uMax, box.vMax);
  const tl = floorToScreen(box.uMin, box.vMin);
  const tr = floorToScreen(box.uMax, box.vMin);
  const cw1 = br.x - bl.x;
  const ch1 = 55;
  const cx1 = base.x - cw1 / 2;
  const cy1 = base.y - ch1;
  const sideW = 8;

  // Ground-plane footprint shadow
  const footGrad = ctx.createRadialGradient(
    s(base.x), s((tl.y + base.y) / 2), 0,
    s(base.x), s((tl.y + base.y) / 2), s(Math.max(cw1, base.y - tl.y) * 0.8)
  );
  footGrad.addColorStop(0, 'rgba(0,0,0,0.16)');
  footGrad.addColorStop(0.7, 'rgba(0,0,0,0.07)');
  footGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = footGrad;
  ctx.beginPath();
  ctx.moveTo(s(tl.x - 3), s(tl.y - 2));
  ctx.lineTo(s(tr.x + 3), s(tr.y - 2));
  ctx.lineTo(s(br.x + 6), s(br.y + 5));
  ctx.lineTo(s(bl.x - 4), s(bl.y + 5));
  ctx.closePath();
  ctx.fill();

  // Contact shadow — wraps full base
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.moveTo(s(cx1 - 8), s(base.y - 1));
  ctx.lineTo(s(cx1 + cw1 + 2), s(base.y - 1));
  ctx.lineTo(s(cx1 + cw1 + 10), s(base.y + 8));
  ctx.lineTo(s(cx1 - 10), s(base.y + 8));
  ctx.closePath();
  ctx.fill();

  // Bottom crate
  drawCrate(cx1, cy1, cw1, ch1, sideW, false);

  // Top crate (smaller, offset)
  const cw2 = cw1 * 0.75;
  const ch2 = 40;
  const cx2 = base.x - cw2 / 2 + 5;
  const cy2 = cy1 - ch2 + 5;
  drawCrate(cx2, cy2, cw2, ch2, sideW * 0.7, true);

  // Stencil marking on bottom crate (subtle industrial stamp)
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.font = `bold ${s(10)}px monospace`;
  ctx.textAlign = 'center';
  ctx.fillText('S-04', s(cx1 + cw1 / 2), s(cy1 + ch1 - 8));
}

// ─── Guard AI ────────────────────────────────────────────────────────────────

function updateGuard(dt) {
  if (detected) return;

  if (guard.waitTimer > 0) {
    guard.waitTimer -= dt;
    return;
  }

  const target = PATROL[guard.waypointIdx];
  const du = target.u - guard.u;
  const dv = target.v - guard.v;
  const dist = Math.hypot(du, dv);

  if (dist < 0.02) {
    guard.waypointIdx = (guard.waypointIdx + 1) % PATROL.length;
    guard.waitTimer = 0.8;
    // Face toward next waypoint
    const next = PATROL[guard.waypointIdx];
    const ndu = next.u - guard.u;
    const ndv = next.v - guard.v;
    if (Math.abs(ndu) > Math.abs(ndv)) {
      guard.facing = ndu > 0 ? 'right' : 'left';
    } else {
      guard.facing = ndv > 0 ? 'down' : 'up';
    }
    return;
  }

  const step = guard.speed * dt;
  const ratio = Math.min(step / dist, 1);
  guard.u += du * ratio;
  guard.v += dv * ratio;

  if (Math.abs(du) > Math.abs(dv)) {
    guard.facing = du > 0 ? 'right' : 'left';
  } else {
    guard.facing = dv > 0 ? 'down' : 'up';
  }
}

// ─── Guard vision cone visual ────────────────────────────────────────────────

function drawGuardVision() {
  const ga = facingAngle(guard.facing);
  const coneAngle = Math.PI * 0.42;
  const coneLen = 0.28;

  ctx.save();
  ctx.globalAlpha = detected ? 0.18 : 0.10;
  ctx.fillStyle = detected ? '#e04040' : '#e0e040';

  const gScreen = floorToScreen(guard.u, guard.v);
  ctx.beginPath();
  ctx.moveTo(s(gScreen.x), s(gScreen.y));

  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    const a = ga - coneAngle + (2 * coneAngle * i / steps);
    const pu = Math.max(0, Math.min(1, guard.u + Math.cos(a) * coneLen));
    const pv = Math.max(0, Math.min(1, guard.v + Math.sin(a) * coneLen));
    const ps = floorToScreen(pu, pv);
    ctx.lineTo(s(ps.x), s(ps.y));
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ─── Reset helper ────────────────────────────────────────────────────────────

function resetGame() {
  detected = false;
  hasKeycard = false;
  won = false;
  player.u = 0.15;
  player.v = 0.85;
  player.facing = 'up';
  guard.u = PATROL[0].u;
  guard.v = PATROL[0].v;
  guard.waypointIdx = 0;
  guard.waitTimer = 1.0;
  guard.facing = 'down';
}

// ─── Character draw ──────────────────────────────────────────────────────────

function drawCharacter(pos, facing, type) {
  const cx = s(pos.x);
  const cy = s(pos.y);
  const sc = scale;
  const c = sc * 1.0;

  const isGuard = type === 'guard';

  // Palette
  const torsoHi  = isGuard ? '#4a4a4a' : '#5a88c8';
  const torsoLo  = isGuard ? '#2a2a2a' : '#3a5e98';
  const legHi    = isGuard ? '#303030' : '#2e3e6e';
  const legLo    = isGuard ? '#1e1e1e' : '#1e2a50';
  const armHi    = isGuard ? '#3e3e3e' : '#4878b8';
  const armLo    = isGuard ? '#282828' : '#305898';
  const skinHi   = '#dca070';
  const skinLo   = '#c08858';

  // Ground shadow
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.30)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + sc * 2, sc * 12, sc * 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // --- Legs (longer for adult proportion) ---
  const legW = 7, legH = 30, legGap = 1;
  // Left leg
  const llGrad = ctx.createLinearGradient(cx - (legGap + legW) * c, 0, cx - legGap * c, 0);
  llGrad.addColorStop(0, legLo);
  llGrad.addColorStop(0.5, legHi);
  llGrad.addColorStop(1, legLo);
  ctx.fillStyle = llGrad;
  ctx.beginPath();
  ctx.roundRect(cx - (legGap + legW) * c, cy - legH * c, legW * c, legH * c, 2 * c);
  ctx.fill();
  // Right leg
  const rlGrad = ctx.createLinearGradient(cx + legGap * c, 0, cx + (legGap + legW) * c, 0);
  rlGrad.addColorStop(0, legLo);
  rlGrad.addColorStop(0.5, legHi);
  rlGrad.addColorStop(1, legLo);
  ctx.fillStyle = rlGrad;
  ctx.beginPath();
  ctx.roundRect(cx + legGap * c, cy - legH * c, legW * c, legH * c, 2 * c);
  ctx.fill();

  // Shoes
  ctx.fillStyle = '#1a1a1a';
  ctx.beginPath();
  ctx.ellipse(cx - (legGap + legW / 2) * c, cy - 1 * c, 6 * c, 3 * c, -0.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx + (legGap + legW / 2) * c, cy - 1 * c, 6 * c, 3 * c, 0.15, 0, Math.PI * 2);
  ctx.fill();

  // --- Torso (slightly taller, narrower) ---
  const torsoW = 22, torsoH = 34, torsoBot = legH + 2, torsoTop = torsoBot + torsoH;
  const tGrad = ctx.createLinearGradient(cx - torsoW / 2 * c, 0, cx + torsoW / 2 * c, 0);
  tGrad.addColorStop(0, torsoLo);
  tGrad.addColorStop(0.35, torsoHi);
  tGrad.addColorStop(0.65, torsoHi);
  tGrad.addColorStop(1, torsoLo);
  ctx.fillStyle = tGrad;
  ctx.beginPath();
  ctx.roundRect(
    cx - torsoW / 2 * c, cy - torsoTop * c, torsoW * c, torsoH * c,
    [3 * c, 3 * c, 1 * c, 1 * c]
  );
  ctx.fill();

  // Belt line
  ctx.strokeStyle = isGuard ? '#1a1a1a' : '#283860';
  ctx.lineWidth = c * 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - torsoW / 2 * c, cy - torsoBot * c);
  ctx.lineTo(cx + torsoW / 2 * c, cy - torsoBot * c);
  ctx.stroke();

  // Shoulder seam
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = c * 0.8;
  ctx.beginPath();
  ctx.moveTo(cx - torsoW / 2 * c, cy - (torsoTop - 3) * c);
  ctx.lineTo(cx + torsoW / 2 * c, cy - (torsoTop - 3) * c);
  ctx.stroke();

  // --- Arms (longer, slimmer) ---
  const armW = 7, armH = 28;
  const armTop = torsoTop - 1;
  // Left arm
  const laGrad = ctx.createLinearGradient(cx - (torsoW / 2 + armW) * c, 0, cx - torsoW / 2 * c, 0);
  laGrad.addColorStop(0, armLo);
  laGrad.addColorStop(0.6, armHi);
  laGrad.addColorStop(1, armLo);
  ctx.fillStyle = laGrad;
  ctx.beginPath();
  ctx.roundRect(cx - (torsoW / 2 + armW) * c, cy - armTop * c, armW * c, armH * c, 3 * c);
  ctx.fill();
  // Right arm
  const raGrad = ctx.createLinearGradient(cx + torsoW / 2 * c, 0, cx + (torsoW / 2 + armW) * c, 0);
  raGrad.addColorStop(0, armLo);
  raGrad.addColorStop(0.4, armHi);
  raGrad.addColorStop(1, armLo);
  ctx.fillStyle = raGrad;
  ctx.beginPath();
  ctx.roundRect(cx + torsoW / 2 * c, cy - armTop * c, armW * c, armH * c, 3 * c);
  ctx.fill();

  // Hands
  const handY = cy - (armTop - armH) * c;
  ctx.fillStyle = skinLo;
  ctx.beginPath();
  ctx.arc(cx - (torsoW / 2 + armW / 2) * c, handY, 3.5 * c, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + (torsoW / 2 + armW / 2) * c, handY, 3.5 * c, 0, Math.PI * 2);
  ctx.fill();

  // --- Neck ---
  const neckBot = torsoTop;
  const neckTop = neckBot + 7;
  const nGrad = ctx.createLinearGradient(cx - 4 * c, 0, cx + 4 * c, 0);
  nGrad.addColorStop(0, skinLo);
  nGrad.addColorStop(0.5, skinHi);
  nGrad.addColorStop(1, skinLo);
  ctx.fillStyle = nGrad;
  ctx.beginPath();
  ctx.roundRect(cx - 4 * c, cy - neckTop * c, 8 * c, 7 * c, 1.5 * c);
  ctx.fill();

  // --- Head (smaller, more adult) ---
  const headCY = cy - (neckTop + 12) * c;
  const headRX = 12, headRY = 13;
  const hGrad = ctx.createRadialGradient(
    cx - 2 * c, headCY - 2 * c, 0,
    cx, headCY, headRY * c
  );
  hGrad.addColorStop(0, skinHi);
  hGrad.addColorStop(1, skinLo);
  ctx.fillStyle = hGrad;
  ctx.beginPath();
  ctx.ellipse(cx, headCY, headRX * c, headRY * c, 0, 0, Math.PI * 2);
  ctx.fill();

  // Ear hints
  ctx.fillStyle = skinLo;
  ctx.beginPath();
  ctx.ellipse(cx - headRX * c, headCY + 1 * c, 2.5 * c, 4 * c, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx + headRX * c, headCY + 1 * c, 2.5 * c, 4 * c, 0, 0, Math.PI * 2);
  ctx.fill();

  // Hair / beret
  if (isGuard) {
    // Beret
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.ellipse(cx - 1 * c, headCY - 11 * c, 12 * c, 6 * c, -0.12, 0, Math.PI * 2);
    ctx.fill();
    // Beret brim
    ctx.fillStyle = '#101010';
    ctx.beginPath();
    ctx.ellipse(cx, headCY - 7 * c, 13 * c, 2.5 * c, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Short hair
    ctx.fillStyle = '#3a2810';
    ctx.beginPath();
    ctx.ellipse(cx, headCY - 5 * c, 13 * c, 10 * c, 0, Math.PI, 0);
    ctx.fill();
    // Side hair
    ctx.beginPath();
    ctx.arc(cx - 12 * c, headCY - 2 * c, 4 * c, 0.5, 2.6);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + 12 * c, headCY - 2 * c, 4 * c, 0.5, 2.6);
    ctx.fill();
  }

  // --- Eyes (smaller, sharper) ---
  const eyeY = headCY + 1 * c;
  if (facing === 'left') {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(cx - 5 * c, eyeY, 3.5 * c, 2.8 * c, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.arc(cx - 6.5 * c, eyeY, 1.8 * c, 0, Math.PI * 2);
    ctx.fill();
  } else if (facing === 'right') {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(cx + 5 * c, eyeY, 3.5 * c, 2.8 * c, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.arc(cx + 6.5 * c, eyeY, 1.8 * c, 0, Math.PI * 2);
    ctx.fill();
  } else if (facing !== 'up') {
    // Forward-facing: two eyes
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(cx - 4 * c, eyeY, 3 * c, 2.5 * c, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx + 4 * c, eyeY, 3 * c, 2.5 * c, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.arc(cx - 4 * c, eyeY, 1.5 * c, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + 4 * c, eyeY, 1.5 * c, 0, Math.PI * 2);
    ctx.fill();
  }

  // Subtle mouth line (not a smiley arc)
  if (facing !== 'up') {
    ctx.strokeStyle = 'rgba(120,70,50,0.35)';
    ctx.lineWidth = c * 1;
    ctx.beginPath();
    ctx.moveTo(cx - 3 * c, headCY + 7 * c);
    ctx.lineTo(cx + 3 * c, headCY + 7 * c);
    ctx.stroke();
  }
}

// ─── Update ──────────────────────────────────────────────────────────────────
const U_MIN = 0.06, U_MAX = 0.94;
const V_MIN = 0.06, V_MAX = 0.96;

function update(dt) {
  gameTime += dt;

  // Reset on R
  if (keys['r'] || keys['R']) {
    if (detected || won) {
      resetGame();
      keys['r'] = false;
      keys['R'] = false;
      return;
    }
  }

  if (detected || won) return;

  // Perspective-normalized movement: compute local screen-space scale
  // so forward/back feels as fast as left/right
  const eps = 0.001;
  const here = floorToScreen(player.u, player.v);
  const rightPt = floorToScreen(player.u + eps, player.v);
  const downPt = floorToScreen(player.u, player.v + eps);
  const scaleU = Math.hypot(rightPt.x - here.x, rightPt.y - here.y) / eps;
  const scaleV = Math.hypot(downPt.x - here.x, downPt.y - here.y) / eps;
  const avgScale = (scaleU + scaleV) / 2;
  const uFactor = avgScale / scaleU;
  const vFactor = avgScale / scaleV;

  const spd = player.speed * dt;
  let du = 0, dv = 0;

  if (keys['ArrowLeft']  || keys['a'] || keys['A']) { du -= spd * uFactor; player.facing = 'left'; }
  if (keys['ArrowRight'] || keys['d'] || keys['D']) { du += spd * uFactor; player.facing = 'right'; }
  if (keys['ArrowUp']    || keys['w'] || keys['W']) { dv -= spd * vFactor; if (du === 0) player.facing = 'up'; }
  if (keys['ArrowDown']  || keys['s'] || keys['S']) { dv += spd * vFactor; if (du === 0) player.facing = 'down'; }

  const oldU = player.u, oldV = player.v;

  // Try full move
  player.u = Math.max(U_MIN, Math.min(U_MAX, oldU + du));
  player.v = Math.max(V_MIN, Math.min(V_MAX, oldV + dv));
  if (collidesWithAny(player.u, player.v)) {
    // Try u only
    player.u = Math.max(U_MIN, Math.min(U_MAX, oldU + du));
    player.v = oldV;
    if (collidesWithAny(player.u, player.v)) {
      // Try v only
      player.u = oldU;
      player.v = Math.max(V_MIN, Math.min(V_MAX, oldV + dv));
      if (collidesWithAny(player.u, player.v)) {
        player.u = oldU;
        player.v = oldV;
      }
    }
  }

  // Keycard pickup — near desk front edge, press E or Space
  if (!hasKeycard && (keys['e'] || keys['E'] || keys[' '])) {
    const desk = COLLIDERS[2];
    const deskCU = (desk.uMin + desk.uMax) / 2;
    const deskFrontV = desk.vMax + 0.06;
    if (Math.abs(player.u - deskCU) < 0.18 && Math.abs(player.v - deskFrontV) < 0.10) {
      hasKeycard = true;
      keys['e'] = false; keys['E'] = false; keys[' '] = false;
    }
  }

  // Exit interaction — near right wall, press E or Space
  if (hasKeycard && (keys['e'] || keys['E'] || keys[' '])) {
    if (player.u > 0.82 && player.v > 0.28 && player.v < 0.82) {
      won = true;
      keys['e'] = false; keys['E'] = false; keys[' '] = false;
    }
  }

  // Guard AI
  updateGuard(dt);

  // LOS detection
  if (guardCanSeePlayer()) {
    detected = true;
  }
}

// ─── Render ──────────────────────────────────────────────────────────────────
function render() {
  ctx.fillStyle = '#0a0a0f';
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.translate((W - 1280 * scale) / 2, (H - 720 * scale) / 2);

  // Room structure
  drawRoom();

  // Guard vision cone (on floor, below sprites)
  drawGuardVision();

  // Depth-sorted: objects + player + guard
  const sortable = [];

  sortable.push({ v: COLLIDERS[2].vMax, draw: drawDesk });
  sortable.push({ v: COLLIDERS[1].vMax, draw: () => drawServerRack(COLLIDERS[1]) });
  sortable.push({ v: COLLIDERS[0].vMax, draw: () => drawServerRack(COLLIDERS[0]) });
  sortable.push({ v: COLLIDERS[3].vMax, draw: drawCrates });

  // Player
  sortable.push({
    v: player.v,
    draw: () => {
      const ps = floorToScreen(player.u, player.v);
      drawCharacter(ps, player.facing, 'player');
    }
  });

  // Guard
  sortable.push({
    v: guard.v,
    draw: () => {
      const gs = floorToScreen(guard.u, guard.v);
      drawCharacter(gs, guard.facing, 'guard');
    }
  });

  sortable.sort((a, b) => a.v - b.v);
  sortable.forEach(spr => spr.draw());

  // Proximity prompts (world-space)
  if (!detected && !won) {
    const desk = COLLIDERS[2];
    const deskCU = (desk.uMin + desk.uMax) / 2;
    const deskFrontV = desk.vMax + 0.06;
    const nearKeycard = !hasKeycard &&
      Math.abs(player.u - deskCU) < 0.18 &&
      Math.abs(player.v - deskFrontV) < 0.10;
    const nearExit = hasKeycard &&
      player.u > 0.82 && player.v > 0.28 && player.v < 0.82;

    if (nearKeycard) {
      const promptPos = floorToScreen(deskCU, desk.vMax + 0.02);
      const bob = Math.sin(gameTime * 4) * 3;
      ctx.textAlign = 'center';
      ctx.font = `bold ${s(14)}px monospace`;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillText('[E] Pick up keycard', s(promptPos.x + 1), s(promptPos.y - 18 + bob + 1));
      ctx.fillStyle = '#80e0ff';
      ctx.fillText('[E] Pick up keycard', s(promptPos.x), s(promptPos.y - 18 + bob));
    }

    if (nearExit) {
      const exitPromptU = 0.95, exitPromptV = 0.55;
      const promptPos = floorToScreen(exitPromptU, exitPromptV);
      const bob = Math.sin(gameTime * 4) * 3;
      ctx.textAlign = 'center';
      ctx.font = `bold ${s(14)}px monospace`;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillText('[E] Use exit', s(promptPos.x + 1), s(promptPos.y - 20 + bob + 1));
      ctx.fillStyle = '#60ff60';
      ctx.fillText('[E] Use exit', s(promptPos.x), s(promptPos.y - 20 + bob));
    }
  }

  // Objective status (bottom-left)
  if (!detected && !won) {
    ctx.textAlign = 'left';
    ctx.font = `${s(13)}px monospace`;
    if (!hasKeycard) {
      ctx.fillStyle = 'rgba(80,200,255,0.5)';
      ctx.fillText('Find the keycard', s(30), s(690));
    } else {
      ctx.fillStyle = 'rgba(64,224,64,0.6)';
      ctx.fillText('Reach the exit', s(30), s(690));
    }
  }

  // Detection overlay
  if (detected) {
    ctx.fillStyle = 'rgba(180,0,0,0.3)';
    ctx.fillRect(0, 0, s(1280), s(720));
    ctx.fillStyle = '#ff2020';
    ctx.font = `bold ${s(48)}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('DETECTED', s(640), s(340));
    ctx.fillStyle = '#ffffff';
    ctx.font = `${s(18)}px monospace`;
    ctx.fillText('Press R to retry', s(640), s(390));
  }

  // Win overlay
  if (won) {
    ctx.fillStyle = 'rgba(0,40,0,0.4)';
    ctx.fillRect(0, 0, s(1280), s(720));
    ctx.fillStyle = '#40e040';
    ctx.font = `bold ${s(48)}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('MISSION COMPLETE', s(640), s(340));
    ctx.fillStyle = '#ffffff';
    ctx.font = `${s(18)}px monospace`;
    ctx.fillText('Press R to play again', s(640), s(390));
  }

  ctx.restore();
}

// ─── Game loop ───────────────────────────────────────────────────────────────
let lastTime = 0;

function loop(timestamp) {
  const dt = Math.min((timestamp - lastTime) / 1000, 0.05);
  lastTime = timestamp;
  update(dt);
  render();
  requestAnimationFrame(loop);
}

requestAnimationFrame(ts => { lastTime = ts; requestAnimationFrame(loop); });
