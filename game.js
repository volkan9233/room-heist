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
  backGrad.addColorStop(0, '#4a4d55');
  backGrad.addColorStop(1, '#3a3d45');
  roomPath([ceilTL, ceilTR, floorTR, floorTL]);
  ctx.fillStyle = backGrad;
  ctx.fill();

  // Concrete panel lines on back wall
  ctx.save();
  roomPath([ceilTL, ceilTR, floorTR, floorTL]);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
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
  }
  for (let i = 1; i <= 5; i++) {
    const t = i / 6;
    const tx1 = ceilTL.x + (ceilTR.x - ceilTL.x) * t;
    const tx2 = floorTL.x + (floorTR.x - floorTL.x) * t;
    ctx.beginPath();
    ctx.moveTo(s(tx1), s(ceilTL.y));
    ctx.lineTo(s(tx2), s(floorTL.y));
    ctx.stroke();
  }
  ctx.restore();

  // ── Left side wall ──
  const leftGrad = ctx.createLinearGradient(s(80), s(130), s(260), s(270));
  leftGrad.addColorStop(0, '#32353d');
  leftGrad.addColorStop(1, '#3a3d45');
  roomPath([leftWallTop, ceilTL, floorTL, floorBL]);
  ctx.fillStyle = leftGrad;
  ctx.fill();

  // ── Right side wall ──
  const rightGrad = ctx.createLinearGradient(s(1020), s(270), s(1200), s(130));
  rightGrad.addColorStop(0, '#3a3d45');
  rightGrad.addColorStop(1, '#35383f');
  roomPath([ceilTR, rightWallTop, floorBR, floorTR]);
  ctx.fillStyle = rightGrad;
  ctx.fill();

  // ── Exit door on right wall ──
  drawExitDoor();

  // ── Floor ──
  const floorGrad = ctx.createLinearGradient(s(640), s(270), s(640), s(640));
  floorGrad.addColorStop(0, '#484b52');
  floorGrad.addColorStop(1, '#3e4148');
  roomPath([floorTL, floorTR, floorBR, floorBL]);
  ctx.fillStyle = floorGrad;
  ctx.fill();

  // Floor tile grid
  ctx.save();
  roomPath([floorTL, floorTR, floorBR, floorBL]);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = s(1);
  const gridH = 12;
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
  const gridV = 16;
  for (let i = 0; i <= gridV; i++) {
    const t = i / gridV;
    const lx1 = floorTL.x + (floorTR.x - floorTL.x) * t;
    const lx2 = floorBL.x + (floorBR.x - floorBL.x) * t;
    ctx.beginPath();
    ctx.moveTo(s(lx1), s(floorTL.y));
    ctx.lineTo(s(lx2), s(floorBL.y));
    ctx.stroke();
  }
  ctx.restore();

  // ── Floor AO ──
  drawFloorAO();

  // ── Metal baseboard strips ──
  ctx.strokeStyle = '#5a5d65';
  ctx.lineWidth = s(2);
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

  // ── Ceiling fluorescent lights ──
  drawCeilingLights();
}

function drawFloorAO() {
  const { floorTL, floorTR, floorBL, floorBR } = ROOM;
  ctx.save();
  roomPath([floorTL, floorTR, floorBR, floorBL]);
  ctx.clip();

  const backAO = ctx.createLinearGradient(s(640), s(floorTL.y), s(640), s(floorTL.y + 50));
  backAO.addColorStop(0, 'rgba(0,0,0,0.25)');
  backAO.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = backAO;
  ctx.fillRect(s(floorTL.x), s(floorTL.y), s(floorTR.x - floorTL.x), s(55));

  const leftAO = ctx.createLinearGradient(s(floorTL.x), s(floorTL.y), s(floorTL.x + 45), s(floorTL.y + 20));
  leftAO.addColorStop(0, 'rgba(0,0,0,0.20)');
  leftAO.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = leftAO;
  ctx.beginPath();
  ctx.moveTo(s(floorTL.x), s(floorTL.y));
  ctx.lineTo(s(floorBL.x), s(floorBL.y));
  ctx.lineTo(s(floorBL.x + 50), s(floorBL.y));
  ctx.lineTo(s(floorTL.x + 45), s(floorTL.y));
  ctx.closePath();
  ctx.fill();

  const rightAO = ctx.createLinearGradient(s(floorTR.x), s(floorTR.y), s(floorTR.x - 45), s(floorTR.y + 20));
  rightAO.addColorStop(0, 'rgba(0,0,0,0.20)');
  rightAO.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rightAO;
  ctx.beginPath();
  ctx.moveTo(s(floorTR.x), s(floorTR.y));
  ctx.lineTo(s(floorBR.x), s(floorBR.y));
  ctx.lineTo(s(floorBR.x - 50), s(floorBR.y));
  ctx.lineTo(s(floorTR.x - 45), s(floorTR.y));
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

function drawCeilingLights() {
  const { ceilTL, ceilTR } = ROOM;

  const l1x = ceilTL.x + (ceilTR.x - ceilTL.x) * 0.3;
  const ly = ceilTL.y + 15;
  ctx.fillStyle = '#e0e0e8';
  ctx.fillRect(s(l1x - 50), s(ly), s(100), s(5));
  const glow1 = ctx.createRadialGradient(s(l1x), s(ly + 2), s(5), s(l1x), s(ly + 2), s(80));
  glow1.addColorStop(0, 'rgba(200,210,230,0.12)');
  glow1.addColorStop(1, 'rgba(200,210,230,0)');
  ctx.fillStyle = glow1;
  ctx.fillRect(s(l1x - 80), s(ly - 40), s(160), s(90));

  const l2x = ceilTL.x + (ceilTR.x - ceilTL.x) * 0.7;
  ctx.fillStyle = '#e0e0e8';
  ctx.fillRect(s(l2x - 50), s(ly), s(100), s(5));
  const glow2 = ctx.createRadialGradient(s(l2x), s(ly + 2), s(5), s(l2x), s(ly + 2), s(80));
  glow2.addColorStop(0, 'rgba(200,210,230,0.12)');
  glow2.addColorStop(1, 'rgba(200,210,230,0)');
  ctx.fillStyle = glow2;
  ctx.fillRect(s(l2x - 80), s(ly - 40), s(160), s(90));
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

  // Frame
  ctx.fillStyle = '#5a5d65';
  ctx.beginPath();
  ctx.moveTo(s(dtl.x - 3), s(dtl.y - 3));
  ctx.lineTo(s(dtr.x + 3), s(dtr.y - 3));
  ctx.lineTo(s(dbr.x + 3), s(dbr.y + 3));
  ctx.lineTo(s(dbl.x - 3), s(dbl.y + 3));
  ctx.closePath();
  ctx.fill();

  // Door surface
  const doorGrad = ctx.createLinearGradient(s(dtl.x), s(dtl.y), s(dtr.x), s(dtr.y));
  doorGrad.addColorStop(0, '#6a6d75');
  doorGrad.addColorStop(0.5, '#757880');
  doorGrad.addColorStop(1, '#6a6d75');
  ctx.fillStyle = doorGrad;
  ctx.beginPath();
  ctx.moveTo(s(dtl.x), s(dtl.y));
  ctx.lineTo(s(dtr.x), s(dtr.y));
  ctx.lineTo(s(dbr.x), s(dbr.y));
  ctx.lineTo(s(dbl.x), s(dbl.y));
  ctx.closePath();
  ctx.fill();

  // Handle
  const handlePos = rightWallPoint(doorU1 + 0.05, (doorT1 + doorT2) * 0.52);
  ctx.fillStyle = '#c0c0c0';
  ctx.beginPath();
  ctx.arc(s(handlePos.x), s(handlePos.y), s(4), 0, Math.PI * 2);
  ctx.fill();

  // Status light
  const lightPos = rightWallPoint(doorU1 + 0.06, doorT1 + 0.06);
  const litColor = hasKeycard ? '#40e040' : '#e04040';
  ctx.fillStyle = litColor;
  ctx.beginPath();
  ctx.arc(s(lightPos.x), s(lightPos.y), s(3), 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  const glowC = hasKeycard ? 'rgba(64,224,64,' : 'rgba(224,64,64,';
  const lightGlow = ctx.createRadialGradient(
    s(lightPos.x), s(lightPos.y), 0,
    s(lightPos.x), s(lightPos.y), s(15)
  );
  lightGlow.addColorStop(0, glowC + '0.3)');
  lightGlow.addColorStop(1, glowC + '0)');
  ctx.fillStyle = lightGlow;
  ctx.beginPath();
  ctx.arc(s(lightPos.x), s(lightPos.y), s(15), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // EXIT label
  const textPos = rightWallPoint((doorU1 + doorU2) * 0.5, doorT1 - 0.06);
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

  // Ground-plane footprint shadow (shows full collision area on floor)
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

  // Contact shadow (hard edge at base)
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.moveTo(s(bx - 2), s(base.y - 1));
  ctx.lineTo(s(bx + screenW + 2), s(base.y - 1));
  ctx.lineTo(s(bx + screenW + 10), s(base.y + 10));
  ctx.lineTo(s(bx - 5), s(base.y + 10));
  ctx.closePath();
  ctx.fill();

  // Front face
  const bodyGrad = ctx.createLinearGradient(s(bx), s(by), s(bx + screenW), s(by));
  bodyGrad.addColorStop(0, '#2a2d35');
  bodyGrad.addColorStop(0.5, '#353840');
  bodyGrad.addColorStop(1, '#2a2d35');
  ctx.fillStyle = bodyGrad;
  ctx.fillRect(s(bx), s(by), s(screenW), s(rackH));

  // Top face
  ctx.fillStyle = '#404550';
  ctx.beginPath();
  ctx.moveTo(s(bx), s(by));
  ctx.lineTo(s(bx + screenW), s(by));
  ctx.lineTo(s(bx + screenW - 8), s(by - 12));
  ctx.lineTo(s(bx - 8), s(by - 12));
  ctx.closePath();
  ctx.fill();

  // Vent slits
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = s(1);
  for (let i = 0; i < 8; i++) {
    const vy = by + 15 + i * 13;
    ctx.beginPath();
    ctx.moveTo(s(bx + 6), s(vy));
    ctx.lineTo(s(bx + screenW - 6), s(vy));
    ctx.stroke();
  }

  // LED indicators
  const ledColors = ['#40e040', '#40e040', '#e0a020', '#40e040', '#e04040', '#40e040'];
  for (let i = 0; i < ledColors.length; i++) {
    ctx.fillStyle = ledColors[i];
    ctx.beginPath();
    ctx.arc(s(bx + 10), s(by + 20 + i * 13), s(2), 0, Math.PI * 2);
    ctx.fill();
  }

  // Frame outline
  ctx.strokeStyle = '#1a1d25';
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
  const dx = base.x - deskW / 2;
  const topY = base.y - legH;

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.moveTo(s(dx), s(base.y));
  ctx.lineTo(s(dx + deskW), s(base.y));
  ctx.lineTo(s(dx + deskW + 12), s(base.y + 10));
  ctx.lineTo(s(dx - 6), s(base.y + 10));
  ctx.closePath();
  ctx.fill();

  // Legs
  ctx.strokeStyle = '#5a5d65';
  ctx.lineWidth = s(4);
  ctx.beginPath(); ctx.moveTo(s(dx + 8), s(topY + 8)); ctx.lineTo(s(dx + 6), s(base.y)); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(s(dx + deskW - 8), s(topY + 8)); ctx.lineTo(s(dx + deskW - 6), s(base.y)); ctx.stroke();

  // Front face
  ctx.fillStyle = '#5a5d65';
  ctx.fillRect(s(dx), s(topY + 4), s(deskW), s(8));

  // Top surface
  const topGrad = ctx.createLinearGradient(s(dx), s(topY), s(dx + deskW), s(topY));
  topGrad.addColorStop(0, '#6a6d75');
  topGrad.addColorStop(0.5, '#757880');
  topGrad.addColorStop(1, '#6a6d75');
  ctx.fillStyle = topGrad;
  ctx.fillRect(s(dx), s(topY - 2), s(deskW), s(6));
  ctx.strokeStyle = '#808590';
  ctx.lineWidth = s(1);
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
  // Stand
  ctx.fillStyle = '#3a3d45';
  ctx.fillRect(s(cx - 4), s(baseY - 6), s(8), s(6));
  ctx.fillRect(s(cx - 10), s(baseY - 2), s(20), s(3));
  // Screen frame
  ctx.fillStyle = '#2a2d35';
  ctx.fillRect(s(cx - mw / 2 - 2), s(baseY - 6 - mh - 2), s(mw + 4), s(mh + 4));
  // Screen
  const scrGrad = ctx.createLinearGradient(s(cx - mw / 2), s(baseY - 6 - mh), s(cx - mw / 2), s(baseY - 6));
  scrGrad.addColorStop(0, '#1a3a4a');
  scrGrad.addColorStop(1, '#0a2030');
  ctx.fillStyle = scrGrad;
  ctx.fillRect(s(cx - mw / 2), s(baseY - 6 - mh), s(mw), s(mh));
  // Text lines on screen
  ctx.fillStyle = 'rgba(80,200,120,0.5)';
  const widths = [18, 26, 12, 22, 15];
  for (let i = 0; i < 5; i++) {
    ctx.fillRect(s(cx - mw / 2 + 4), s(baseY - 6 - mh + 5 + i * 5), s(widths[i]), s(2));
  }
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

  // Ground-plane footprint shadow (shows full collision area on floor)
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

  // Contact shadow (hard edge at base)
  ctx.fillStyle = 'rgba(0,0,0,0.20)';
  ctx.beginPath();
  ctx.moveTo(s(cx1 - 1), s(base.y - 1));
  ctx.lineTo(s(cx1 + cw1 + 1), s(base.y - 1));
  ctx.lineTo(s(cx1 + cw1 + 10), s(base.y + 8));
  ctx.lineTo(s(cx1 - 5), s(base.y + 8));
  ctx.closePath();
  ctx.fill();

  // Bottom crate front face
  const crateGrad = ctx.createLinearGradient(s(cx1), s(cy1), s(cx1 + cw1), s(cy1));
  crateGrad.addColorStop(0, '#6a5530');
  crateGrad.addColorStop(0.5, '#7a6540');
  crateGrad.addColorStop(1, '#6a5530');
  ctx.fillStyle = crateGrad;
  ctx.fillRect(s(cx1), s(cy1), s(cw1), s(ch1));

  // Bottom crate top face
  ctx.fillStyle = '#8a7550';
  ctx.beginPath();
  ctx.moveTo(s(cx1), s(cy1));
  ctx.lineTo(s(cx1 + cw1), s(cy1));
  ctx.lineTo(s(cx1 + cw1 - 8), s(cy1 - 10));
  ctx.lineTo(s(cx1 - 8), s(cy1 - 10));
  ctx.closePath();
  ctx.fill();

  // Cross bracing
  ctx.strokeStyle = '#5a4520';
  ctx.lineWidth = s(2);
  ctx.beginPath();
  ctx.moveTo(s(cx1 + 4), s(cy1 + 4));
  ctx.lineTo(s(cx1 + cw1 - 4), s(cy1 + ch1 - 4));
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s(cx1 + cw1 - 4), s(cy1 + 4));
  ctx.lineTo(s(cx1 + 4), s(cy1 + ch1 - 4));
  ctx.stroke();

  // Edge
  ctx.strokeStyle = '#4a3518';
  ctx.lineWidth = s(1.5);
  ctx.strokeRect(s(cx1), s(cy1), s(cw1), s(ch1));

  // Top crate (smaller, offset)
  const cw2 = cw1 * 0.75;
  const ch2 = 40;
  const cx2 = base.x - cw2 / 2 + 5;
  const cy2 = cy1 - ch2 + 5;

  ctx.fillStyle = '#5a4828';
  ctx.fillRect(s(cx2), s(cy2), s(cw2), s(ch2));
  // Top face
  ctx.fillStyle = '#7a6840';
  ctx.beginPath();
  ctx.moveTo(s(cx2), s(cy2));
  ctx.lineTo(s(cx2 + cw2), s(cy2));
  ctx.lineTo(s(cx2 + cw2 - 6), s(cy2 - 8));
  ctx.lineTo(s(cx2 - 6), s(cy2 - 8));
  ctx.closePath();
  ctx.fill();
  // Cross bracing
  ctx.strokeStyle = '#4a3818';
  ctx.lineWidth = s(1.5);
  ctx.beginPath();
  ctx.moveTo(s(cx2 + 3), s(cy2 + 3));
  ctx.lineTo(s(cx2 + cw2 - 3), s(cy2 + ch2 - 3));
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s(cx2 + cw2 - 3), s(cy2 + 3));
  ctx.lineTo(s(cx2 + 3), s(cy2 + ch2 - 3));
  ctx.stroke();
  ctx.strokeStyle = '#3a2510';
  ctx.strokeRect(s(cx2), s(cy2), s(cw2), s(ch2));
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
  const csc = sc * 1.0;

  const isGuard = type === 'guard';
  const torsoC1 = isGuard ? '#404040' : '#5080c0';
  const torsoC2 = isGuard ? '#2a2a2a' : '#3060a0';
  const legC    = isGuard ? '#2a2a2a' : '#2a3a6a';
  const armC    = isGuard ? '#353535' : '#4070b0';

  // Shadow
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + sc * 2, sc * 14, sc * 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Legs
  ctx.fillStyle = legC;
  ctx.beginPath();
  ctx.roundRect(cx - 9 * csc, cy - 24 * csc, 9 * csc, 24 * csc, 3 * csc);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(cx + 1 * csc, cy - 24 * csc, 9 * csc, 24 * csc, 3 * csc);
  ctx.fill();
  // Shoes
  ctx.fillStyle = '#1a1a1a';
  ctx.beginPath();
  ctx.ellipse(cx - 5 * csc, cy - 1 * csc, 8 * csc, 4 * csc, -0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx + 5 * csc, cy - 1 * csc, 8 * csc, 4 * csc, 0.2, 0, Math.PI * 2);
  ctx.fill();

  // Torso
  const torsoGrad = ctx.createLinearGradient(
    cx - 13 * csc, cy - 56 * csc, cx + 13 * csc, cy - 24 * csc
  );
  torsoGrad.addColorStop(0, torsoC1);
  torsoGrad.addColorStop(1, torsoC2);
  ctx.fillStyle = torsoGrad;
  ctx.beginPath();
  ctx.roundRect(cx - 13 * csc, cy - 56 * csc, 26 * csc, 32 * csc,
    [4 * csc, 4 * csc, 2 * csc, 2 * csc]);
  ctx.fill();

  // Arms
  ctx.fillStyle = armC;
  ctx.beginPath();
  ctx.roundRect(cx - 21 * csc, cy - 55 * csc, 9 * csc, 22 * csc, 4 * csc);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(cx + 12 * csc, cy - 55 * csc, 9 * csc, 22 * csc, 4 * csc);
  ctx.fill();
  // Hands
  ctx.fillStyle = '#d4956a';
  ctx.beginPath();
  ctx.arc(cx - 16 * csc, cy - 34 * csc, 5 * csc, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + 16 * csc, cy - 34 * csc, 5 * csc, 0, Math.PI * 2);
  ctx.fill();

  // Neck
  ctx.fillStyle = '#d4956a';
  ctx.beginPath();
  ctx.roundRect(cx - 5 * csc, cy - 64 * csc, 10 * csc, 10 * csc, 2 * csc);
  ctx.fill();

  // Head
  ctx.fillStyle = '#e0a878';
  ctx.beginPath();
  ctx.ellipse(cx, cy - 78 * csc, 16 * csc, 18 * csc, 0, 0, Math.PI * 2);
  ctx.fill();

  // Hair / beret
  if (isGuard) {
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.ellipse(cx - 2 * csc, cy - 92 * csc, 14 * csc, 8 * csc, -0.15, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = '#3a2810';
    ctx.beginPath();
    ctx.ellipse(cx, cy - 88 * csc, 15 * csc, 10 * csc, 0, Math.PI, 0);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx - 15 * csc, cy - 80 * csc, 6 * csc, 0.8, 2.4);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + 15 * csc, cy - 80 * csc, 6 * csc, 0.7, 2.3);
    ctx.fill();
  }

  // Eyes
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
  } else if (facing !== 'up') {
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

  // Mouth
  if (facing !== 'up') {
    ctx.strokeStyle = isGuard ? '#805040' : '#a0604a';
    ctx.lineWidth = sc * 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy - 70 * csc, 5 * csc, 0.2, Math.PI - 0.2);
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
