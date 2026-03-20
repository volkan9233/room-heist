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

// ─── Guard (defined here, AI activated in Part 2) ────────────────────────────
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

// ─── LOS helpers (used by guard AI in Part 2) ────────────────────────────────
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

// ─── Placeholder objects (will become detailed art in Part 2) ────────────────

function drawPlaceholderBox(box, label, color, height) {
  // Draw a simple 3D box at the collider position
  const bl = floorToScreen(box.uMin, box.vMax);
  const br = floorToScreen(box.uMax, box.vMax);
  const tl = floorToScreen(box.uMin, box.vMin);
  const tr = floorToScreen(box.uMax, box.vMin);

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.moveTo(s(bl.x), s(bl.y));
  ctx.lineTo(s(br.x), s(br.y));
  ctx.lineTo(s(br.x + 8), s(br.y + 10));
  ctx.lineTo(s(bl.x - 4), s(bl.y + 10));
  ctx.closePath();
  ctx.fill();

  // Front face
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(s(bl.x), s(bl.y - height));
  ctx.lineTo(s(br.x), s(br.y - height));
  ctx.lineTo(s(br.x), s(br.y));
  ctx.lineTo(s(bl.x), s(bl.y));
  ctx.closePath();
  ctx.fill();

  // Top face
  const topColor = color.replace(')', ',0.7)').replace('rgb', 'rgba');
  // just lighten by drawing a lighter rect
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.beginPath();
  ctx.moveTo(s(bl.x), s(bl.y - height));
  ctx.lineTo(s(br.x), s(br.y - height));
  ctx.lineTo(s(tr.x), s(tr.y - height));
  ctx.lineTo(s(tl.x), s(tl.y - height));
  ctx.closePath();
  ctx.fill();

  // Outline
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = s(1.5);
  ctx.beginPath();
  ctx.moveTo(s(bl.x), s(bl.y));
  ctx.lineTo(s(bl.x), s(bl.y - height));
  ctx.lineTo(s(br.x), s(br.y - height));
  ctx.lineTo(s(br.x), s(br.y));
  ctx.closePath();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s(bl.x), s(bl.y - height));
  ctx.lineTo(s(tl.x), s(tl.y - height));
  ctx.lineTo(s(tr.x), s(tr.y - height));
  ctx.lineTo(s(br.x), s(br.y - height));
  ctx.stroke();

  // Label
  const cx = (bl.x + br.x) / 2;
  const cy = (bl.y + bl.y - height) / 2;
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = `${s(10)}px monospace`;
  ctx.textAlign = 'center';
  ctx.fillText(label, s(cx), s(cy));
}

function drawAllObjects() {
  // Draw placeholder objects sorted back-to-front by vMax
  const objects = [
    { box: COLLIDERS[2], label: 'DESK', color: '#5a5d65', height: 55 },
    { box: COLLIDERS[1], label: 'SERVER', color: '#2a2d35', height: 120 },
    { box: COLLIDERS[0], label: 'SERVER', color: '#2a2d35', height: 120 },
    { box: COLLIDERS[3], label: 'CRATES', color: '#6a5530', height: 80 },
  ];
  objects.sort((a, b) => a.box.vMax - b.box.vMax);

  return objects;
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
  if (detected) return;

  const spd = player.speed * dt;
  let du = 0, dv = 0;

  if (keys['ArrowLeft']  || keys['a'] || keys['A']) { du -= spd; player.facing = 'left'; }
  if (keys['ArrowRight'] || keys['d'] || keys['D']) { du += spd; player.facing = 'right'; }
  if (keys['ArrowUp']    || keys['w'] || keys['W']) { dv -= spd * 0.7; if (du === 0) player.facing = 'up'; }
  if (keys['ArrowDown']  || keys['s'] || keys['S']) { dv += spd * 0.7; if (du === 0) player.facing = 'down'; }

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
}

// ─── Render ──────────────────────────────────────────────────────────────────
function render() {
  ctx.fillStyle = '#0a0a0f';
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.translate((W - 1280 * scale) / 2, (H - 720 * scale) / 2);

  // Room structure
  drawRoom();

  // Depth-sorted: objects + player
  const sortable = [];

  // Objects
  const objs = [
    { box: COLLIDERS[2], label: 'DESK', color: '#5a5d65', height: 55 },
    { box: COLLIDERS[1], label: 'SERVER', color: '#2a2d35', height: 120 },
    { box: COLLIDERS[0], label: 'SERVER', color: '#2a2d35', height: 120 },
    { box: COLLIDERS[3], label: 'CRATES', color: '#6a5530', height: 80 },
  ];
  for (const o of objs) {
    sortable.push({ v: o.box.vMax, draw: () => drawPlaceholderBox(o.box, o.label, o.color, o.height) });
  }

  // Player
  sortable.push({
    v: player.v,
    draw: () => {
      const ps = floorToScreen(player.u, player.v);
      drawCharacter(ps, player.facing, 'player');
    }
  });

  sortable.sort((a, b) => a.v - b.v);
  sortable.forEach(spr => spr.draw());

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
