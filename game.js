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
const justPressed = {};  // edge-triggered: true only on the frame the key goes down
window.addEventListener('keydown', e => {
  if (!keys[e.key]) justPressed[e.key] = true;
  keys[e.key] = true;
});
window.addEventListener('keyup',   e => { keys[e.key] = false; });

// ─── Player ───────────────────────────────────────────────────────────────────
const player = {
  u: 0.15,
  v: 0.85,
  speed: 0.22,
  facing: 'up',
  walkPhase: 0,
  // Hotspot movement state
  currentHotspot: 'r1_start',  // id of hotspot player is at (null if mid-walk)
  targetHotspot: null,         // id of hotspot player is walking toward
  walkFromU: 0, walkFromV: 0,  // origin of current walk
  walkProgress: 0,             // 0-1 lerp between from and target
  // Destination-based movement (Part 1)
  walkPath: [],                // ordered list of hotspot IDs to walk through
  walkPathIndex: 0,            // current index in walkPath
  queuedDestination: null,     // next destination clicked while walking (at most one)
};

// ─── Guard ───────────────────────────────────────────────────────────────────
const ROOM1_PATROL = [
  { u: 0.60, v: 0.22 },
  { u: 0.60, v: 0.72 },
  { u: 0.22, v: 0.72 },
  { u: 0.22, v: 0.42 },
];

const ROOM2_PATROL = [
  // Back area: in front of workbench
  { u: 0.22, v: 0.30 },
  // Down past barrels toward gap
  { u: 0.24, v: 0.60 },
  // Gap waypoint (below partition end)
  { u: 0.43, v: 0.72 },
  // Front area: corridor between crates and shelving
  { u: 0.72, v: 0.72 },
  // Up past shelving
  { u: 0.72, v: 0.32 },
  // Back down
  { u: 0.72, v: 0.72 },
  // Gap waypoint return (below partition)
  { u: 0.43, v: 0.72 },
  // Back into back area
  { u: 0.24, v: 0.60 },
];

const ROOM3_PATROL = [
  // North corridor: in front of utility table and server rack
  { u: 0.20, v: 0.32 },
  { u: 0.62, v: 0.32 },
  // Through gap to south (right of partition uMax=0.64, left of locker uMin=0.76)
  { u: 0.70, v: 0.32 },
  { u: 0.70, v: 0.78 },
  // South corridor: sweep left past crates
  { u: 0.50, v: 0.78 },
  { u: 0.12, v: 0.78 },
  // South corridor: sweep back right toward gap
  { u: 0.50, v: 0.78 },
  { u: 0.70, v: 0.78 },
  // Back up through gap to north
  { u: 0.70, v: 0.32 },
];

let PATROL = ROOM1_PATROL;

const guard = {
  u: PATROL[0].u,
  v: PATROL[0].v,
  speed: 0.13,
  alertSpeed: 0.18,
  facing: 'down',
  waypointIdx: 0,
  waitTimer: 1.0,
  walkPhase: 0,
  investigating: false,
  investigateTarget: null,
  investigateWaitTimer: 0,
  // State machine: 'patrol' | 'notice' | 'alert' | 'suspicious'
  state: 'patrol',
  noticeTimer: 0,
  alertTimer: 0,
  suspiciousTimer: 0,
  lastSeenU: 0,
  lastSeenV: 0,
};

// ─── Collision boxes (UV floor space) ────────────────────────────────────────
const ROOM1_COLLIDERS = [
  { id: 'rack1',  uMin: 0.06, vMin: 0.15, uMax: 0.21, vMax: 0.38, cover: ['south', 'east'] },
  { id: 'rack2',  uMin: 0.41, vMin: 0.10, uMax: 0.55, vMax: 0.34, cover: ['south', 'west'] },
  { id: 'desk',   uMin: 0.66, vMin: 0.08, uMax: 0.92, vMax: 0.30, cover: ['south'] },
  { id: 'crates', uMin: 0.27, vMin: 0.50, uMax: 0.42, vMax: 0.67, cover: ['north', 'south', 'east', 'west'] },
];

const ROOM2_COLLIDERS = [
  // Partition wall: runs from back wall down, gap at bottom (v > 0.62)
  { id: 'partition', uMin: 0.40, vMin: 0.02, uMax: 0.46, vMax: 0.62 },
  // Back area (left of partition)
  { id: 'workbench', uMin: 0.05, vMin: 0.08, uMax: 0.36, vMax: 0.24, cover: ['south'] },
  { id: 'barrels',   uMin: 0.06, vMin: 0.42, uMax: 0.20, vMax: 0.56, cover: ['south', 'east'] },
  // Front area (right of partition)
  { id: 'cabinet',   uMin: 0.56, vMin: 0.08, uMax: 0.68, vMax: 0.28, cover: ['south', 'west'] },
  { id: 'shelving',  uMin: 0.74, vMin: 0.36, uMax: 0.90, vMax: 0.54, cover: ['west', 'south'] },
  { id: 'crates2',   uMin: 0.56, vMin: 0.50, uMax: 0.70, vMax: 0.62, cover: ['north', 'south', 'west'] },
];

const ROOM3_COLLIDERS = [
  // Horizontal partition: gap on right (u > 0.64), attached to left wall
  { id: 'partitionR3', uMin: 0.02, vMin: 0.40, uMax: 0.64, vMax: 0.46 },
  // North corridor (above partition)
  { id: 'utilTable',   uMin: 0.08, vMin: 0.08, uMax: 0.32, vMax: 0.22, cover: ['south', 'east'] },
  { id: 'rackR3',     uMin: 0.44, vMin: 0.08, uMax: 0.60, vMax: 0.28, cover: ['south', 'west'] },
  // South corridor (below partition)
  { id: 'locker',     uMin: 0.76, vMin: 0.54, uMax: 0.90, vMax: 0.72, cover: ['west', 'north'] },
  { id: 'cratesR3',   uMin: 0.20, vMin: 0.58, uMax: 0.38, vMax: 0.72, cover: ['north', 'east', 'west'] },
];

let COLLIDERS = ROOM1_COLLIDERS;

// ─── Walkable zones (UV rectangles — player can only move within these) ─────
// Room 1: generous open layout — tutorial room stays easy
const ROOM1_ZONES = [
  { uMin: 0.04, vMin: 0.04, uMax: 0.96, vMax: 0.96 },  // nearly full room
];

// Room 2: two areas connected by gap below partition (uMax=0.46, vMax=0.62)
const ROOM2_ZONES = [
  // Back area (left of partition)
  { uMin: 0.04, vMin: 0.04, uMax: 0.38, vMax: 0.82 },
  // Front area (right of partition)
  { uMin: 0.48, vMin: 0.04, uMax: 0.96, vMax: 0.82 },
  // Gap corridor below partition
  { uMin: 0.24, vMin: 0.64, uMax: 0.72, vMax: 0.96 },
  // Player start area (bottom-right)
  { uMin: 0.48, vMin: 0.64, uMax: 0.96, vMax: 0.96 },
];

// Room 3: north + south corridors connected by right-side gap
const ROOM3_ZONES = [
  // North corridor (above partition, v < 0.40)
  { uMin: 0.04, vMin: 0.04, uMax: 0.96, vMax: 0.38 },
  // Gap passage (right of partition uMax=0.64)
  { uMin: 0.66, vMin: 0.30, uMax: 0.96, vMax: 0.52 },
  // South corridor (below partition)
  { uMin: 0.04, vMin: 0.48, uMax: 0.96, vMax: 0.96 },
];

let ZONES = ROOM1_ZONES;

function insideWalkableZone(u, v) {
  for (const z of ZONES) {
    if (u >= z.uMin && u <= z.uMax && v >= z.vMin && v <= z.vMax) {
      return true;
    }
  }
  return false;
}

// ─── Hotspot graphs (node-to-node movement per room) ────────────────────────
// Each hotspot: { id, u, v, edges: [id...] }
// Edges are bidirectional — listed from both sides for clarity

const ROOM1_HOTSPOTS = [
  // Bottom row (player entry area)
  { id: 'r1_start',       u: 0.15, v: 0.85, edges: ['r1_blCorner', 'r1_behindCrates'] },
  { id: 'r1_blCorner',    u: 0.10, v: 0.75, edges: ['r1_start', 'r1_leftOfRack1', 'r1_behindCrates', 'r1_westCrates'] },
  { id: 'r1_behindCrates',u: 0.35, v: 0.78, edges: ['r1_start', 'r1_blCorner', 'r1_midFloor'] },
  { id: 'r1_brCorner',    u: 0.80, v: 0.80, edges: ['r1_midFloor', 'r1_exitDoor'] },
  // Mid row — westCrates routes west of crate box (u < 0.27)
  { id: 'r1_westCrates',  u: 0.22, v: 0.45, edges: ['r1_blCorner', 'r1_southCrates', 'r1_leftOfRack1'] },
  { id: 'r1_leftOfRack1', u: 0.10, v: 0.45, edges: ['r1_blCorner', 'r1_frontRack1', 'r1_westCrates'] },
  { id: 'r1_southCrates', u: 0.35, v: 0.48, edges: ['r1_westCrates', 'r1_midUpper', 'r1_eastOfCrates'] },
  { id: 'r1_midFloor',    u: 0.58, v: 0.60, edges: ['r1_behindCrates', 'r1_brCorner', 'r1_eastOfCrates'] },
  { id: 'r1_exitDoor',    u: 0.90, v: 0.55, edges: ['r1_brCorner', 'r1_eastOfCrates'] },
  { id: 'r1_eastOfCrates',u: 0.55, v: 0.45, edges: ['r1_midFloor', 'r1_exitDoor', 'r1_southCrates', 'r1_midUpper', 'r1_frontDesk', 'r1_frontRack2'] },
  // Upper row — frontRack1 moved south of rack1 bounding box
  { id: 'r1_frontRack1',  u: 0.14, v: 0.40, edges: ['r1_leftOfRack1', 'r1_midUpper'] },
  { id: 'r1_midUpper',    u: 0.32, v: 0.38, edges: ['r1_frontRack1', 'r1_southCrates', 'r1_eastOfCrates', 'r1_frontRack2'] },
  { id: 'r1_frontRack2',  u: 0.48, v: 0.36, edges: ['r1_midUpper', 'r1_eastOfCrates', 'r1_frontDesk'] },
  { id: 'r1_frontDesk',   u: 0.78, v: 0.34, edges: ['r1_frontRack2', 'r1_eastOfCrates'] },
];

const ROOM2_HOTSPOTS = [
  // Back area (left of partition) — u=0.22 stays east of barrels (uMax=0.20)
  { id: 'r2_backStart',    u: 0.22, v: 0.75, edges: ['r2_backCenter', 'r2_gapSouth', 'r2_behindBarrels', 'r2_exitArea'] },
  { id: 'r2_backCenter',   u: 0.22, v: 0.38, edges: ['r2_backStart', 'r2_frontBench', 'r2_behindBarrels'] },
  { id: 'r2_frontBench',   u: 0.22, v: 0.28, edges: ['r2_backCenter'] },
  { id: 'r2_behindBarrels',u: 0.24, v: 0.56, edges: ['r2_backCenter', 'r2_backStart'] },
  // Gap corridor
  { id: 'r2_gapSouth',     u: 0.43, v: 0.75, edges: ['r2_backStart', 'r2_gapNorth', 'r2_frontStart'] },
  { id: 'r2_gapNorth',     u: 0.43, v: 0.64, edges: ['r2_gapSouth'] },
  // Front area (right of partition)
  { id: 'r2_frontStart',   u: 0.85, v: 0.85, edges: ['r2_gapSouth', 'r2_frontLower', 'r2_exitArea'] },
  { id: 'r2_frontLower',   u: 0.72, v: 0.65, edges: ['r2_frontStart', 'r2_frontShelving', 'r2_westCrates'] },
  { id: 'r2_westCrates',   u: 0.52, v: 0.65, edges: ['r2_frontLower', 'r2_frontSpool'] },
  { id: 'r2_frontSpool',   u: 0.52, v: 0.38, edges: ['r2_westCrates', 'r2_frontCabinet', 'r2_frontShelving'] },
  { id: 'r2_frontCabinet', u: 0.62, v: 0.30, edges: ['r2_frontSpool'] },
  { id: 'r2_frontShelving',u: 0.72, v: 0.45, edges: ['r2_frontLower', 'r2_frontSpool'] },
  { id: 'r2_exitArea',     u: 0.08, v: 0.62, edges: ['r2_backStart', 'r2_frontStart'] },
];

const ROOM3_HOTSPOTS = [
  // South corridor (player enters here)
  { id: 'r3_start',       u: 0.85, v: 0.85, edges: ['r3_nearLocker', 'r3_southCenter'] },
  { id: 'r3_nearLocker',  u: 0.83, v: 0.76, edges: ['r3_start', 'r3_southCenter', 'r3_westLocker'] },
  { id: 'r3_westLocker',  u: 0.70, v: 0.76, edges: ['r3_nearLocker', 'r3_southCenter', 'r3_gapSouth'] },
  { id: 'r3_southCenter', u: 0.50, v: 0.78, edges: ['r3_start', 'r3_nearLocker', 'r3_westLocker', 'r3_nearCrates', 'r3_exitDoor'] },
  { id: 'r3_nearCrates',  u: 0.30, v: 0.76, edges: ['r3_southCenter', 'r3_exitDoor'] },
  { id: 'r3_exitDoor',    u: 0.08, v: 0.76, edges: ['r3_southCenter', 'r3_nearCrates'] },
  // Gap passage (right side, between corridors)
  { id: 'r3_gapSouth',    u: 0.70, v: 0.50, edges: ['r3_westLocker', 'r3_gapNorth'] },
  { id: 'r3_gapNorth',    u: 0.70, v: 0.36, edges: ['r3_gapSouth', 'r3_northEast'] },
  // North corridor
  { id: 'r3_northEast',   u: 0.62, v: 0.32, edges: ['r3_gapNorth', 'r3_frontRack'] },
  { id: 'r3_frontRack',   u: 0.52, v: 0.32, edges: ['r3_northEast', 'r3_northCenter'] },
  { id: 'r3_northCenter', u: 0.36, v: 0.32, edges: ['r3_frontRack', 'r3_frontTable'] },
  { id: 'r3_frontTable',  u: 0.20, v: 0.28, edges: ['r3_northCenter'] },
];

let HOTSPOTS = ROOM1_HOTSPOTS;

function getHotspot(id) {
  for (const h of HOTSPOTS) {
    if (h.id === id) return h;
  }
  return null;
}

// ─── Pathfinding & destination movement ──────────────────────────────────────

// BFS from startId to goalId along hotspot edges. Returns array of hotspot IDs
// (excluding startId, including goalId), or null if unreachable.
function findPath(startId, goalId) {
  if (startId === goalId) return [];
  const visited = new Set([startId]);
  const parent = {};
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift();
    const node = getHotspot(current);
    if (!node) continue;
    for (const neighborId of node.edges) {
      if (visited.has(neighborId)) continue;
      visited.add(neighborId);
      parent[neighborId] = current;
      if (neighborId === goalId) {
        // Reconstruct path
        const path = [];
        let id = goalId;
        while (id !== startId) {
          path.push(id);
          id = parent[id];
        }
        path.reverse();
        return path;
      }
      queue.push(neighborId);
    }
  }
  return null; // unreachable
}

// Start walking to a destination hotspot. Returns true if path found.
function startWalkToDestination(destinationId) {
  const fromId = player.currentHotspot;
  if (!fromId) return false; // mid-walk, can't start new path from here
  if (fromId === destinationId) return false; // already there

  const path = findPath(fromId, destinationId);
  if (!path || path.length === 0) return false; // unreachable

  player.walkPath = path;
  player.walkPathIndex = 0;
  player.queuedDestination = null;

  // Start first segment
  const from = getHotspot(fromId);
  const firstTarget = getHotspot(path[0]);
  player.targetHotspot = path[0];
  player.walkFromU = from.u;
  player.walkFromV = from.v;
  player.walkProgress = 0;
  player.currentHotspot = null;

  // Face toward first waypoint
  if (Math.abs(firstTarget.u - from.u) > Math.abs(firstTarget.v - from.v)) {
    player.facing = firstTarget.u > from.u ? 'right' : 'left';
  } else {
    player.facing = firstTarget.v > from.v ? 'down' : 'up';
  }
  return true;
}

// Find closest hotspot to a screen-space click point
function findClickedHotspot(screenX, screenY, maxDist) {
  let bestId = null, bestDist = Infinity;
  for (const h of HOTSPOTS) {
    const pos = floorToScreen(h.u, h.v);
    // Apply the same transform as render: scale and center
    const drawX = pos.x * scale + (W - 1280 * scale) / 2;
    const drawY = pos.y * scale + (H - 720 * scale) / 2;
    const d = Math.hypot(screenX - drawX, screenY - drawY);
    if (d < bestDist) {
      bestDist = d;
      bestId = h.id;
    }
  }
  return bestDist <= maxDist ? bestId : null;
}

// ─── Click/tap handler for destination movement ─────────────────────────────
canvas.addEventListener('pointerdown', function(e) {
  // Ignore if game is over or transitioning
  if (detected || won || roomTransitionTimer > 0) return;
  // Ignore if player is hidden
  if (playerHidden) return;

  const clickX = e.clientX;
  const clickY = e.clientY;

  // Hit radius scales with screen size — 40px at 1280w baseline
  const hitRadius = 40 * scale;
  const clickedId = findClickedHotspot(clickX, clickY, hitRadius);
  if (!clickedId) return;

  if (player.currentHotspot) {
    // Player is idle at a hotspot — start walking
    startWalkToDestination(clickedId);
  } else if (player.targetHotspot) {
    // Player is mid-walk — queue this as next destination (replaces any prior queue)
    player.queuedDestination = clickedId;
  }
});

// ─── Game state ──────────────────────────────────────────────────────────────
let detected = false;
let hasKeycard = false;
let won = false;
let gameTime = 0;
let currentRoom = 1;
let roomTransitionTimer = 0;
let spoolKnocked = false;
let spoolNoiseTimer = 0;
let playerHidden = false;

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

// Cover proximity: check if player is tucked behind a cover face
// Returns true if any cover object shields the player from the guard
function shieldedByCover() {
  const COVER_DIST = 0.06;  // how close to the face the player must be
  const COVER_PAD = 0.04;   // how much the collider expands for the LOS check
  for (const b of COLLIDERS) {
    if (!b.cover) continue;
    for (const face of b.cover) {
      let nearFace = false;
      let guardOnOppositeSide = false;
      if (face === 'south') {
        nearFace = player.v > b.vMax && player.v < b.vMax + COVER_DIST &&
                   player.u > b.uMin - 0.02 && player.u < b.uMax + 0.02;
        guardOnOppositeSide = guard.v < b.vMin;
      } else if (face === 'north') {
        nearFace = player.v < b.vMin && player.v > b.vMin - COVER_DIST &&
                   player.u > b.uMin - 0.02 && player.u < b.uMax + 0.02;
        guardOnOppositeSide = guard.v > b.vMax;
      } else if (face === 'east') {
        nearFace = player.u > b.uMax && player.u < b.uMax + COVER_DIST &&
                   player.v > b.vMin - 0.02 && player.v < b.vMax + 0.02;
        guardOnOppositeSide = guard.u < b.uMin;
      } else if (face === 'west') {
        nearFace = player.u < b.uMin && player.u > b.uMin - COVER_DIST &&
                   player.v > b.vMin - 0.02 && player.v < b.vMax + 0.02;
        guardOnOppositeSide = guard.u > b.uMax;
      }
      if (nearFace && guardOnOppositeSide) {
        // Expand this collider for the LOS ray check
        const padBox = {
          uMin: b.uMin - COVER_PAD, vMin: b.vMin - COVER_PAD,
          uMax: b.uMax + COVER_PAD, vMax: b.vMax + COVER_PAD
        };
        // Check if the ray from guard to player passes through the padded box
        const steps = 20;
        for (let i = 1; i < steps; i++) {
          const t = i / steps;
          const ru = guard.u + (player.u - guard.u) * t;
          const rv = guard.v + (player.v - guard.v) * t;
          if (ru > padBox.uMin && ru < padBox.uMax &&
              rv > padBox.vMin && rv < padBox.vMax) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

// Proximity-based awareness: guard controls space around them
// Wider awareness when player is mid-walk (exposed in the open)
const AWARENESS_RADIUS = 0.25;       // at a hotspot
const AWARENESS_RADIUS_MOVING = 0.32; // mid-walk (more exposed)

function guardAwareOfPlayer() {
  if (playerHidden) return false;

  const midWalk = !player.currentHotspot && player.targetHotspot;
  const radius = midWalk ? AWARENESS_RADIUS_MOVING : AWARENESS_RADIUS;

  const du = player.u - guard.u;
  const dv = player.v - guard.v;
  const dist = Math.hypot(du, dv);
  if (dist > radius) return false;

  // Still need LOS — furniture blocks awareness
  if (rayBlocked(guard.u, guard.v, player.u, player.v)) return false;
  // Cover face shielding still works
  if (shieldedByCover()) return false;
  return true;
}

// Legacy alias — keep for any remaining references
function guardCanSeePlayer() { return guardAwareOfPlayer(); }

// ─── Facility room: walls, floor, structure ──────────────────────────────────

// Per-room colour palettes — gives each room a distinct visual identity
const ROOM_PALETTES = {
  1: { // Server Room: cool, clean corporate — slight blue undertone
    backWall:  ['#4a4f5a', '#424752', '#3a3f4a'],
    leftWall:  ['#323844', '#383e4a', '#3e444e'],
    rightWall: ['#3e444e', '#383e4a', '#343a46'],
    floor:     ['#484d58', '#424752', '#3c414a'],
    tileGroove: 'rgba(0,0,20,0.10)',
    tileHighlight: 'rgba(180,190,220,0.03)',
    seamDark:  'rgba(0,0,20,0.10)',
    seamLight: 'rgba(200,210,240,0.03)',
    baseboard: '#2a2e38',
    baseHighlight: '#5e6270',
  },
  2: { // Maintenance Workshop: warm brownish grays — industrial, worn
    backWall:  ['#524c44', '#4a443e', '#423c38'],
    leftWall:  ['#3a3632', '#423e38', '#4a4640'],
    rightWall: ['#4a4640', '#423e38', '#3e3a36'],
    floor:     ['#4e4840', '#48423c', '#423e38'],
    tileGroove: 'rgba(40,20,0,0.10)',
    tileHighlight: 'rgba(220,200,170,0.03)',
    seamDark:  'rgba(40,20,0,0.09)',
    seamLight: 'rgba(220,200,170,0.03)',
    baseboard: '#302c28',
    baseHighlight: '#625c54',
  },
  3: { // Server Closet: cool blue-shifted grays — tight, technical
    backWall:  ['#464e5a', '#3e4652', '#38404c'],
    leftWall:  ['#343c4a', '#3a4250', '#404854'],
    rightWall: ['#404854', '#3a4250', '#363e4c'],
    floor:     ['#444c58', '#3e4650', '#384048'],
    tileGroove: 'rgba(0,10,40,0.12)',
    tileHighlight: 'rgba(160,180,220,0.03)',
    seamDark:  'rgba(0,10,40,0.11)',
    seamLight: 'rgba(160,180,220,0.03)',
    baseboard: '#262e38',
    baseHighlight: '#565e6c',
  },
};

function drawRoom() {
  const { floorTL, floorTR, floorBL, floorBR,
          ceilTL, ceilTR, leftWallTop, rightWallTop } = ROOM;
  const pal = ROOM_PALETTES[currentRoom] || ROOM_PALETTES[1];

  // ── Back wall ──
  const backGrad = ctx.createLinearGradient(s(260), s(60), s(260), s(270));
  backGrad.addColorStop(0, pal.backWall[0]);
  backGrad.addColorStop(0.6, pal.backWall[1]);
  backGrad.addColorStop(1, pal.backWall[2]);
  roomPath([ceilTL, ceilTR, floorTR, floorTL]);
  ctx.fillStyle = backGrad;
  ctx.fill();

  // Concrete panel lines on back wall
  ctx.save();
  roomPath([ceilTL, ceilTR, floorTR, floorTL]);
  ctx.clip();
  // Horizontal seams
  ctx.strokeStyle = pal.seamDark;
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
    ctx.strokeStyle = pal.seamLight;
    ctx.beginPath();
    ctx.moveTo(s(lx1), s(ly1 + 1.5));
    ctx.lineTo(s(lx2), s(ly2 + 1.5));
    ctx.stroke();
    ctx.strokeStyle = pal.seamDark;
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
  leftGrad.addColorStop(0, pal.leftWall[0]);
  leftGrad.addColorStop(0.5, pal.leftWall[1]);
  leftGrad.addColorStop(1, pal.leftWall[2]);
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
  rightGrad.addColorStop(0, pal.rightWall[0]);
  rightGrad.addColorStop(0.5, pal.rightWall[1]);
  rightGrad.addColorStop(1, pal.rightWall[2]);
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

  // ── Wall-mounted decorative props ──
  if (currentRoom === 1) drawRoom1WallDecor();
  else if (currentRoom === 2) drawRoom2WallDecor();
  else if (currentRoom === 3) drawRoom3WallDecor();

  // ── Exit door ──
  if (currentRoom === 1) drawExitDoor();
  else drawExitDoorLeft();

  // ── Floor ──
  const floorGrad = ctx.createLinearGradient(s(640), s(270), s(640), s(640));
  floorGrad.addColorStop(0, pal.floor[0]);
  floorGrad.addColorStop(0.5, pal.floor[1]);
  floorGrad.addColorStop(1, pal.floor[2]);
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
  ctx.strokeStyle = pal.tileGroove;
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
  ctx.strokeStyle = pal.tileHighlight;
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

  // ── Floor-surface decorative details ──
  if (currentRoom === 1) drawRoom1FloorMarkings();
  if (currentRoom === 2) {
    drawRoom2FloorDrain();
    drawRoom2FloorStains();
    drawRoom2WallAging();
  }
  if (currentRoom === 3) {
    drawRoom3FloorCables();
    drawRoom3WallFraming();
  }

  // ── Metal baseboard strips ──
  // Dark groove
  ctx.strokeStyle = pal.baseboard;
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
  ctx.strokeStyle = pal.baseHighlight;
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
  const cornerR = 50;
  // Back-left corner
  const blcGrad = ctx.createRadialGradient(s(floorTL.x), s(floorTL.y), 0, s(floorTL.x), s(floorTL.y), s(cornerR));
  blcGrad.addColorStop(0, 'rgba(0,0,0,0.22)');
  blcGrad.addColorStop(0.5, 'rgba(0,0,0,0.08)');
  blcGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = blcGrad;
  ctx.fillRect(s(floorTL.x), s(floorTL.y), s(cornerR), s(cornerR));
  // Back-right corner
  const brcGrad = ctx.createRadialGradient(s(floorTR.x), s(floorTR.y), 0, s(floorTR.x), s(floorTR.y), s(cornerR));
  brcGrad.addColorStop(0, 'rgba(0,0,0,0.22)');
  brcGrad.addColorStop(0.5, 'rgba(0,0,0,0.08)');
  brcGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = brcGrad;
  ctx.fillRect(s(floorTR.x - cornerR), s(floorTR.y), s(cornerR), s(cornerR));
  // Front-left corner
  const flcR = 35;
  const flcGrad = ctx.createRadialGradient(s(floorBL.x), s(floorBL.y), 0, s(floorBL.x), s(floorBL.y), s(flcR));
  flcGrad.addColorStop(0, 'rgba(0,0,0,0.15)');
  flcGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = flcGrad;
  ctx.fillRect(s(floorBL.x), s(floorBL.y - flcR), s(flcR), s(flcR));
  // Front-right corner
  const frcGrad = ctx.createRadialGradient(s(floorBR.x), s(floorBR.y), 0, s(floorBR.x), s(floorBR.y), s(flcR));
  frcGrad.addColorStop(0, 'rgba(0,0,0,0.15)');
  frcGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = frcGrad;
  ctx.fillRect(s(floorBR.x - flcR), s(floorBR.y - flcR), s(flcR), s(flcR));

  ctx.restore();
}

// Per-room light tints: [diffuser edge, diffuser mid, diffuser center, glow RGBA]
const LIGHT_TINTS = {
  1: { de: '#c8ccd6', dm: '#e0e4f0', dc: '#eaf0fa', glow: '190,200,235' }, // cool white
  2: { de: '#d0c8b8', dm: '#e8dece', dc: '#f2e8d8', glow: '230,210,180' }, // warm
  3: { de: '#c0c8d6', dm: '#d8e2f0', dc: '#e4eefa', glow: '170,190,230' }, // cool blue
};

function drawCeilingLight(lx, ly) {
  const fixtW = 100, fixtH = 5;
  const lt = LIGHT_TINTS[currentRoom] || LIGHT_TINTS[1];
  // Housing (dark metal surround)
  ctx.fillStyle = '#50535a';
  ctx.fillRect(s(lx - fixtW / 2 - 3), s(ly - 1), s(fixtW + 6), s(fixtH + 2));
  // Diffuser panel (bright — tinted per room)
  const diffGrad = ctx.createLinearGradient(s(lx - fixtW / 2), 0, s(lx + fixtW / 2), 0);
  diffGrad.addColorStop(0, lt.de);
  diffGrad.addColorStop(0.3, lt.dm);
  diffGrad.addColorStop(0.5, lt.dc);
  diffGrad.addColorStop(0.7, lt.dm);
  diffGrad.addColorStop(1, lt.de);
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
  glow.addColorStop(0, `rgba(${lt.glow},0.14)`);
  glow.addColorStop(0.5, `rgba(${lt.glow},0.05)`);
  glow.addColorStop(1, `rgba(${lt.glow},0)`);
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
    s(lightPos.x), s(lightPos.y), s(26)
  );
  lightGlow.addColorStop(0, glowC + '0.45)');
  lightGlow.addColorStop(0.4, glowC + '0.15)');
  lightGlow.addColorStop(1, glowC + '0)');
  ctx.fillStyle = lightGlow;
  ctx.beginPath();
  ctx.arc(s(lightPos.x), s(lightPos.y), s(26), 0, Math.PI * 2);
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

function drawExitDoorLeft() {
  const { ceilTL, leftWallTop, floorTL, floorBL } = ROOM;

  function leftWallPoint(u, v) {
    const x = (1 - u) * (1 - v) * ceilTL.x + u * (1 - v) * leftWallTop.x
            + (1 - u) * v * floorTL.x + u * v * floorBL.x;
    const y = (1 - u) * (1 - v) * ceilTL.y + u * (1 - v) * leftWallTop.y
            + (1 - u) * v * floorTL.y + u * v * floorBL.y;
    return { x, y };
  }

  const doorU1 = 0.3, doorU2 = 0.55;
  // Room 3: door only in south corridor (below partition)
  const doorT1 = currentRoom === 3 ? 0.55 : 0.35;
  const doorT2 = currentRoom === 3 ? 0.88 : 0.78;

  const dtl = leftWallPoint(doorU1, doorT1);
  const dtr = leftWallPoint(doorU2, doorT1);
  const dbr = leftWallPoint(doorU2, doorT2);
  const dbl = leftWallPoint(doorU1, doorT2);

  // Frame
  const framePad = 4;
  const frmGrad = ctx.createLinearGradient(s(dtl.x), 0, s(dtr.x), 0);
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
  // Frame inner edge
  ctx.strokeStyle = '#2a2d34';
  ctx.lineWidth = s(1.2);
  ctx.beginPath();
  ctx.moveTo(s(dtl.x - 1), s(dtl.y - 1));
  ctx.lineTo(s(dtr.x + 1), s(dtr.y - 1));
  ctx.lineTo(s(dbr.x + 1), s(dbr.y + 1));
  ctx.lineTo(s(dbl.x - 1), s(dbl.y + 1));
  ctx.closePath();
  ctx.stroke();

  // Door surface
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

  // Panel inset
  const pMid = 0.08;
  const ptl = leftWallPoint(doorU1 + pMid, doorT1 + 0.06);
  const ptr = leftWallPoint(doorU2 - pMid, doorT1 + 0.06);
  const pbr = leftWallPoint(doorU2 - pMid, doorT2 - 0.06);
  const pbl = leftWallPoint(doorU1 + pMid, doorT2 - 0.06);
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = s(1);
  ctx.beginPath();
  ctx.moveTo(s(ptl.x), s(ptl.y));
  ctx.lineTo(s(ptr.x), s(ptr.y));
  ctx.lineTo(s(pbr.x), s(pbr.y));
  ctx.lineTo(s(pbl.x), s(pbl.y));
  ctx.closePath();
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = s(0.6);
  ctx.beginPath();
  ctx.moveTo(s(ptl.x + 1), s(ptl.y + 1));
  ctx.lineTo(s(ptr.x - 1), s(ptr.y + 1));
  ctx.stroke();

  // Handle — on right side of door (inner side)
  const hBase = leftWallPoint(doorU2 - 0.05, (doorT1 + doorT2) * 0.52);
  const hEnd  = leftWallPoint(doorU2 - 0.05, (doorT1 + doorT2) * 0.52 + 0.05);
  ctx.fillStyle = '#8a8d95';
  ctx.beginPath();
  ctx.ellipse(s(hBase.x), s(hBase.y), s(6), s(8), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#6a6d75';
  ctx.lineWidth = s(0.8);
  ctx.stroke();
  ctx.strokeStyle = '#a0a3aa';
  ctx.lineWidth = s(2.5);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(s(hBase.x), s(hBase.y));
  ctx.lineTo(s(hEnd.x), s(hEnd.y));
  ctx.stroke();
  ctx.lineCap = 'butt';

  // Status light
  const lightPos = leftWallPoint(doorU2 - 0.06, doorT1 + 0.06);
  const litColor = hasKeycard ? '#40e040' : '#e04040';
  ctx.fillStyle = '#2a2d34';
  ctx.beginPath();
  ctx.arc(s(lightPos.x), s(lightPos.y), s(5), 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = litColor;
  ctx.beginPath();
  ctx.arc(s(lightPos.x), s(lightPos.y), s(3), 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.beginPath();
  ctx.arc(s(lightPos.x - 1), s(lightPos.y - 1), s(1), 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  const glowC2 = hasKeycard ? 'rgba(64,224,64,' : 'rgba(224,64,64,';
  const lightGlow2 = ctx.createRadialGradient(
    s(lightPos.x), s(lightPos.y), 0,
    s(lightPos.x), s(lightPos.y), s(26)
  );
  lightGlow2.addColorStop(0, glowC2 + '0.45)');
  lightGlow2.addColorStop(0.4, glowC2 + '0.15)');
  lightGlow2.addColorStop(1, glowC2 + '0)');
  ctx.fillStyle = lightGlow2;
  ctx.beginPath();
  ctx.arc(s(lightPos.x), s(lightPos.y), s(26), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // EXIT label
  const textPos = leftWallPoint((doorU1 + doorU2) * 0.5, doorT1 - 0.06);
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(s(textPos.x - 18), s(textPos.y - 7), s(36), s(12));
  ctx.fillStyle = '#e04040';
  ctx.font = `bold ${s(10)}px monospace`;
  ctx.textAlign = 'center';
  ctx.fillText('EXIT', s(textPos.x), s(textPos.y));
}

// ─── Room 1 floor markings (clean server-room anti-static stripe) ─────────────

function drawRoom1FloorMarkings() {
  const { floorTL, floorTR, floorBL, floorBR } = ROOM;
  ctx.save();
  roomPath([floorTL, floorTR, floorBR, floorBL]);
  ctx.clip();

  // Anti-static warning stripe along back wall edge (faded yellow dashes)
  const stripeV = 0.06; // near back wall
  const sl = floorToScreen(0.10, stripeV);
  const sr = floorToScreen(0.90, stripeV);
  ctx.strokeStyle = 'rgba(180,160,60,0.08)';
  ctx.lineWidth = s(2.5);
  ctx.setLineDash([s(8), s(12)]);
  ctx.beginPath();
  ctx.moveTo(s(sl.x), s(sl.y));
  ctx.lineTo(s(sr.x), s(sr.y));
  ctx.stroke();
  ctx.setLineDash([]);

  // Subtle ESD symbol stencil on floor near center (faded)
  const sym = floorToScreen(0.50, 0.55);
  ctx.strokeStyle = 'rgba(100,120,180,0.06)';
  ctx.lineWidth = s(1.2);
  // Triangle outline
  ctx.beginPath();
  ctx.moveTo(s(sym.x), s(sym.y - 8));
  ctx.lineTo(s(sym.x - 7), s(sym.y + 5));
  ctx.lineTo(s(sym.x + 7), s(sym.y + 5));
  ctx.closePath();
  ctx.stroke();
  // Lightning line inside
  ctx.beginPath();
  ctx.moveTo(s(sym.x + 1), s(sym.y - 4));
  ctx.lineTo(s(sym.x - 2), s(sym.y));
  ctx.lineTo(s(sym.x + 2), s(sym.y));
  ctx.lineTo(s(sym.x - 1), s(sym.y + 4));
  ctx.stroke();

  // Cooling vent marks on floor in front of rack area (subtle parallel lines)
  ctx.strokeStyle = 'rgba(0,0,30,0.04)';
  ctx.lineWidth = s(0.8);
  for (let i = 0; i < 5; i++) {
    const vy = 0.40 + i * 0.03;
    const vl = floorToScreen(0.08, vy);
    const vr = floorToScreen(0.48, vy);
    ctx.beginPath();
    ctx.moveTo(s(vl.x), s(vl.y));
    ctx.lineTo(s(vr.x), s(vr.y));
    ctx.stroke();
  }

  // Corner dust accumulation (front-left and front-right)
  for (const cu of [0.06, 0.94]) {
    const cp = floorToScreen(cu, 0.92);
    const dg = ctx.createRadialGradient(s(cp.x), s(cp.y), 0, s(cp.x), s(cp.y), s(22));
    dg.addColorStop(0, 'rgba(0,0,0,0.04)');
    dg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = dg;
    ctx.beginPath();
    ctx.arc(s(cp.x), s(cp.y), s(22), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

// ─── Room 1 decorative props (draw-only, no colliders) ───────────────────────

function drawRoom1WallDecor() {
  const { ceilTL, ceilTR, floorTL } = ROOM;

  // Helper: back wall position (u: 0=left, 1=right; v: 0=top, 1=bottom)
  function bw(u, v) {
    return {
      x: ceilTL.x + u * (ceilTR.x - ceilTL.x),
      y: ceilTL.y + v * (floorTL.y - ceilTL.y)
    };
  }

  // ── Cable conduit (horizontal trunking along back wall base) ──
  const condY = floorTL.y - 14;
  const condX1 = ceilTL.x + 30;
  const condX2 = ceilTR.x - 60;
  ctx.fillStyle = '#3a3d44';
  ctx.fillRect(s(condX1), s(condY), s(condX2 - condX1), s(8));
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = s(0.6);
  ctx.beginPath();
  ctx.moveTo(s(condX1), s(condY));
  ctx.lineTo(s(condX2), s(condY));
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = s(0.8);
  ctx.beginPath();
  ctx.moveTo(s(condX1), s(condY + 8));
  ctx.lineTo(s(condX2), s(condY + 8));
  ctx.stroke();
  // Mounting clips
  ctx.fillStyle = '#4a4d55';
  for (let cx = condX1 + 40; cx < condX2 - 20; cx += 80) {
    ctx.fillRect(s(cx - 3), s(condY - 2), s(6), s(12));
  }

  // ── Whiteboard (between rack2 and desk on back wall) ──
  const wb = bw(0.57, 0.30);
  const wbW = 90, wbH = 55;
  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.fillRect(s(wb.x - wbW / 2 + 3), s(wb.y - wbH / 2 + 3), s(wbW), s(wbH));
  // Frame
  ctx.fillStyle = '#5a5d65';
  ctx.fillRect(s(wb.x - wbW / 2 - 3), s(wb.y - wbH / 2 - 3), s(wbW + 6), s(wbH + 6));
  // Board surface
  const wbGrad = ctx.createLinearGradient(0, s(wb.y - wbH / 2), 0, s(wb.y + wbH / 2));
  wbGrad.addColorStop(0, '#d8dae0');
  wbGrad.addColorStop(0.5, '#ccced5');
  wbGrad.addColorStop(1, '#c0c2ca');
  ctx.fillStyle = wbGrad;
  ctx.fillRect(s(wb.x - wbW / 2), s(wb.y - wbH / 2), s(wbW), s(wbH));
  // Faint marker residue lines
  ctx.strokeStyle = 'rgba(60,80,120,0.08)';
  ctx.lineWidth = s(1);
  const lineWidths = [30, 48, 22, 40];
  for (let i = 0; i < 4; i++) {
    const ly = wb.y - wbH / 2 + 12 + i * 11;
    ctx.beginPath();
    ctx.moveTo(s(wb.x - wbW / 2 + 10), s(ly));
    ctx.lineTo(s(wb.x - wbW / 2 + 10 + lineWidths[i]), s(ly));
    ctx.stroke();
  }
  // Sticky notes
  ctx.fillStyle = 'rgba(220,180,60,0.35)';
  ctx.fillRect(s(wb.x + wbW / 2 - 22), s(wb.y - wbH / 2 + 6), s(14), s(14));
  ctx.fillStyle = 'rgba(80,180,120,0.30)';
  ctx.fillRect(s(wb.x + wbW / 2 - 22), s(wb.y - wbH / 2 + 24), s(14), s(12));
  // Marker tray
  ctx.fillStyle = '#4a4d55';
  ctx.fillRect(s(wb.x - 20), s(wb.y + wbH / 2 + 1), s(40), s(4));

  // ── Wall clock (above rack1 area) ──
  const clk = bw(0.14, 0.22);
  const clkR = 14;
  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.10)';
  ctx.beginPath();
  ctx.arc(s(clk.x + 2), s(clk.y + 2), s(clkR + 1), 0, Math.PI * 2);
  ctx.fill();
  // Housing
  ctx.fillStyle = '#2a2d34';
  ctx.beginPath();
  ctx.arc(s(clk.x), s(clk.y), s(clkR + 2), 0, Math.PI * 2);
  ctx.fill();
  // Face
  const faceGrad = ctx.createRadialGradient(s(clk.x - 2), s(clk.y - 2), 0, s(clk.x), s(clk.y), s(clkR));
  faceGrad.addColorStop(0, '#e8eae8');
  faceGrad.addColorStop(1, '#c8cac8');
  ctx.fillStyle = faceGrad;
  ctx.beginPath();
  ctx.arc(s(clk.x), s(clk.y), s(clkR), 0, Math.PI * 2);
  ctx.fill();
  // Hour marks
  ctx.strokeStyle = '#3a3d44';
  ctx.lineWidth = s(1.2);
  for (let h = 0; h < 12; h++) {
    const a = (h / 12) * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(s(clk.x + Math.cos(a) * (clkR - 3)), s(clk.y + Math.sin(a) * (clkR - 3)));
    ctx.lineTo(s(clk.x + Math.cos(a) * (clkR - 1)), s(clk.y + Math.sin(a) * (clkR - 1)));
    ctx.stroke();
  }
  // Hour hand (~10 o'clock)
  ctx.strokeStyle = '#2a2d34';
  ctx.lineWidth = s(1.2);
  const ha = (-60 / 360) * Math.PI * 2 - Math.PI / 2;
  ctx.beginPath();
  ctx.moveTo(s(clk.x), s(clk.y));
  ctx.lineTo(s(clk.x + Math.cos(ha) * clkR * 0.5), s(clk.y + Math.sin(ha) * clkR * 0.5));
  ctx.stroke();
  // Minute hand (~2 o'clock)
  ctx.lineWidth = s(0.8);
  const ma = (60 / 360) * Math.PI * 2 - Math.PI / 2;
  ctx.beginPath();
  ctx.moveTo(s(clk.x), s(clk.y));
  ctx.lineTo(s(clk.x + Math.cos(ma) * clkR * 0.7), s(clk.y + Math.sin(ma) * clkR * 0.7));
  ctx.stroke();
  // Center pin
  ctx.fillStyle = '#2a2d34';
  ctx.beginPath();
  ctx.arc(s(clk.x), s(clk.y), s(1.5), 0, Math.PI * 2);
  ctx.fill();
}

function drawTrashBin() {
  const pos = floorToScreen(0.62, 0.36);
  const binW = 16, binH = 22;
  const bx = pos.x - binW / 2;
  const by = pos.y - binH;

  // Contact shadow
  ctx.fillStyle = 'rgba(0,0,0,0.20)';
  ctx.beginPath();
  ctx.ellipse(s(pos.x), s(pos.y), s(12), s(5), 0, 0, Math.PI * 2);
  ctx.fill();

  // Tapered bin body
  const bodyGrad = ctx.createLinearGradient(s(bx - 1), 0, s(bx + binW + 1), 0);
  bodyGrad.addColorStop(0, '#3a3d44');
  bodyGrad.addColorStop(0.3, '#4a4d55');
  bodyGrad.addColorStop(0.7, '#4a4d55');
  bodyGrad.addColorStop(1, '#3a3d44');
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.moveTo(s(bx + 2), s(pos.y));
  ctx.lineTo(s(bx + binW - 2), s(pos.y));
  ctx.lineTo(s(bx + binW), s(by));
  ctx.lineTo(s(bx), s(by));
  ctx.closePath();
  ctx.fill();

  // Rim
  ctx.strokeStyle = '#5a5d65';
  ctx.lineWidth = s(1.5);
  ctx.beginPath();
  ctx.moveTo(s(bx - 1), s(by));
  ctx.lineTo(s(bx + binW + 1), s(by));
  ctx.stroke();

  // Outline
  ctx.strokeStyle = '#2a2d34';
  ctx.lineWidth = s(0.8);
  ctx.beginPath();
  ctx.moveTo(s(bx + 2), s(pos.y));
  ctx.lineTo(s(bx + binW - 2), s(pos.y));
  ctx.lineTo(s(bx + binW), s(by));
  ctx.lineTo(s(bx), s(by));
  ctx.closePath();
  ctx.stroke();
}

function drawFireExtinguisher() {
  const pos = floorToScreen(0.03, 0.48);
  const extW = 10, extH = 32;
  const bx = pos.x - extW / 2;
  const by = pos.y - extH;

  // Contact shadow
  ctx.fillStyle = 'rgba(0,0,0,0.20)';
  ctx.beginPath();
  ctx.ellipse(s(pos.x), s(pos.y), s(8), s(3.5), 0, 0, Math.PI * 2);
  ctx.fill();

  // Red cylinder
  const bodyGrad = ctx.createLinearGradient(s(bx), 0, s(bx + extW), 0);
  bodyGrad.addColorStop(0, '#6a1a1a');
  bodyGrad.addColorStop(0.3, '#c03030');
  bodyGrad.addColorStop(0.5, '#d84040');
  bodyGrad.addColorStop(0.7, '#c03030');
  bodyGrad.addColorStop(1, '#6a1a1a');
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.roundRect(s(bx), s(by + 4), s(extW), s(extH - 4), s(2));
  ctx.fill();

  // Top valve cap
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(s(bx + 2), s(by), s(extW - 4), s(6));

  // Handle/nozzle
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = s(1.5);
  ctx.beginPath();
  ctx.moveTo(s(pos.x + 2), s(by + 2));
  ctx.lineTo(s(pos.x + 6), s(by - 2));
  ctx.stroke();

  // Label band
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fillRect(s(bx + 1), s(by + extH * 0.35), s(extW - 2), s(8));

  // Pressure gauge
  ctx.fillStyle = '#2a4a2a';
  ctx.beginPath();
  ctx.arc(s(pos.x), s(by + 10), s(2.5), 0, Math.PI * 2);
  ctx.fill();

  // Highlight
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = s(0.5);
  ctx.beginPath();
  ctx.moveTo(s(bx + 2), s(by + 6));
  ctx.lineTo(s(bx + 2), s(pos.y - 3));
  ctx.stroke();
}

// ─── Room 2 decorative props (draw-only, no colliders) ───────────────────────

function drawRoom2WallDecor() {
  const { ceilTL, ceilTR, floorTL, leftWallTop, floorBL } = ROOM;

  // Helper: back wall position
  function bw(u, v) {
    return {
      x: ceilTL.x + u * (ceilTR.x - ceilTL.x),
      y: ceilTL.y + v * (floorTL.y - ceilTL.y)
    };
  }

  // Helper: left wall position (u: 0=inner/ceilTL, 1=outer/leftWallTop; v: 0=top, 1=bottom)
  function lw(u, v) {
    return {
      x: (1 - u) * (1 - v) * ceilTL.x + u * (1 - v) * leftWallTop.x
          + (1 - u) * v * floorTL.x + u * v * floorBL.x,
      y: (1 - u) * (1 - v) * ceilTL.y + u * (1 - v) * leftWallTop.y
          + (1 - u) * v * floorTL.y + u * v * floorBL.y
    };
  }

  // ── Pegboard (back wall, left of partition, above workbench) ──
  const pg = bw(0.20, 0.25);
  const pgW = 80, pgH = 60;
  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.10)';
  ctx.fillRect(s(pg.x - pgW / 2 + 3), s(pg.y - pgH / 2 + 3), s(pgW), s(pgH));
  // Board body (warm brown hardboard)
  const pgGrad = ctx.createLinearGradient(0, s(pg.y - pgH / 2), 0, s(pg.y + pgH / 2));
  pgGrad.addColorStop(0, '#7a6a50');
  pgGrad.addColorStop(0.5, '#6e5e48');
  pgGrad.addColorStop(1, '#625440');
  ctx.fillStyle = pgGrad;
  ctx.fillRect(s(pg.x - pgW / 2), s(pg.y - pgH / 2), s(pgW), s(pgH));
  // Peg holes (grid of small dots)
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 7; col++) {
      const hx = pg.x - pgW / 2 + 8 + col * (pgW - 16) / 6;
      const hy = pg.y - pgH / 2 + 8 + row * (pgH - 16) / 4;
      ctx.beginPath();
      ctx.arc(s(hx), s(hy), s(1.2), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Hung tool silhouettes (wrench, screwdriver, pliers — kept subtle)
  ctx.strokeStyle = 'rgba(50,50,50,0.15)';
  ctx.lineWidth = s(2);
  // Wrench
  ctx.beginPath();
  ctx.moveTo(s(pg.x - pgW / 2 + 12), s(pg.y - 8));
  ctx.lineTo(s(pg.x - pgW / 2 + 12), s(pg.y + 14));
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(s(pg.x - pgW / 2 + 12), s(pg.y + 16), s(3), 0, Math.PI * 2);
  ctx.stroke();
  // Screwdriver
  ctx.lineWidth = s(1.5);
  ctx.beginPath();
  ctx.moveTo(s(pg.x - 5), s(pg.y - 10));
  ctx.lineTo(s(pg.x - 5), s(pg.y + 16));
  ctx.stroke();
  ctx.lineWidth = s(2.5);
  ctx.beginPath();
  ctx.moveTo(s(pg.x - 5), s(pg.y - 10));
  ctx.lineTo(s(pg.x - 5), s(pg.y - 2));
  ctx.stroke();
  // Pliers
  ctx.lineWidth = s(1.5);
  ctx.beginPath();
  ctx.moveTo(s(pg.x + 18), s(pg.y - 8));
  ctx.lineTo(s(pg.x + 16), s(pg.y + 4));
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s(pg.x + 22), s(pg.y - 8));
  ctx.lineTo(s(pg.x + 20), s(pg.y + 4));
  ctx.stroke();
  // Outline
  ctx.strokeStyle = '#4a4030';
  ctx.lineWidth = s(1);
  ctx.strokeRect(s(pg.x - pgW / 2), s(pg.y - pgH / 2), s(pgW), s(pgH));

  // ── Safety sign (back wall, right of partition, above cabinet — weathered) ──
  const sgn = bw(0.75, 0.18);
  const sgnW = 32, sgnH = 24;
  // Yellow/black caution sign — faded
  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(s(sgn.x - sgnW / 2 - 1), s(sgn.y - sgnH / 2 - 1), s(sgnW + 2), s(sgnH + 2));
  ctx.fillStyle = '#9a8428';
  ctx.fillRect(s(sgn.x - sgnW / 2), s(sgn.y - sgnH / 2), s(sgnW), s(sgnH));
  // Hazard stripes (diagonal, faded)
  ctx.save();
  ctx.beginPath();
  ctx.rect(s(sgn.x - sgnW / 2), s(sgn.y - sgnH / 2), s(sgnW), s(sgnH));
  ctx.clip();
  ctx.strokeStyle = 'rgba(0,0,0,0.20)';
  ctx.lineWidth = s(3);
  for (let i = -4; i < 8; i++) {
    const sx = sgn.x - sgnW / 2 + i * 8;
    ctx.beginPath();
    ctx.moveTo(s(sx), s(sgn.y - sgnH / 2));
    ctx.lineTo(s(sx + sgnH), s(sgn.y + sgnH / 2));
    ctx.stroke();
  }
  ctx.restore();
  // Exclamation mark (faded)
  ctx.fillStyle = 'rgba(26,26,26,0.6)';
  ctx.font = `bold ${s(12)}px monospace`;
  ctx.textAlign = 'center';
  ctx.fillText('!', s(sgn.x), s(sgn.y + 4));

  // ── First aid box (left wall, mid-height) ──
  const fa = lw(0.35, 0.42);
  const faW = 22, faH = 18;
  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.fillRect(s(fa.x - faW / 2 + 2), s(fa.y - faH / 2 + 2), s(faW), s(faH));
  // Box body (white)
  ctx.fillStyle = '#d0d2d0';
  ctx.fillRect(s(fa.x - faW / 2), s(fa.y - faH / 2), s(faW), s(faH));
  // Red cross
  ctx.fillStyle = '#c03030';
  ctx.fillRect(s(fa.x - 2), s(fa.y - 6), s(4), s(12));
  ctx.fillRect(s(fa.x - 6), s(fa.y - 2), s(12), s(4));
  // Outline
  ctx.strokeStyle = '#8a8c8a';
  ctx.lineWidth = s(0.8);
  ctx.strokeRect(s(fa.x - faW / 2), s(fa.y - faH / 2), s(faW), s(faH));
}

function drawRoom2FloorDrain() {
  // Circular drain grate on the floor (in gap/chokepoint area)
  const drainPos = floorToScreen(0.46, 0.72);
  const drainR = 12;

  ctx.save();
  // Dark circle
  ctx.fillStyle = 'rgba(0,0,0,0.15)';
  ctx.beginPath();
  ctx.ellipse(s(drainPos.x), s(drainPos.y), s(drainR), s(drainR * 0.45), 0, 0, Math.PI * 2);
  ctx.fill();
  // Grate ring
  ctx.strokeStyle = 'rgba(80,85,90,0.4)';
  ctx.lineWidth = s(1.5);
  ctx.beginPath();
  ctx.ellipse(s(drainPos.x), s(drainPos.y), s(drainR), s(drainR * 0.45), 0, 0, Math.PI * 2);
  ctx.stroke();
  // Cross bars
  ctx.strokeStyle = 'rgba(80,85,90,0.3)';
  ctx.lineWidth = s(1);
  ctx.beginPath();
  ctx.moveTo(s(drainPos.x - drainR + 2), s(drainPos.y));
  ctx.lineTo(s(drainPos.x + drainR - 2), s(drainPos.y));
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s(drainPos.x), s(drainPos.y - drainR * 0.4));
  ctx.lineTo(s(drainPos.x), s(drainPos.y + drainR * 0.4));
  ctx.stroke();
  // Moisture stain ring around drain
  const stain = ctx.createRadialGradient(
    s(drainPos.x), s(drainPos.y), s(drainR),
    s(drainPos.x), s(drainPos.y), s(drainR + 10)
  );
  stain.addColorStop(0, 'rgba(0,0,0,0.06)');
  stain.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = stain;
  ctx.beginPath();
  ctx.ellipse(s(drainPos.x), s(drainPos.y), s(drainR + 10), s((drainR + 10) * 0.45), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawRoom2FloorStains() {
  // Oil stain near workbench area (back area, workshop feel)
  const oilPos = floorToScreen(0.22, 0.30);
  const oilGrad = ctx.createRadialGradient(
    s(oilPos.x), s(oilPos.y), 0,
    s(oilPos.x), s(oilPos.y), s(18)
  );
  oilGrad.addColorStop(0, 'rgba(20,18,10,0.10)');
  oilGrad.addColorStop(0.5, 'rgba(20,18,10,0.05)');
  oilGrad.addColorStop(1, 'rgba(20,18,10,0)');
  ctx.fillStyle = oilGrad;
  ctx.beginPath();
  ctx.ellipse(s(oilPos.x), s(oilPos.y), s(18), s(9), 0.2, 0, Math.PI * 2);
  ctx.fill();

  // Smaller grease spot near barrels
  const g2 = floorToScreen(0.16, 0.60);
  const g2Grad = ctx.createRadialGradient(s(g2.x), s(g2.y), 0, s(g2.x), s(g2.y), s(10));
  g2Grad.addColorStop(0, 'rgba(15,12,8,0.08)');
  g2Grad.addColorStop(1, 'rgba(15,12,8,0)');
  ctx.fillStyle = g2Grad;
  ctx.beginPath();
  ctx.ellipse(s(g2.x), s(g2.y), s(10), s(5), -0.1, 0, Math.PI * 2);
  ctx.fill();

  // Scuff marks near gap/chokepoint (foot traffic)
  ctx.strokeStyle = 'rgba(0,0,0,0.04)';
  ctx.lineWidth = s(2);
  const sc1 = floorToScreen(0.44, 0.68);
  ctx.beginPath();
  ctx.moveTo(s(sc1.x - 8), s(sc1.y));
  ctx.lineTo(s(sc1.x + 6), s(sc1.y + 1));
  ctx.stroke();
  const sc2 = floorToScreen(0.50, 0.72);
  ctx.beginPath();
  ctx.moveTo(s(sc2.x - 5), s(sc2.y - 1));
  ctx.lineTo(s(sc2.x + 8), s(sc2.y));
  ctx.stroke();

  // Equipment dolly scuff arcs (curved wear from moving heavy items)
  ctx.strokeStyle = 'rgba(0,0,0,0.05)';
  ctx.lineWidth = s(2.5);
  const arc1s = floorToScreen(0.30, 0.40);
  const arc1m = floorToScreen(0.42, 0.48);
  const arc1e = floorToScreen(0.55, 0.44);
  ctx.beginPath();
  ctx.moveTo(s(arc1s.x), s(arc1s.y));
  ctx.quadraticCurveTo(s(arc1m.x), s(arc1m.y), s(arc1e.x), s(arc1e.y));
  ctx.stroke();
  ctx.lineWidth = s(1.8);
  const arc2s = floorToScreen(0.60, 0.70);
  const arc2m = floorToScreen(0.68, 0.64);
  const arc2e = floorToScreen(0.72, 0.56);
  ctx.beginPath();
  ctx.moveTo(s(arc2s.x), s(arc2s.y));
  ctx.quadraticCurveTo(s(arc2m.x), s(arc2m.y), s(arc2e.x), s(arc2e.y));
  ctx.stroke();
}

// ─── Room 2 wall aging (warm industrial wear on walls) ───────────────────────

function drawRoom2WallAging() {
  const { ceilTL, ceilTR, floorTL, floorTR, floorBL, leftWallTop } = ROOM;

  // Moisture/rust stain near bottom of back wall (seepage)
  ctx.save();
  roomPath([ceilTL, ceilTR, floorTR, floorTL]);
  ctx.clip();
  const rustPos = { x: floorTL.x + (floorTR.x - floorTL.x) * 0.65, y: floorTL.y - 12 };
  const rustGrad = ctx.createRadialGradient(
    s(rustPos.x), s(rustPos.y), 0,
    s(rustPos.x), s(rustPos.y), s(35)
  );
  rustGrad.addColorStop(0, 'rgba(100,70,40,0.06)');
  rustGrad.addColorStop(0.6, 'rgba(80,60,35,0.03)');
  rustGrad.addColorStop(1, 'rgba(80,60,35,0)');
  ctx.fillStyle = rustGrad;
  ctx.fillRect(s(rustPos.x - 40), s(rustPos.y - 30), s(80), s(40));
  ctx.restore();

  // Faded dust/dirt band along left wall base
  ctx.save();
  roomPath([leftWallTop, ceilTL, floorTL, floorBL]);
  ctx.clip();
  const dirtGrad = ctx.createLinearGradient(
    s(floorBL.x), s(floorBL.y), s(floorBL.x), s(floorBL.y - 40)
  );
  dirtGrad.addColorStop(0, 'rgba(80,65,45,0.08)');
  dirtGrad.addColorStop(0.5, 'rgba(80,65,45,0.03)');
  dirtGrad.addColorStop(1, 'rgba(80,65,45,0)');
  ctx.fillStyle = dirtGrad;
  ctx.beginPath();
  ctx.moveTo(s(floorBL.x), s(floorBL.y));
  ctx.lineTo(s(floorTL.x), s(floorTL.y));
  ctx.lineTo(s(floorTL.x), s(floorTL.y - 40));
  ctx.lineTo(s(floorBL.x), s(floorBL.y - 40));
  ctx.closePath();
  ctx.fill();

  // Seepage streaks descending from wall panel seams (water damage)
  ctx.strokeStyle = 'rgba(90,75,50,0.05)';
  ctx.lineWidth = s(1.5);
  for (const frac of [0.55, 0.75]) {
    const sx = leftWallTop.x + (ceilTL.x - leftWallTop.x) * frac;
    const sy = leftWallTop.y + (ceilTL.y - leftWallTop.y) * frac;
    const ex = floorBL.x + (floorTL.x - floorBL.x) * frac;
    const ey = floorBL.y + (floorTL.y - floorBL.y) * frac;
    const midY = sy + (ey - sy) * 0.6;
    ctx.beginPath();
    ctx.moveTo(s(sx), s(sy + 10));
    ctx.quadraticCurveTo(s(sx - 2), s(midY), s(ex + 1), s(ey - 5));
    ctx.stroke();
  }
  ctx.restore();
}

function drawRoom3FloorCables() {
  // Floor cable run — taped down cable in north corridor (above partition)
  const c1 = floorToScreen(0.35, 0.10);
  const c2 = floorToScreen(0.50, 0.22);
  const c3 = floorToScreen(0.62, 0.34);

  // Cable shadow
  ctx.strokeStyle = 'rgba(0,0,0,0.06)';
  ctx.lineWidth = s(4);
  ctx.beginPath();
  ctx.moveTo(s(c1.x + 1), s(c1.y + 1));
  ctx.quadraticCurveTo(s(c2.x + 1), s(c2.y + 1), s(c3.x + 1), s(c3.y + 1));
  ctx.stroke();

  // Cable body (dark gray)
  ctx.strokeStyle = '#3a3d44';
  ctx.lineWidth = s(2.5);
  ctx.beginPath();
  ctx.moveTo(s(c1.x), s(c1.y));
  ctx.quadraticCurveTo(s(c2.x), s(c2.y), s(c3.x), s(c3.y));
  ctx.stroke();

  // Cable highlight
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = s(0.8);
  ctx.beginPath();
  ctx.moveTo(s(c1.x - 0.5), s(c1.y - 0.5));
  ctx.quadraticCurveTo(s(c2.x - 0.5), s(c2.y - 0.5), s(c3.x - 0.5), s(c3.y - 0.5));
  ctx.stroke();

  // Tape strips holding cable down
  ctx.fillStyle = 'rgba(80,80,70,0.12)';
  const tape1 = floorToScreen(0.42, 0.15);
  ctx.save();
  ctx.translate(s(tape1.x), s(tape1.y));
  ctx.rotate(0.1);
  ctx.fillRect(s(-6), s(-1.5), s(12), s(3));
  ctx.restore();
  const tape2 = floorToScreen(0.56, 0.28);
  ctx.save();
  ctx.translate(s(tape2.x), s(tape2.y));
  ctx.rotate(-0.15);
  ctx.fillRect(s(-6), s(-1.5), s(12), s(3));
  ctx.restore();
}

// ─── Room 3 wall framing (structural/conduit lines — tight utility corridor) ─

function drawRoom3WallFraming() {
  const { ceilTL, ceilTR, floorTL, floorTR, floorBL, floorBR,
          leftWallTop, rightWallTop } = ROOM;

  // Thin horizontal conduit lines on back wall (cable trunking runs)
  ctx.save();
  roomPath([ceilTL, ceilTR, floorTR, floorTL]);
  ctx.clip();
  ctx.strokeStyle = 'rgba(80,110,150,0.06)';
  ctx.lineWidth = s(1);
  // Two thin horizontal lines suggesting cable management channels
  for (const frac of [0.35, 0.75]) {
    const ly = ceilTL.y + (floorTL.y - ceilTL.y) * frac;
    const ry = ceilTR.y + (floorTR.y - ceilTR.y) * frac;
    ctx.beginPath();
    ctx.moveTo(s(ceilTL.x + 8), s(ly));
    ctx.lineTo(s(ceilTR.x - 8), s(ry));
    ctx.stroke();
  }
  ctx.restore();

  // Faint blue ambient glow along floor edge (LED strip / equipment indicator light bleed)
  ctx.save();
  roomPath([floorTL, floorTR, floorBR, floorBL]);
  ctx.clip();
  const glowGrad = ctx.createLinearGradient(
    s(640), s(floorTL.y), s(640), s(floorTL.y + 30)
  );
  glowGrad.addColorStop(0, 'rgba(60,100,180,0.05)');
  glowGrad.addColorStop(0.5, 'rgba(60,100,180,0.02)');
  glowGrad.addColorStop(1, 'rgba(60,100,180,0)');
  ctx.fillStyle = glowGrad;
  ctx.fillRect(s(floorTL.x), s(floorTL.y), s(floorTR.x - floorTL.x), s(30));
  ctx.restore();

  // Thermal bloom around network panel area on back wall (equipment heat signature)
  ctx.save();
  roomPath([ceilTL, ceilTR, floorTR, floorTL]);
  ctx.clip();
  const panelFrac = 0.52; // network panel position on back wall
  const panelX = ceilTL.x + (ceilTR.x - ceilTL.x) * panelFrac;
  const panelY = ceilTL.y + (floorTL.y - ceilTL.y) * 0.40;
  const thermGrad = ctx.createRadialGradient(
    s(panelX), s(panelY), 0, s(panelX), s(panelY), s(45)
  );
  thermGrad.addColorStop(0, 'rgba(80,130,200,0.05)');
  thermGrad.addColorStop(0.5, 'rgba(80,130,200,0.02)');
  thermGrad.addColorStop(1, 'rgba(80,130,200,0)');
  ctx.fillStyle = thermGrad;
  ctx.beginPath();
  ctx.arc(s(panelX), s(panelY), s(45), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Asset label silhouettes on back wall (datacenter infrastructure tags)
  ctx.save();
  roomPath([ceilTL, ceilTR, floorTR, floorTL]);
  ctx.clip();
  ctx.strokeStyle = 'rgba(120,140,170,0.07)';
  ctx.lineWidth = s(0.5);
  for (const [fU, fV, w, h] of [[0.22, 0.20, 10, 5], [0.78, 0.30, 8, 4], [0.38, 0.65, 10, 5]]) {
    const lx = ceilTL.x + (ceilTR.x - ceilTL.x) * fU;
    const ly = ceilTL.y + (floorTL.y - ceilTL.y) * fV;
    ctx.strokeRect(s(lx - w / 2), s(ly - h / 2), s(w), s(h));
    // Tiny barcode lines inside
    ctx.strokeStyle = 'rgba(120,140,170,0.05)';
    for (let i = 0; i < 4; i++) {
      const bx = lx - w / 2 + 2 + i * 2;
      ctx.beginPath();
      ctx.moveTo(s(bx), s(ly - h / 2 + 1));
      ctx.lineTo(s(bx), s(ly + h / 2 - 1));
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(120,140,170,0.07)';
  }
  ctx.restore();
}

function drawMopBucket() {
  // Position: back area corner, near barrels, out of stealth lanes
  const pos = floorToScreen(0.28, 0.62);
  const bucW = 18, bucH = 20;
  const bx = pos.x - bucW / 2;
  const by = pos.y - bucH;

  // Contact shadow
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  ctx.ellipse(s(pos.x), s(pos.y), s(14), s(5.5), 0, 0, Math.PI * 2);
  ctx.fill();

  // Bucket body (dark blue/grey plastic)
  const bucGrad = ctx.createLinearGradient(s(bx - 1), 0, s(bx + bucW + 1), 0);
  bucGrad.addColorStop(0, '#2a3a4a');
  bucGrad.addColorStop(0.3, '#3a4e62');
  bucGrad.addColorStop(0.7, '#3a4e62');
  bucGrad.addColorStop(1, '#2a3a4a');
  ctx.fillStyle = bucGrad;
  ctx.beginPath();
  ctx.moveTo(s(bx + 2), s(pos.y));
  ctx.lineTo(s(bx + bucW - 2), s(pos.y));
  ctx.lineTo(s(bx + bucW + 1), s(by));
  ctx.lineTo(s(bx - 1), s(by));
  ctx.closePath();
  ctx.fill();

  // Rim
  ctx.strokeStyle = '#4a6078';
  ctx.lineWidth = s(1.5);
  ctx.beginPath();
  ctx.moveTo(s(bx - 2), s(by));
  ctx.lineTo(s(bx + bucW + 2), s(by));
  ctx.stroke();

  // Wire handle (arc)
  ctx.strokeStyle = '#6a6d75';
  ctx.lineWidth = s(1);
  ctx.beginPath();
  ctx.arc(s(pos.x), s(by - 6), s(bucW / 2 - 2), Math.PI * 0.15, Math.PI * 0.85);
  ctx.stroke();

  // Outline
  ctx.strokeStyle = '#1e2a38';
  ctx.lineWidth = s(0.8);
  ctx.beginPath();
  ctx.moveTo(s(bx + 2), s(pos.y));
  ctx.lineTo(s(bx + bucW - 2), s(pos.y));
  ctx.lineTo(s(bx + bucW + 1), s(by));
  ctx.lineTo(s(bx - 1), s(by));
  ctx.closePath();
  ctx.stroke();

  // Mop handle (diagonal stick leaning from bucket)
  ctx.strokeStyle = '#6a5a3a';
  ctx.lineWidth = s(2);
  ctx.beginPath();
  ctx.moveTo(s(pos.x + 4), s(by));
  ctx.lineTo(s(pos.x + 14), s(by - 42));
  ctx.stroke();
  // Mop handle highlight
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = s(0.6);
  ctx.beginPath();
  ctx.moveTo(s(pos.x + 3), s(by));
  ctx.lineTo(s(pos.x + 13), s(by - 40));
  ctx.stroke();
  // Mop head (small grey tuft at top)
  ctx.fillStyle = '#808080';
  ctx.beginPath();
  ctx.ellipse(s(pos.x + 15), s(by - 43), s(4), s(3), 0.3, 0, Math.PI * 2);
  ctx.fill();
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
    s(base.x), s((tl.y + base.y) / 2), s(Math.max(screenW, base.y - tl.y) * 0.85)
  );
  footGrad.addColorStop(0, 'rgba(0,0,0,0.22)');
  footGrad.addColorStop(0.6, 'rgba(0,0,0,0.10)');
  footGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = footGrad;
  ctx.beginPath();
  ctx.moveTo(s(tl.x - 6), s(tl.y - 3));
  ctx.lineTo(s(tr.x + 6), s(tr.y - 3));
  ctx.lineTo(s(br.x + 10), s(br.y + 8));
  ctx.lineTo(s(bl.x - 8), s(bl.y + 8));
  ctx.closePath();
  ctx.fill();

  // Contact shadow — spread layer
  const ctsGrad = ctx.createLinearGradient(0, s(base.y - 2), 0, s(base.y + 12));
  ctsGrad.addColorStop(0, 'rgba(0,0,0,0.30)');
  ctsGrad.addColorStop(0.4, 'rgba(0,0,0,0.18)');
  ctsGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = ctsGrad;
  ctx.beginPath();
  ctx.moveTo(s(bx - sideW), s(base.y - 2));
  ctx.lineTo(s(bx + screenW + sideW), s(base.y - 2));
  ctx.lineTo(s(bx + screenW + sideW + 4), s(base.y + 12));
  ctx.lineTo(s(bx - sideW - 4), s(base.y + 12));
  ctx.closePath();
  ctx.fill();
  // Base occlusion strip — tight dark line right at ground contact
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = s(1.5);
  ctx.beginPath();
  ctx.moveTo(s(bx - sideW), s(base.y));
  ctx.lineTo(s(bx + screenW + sideW), s(base.y));
  ctx.stroke();

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
  const tl = floorToScreen(box.uMin, box.vMin);
  const tr = floorToScreen(box.uMax, box.vMin);
  const deskW = br.x - bl.x;
  const legH = 50;
  const sideW = 10;
  const dx = base.x - deskW / 2;
  const topY = base.y - legH;

  // Ground-plane footprint shadow (matches rack/crate pattern)
  const footGrad = ctx.createRadialGradient(
    s(base.x), s((tl.y + base.y) / 2), 0,
    s(base.x), s((tl.y + base.y) / 2), s(Math.max(deskW, base.y - tl.y) * 0.85)
  );
  footGrad.addColorStop(0, 'rgba(0,0,0,0.18)');
  footGrad.addColorStop(0.6, 'rgba(0,0,0,0.08)');
  footGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = footGrad;
  ctx.beginPath();
  ctx.moveTo(s(tl.x - 4), s(tl.y - 2));
  ctx.lineTo(s(tr.x + 4), s(tr.y - 2));
  ctx.lineTo(s(br.x + 8), s(br.y + 6));
  ctx.lineTo(s(bl.x - 6), s(bl.y + 6));
  ctx.closePath();
  ctx.fill();

  // Contact shadow — gradient spread
  const dcsGrad = ctx.createLinearGradient(0, s(base.y - 2), 0, s(base.y + 12));
  dcsGrad.addColorStop(0, 'rgba(0,0,0,0.28)');
  dcsGrad.addColorStop(0.4, 'rgba(0,0,0,0.14)');
  dcsGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = dcsGrad;
  ctx.beginPath();
  ctx.moveTo(s(dx - 6), s(base.y - 2));
  ctx.lineTo(s(dx + deskW + sideW + 2), s(base.y - 2));
  ctx.lineTo(s(dx + deskW + sideW + 6), s(base.y + 12));
  ctx.lineTo(s(dx - 8), s(base.y + 12));
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
    // Foot pad AO ring
    const fpGrad = ctx.createRadialGradient(s(botX), s(base.y), 0, s(botX), s(base.y), s(8));
    fpGrad.addColorStop(0, 'rgba(0,0,0,0.25)');
    fpGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = fpGrad;
    ctx.beginPath();
    ctx.ellipse(s(botX), s(base.y), s(8), s(3.5), 0, 0, Math.PI * 2);
    ctx.fill();
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

  // Desk clutter around keycard area
  drawDeskClutter(dx, deskW, topY);

  // Keycard on desk (drawn last so it's on top of clutter)
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
  const glowR = 42 + 12 * pulse;

  // Outer pulsing glow
  const glow = ctx.createRadialGradient(s(cx), s(baseY - kh / 2), 0, s(cx), s(baseY - kh / 2), s(glowR));
  glow.addColorStop(0, `rgba(80,200,255,${0.40 * pulse})`);
  glow.addColorStop(0.5, `rgba(80,200,255,${0.18 * pulse})`);
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

function drawDeskClutter(dx, deskW, topY) {
  // Coffee mug (left of keycard area, between monitor1 and keycard)
  const mugX = dx + deskW * 0.42;
  const mugY = topY - 6;
  // Mug body
  ctx.fillStyle = '#4a4a52';
  ctx.beginPath();
  ctx.roundRect(s(mugX - 5), s(mugY - 10), s(10), s(10), s(1.5));
  ctx.fill();
  // Mug rim
  ctx.strokeStyle = '#5a5a62';
  ctx.lineWidth = s(1);
  ctx.beginPath();
  ctx.ellipse(s(mugX), s(mugY - 10), s(5), s(2), 0, 0, Math.PI * 2);
  ctx.stroke();
  // Liquid inside
  ctx.fillStyle = '#2a1a0a';
  ctx.beginPath();
  ctx.ellipse(s(mugX), s(mugY - 9.5), s(4), s(1.5), 0, 0, Math.PI * 2);
  ctx.fill();
  // Handle
  ctx.strokeStyle = '#4a4a52';
  ctx.lineWidth = s(1.2);
  ctx.beginPath();
  ctx.arc(s(mugX + 6), s(mugY - 5), s(3), -Math.PI * 0.4, Math.PI * 0.4);
  ctx.stroke();

  // Stack of papers (right of keycard area)
  const papX = dx + deskW * 0.60;
  const papY = topY - 5;
  // Stack with slight offset layers
  ctx.fillStyle = '#c8c8c0';
  ctx.fillRect(s(papX), s(papY - 6), s(18), s(3));
  ctx.fillStyle = '#d0d0c8';
  ctx.fillRect(s(papX - 1), s(papY - 9), s(18), s(3));
  ctx.fillStyle = '#d8d8d0';
  ctx.fillRect(s(papX + 1), s(papY - 12), s(18), s(3));
  // Subtle text lines on top sheet
  ctx.strokeStyle = 'rgba(80,80,80,0.12)';
  ctx.lineWidth = s(0.5);
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(s(papX + 3), s(papY - 11 + i * 2.5));
    ctx.lineTo(s(papX + 14), s(papY - 11 + i * 2.5));
    ctx.stroke();
  }

  // Pen (angled, near papers)
  ctx.strokeStyle = '#1a2a5a';
  ctx.lineWidth = s(1.5);
  ctx.beginPath();
  ctx.moveTo(s(papX + 20), s(papY - 3));
  ctx.lineTo(s(papX + 30), s(papY - 9));
  ctx.stroke();
  // Pen tip
  ctx.strokeStyle = '#8a8a8a';
  ctx.lineWidth = s(0.8);
  ctx.beginPath();
  ctx.moveTo(s(papX + 30), s(papY - 9));
  ctx.lineTo(s(papX + 32), s(papY - 10));
  ctx.stroke();

  // Small sticky note (between monitors, left side)
  ctx.fillStyle = 'rgba(240,220,80,0.30)';
  ctx.fillRect(s(dx + deskW * 0.15), s(topY - 14), s(12), s(10));
  ctx.strokeStyle = 'rgba(200,180,40,0.15)';
  ctx.lineWidth = s(0.5);
  ctx.strokeRect(s(dx + deskW * 0.15), s(topY - 14), s(12), s(10));
}

function drawBenchClutter(dx, benchW, topY) {
  // Clipboard (right of keycard area, angled)
  const clipX = dx + benchW * 0.70;
  const clipY = topY - 5;
  // Board
  ctx.fillStyle = '#6a5a40';
  ctx.save();
  ctx.translate(s(clipX), s(clipY));
  ctx.rotate(-0.15);
  ctx.fillRect(s(-8), s(-14), s(16), s(20));
  // Paper on clipboard
  ctx.fillStyle = '#d4d4cc';
  ctx.fillRect(s(-7), s(-12), s(14), s(17));
  // Text lines
  ctx.strokeStyle = 'rgba(80,80,80,0.12)';
  ctx.lineWidth = s(0.5);
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(s(-5), s(-10 + i * 3.5));
    ctx.lineTo(s(5), s(-10 + i * 3.5));
    ctx.stroke();
  }
  // Metal clip at top
  ctx.fillStyle = '#8a8d95';
  ctx.fillRect(s(-4), s(-14.5), s(8), s(3));
  ctx.restore();

  // Scattered washers/bolts (small metal circles near keycard)
  ctx.fillStyle = '#6a6d75';
  const bolts = [
    [dx + benchW * 0.48, topY - 7, 1.5],
    [dx + benchW * 0.51, topY - 5, 1.2],
    [dx + benchW * 0.62, topY - 6, 1.8],
    [dx + benchW * 0.46, topY - 9, 1.0],
  ];
  for (const [bx, by, br] of bolts) {
    ctx.beginPath();
    ctx.arc(s(bx), s(by), s(br), 0, Math.PI * 2);
    ctx.fill();
  }
  // One washer (ring)
  ctx.strokeStyle = '#7a7d85';
  ctx.lineWidth = s(1);
  ctx.beginPath();
  ctx.arc(s(dx + benchW * 0.59), s(topY - 9), s(2.5), 0, Math.PI * 2);
  ctx.stroke();

  // Rag/cloth (draped, near right side)
  ctx.fillStyle = 'rgba(90,70,55,0.35)';
  ctx.beginPath();
  ctx.moveTo(s(dx + benchW * 0.78), s(topY - 4));
  ctx.quadraticCurveTo(s(dx + benchW * 0.82), s(topY - 10), s(dx + benchW * 0.88), s(topY - 5));
  ctx.quadraticCurveTo(s(dx + benchW * 0.85), s(topY - 2), s(dx + benchW * 0.78), s(topY - 4));
  ctx.fill();
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

function drawCrates(box) {
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
    s(base.x), s((tl.y + base.y) / 2), s(Math.max(cw1, base.y - tl.y) * 0.85)
  );
  footGrad.addColorStop(0, 'rgba(0,0,0,0.22)');
  footGrad.addColorStop(0.6, 'rgba(0,0,0,0.10)');
  footGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = footGrad;
  ctx.beginPath();
  ctx.moveTo(s(tl.x - 6), s(tl.y - 3));
  ctx.lineTo(s(tr.x + 6), s(tr.y - 3));
  ctx.lineTo(s(br.x + 10), s(br.y + 8));
  ctx.lineTo(s(bl.x - 8), s(bl.y + 8));
  ctx.closePath();
  ctx.fill();

  // Contact shadow — gradient spread
  const ccsGrad = ctx.createLinearGradient(0, s(base.y - 2), 0, s(base.y + 12));
  ccsGrad.addColorStop(0, 'rgba(0,0,0,0.30)');
  ccsGrad.addColorStop(0.4, 'rgba(0,0,0,0.18)');
  ccsGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = ccsGrad;
  ctx.beginPath();
  ctx.moveTo(s(cx1 - sideW - 2), s(base.y - 2));
  ctx.lineTo(s(cx1 + cw1 + sideW + 2), s(base.y - 2));
  ctx.lineTo(s(cx1 + cw1 + sideW + 6), s(base.y + 12));
  ctx.lineTo(s(cx1 - sideW - 6), s(base.y + 12));
  ctx.closePath();
  ctx.fill();
  // Base occlusion strip
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = s(1.5);
  ctx.beginPath();
  ctx.moveTo(s(cx1 - sideW), s(base.y));
  ctx.lineTo(s(cx1 + cw1 + sideW), s(base.y));
  ctx.stroke();

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

// ─── Room 2: Partition wall ──────────────────────────────────────────────────

function drawPartition(box) {
  const tl = floorToScreen(box.uMin, box.vMin);
  const tr = floorToScreen(box.uMax, box.vMin);
  const bl = floorToScreen(box.uMin, box.vMax);
  const br = floorToScreen(box.uMax, box.vMax);
  const base = floorToScreen((box.uMin + box.uMax) / 2, box.vMax);

  const wallW = br.x - bl.x;
  const wallDepth = bl.y - tl.y;
  // Partition rises from floor to ~70% of room height
  const wallH = wallDepth * 2.8;
  const dx = bl.x;
  const by = bl.y;

  // Ground-plane footprint shadow
  const footGrad = ctx.createRadialGradient(
    s(base.x), s((tl.y + base.y) / 2), 0,
    s(base.x), s((tl.y + base.y) / 2), s(Math.max(wallW, wallDepth) * 1.2)
  );
  footGrad.addColorStop(0, 'rgba(0,0,0,0.22)');
  footGrad.addColorStop(0.5, 'rgba(0,0,0,0.08)');
  footGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = footGrad;
  ctx.beginPath();
  ctx.moveTo(s(tl.x - 6), s(tl.y - 3));
  ctx.lineTo(s(tr.x + 6), s(tr.y - 3));
  ctx.lineTo(s(br.x + 10), s(br.y + 8));
  ctx.lineTo(s(bl.x - 8), s(bl.y + 8));
  ctx.closePath();
  ctx.fill();

  // Contact shadow
  const ctsGrad = ctx.createLinearGradient(0, s(by - 2), 0, s(by + 14));
  ctsGrad.addColorStop(0, 'rgba(0,0,0,0.30)');
  ctsGrad.addColorStop(0.4, 'rgba(0,0,0,0.12)');
  ctsGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = ctsGrad;
  ctx.fillRect(s(dx - 8), s(by - 2), s(wallW + 16), s(16));

  // Drop shadow behind wall body
  ctx.fillStyle = 'rgba(0,0,0,0.20)';
  ctx.fillRect(s(dx + 4), s(by - wallH + 4), s(wallW + 2), s(wallH));

  // Front face — concrete/drywall
  const frontGrad = ctx.createLinearGradient(s(dx), s(by - wallH), s(dx), s(by));
  frontGrad.addColorStop(0, '#505560');
  frontGrad.addColorStop(0.3, '#4a4f58');
  frontGrad.addColorStop(0.7, '#464b54');
  frontGrad.addColorStop(1, '#424750');
  ctx.fillStyle = frontGrad;
  ctx.fillRect(s(dx), s(by - wallH), s(wallW), s(wallH));

  // Side face (right edge, gives 3D depth)
  const sideW = 8;
  const sdGrad = ctx.createLinearGradient(s(dx + wallW), 0, s(dx + wallW + sideW), 0);
  sdGrad.addColorStop(0, '#3e434c');
  sdGrad.addColorStop(1, '#363b44');
  ctx.fillStyle = sdGrad;
  ctx.beginPath();
  ctx.moveTo(s(dx + wallW), s(by - wallH));
  ctx.lineTo(s(dx + wallW + sideW), s(by - wallH + 4));
  ctx.lineTo(s(dx + wallW + sideW), s(by + 4));
  ctx.lineTo(s(dx + wallW), s(by));
  ctx.closePath();
  ctx.fill();

  // Top edge (cap)
  ctx.fillStyle = '#585d66';
  ctx.beginPath();
  ctx.moveTo(s(dx), s(by - wallH));
  ctx.lineTo(s(dx + wallW), s(by - wallH));
  ctx.lineTo(s(dx + wallW + sideW), s(by - wallH + 4));
  ctx.lineTo(s(dx + sideW), s(by - wallH + 4));
  ctx.closePath();
  ctx.fill();

  // Metal cap strip on top
  ctx.strokeStyle = '#6a6f78';
  ctx.lineWidth = s(1.5);
  ctx.beginPath();
  ctx.moveTo(s(dx), s(by - wallH));
  ctx.lineTo(s(dx + wallW), s(by - wallH));
  ctx.stroke();

  // Horizontal seam lines (panel look)
  ctx.strokeStyle = 'rgba(0,0,0,0.08)';
  ctx.lineWidth = s(0.8);
  for (let i = 1; i <= 4; i++) {
    const sy = by - wallH + (wallH * i / 5);
    ctx.beginPath();
    ctx.moveTo(s(dx + 2), s(sy));
    ctx.lineTo(s(dx + wallW - 2), s(sy));
    ctx.stroke();
  }
  // Seam highlight
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  for (let i = 1; i <= 4; i++) {
    const sy = by - wallH + (wallH * i / 5) + 1;
    ctx.beginPath();
    ctx.moveTo(s(dx + 2), s(sy));
    ctx.lineTo(s(dx + wallW - 2), s(sy));
    ctx.stroke();
  }

  // Bottom edge shadow
  ctx.strokeStyle = '#2a2e36';
  ctx.lineWidth = s(1.2);
  ctx.beginPath();
  ctx.moveTo(s(dx), s(by));
  ctx.lineTo(s(dx + wallW), s(by));
  ctx.stroke();

  // Left edge highlight (where partition meets back wall)
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = s(0.8);
  ctx.beginPath();
  ctx.moveTo(s(dx + 1), s(by - wallH + 2));
  ctx.lineTo(s(dx + 1), s(by - 2));
  ctx.stroke();
}

// ─── Room 2 facility objects ──────────────────────────────────────────────────

function drawToolCabinet(box) {
  const base = floorToScreen((box.uMin + box.uMax) / 2, box.vMax);
  const bl = floorToScreen(box.uMin, box.vMax);
  const br = floorToScreen(box.uMax, box.vMax);
  const tl = floorToScreen(box.uMin, box.vMin);
  const screenW = br.x - bl.x;
  const cabinetH = 140;
  const bx = base.x - screenW / 2;
  const by = base.y - cabinetH;
  const sideW = 10;

  // Footprint shadow
  const footGrad = ctx.createRadialGradient(
    s(base.x), s((tl.y + base.y) / 2), 0,
    s(base.x), s((tl.y + base.y) / 2), s(Math.max(screenW, base.y - tl.y) * 0.85)
  );
  footGrad.addColorStop(0, 'rgba(0,0,0,0.22)');
  footGrad.addColorStop(0.6, 'rgba(0,0,0,0.10)');
  footGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = footGrad;
  ctx.beginPath();
  ctx.moveTo(s(tl.x - 6), s(tl.y - 3));
  ctx.lineTo(s(br.x + 6), s(tl.y - 3));
  ctx.lineTo(s(br.x + 10), s(base.y + 8));
  ctx.lineTo(s(bl.x - 8), s(base.y + 8));
  ctx.closePath();
  ctx.fill();

  // Contact shadow
  const ctsGrad = ctx.createLinearGradient(0, s(base.y - 2), 0, s(base.y + 12));
  ctsGrad.addColorStop(0, 'rgba(0,0,0,0.30)');
  ctsGrad.addColorStop(0.4, 'rgba(0,0,0,0.18)');
  ctsGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = ctsGrad;
  ctx.fillRect(s(bx - sideW - 4), s(base.y - 2), s(screenW + sideW * 2 + 8), s(14));
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = s(1.5);
  ctx.beginPath();
  ctx.moveTo(s(bx - sideW), s(base.y));
  ctx.lineTo(s(bx + screenW + sideW), s(base.y));
  ctx.stroke();

  // Left side face
  const lsGrad = ctx.createLinearGradient(s(bx - sideW), 0, s(bx), 0);
  lsGrad.addColorStop(0, '#1e2a18');
  lsGrad.addColorStop(1, '#2a3a22');
  ctx.fillStyle = lsGrad;
  ctx.beginPath();
  ctx.moveTo(s(bx), s(by));
  ctx.lineTo(s(bx - sideW), s(by - 8));
  ctx.lineTo(s(bx - sideW), s(base.y - 4));
  ctx.lineTo(s(bx), s(base.y));
  ctx.closePath();
  ctx.fill();

  // Right side face
  const rsGrad = ctx.createLinearGradient(s(bx + screenW), 0, s(bx + screenW + sideW), 0);
  rsGrad.addColorStop(0, '#2a3a22');
  rsGrad.addColorStop(1, '#1e2a18');
  ctx.fillStyle = rsGrad;
  ctx.beginPath();
  ctx.moveTo(s(bx + screenW), s(by));
  ctx.lineTo(s(bx + screenW + sideW), s(by - 8));
  ctx.lineTo(s(bx + screenW + sideW), s(base.y - 4));
  ctx.lineTo(s(bx + screenW), s(base.y));
  ctx.closePath();
  ctx.fill();

  // Front face — olive green
  const bodyGrad = ctx.createLinearGradient(s(bx), 0, s(bx + screenW), 0);
  bodyGrad.addColorStop(0, '#2e4028');
  bodyGrad.addColorStop(0.15, '#3a5030');
  bodyGrad.addColorStop(0.4, '#425838');
  bodyGrad.addColorStop(0.6, '#425838');
  bodyGrad.addColorStop(0.85, '#3a5030');
  bodyGrad.addColorStop(1, '#2e4028');
  ctx.fillStyle = bodyGrad;
  ctx.fillRect(s(bx), s(by), s(screenW), s(cabinetH));

  // Two door panels
  const doorPad = 4;
  const doorW = (screenW - doorPad * 3) / 2;
  for (let d = 0; d < 2; d++) {
    const ddx = bx + doorPad + d * (doorW + doorPad);
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = s(1);
    ctx.strokeRect(s(ddx), s(by + doorPad), s(doorW), s(cabinetH - doorPad * 2));
    // Handle
    const hx = d === 0 ? ddx + doorW - 6 : ddx + 6;
    const hy = by + cabinetH / 2;
    ctx.strokeStyle = '#6a7060';
    ctx.lineWidth = s(2);
    ctx.beginPath();
    ctx.moveTo(s(hx), s(hy - 8));
    ctx.lineTo(s(hx), s(hy + 8));
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = s(0.8);
    ctx.beginPath();
    ctx.moveTo(s(hx + 1), s(hy - 7));
    ctx.lineTo(s(hx + 1), s(hy + 7));
    ctx.stroke();
  }

  // Vent slits at top
  ctx.strokeStyle = 'rgba(0,0,0,0.30)';
  ctx.lineWidth = s(0.7);
  for (let i = 0; i < 4; i++) {
    const vy = by + 8 + i * 4;
    ctx.beginPath();
    ctx.moveTo(s(bx + 8), s(vy));
    ctx.lineTo(s(bx + screenW - 8), s(vy));
    ctx.stroke();
  }

  // Top face
  const topGrad = ctx.createLinearGradient(0, s(by - 12), 0, s(by));
  topGrad.addColorStop(0, '#5a6a50');
  topGrad.addColorStop(1, '#425838');
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

  // Stencil label
  ctx.fillStyle = 'rgba(200,200,180,0.15)';
  ctx.font = `bold ${s(9)}px monospace`;
  ctx.textAlign = 'center';
  ctx.fillText('TOOLS', s(bx + screenW / 2), s(by + cabinetH - 10));

  // Frame outline
  ctx.strokeStyle = '#1e2a18';
  ctx.lineWidth = s(1.5);
  ctx.strokeRect(s(bx), s(by), s(screenW), s(cabinetH));

  // Wire spool on top of cabinet (Room 2 distraction) — hidden when knocked
  if (currentRoom === 2 && !spoolKnocked) {
    const spoolX = bx + screenW * 0.5;
    const spoolY = by - 10;
    // Subtle glow to draw player's eye
    ctx.fillStyle = 'rgba(200,140,50,0.10)';
    ctx.beginPath();
    ctx.ellipse(s(spoolX), s(spoolY - 3), s(14), s(10), 0, 0, Math.PI * 2);
    ctx.fill();
    // Spool body (lighter to stand out against dark cabinet)
    ctx.fillStyle = '#4a4e58';
    ctx.fillRect(s(spoolX - 7), s(spoolY - 5), s(14), s(5));
    // Wire wound around it — copper tone for visibility
    ctx.strokeStyle = '#b87830';
    ctx.lineWidth = s(2.5);
    ctx.beginPath();
    ctx.moveTo(s(spoolX - 5), s(spoolY - 3));
    ctx.lineTo(s(spoolX + 5), s(spoolY - 3));
    ctx.stroke();
    // End flanges
    ctx.fillStyle = '#5a5e68';
    ctx.fillRect(s(spoolX - 8), s(spoolY - 6), s(2), s(7));
    ctx.fillRect(s(spoolX + 6), s(spoolY - 6), s(2), s(7));
  }
}

function drawWorkbench(box) {
  const base = floorToScreen((box.uMin + box.uMax) / 2, box.vMax);
  const bl = floorToScreen(box.uMin, box.vMax);
  const br = floorToScreen(box.uMax, box.vMax);
  const tl = floorToScreen(box.uMin, box.vMin);
  const tr = floorToScreen(box.uMax, box.vMin);
  const benchW = br.x - bl.x;
  const legH = 55;
  const sideW = 10;
  const dx = base.x - benchW / 2;
  const topY = base.y - legH;

  // Footprint shadow
  const footGrad = ctx.createRadialGradient(
    s(base.x), s((tl.y + base.y) / 2), 0,
    s(base.x), s((tl.y + base.y) / 2), s(Math.max(benchW, base.y - tl.y) * 0.85)
  );
  footGrad.addColorStop(0, 'rgba(0,0,0,0.20)');
  footGrad.addColorStop(0.6, 'rgba(0,0,0,0.08)');
  footGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = footGrad;
  ctx.beginPath();
  ctx.moveTo(s(tl.x - 4), s(tl.y - 2));
  ctx.lineTo(s(tr.x + 4), s(tr.y - 2));
  ctx.lineTo(s(br.x + 8), s(br.y + 6));
  ctx.lineTo(s(bl.x - 6), s(bl.y + 6));
  ctx.closePath();
  ctx.fill();

  // Contact shadow
  const ctsGrad = ctx.createLinearGradient(0, s(base.y - 2), 0, s(base.y + 12));
  ctsGrad.addColorStop(0, 'rgba(0,0,0,0.28)');
  ctsGrad.addColorStop(0.4, 'rgba(0,0,0,0.14)');
  ctsGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = ctsGrad;
  ctx.fillRect(s(dx - 8), s(base.y - 2), s(benchW + sideW + 16), s(14));

  // Thick legs
  const legW = 5;
  const legs = [
    [dx + 10, dx + 8],
    [dx + benchW - 10, dx + benchW - 8]
  ];
  for (const [topX, botX] of legs) {
    ctx.strokeStyle = '#4a4d55';
    ctx.lineWidth = s(legW + 2);
    ctx.beginPath(); ctx.moveTo(s(topX), s(topY + 10)); ctx.lineTo(s(botX), s(base.y)); ctx.stroke();
    ctx.strokeStyle = '#686b72';
    ctx.lineWidth = s(legW);
    ctx.beginPath(); ctx.moveTo(s(topX), s(topY + 10)); ctx.lineTo(s(botX), s(base.y)); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = s(1);
    ctx.beginPath(); ctx.moveTo(s(topX - 1), s(topY + 12)); ctx.lineTo(s(botX - 1), s(base.y - 2)); ctx.stroke();
    // Foot pad
    ctx.fillStyle = '#3a3d44';
    ctx.beginPath();
    ctx.ellipse(s(botX), s(base.y), s(6), s(2.5), 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Cross brace between legs
  ctx.strokeStyle = '#5a5d65';
  ctx.lineWidth = s(2);
  ctx.beginPath();
  ctx.moveTo(s(dx + 10), s(base.y - legH * 0.35));
  ctx.lineTo(s(dx + benchW - 10), s(base.y - legH * 0.35));
  ctx.stroke();

  // Side face
  const sdGrad = ctx.createLinearGradient(s(dx + benchW), 0, s(dx + benchW + sideW), 0);
  sdGrad.addColorStop(0, '#585b62');
  sdGrad.addColorStop(1, '#484b52');
  ctx.fillStyle = sdGrad;
  ctx.beginPath();
  ctx.moveTo(s(dx + benchW), s(topY + 2));
  ctx.lineTo(s(dx + benchW + sideW), s(topY - 2));
  ctx.lineTo(s(dx + benchW + sideW), s(topY + 12));
  ctx.lineTo(s(dx + benchW), s(topY + 14));
  ctx.closePath();
  ctx.fill();

  // Front apron (thicker than desk)
  const apronGrad = ctx.createLinearGradient(s(dx), 0, s(dx + benchW), 0);
  apronGrad.addColorStop(0, '#585b62');
  apronGrad.addColorStop(0.15, '#686b72');
  apronGrad.addColorStop(0.5, '#727580');
  apronGrad.addColorStop(0.85, '#686b72');
  apronGrad.addColorStop(1, '#585b62');
  ctx.fillStyle = apronGrad;
  ctx.fillRect(s(dx), s(topY + 2), s(benchW), s(12));
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = s(0.8);
  ctx.beginPath();
  ctx.moveTo(s(dx), s(topY + 14));
  ctx.lineTo(s(dx + benchW), s(topY + 14));
  ctx.stroke();

  // Top surface — darker metal
  const topGrad = ctx.createLinearGradient(s(dx), 0, s(dx + benchW), 0);
  topGrad.addColorStop(0, '#5a5d64');
  topGrad.addColorStop(0.2, '#686b72');
  topGrad.addColorStop(0.5, '#6e7178');
  topGrad.addColorStop(0.8, '#686b72');
  topGrad.addColorStop(1, '#5a5d64');
  ctx.fillStyle = topGrad;
  ctx.fillRect(s(dx), s(topY - 4), s(benchW), s(6));
  // Top surface side
  ctx.fillStyle = '#646770';
  ctx.beginPath();
  ctx.moveTo(s(dx + benchW), s(topY - 4));
  ctx.lineTo(s(dx + benchW + sideW), s(topY - 6));
  ctx.lineTo(s(dx + benchW + sideW), s(topY - 2));
  ctx.lineTo(s(dx + benchW), s(topY + 2));
  ctx.closePath();
  ctx.fill();
  // Front edge highlight
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = s(0.8);
  ctx.beginPath();
  ctx.moveTo(s(dx), s(topY - 4));
  ctx.lineTo(s(dx + benchW), s(topY - 4));
  ctx.stroke();

  // Vise on left end
  const vx = dx + 12;
  const vy = topY - 8;
  ctx.fillStyle = '#4a4d55';
  ctx.fillRect(s(vx), s(vy), s(16), s(6));
  ctx.fillStyle = '#5a5d65';
  ctx.fillRect(s(vx + 2), s(vy - 4), s(5), s(4));
  ctx.fillRect(s(vx + 11), s(vy - 4), s(5), s(4));
  ctx.strokeStyle = '#3a3d44';
  ctx.lineWidth = s(0.8);
  ctx.strokeRect(s(vx), s(vy), s(16), s(6));

  // Workbench clutter around keycard area
  drawBenchClutter(dx, benchW, topY);

  // Keycard on workbench (drawn last so it's on top of clutter)
  if (!hasKeycard) {
    drawKeycard(dx + benchW * 0.55, topY - 8);
  }
}

function drawShelfBox(bx, by, bw, bh, colors) {
  const [hi, lo] = colors;
  const grad = ctx.createLinearGradient(s(bx), 0, s(bx + bw), 0);
  grad.addColorStop(0, lo);
  grad.addColorStop(0.3, hi);
  grad.addColorStop(0.7, hi);
  grad.addColorStop(1, lo);
  ctx.fillStyle = grad;
  ctx.fillRect(s(bx), s(by), s(bw), s(bh));
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = s(0.8);
  ctx.strokeRect(s(bx), s(by), s(bw), s(bh));
}

function drawShelving(box) {
  const base = floorToScreen((box.uMin + box.uMax) / 2, box.vMax);
  const bl = floorToScreen(box.uMin, box.vMax);
  const br = floorToScreen(box.uMax, box.vMax);
  const tl = floorToScreen(box.uMin, box.vMin);
  const screenW = br.x - bl.x;
  const shelfH = 110;
  const bx = base.x - screenW / 2;
  const by = base.y - shelfH;
  const sideW = 12;

  // Footprint shadow
  const footGrad = ctx.createRadialGradient(
    s(base.x), s((tl.y + base.y) / 2), 0,
    s(base.x), s((tl.y + base.y) / 2), s(Math.max(screenW, base.y - tl.y) * 0.85)
  );
  footGrad.addColorStop(0, 'rgba(0,0,0,0.20)');
  footGrad.addColorStop(0.6, 'rgba(0,0,0,0.08)');
  footGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = footGrad;
  ctx.beginPath();
  ctx.moveTo(s(tl.x - 6), s(tl.y - 3));
  ctx.lineTo(s(br.x + 6), s(tl.y - 3));
  ctx.lineTo(s(br.x + 10), s(base.y + 8));
  ctx.lineTo(s(bl.x - 8), s(base.y + 8));
  ctx.closePath();
  ctx.fill();

  // Contact shadow
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = s(1.5);
  ctx.beginPath();
  ctx.moveTo(s(bx - sideW), s(base.y));
  ctx.lineTo(s(bx + screenW + sideW), s(base.y));
  ctx.stroke();

  // Upright posts (4 vertical lines)
  const postColor = '#5a5d65';
  const postDark = '#3a3d44';
  const posts = [bx, bx + screenW / 3, bx + screenW * 2 / 3, bx + screenW];
  for (const px of posts) {
    ctx.strokeStyle = postDark;
    ctx.lineWidth = s(3);
    ctx.beginPath();
    ctx.moveTo(s(px), s(by));
    ctx.lineTo(s(px), s(base.y));
    ctx.stroke();
    ctx.strokeStyle = postColor;
    ctx.lineWidth = s(1.5);
    ctx.beginPath();
    ctx.moveTo(s(px - 0.5), s(by));
    ctx.lineTo(s(px - 0.5), s(base.y));
    ctx.stroke();
  }

  // Shelves (3 levels + top)
  const shelfLevels = [0, 0.33, 0.66, 0.95];
  for (const t of shelfLevels) {
    const sy = by + shelfH * t;
    ctx.fillStyle = '#484b52';
    ctx.fillRect(s(bx - 2), s(sy), s(screenW + 4), s(3));
    // Side depth
    ctx.fillStyle = '#3a3d44';
    ctx.beginPath();
    ctx.moveTo(s(bx + screenW), s(sy));
    ctx.lineTo(s(bx + screenW + sideW), s(sy - 4));
    ctx.lineTo(s(bx + screenW + sideW), s(sy - 1));
    ctx.lineTo(s(bx + screenW), s(sy + 3));
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = s(0.5);
    ctx.beginPath();
    ctx.moveTo(s(bx), s(sy));
    ctx.lineTo(s(bx + screenW), s(sy));
    ctx.stroke();
  }

  // Boxes on shelves
  const boxColors = [
    ['#8a5a3a', '#6a4228'],
    ['#4a6a8a', '#385878'],
    ['#8a7a3a', '#6a5a28'],
    ['#5a7a5a', '#426842'],
    ['#7a4a5a', '#623848'],
  ];
  // Shelf 1 (bottom)
  const s1y = by + shelfH * 0.66 + 4;
  const boxH1 = shelfH * 0.28;
  drawShelfBox(bx + 4, s1y, screenW / 3 - 6, boxH1, boxColors[0]);
  drawShelfBox(bx + screenW / 3 + 2, s1y, screenW / 3 - 4, boxH1, boxColors[1]);
  // Shelf 2 (middle)
  const s2y = by + shelfH * 0.33 + 4;
  const boxH2 = shelfH * 0.28;
  drawShelfBox(bx + 2, s2y, screenW / 4 - 3, boxH2, boxColors[2]);
  drawShelfBox(bx + screenW / 4 + 1, s2y, screenW / 4 - 2, boxH2, boxColors[3]);
  drawShelfBox(bx + screenW / 2 + 4, s2y, screenW / 3 - 6, boxH2, boxColors[4]);
  // Shelf 3 (top)
  const s3y = by + 4;
  const boxH3 = shelfH * 0.28;
  drawShelfBox(bx + screenW / 4, s3y, screenW / 3, boxH3, boxColors[0]);

  // Top face
  ctx.fillStyle = '#505358';
  ctx.beginPath();
  ctx.moveTo(s(bx - 2), s(by));
  ctx.lineTo(s(bx + screenW + 2), s(by));
  ctx.lineTo(s(bx + screenW + sideW), s(by - 4));
  ctx.lineTo(s(bx - sideW + 8), s(by - 4));
  ctx.closePath();
  ctx.fill();
}

function drawBarrels(box) {
  const base = floorToScreen((box.uMin + box.uMax) / 2, box.vMax);
  const bl = floorToScreen(box.uMin, box.vMax);
  const br = floorToScreen(box.uMax, box.vMax);
  const tl = floorToScreen(box.uMin, box.vMin);
  const screenW = br.x - bl.x;

  // Footprint shadow
  const footGrad = ctx.createRadialGradient(
    s(base.x), s((tl.y + base.y) / 2), 0,
    s(base.x), s((tl.y + base.y) / 2), s(Math.max(screenW, base.y - tl.y) * 0.85)
  );
  footGrad.addColorStop(0, 'rgba(0,0,0,0.22)');
  footGrad.addColorStop(0.6, 'rgba(0,0,0,0.10)');
  footGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = footGrad;
  ctx.beginPath();
  ctx.moveTo(s(tl.x - 6), s(tl.y - 3));
  ctx.lineTo(s(br.x + 6), s(tl.y - 3));
  ctx.lineTo(s(br.x + 10), s(base.y + 8));
  ctx.lineTo(s(bl.x - 8), s(base.y + 8));
  ctx.closePath();
  ctx.fill();

  // Draw 3 barrels (back two first, front one on top for overlap)
  const barrelR = screenW / 5;
  const barrelH = 70;
  const barrels = [
    { cx: base.x - barrelR * 1.3, color: '#3a5a8a', stripe: '#2a4a7a' },
    { cx: base.x + barrelR * 1.3, color: '#8a3a3a', stripe: '#7a2a2a' },
    { cx: base.x, color: '#8a7a3a', stripe: '#7a6a2a' },
  ];

  for (const barrel of barrels) {
    const bcx = barrel.cx;
    const bby = base.y - barrelH;

    // Contact shadow
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(s(bcx), s(base.y), s(barrelR + 4), s(barrelR * 0.35 + 2), 0, 0, Math.PI * 2);
    ctx.fill();

    // Barrel body
    const bodyGrad = ctx.createLinearGradient(s(bcx - barrelR), 0, s(bcx + barrelR), 0);
    bodyGrad.addColorStop(0, '#1a1a1a');
    bodyGrad.addColorStop(0.15, barrel.stripe);
    bodyGrad.addColorStop(0.45, barrel.color);
    bodyGrad.addColorStop(0.55, barrel.color);
    bodyGrad.addColorStop(0.85, barrel.stripe);
    bodyGrad.addColorStop(1, '#1a1a1a');
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.moveTo(s(bcx - barrelR), s(bby));
    ctx.lineTo(s(bcx + barrelR), s(bby));
    ctx.lineTo(s(bcx + barrelR), s(base.y));
    ctx.lineTo(s(bcx - barrelR), s(base.y));
    ctx.closePath();
    ctx.fill();

    // Metal bands
    ctx.strokeStyle = '#5a5d65';
    ctx.lineWidth = s(2);
    ctx.beginPath();
    ctx.moveTo(s(bcx - barrelR), s(bby + 5));
    ctx.lineTo(s(bcx + barrelR), s(bby + 5));
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s(bcx - barrelR), s(base.y - 5));
    ctx.lineTo(s(bcx + barrelR), s(base.y - 5));
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = s(0.5);
    ctx.beginPath();
    ctx.moveTo(s(bcx - barrelR + 2), s(bby + 4));
    ctx.lineTo(s(bcx + barrelR - 2), s(bby + 4));
    ctx.stroke();

    // Top ellipse (lid)
    const topGrad = ctx.createLinearGradient(s(bcx - barrelR), 0, s(bcx + barrelR), 0);
    topGrad.addColorStop(0, barrel.stripe);
    topGrad.addColorStop(0.3, barrel.color);
    topGrad.addColorStop(0.7, barrel.color);
    topGrad.addColorStop(1, barrel.stripe);
    ctx.fillStyle = topGrad;
    ctx.beginPath();
    ctx.ellipse(s(bcx), s(bby), s(barrelR), s(barrelR * 0.3), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#3a3d44';
    ctx.lineWidth = s(1);
    ctx.beginPath();
    ctx.ellipse(s(bcx), s(bby), s(barrelR), s(barrelR * 0.3), 0, 0, Math.PI * 2);
    ctx.stroke();

    // Cap/bung on top
    ctx.fillStyle = '#4a4d55';
    ctx.beginPath();
    ctx.ellipse(s(bcx + 3), s(bby), s(3), s(2), 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ─── Room 3: Locker ─────────────────────────────────────────────────────────

function drawLocker(box) {
  const tl = floorToScreen(box.uMin, box.vMin);
  const tr = floorToScreen(box.uMax, box.vMin);
  const bl = floorToScreen(box.uMin, box.vMax);
  const br = floorToScreen(box.uMax, box.vMax);

  const lockerW = tr.x - tl.x;
  const lockerH = (bl.y - tl.y) * 2.2;
  const dx = tl.x;
  const by = bl.y;
  const base = floorToScreen((box.uMin + box.uMax) / 2, box.vMax);

  // Ground-plane footprint shadow (matches other objects)
  const footGrad = ctx.createRadialGradient(
    s(base.x), s((tl.y + base.y) / 2), 0,
    s(base.x), s((tl.y + base.y) / 2), s(Math.max(lockerW, base.y - tl.y) * 0.85)
  );
  footGrad.addColorStop(0, 'rgba(0,0,0,0.20)');
  footGrad.addColorStop(0.6, 'rgba(0,0,0,0.08)');
  footGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = footGrad;
  ctx.beginPath();
  ctx.moveTo(s(tl.x - 4), s(tl.y - 2));
  ctx.lineTo(s(tr.x + 4), s(tr.y - 2));
  ctx.lineTo(s(br.x + 8), s(br.y + 6));
  ctx.lineTo(s(bl.x - 6), s(bl.y + 6));
  ctx.closePath();
  ctx.fill();

  // Contact shadow
  const ctsGrad = ctx.createLinearGradient(0, s(by - 2), 0, s(by + 12));
  ctsGrad.addColorStop(0, 'rgba(0,0,0,0.30)');
  ctsGrad.addColorStop(0.4, 'rgba(0,0,0,0.14)');
  ctsGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = ctsGrad;
  ctx.fillRect(s(dx - 6), s(by - 2), s(lockerW + 12), s(14));

  // Drop shadow behind locker body
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(s(dx + 4), s(by - lockerH + 4), s(lockerW), s(lockerH));

  // Main body
  const bodyGrad = ctx.createLinearGradient(s(dx), 0, s(dx + lockerW), 0);
  bodyGrad.addColorStop(0, '#4a5058');
  bodyGrad.addColorStop(0.3, '#5a6068');
  bodyGrad.addColorStop(0.7, '#555b63');
  bodyGrad.addColorStop(1, '#484e56');
  ctx.fillStyle = bodyGrad;
  ctx.fillRect(s(dx), s(by - lockerH), s(lockerW), s(lockerH));

  // Door seam (vertical center line)
  ctx.strokeStyle = '#383c44';
  ctx.lineWidth = s(1.5);
  const midX = dx + lockerW * 0.5;
  ctx.beginPath();
  ctx.moveTo(s(midX), s(by - lockerH + 4));
  ctx.lineTo(s(midX), s(by - 4));
  ctx.stroke();

  if (playerHidden && currentRoom === 3) {
    // Closed door — show vents and handle, slight glow hint
    // Top vent slits
    ctx.strokeStyle = '#2a2e36';
    ctx.lineWidth = s(1);
    for (let i = 0; i < 4; i++) {
      const vy = by - lockerH + 14 + i * 4;
      ctx.beginPath();
      ctx.moveTo(s(dx + 6), s(vy));
      ctx.lineTo(s(dx + lockerW * 0.45), s(vy));
      ctx.stroke();
    }
    // Handle
    ctx.fillStyle = '#8a8e96';
    ctx.fillRect(s(dx + lockerW * 0.40), s(by - lockerH * 0.45), s(4), s(12));
    // Subtle player silhouette hint through vents
    ctx.fillStyle = 'rgba(90,136,200,0.12)';
    for (let i = 0; i < 4; i++) {
      const vy = by - lockerH + 13 + i * 4;
      ctx.fillRect(s(dx + 7), s(vy), s(lockerW * 0.38), s(2));
    }
    // Occupied indicator — faint interior glow spill from vents
    const ventGlow = ctx.createRadialGradient(
      s(dx + lockerW * 0.25), s(by - lockerH + 20), 0,
      s(dx + lockerW * 0.25), s(by - lockerH + 20), s(18)
    );
    ventGlow.addColorStop(0, 'rgba(80,160,220,0.08)');
    ventGlow.addColorStop(1, 'rgba(80,160,220,0)');
    ctx.fillStyle = ventGlow;
    ctx.fillRect(s(dx), s(by - lockerH), s(lockerW * 0.5), s(40));
  } else {
    // Open/empty — show vents and handle
    // Top vent slits
    ctx.strokeStyle = '#2a2e36';
    ctx.lineWidth = s(1);
    for (let i = 0; i < 4; i++) {
      const vy = by - lockerH + 14 + i * 4;
      ctx.beginPath();
      ctx.moveTo(s(dx + 6), s(vy));
      ctx.lineTo(s(dx + lockerW * 0.45), s(vy));
      ctx.stroke();
    }
    // Handle — slightly brighter to draw attention as interaction target
    ctx.fillStyle = '#9a9ea8';
    ctx.fillRect(s(dx + lockerW * 0.40), s(by - lockerH * 0.45), s(4), s(12));
    // Handle highlight edge
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = s(0.6);
    ctx.beginPath();
    ctx.moveTo(s(dx + lockerW * 0.40), s(by - lockerH * 0.45));
    ctx.lineTo(s(dx + lockerW * 0.40), s(by - lockerH * 0.45 + 12));
    ctx.stroke();
    // Stencil label on lower half — "STAFF"
    ctx.fillStyle = 'rgba(200,200,180,0.10)';
    ctx.font = `bold ${s(7)}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('STAFF', s(dx + lockerW * 0.25), s(by - lockerH * 0.22));
  }

  // Top edge highlight
  ctx.strokeStyle = '#6a6e76';
  ctx.lineWidth = s(1);
  ctx.beginPath();
  ctx.moveTo(s(dx), s(by - lockerH));
  ctx.lineTo(s(dx + lockerW), s(by - lockerH));
  ctx.stroke();

  // Bottom edge shadow
  ctx.strokeStyle = '#2a2e36';
  ctx.beginPath();
  ctx.moveTo(s(dx), s(by));
  ctx.lineTo(s(dx + lockerW), s(by));
  ctx.stroke();

  // Side edge highlight (left)
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = s(0.8);
  ctx.beginPath();
  ctx.moveTo(s(dx + 1), s(by - lockerH + 2));
  ctx.lineTo(s(dx + 1), s(by - 2));
  ctx.stroke();
}

// ─── Room 3: Equipment counter (network/utility bench replacing drywall partition) ─

function drawEquipmentCounter(box) {
  const tl = floorToScreen(box.uMin, box.vMin);
  const tr = floorToScreen(box.uMax, box.vMin);
  const bl = floorToScreen(box.uMin, box.vMax);
  const br = floorToScreen(box.uMax, box.vMax);
  const base = floorToScreen((box.uMin + box.uMax) / 2, box.vMax);

  const counterW = br.x - bl.x;
  const counterD = bl.y - tl.y;
  const dx = bl.x;
  const by = bl.y;
  // Counter is waist-high — shorter than the old partition wall
  const counterH = counterD * 1.6;
  const sideW = 6;

  // Ground-plane footprint shadow
  const footGrad = ctx.createRadialGradient(
    s(base.x), s((tl.y + base.y) / 2), 0,
    s(base.x), s((tl.y + base.y) / 2), s(Math.max(counterW, counterD) * 1.1)
  );
  footGrad.addColorStop(0, 'rgba(0,0,0,0.20)');
  footGrad.addColorStop(0.5, 'rgba(0,0,0,0.07)');
  footGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = footGrad;
  ctx.beginPath();
  ctx.moveTo(s(tl.x - 4), s(tl.y - 2));
  ctx.lineTo(s(tr.x + 4), s(tr.y - 2));
  ctx.lineTo(s(br.x + 8), s(br.y + 6));
  ctx.lineTo(s(bl.x - 6), s(bl.y + 6));
  ctx.closePath();
  ctx.fill();

  // Contact shadow
  const ctsGrad = ctx.createLinearGradient(0, s(by - 2), 0, s(by + 12));
  ctsGrad.addColorStop(0, 'rgba(0,0,0,0.28)');
  ctsGrad.addColorStop(0.4, 'rgba(0,0,0,0.10)');
  ctsGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = ctsGrad;
  ctx.fillRect(s(dx - 6), s(by - 2), s(counterW + 12), s(14));

  // Drop shadow behind body
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(s(dx + 3), s(by - counterH + 3), s(counterW + 2), s(counterH));

  // ── Cabinet body (front face) — dark metal housing ──
  const bodyGrad = ctx.createLinearGradient(s(dx), s(by - counterH), s(dx), s(by));
  bodyGrad.addColorStop(0, '#3e434c');
  bodyGrad.addColorStop(0.3, '#383d46');
  bodyGrad.addColorStop(0.7, '#343940');
  bodyGrad.addColorStop(1, '#30353c');
  ctx.fillStyle = bodyGrad;
  ctx.fillRect(s(dx), s(by - counterH), s(counterW), s(counterH));

  // ── Side face (right edge, 3D depth) ──
  const sdGrad = ctx.createLinearGradient(s(dx + counterW), 0, s(dx + counterW + sideW), 0);
  sdGrad.addColorStop(0, '#2e333a');
  sdGrad.addColorStop(1, '#282d34');
  ctx.fillStyle = sdGrad;
  ctx.beginPath();
  ctx.moveTo(s(dx + counterW), s(by - counterH));
  ctx.lineTo(s(dx + counterW + sideW), s(by - counterH + 3));
  ctx.lineTo(s(dx + counterW + sideW), s(by + 3));
  ctx.lineTo(s(dx + counterW), s(by));
  ctx.closePath();
  ctx.fill();

  // ── Countertop surface ──
  const topThick = 5;
  const topGrad = ctx.createLinearGradient(0, s(by - counterH - topThick), 0, s(by - counterH));
  topGrad.addColorStop(0, '#5a5f68');
  topGrad.addColorStop(1, '#4e535c');
  ctx.fillStyle = topGrad;
  ctx.fillRect(s(dx - 2), s(by - counterH - topThick), s(counterW + 4), s(topThick));

  // Top surface (perspective top plane)
  ctx.fillStyle = '#626770';
  ctx.beginPath();
  ctx.moveTo(s(dx - 2), s(by - counterH - topThick));
  ctx.lineTo(s(dx + counterW + 2), s(by - counterH - topThick));
  ctx.lineTo(s(dx + counterW + sideW + 2), s(by - counterH - topThick + 3));
  ctx.lineTo(s(dx + sideW - 2), s(by - counterH - topThick + 3));
  ctx.closePath();
  ctx.fill();

  // Top edge highlight
  ctx.strokeStyle = '#6e737c';
  ctx.lineWidth = s(1);
  ctx.beginPath();
  ctx.moveTo(s(dx - 2), s(by - counterH - topThick));
  ctx.lineTo(s(dx + counterW + 2), s(by - counterH - topThick));
  ctx.stroke();

  // ── Rack-mount equipment panels (3 bays across the front face) ──
  const panelCount = Math.max(3, Math.floor(counterW / 50));
  const panelGap = 4;
  const panelMarginX = 6;
  const panelMarginTop = 5;
  const panelTotalW = counterW - panelMarginX * 2;
  const panelW = (panelTotalW - panelGap * (panelCount - 1)) / panelCount;
  const panelH = counterH * 0.65;
  const panelTopY = by - counterH + panelMarginTop;

  for (let i = 0; i < panelCount; i++) {
    const px = dx + panelMarginX + i * (panelW + panelGap);

    // Panel recess (darker)
    ctx.fillStyle = '#22262c';
    ctx.fillRect(s(px), s(panelTopY), s(panelW), s(panelH));

    // Panel inset border
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = s(0.5);
    ctx.strokeRect(s(px + 0.5), s(panelTopY + 0.5), s(panelW - 1), s(panelH - 1));

    // Equipment face — each panel is a different unit
    if (i === 0) {
      // Patch panel — rows of small port rectangles
      const portRows = 2;
      const portCols = Math.max(4, Math.floor(panelW / 8));
      const portW = 3, portH = 2.5;
      const portStartX = px + 3;
      const portStartY = panelTopY + 6;
      const portSpacingX = (panelW - 6) / portCols;
      const portSpacingY = panelH * 0.25;
      for (let r = 0; r < portRows; r++) {
        for (let c = 0; c < portCols; c++) {
          ctx.fillStyle = '#1a1e24';
          ctx.fillRect(s(portStartX + c * portSpacingX), s(portStartY + r * portSpacingY), s(portW), s(portH));
        }
      }
      // Label "PATCH" (tiny)
      ctx.fillStyle = 'rgba(180,185,195,0.35)';
      ctx.font = s(5) + 'px monospace';
      ctx.fillText('PATCH', s(px + 3), s(panelTopY + panelH - 4));
    } else if (i === panelCount - 1) {
      // UPS unit — large block with battery indicator
      const upsBodyY = panelTopY + 4;
      const upsBodyH = panelH - 8;
      ctx.fillStyle = '#2a2e34';
      ctx.fillRect(s(px + 3), s(upsBodyY), s(panelW - 6), s(upsBodyH));

      // Battery level bars
      const barCount = 4;
      const barW = 3, barH = 6;
      const barStartX = px + panelW / 2 - (barCount * (barW + 2)) / 2;
      const barY = upsBodyY + upsBodyH / 2 - barH / 2;
      for (let b = 0; b < barCount; b++) {
        ctx.fillStyle = b < 3 ? 'rgba(80,200,80,0.6)' : 'rgba(80,200,80,0.2)';
        ctx.fillRect(s(barStartX + b * (barW + 2)), s(barY), s(barW), s(barH));
      }
      // Label "UPS"
      ctx.fillStyle = 'rgba(180,185,195,0.35)';
      ctx.font = s(5) + 'px monospace';
      ctx.fillText('UPS', s(px + panelW / 2 - 6), s(panelTopY + panelH - 4));
    } else {
      // Switch/router unit — horizontal line slots with LED row
      const slotCount = 3;
      const slotH = 1.5;
      const slotStartY = panelTopY + 8;
      const slotSpacing = (panelH - 16) / (slotCount + 1);
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth = s(slotH);
      for (let sl = 0; sl < slotCount; sl++) {
        const sly = slotStartY + sl * slotSpacing;
        ctx.beginPath();
        ctx.moveTo(s(px + 4), s(sly));
        ctx.lineTo(s(px + panelW - 4), s(sly));
        ctx.stroke();
      }

      // LED row along top
      const ledCount = Math.max(3, Math.floor(panelW / 10));
      const ledStartX = px + 5;
      const ledSpacing = (panelW - 10) / ledCount;
      const ledY = panelTopY + 4;
      for (let l = 0; l < ledCount; l++) {
        const ledOn = (l + i) % 3 !== 0;
        ctx.fillStyle = ledOn ? 'rgba(60,200,100,0.7)' : 'rgba(200,60,40,0.4)';
        ctx.beginPath();
        ctx.arc(s(ledStartX + l * ledSpacing), s(ledY), s(1.2), 0, Math.PI * 2);
        ctx.fill();
        // LED glow
        if (ledOn) {
          ctx.fillStyle = 'rgba(60,200,100,0.15)';
          ctx.beginPath();
          ctx.arc(s(ledStartX + l * ledSpacing), s(ledY), s(3), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  // ── Cable runs below counter (visible under countertop) ──
  ctx.strokeStyle = 'rgba(40,80,180,0.3)';
  ctx.lineWidth = s(1.2);
  // Horizontal cable bundle along bottom
  const cableY = by - 4;
  ctx.beginPath();
  ctx.moveTo(s(dx + 8), s(cableY));
  ctx.lineTo(s(dx + counterW - 8), s(cableY));
  ctx.stroke();
  // Second cable (red)
  ctx.strokeStyle = 'rgba(180,50,40,0.25)';
  ctx.beginPath();
  ctx.moveTo(s(dx + 12), s(cableY + 2));
  ctx.lineTo(s(dx + counterW - 12), s(cableY + 2));
  ctx.stroke();

  // ── Bottom edge shadow ──
  ctx.strokeStyle = '#1e222a';
  ctx.lineWidth = s(1.2);
  ctx.beginPath();
  ctx.moveTo(s(dx), s(by));
  ctx.lineTo(s(dx + counterW), s(by));
  ctx.stroke();

  // Left edge highlight (where counter meets back wall)
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = s(0.8);
  ctx.beginPath();
  ctx.moveTo(s(dx + 1), s(by - counterH - topThick + 2));
  ctx.lineTo(s(dx + 1), s(by - 2));
  ctx.stroke();
}

// ─── Room 3: Utility table (small desk with keycard) ────────────────────────

function drawUtilTable(box) {
  const tl = floorToScreen(box.uMin, box.vMin);
  const tr = floorToScreen(box.uMax, box.vMin);
  const bl = floorToScreen(box.uMin, box.vMax);
  const br = floorToScreen(box.uMax, box.vMax);
  const base = floorToScreen((box.uMin + box.uMax) / 2, box.vMax);

  const tableW = tr.x - tl.x;
  const tableD = bl.y - tl.y;
  const dx = tl.x;
  const topY = tl.y;

  // Ground-plane footprint shadow
  const footGrad = ctx.createRadialGradient(
    s(base.x), s((tl.y + base.y) / 2), 0,
    s(base.x), s((tl.y + base.y) / 2), s(Math.max(tableW, base.y - tl.y) * 0.8)
  );
  footGrad.addColorStop(0, 'rgba(0,0,0,0.15)');
  footGrad.addColorStop(0.6, 'rgba(0,0,0,0.06)');
  footGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = footGrad;
  ctx.beginPath();
  ctx.moveTo(s(tl.x - 3), s(tl.y - 1));
  ctx.lineTo(s(tr.x + 3), s(tr.y - 1));
  ctx.lineTo(s(br.x + 5), s(br.y + 4));
  ctx.lineTo(s(bl.x - 4), s(bl.y + 4));
  ctx.closePath();
  ctx.fill();

  // Legs — with highlight
  const legW = 3, legH = tableD * 0.8;
  const legTops = [dx + 5, dx + tableW - 5];
  for (const lx of legTops) {
    ctx.fillStyle = '#3a3d44';
    ctx.fillRect(s(lx), s(topY + tableD * 0.2), s(legW), s(legH));
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = s(0.5);
    ctx.beginPath();
    ctx.moveTo(s(lx), s(topY + tableD * 0.2));
    ctx.lineTo(s(lx), s(topY + tableD * 0.2 + legH));
    ctx.stroke();
  }

  // Tabletop
  const topGrad = ctx.createLinearGradient(0, s(topY - 6), 0, s(topY + 2));
  topGrad.addColorStop(0, '#5a5d64');
  topGrad.addColorStop(1, '#4a4d54');
  ctx.fillStyle = topGrad;
  ctx.fillRect(s(dx - 2), s(topY - 6), s(tableW + 4), s(8));

  // Front edge
  ctx.fillStyle = '#3a3d44';
  ctx.fillRect(s(dx - 2), s(topY + 2), s(tableW + 4), s(3));

  // Top edge highlight
  ctx.strokeStyle = '#6a6d74';
  ctx.lineWidth = s(0.8);
  ctx.beginPath();
  ctx.moveTo(s(dx - 2), s(topY - 6));
  ctx.lineTo(s(dx + tableW + 2), s(topY - 6));
  ctx.stroke();

  // Keycard on table (drawn last, on top)
  if (!hasKeycard) {
    drawKeycard(dx + tableW * 0.5, topY - 8);
  }

  // Small clutter — pen and loose screw (subtle, below keycard)
  ctx.strokeStyle = 'rgba(26,42,90,0.5)';
  ctx.lineWidth = s(1);
  ctx.beginPath();
  ctx.moveTo(s(dx + tableW * 0.18), s(topY - 3));
  ctx.lineTo(s(dx + tableW * 0.32), s(topY - 6));
  ctx.stroke();
  ctx.fillStyle = 'rgba(106,109,117,0.5)';
  ctx.beginPath();
  ctx.arc(s(dx + tableW * 0.78), s(topY - 4), s(1), 0, Math.PI * 2);
  ctx.fill();
}

// ─── Room 3: Wall decor (server closet feel) ────────────────────────────────

function drawRoom3WallDecor() {
  const { ceilTL, ceilTR, floorTL, floorBL, leftWallTop } = ROOM;

  // Back wall helper
  function bw(u, v) {
    return {
      x: ceilTL.x + u * (ceilTR.x - ceilTL.x),
      y: ceilTL.y + v * (floorTL.y - ceilTL.y)
    };
  }

  // Left wall helper
  function lw(u, v) {
    return {
      x: (1 - u) * (1 - v) * ceilTL.x + u * (1 - v) * leftWallTop.x
          + (1 - u) * v * floorTL.x + u * v * floorBL.x,
      y: (1 - u) * (1 - v) * ceilTL.y + u * (1 - v) * leftWallTop.y
          + (1 - u) * v * floorTL.y + u * v * floorBL.y
    };
  }

  // Cable tray along back wall top
  const ct1 = bw(0.10, 0.08);
  const ct2 = bw(0.90, 0.08);
  ctx.strokeStyle = '#3a3d44';
  ctx.lineWidth = s(3);
  ctx.beginPath();
  ctx.moveTo(s(ct1.x), s(ct1.y));
  ctx.lineTo(s(ct2.x), s(ct2.y));
  ctx.stroke();
  // Cable tray brackets
  ctx.strokeStyle = '#4a4d55';
  ctx.lineWidth = s(1.5);
  for (let i = 0; i < 4; i++) {
    const bp = bw(0.15 + i * 0.22, 0.08);
    ctx.beginPath();
    ctx.moveTo(s(bp.x), s(bp.y));
    ctx.lineTo(s(bp.x), s(bp.y + 8));
    ctx.stroke();
  }
  // Cables draped from tray
  ctx.strokeStyle = '#2a4a6a';
  ctx.lineWidth = s(1);
  const cab1 = bw(0.25, 0.08);
  const cab1b = bw(0.28, 0.18);
  ctx.beginPath();
  ctx.moveTo(s(cab1.x), s(cab1.y));
  ctx.quadraticCurveTo(s(cab1.x + 10), s(cab1.y + 20), s(cab1b.x), s(cab1b.y));
  ctx.stroke();
  ctx.strokeStyle = '#6a2a2a';
  ctx.lineWidth = s(1);
  const cab2 = bw(0.60, 0.08);
  const cab2b = bw(0.58, 0.20);
  ctx.beginPath();
  ctx.moveTo(s(cab2.x), s(cab2.y));
  ctx.quadraticCurveTo(s(cab2.x - 5), s(cab2.y + 18), s(cab2b.x), s(cab2b.y));
  ctx.stroke();

  // Warning sign on left wall (faded)
  const ws = lw(0.45, 0.30);
  const wsW = 18, wsH = 14;
  ctx.fillStyle = '#8a7420';
  ctx.fillRect(s(ws.x - wsW / 2), s(ws.y - wsH / 2), s(wsW), s(wsH));
  ctx.strokeStyle = '#2a2a2a';
  ctx.lineWidth = s(1);
  ctx.strokeRect(s(ws.x - wsW / 2), s(ws.y - wsH / 2), s(wsW), s(wsH));
  // Lightning bolt symbol
  ctx.strokeStyle = 'rgba(26,26,26,0.6)';
  ctx.lineWidth = s(1.5);
  ctx.beginPath();
  ctx.moveTo(s(ws.x + 1), s(ws.y - 4));
  ctx.lineTo(s(ws.x - 2), s(ws.y));
  ctx.lineTo(s(ws.x + 1), s(ws.y));
  ctx.lineTo(s(ws.x - 1), s(ws.y + 4));
  ctx.stroke();

  // Small network panel on back wall (above server rack)
  const np = bw(0.52, 0.40);
  ctx.fillStyle = '#3a3d44';
  ctx.fillRect(s(np.x - 12), s(np.y - 8), s(24), s(16));
  ctx.strokeStyle = '#2a2d34';
  ctx.lineWidth = s(0.8);
  ctx.strokeRect(s(np.x - 12), s(np.y - 8), s(24), s(16));
  // Port indicators (tiny colored dots)
  const portColors = ['#20a020', '#20a020', '#a04020', '#20a020'];
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = portColors[i];
    ctx.beginPath();
    ctx.arc(s(np.x - 7 + i * 5), s(np.y - 2), s(1.5), 0, Math.PI * 2);
    ctx.fill();
  }
}

// ─── Fallen spool + noise ring (Room 2 distraction) ─────────────────────────

const SPOOL_LAND = { u: 0.68, v: 0.42 };

function drawFallenSpool() {
  if (!spoolKnocked || currentRoom !== 2) return;
  const pos = floorToScreen(SPOOL_LAND.u, SPOOL_LAND.v);
  const px = pos.x, py = pos.y;
  // Spool on its side on the floor — slightly tilted
  ctx.save();
  ctx.translate(s(px), s(py));
  ctx.rotate(0.3);
  // Body
  ctx.fillStyle = '#4a4e58';
  ctx.fillRect(s(-5), s(-3), s(10), s(4));
  // Wire — copper tone matching spool on cabinet
  ctx.strokeStyle = '#b87830';
  ctx.lineWidth = s(1.8);
  ctx.beginPath();
  ctx.moveTo(s(-3), s(-1.5));
  ctx.lineTo(s(3), s(-1.5));
  ctx.stroke();
  // Flanges
  ctx.fillStyle = '#5a5e68';
  ctx.fillRect(s(-6), s(-4), s(2), s(6));
  ctx.fillRect(s(4), s(-4), s(2), s(6));
  // Trailing wire on floor
  ctx.strokeStyle = '#b87830';
  ctx.lineWidth = s(0.8);
  ctx.beginPath();
  ctx.moveTo(s(5), s(0));
  ctx.quadraticCurveTo(s(12), s(4), s(16), s(2));
  ctx.stroke();
  ctx.restore();
}

function drawNoiseRing() {
  if (spoolNoiseTimer <= 0 || currentRoom !== 2) return;
  const pos = floorToScreen(SPOOL_LAND.u, SPOOL_LAND.v);
  const alpha = spoolNoiseTimer / 1.5; // fades over 1.5s
  const expand = (1 - alpha) * 40 + 10; // ring grows outward
  ctx.save();
  ctx.strokeStyle = `rgba(255,200,80,${alpha * 0.5})`;
  ctx.lineWidth = s(2);
  ctx.beginPath();
  ctx.ellipse(s(pos.x), s(pos.y), s(expand), s(expand * 0.4), 0, 0, Math.PI * 2);
  ctx.stroke();
  // Inner ring
  ctx.strokeStyle = `rgba(255,200,80,${alpha * 0.3})`;
  ctx.lineWidth = s(1.5);
  ctx.beginPath();
  ctx.ellipse(s(pos.x), s(pos.y), s(expand * 0.6), s(expand * 0.25), 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// ─── Guard AI ────────────────────────────────────────────────────────────────

function guardFaceToward(tu, tv) {
  const du = tu - guard.u;
  const dv = tv - guard.v;
  if (Math.abs(du) > Math.abs(dv)) {
    guard.facing = du > 0 ? 'right' : 'left';
  } else {
    guard.facing = dv > 0 ? 'down' : 'up';
  }
}

function guardMoveToward(tu, tv, spd, dt) {
  const du = tu - guard.u;
  const dv = tv - guard.v;
  const dist = Math.hypot(du, dv);
  if (dist < 0.01) return true; // arrived
  const step = spd * dt;
  const ratio = Math.min(step / dist, 1);
  guard.u += du * ratio;
  guard.v += dv * ratio;
  guard.walkPhase += dt * 8;
  guardFaceToward(tu, tv);
  return dist < 0.03;
}

function guardResumePatrol() {
  guard.state = 'patrol';
  guard.investigating = false;
  guard.investigateTarget = null;
  // Find nearest patrol waypoint
  let bestIdx = 0, bestDist = Infinity;
  for (let i = 0; i < PATROL.length; i++) {
    const d = Math.hypot(PATROL[i].u - guard.u, PATROL[i].v - guard.v);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  guard.waypointIdx = bestIdx;
  guard.waitTimer = 0.3;
}

function updateGuard(dt) {
  if (detected) return;

  // Spool noise timer (visual ring)
  if (spoolNoiseTimer > 0) spoolNoiseTimer -= dt;

  const aware = guardAwareOfPlayer();
  const midWalk = !player.currentHotspot && player.targetHotspot;

  // Notice threshold: shorter when player is mid-walk (exposed, moving)
  const NOTICE_TIME = midWalk ? 0.2 : 0.4;
  const ALERT_CATCH_TIME = 0.6;

  // ── Alert state: guard closing in — decisive, short window ──
  if (guard.state === 'alert') {
    if (aware) {
      guard.lastSeenU = player.u;
      guard.lastSeenV = player.v;
      guard.alertTimer += dt;
      if (guard.alertTimer >= ALERT_CATCH_TIME) {
        detected = true;
        return;
      }
      // Rush toward player
      guardMoveToward(player.u, player.v, guard.alertSpeed, dt);
    } else {
      // Player broke away — suspicious, but alert pressure preserved
      guard.state = 'suspicious';
      guard.suspiciousTimer = 2.5;
    }
    return;
  }

  // ── Notice state: guard has spotted player, short reaction window ──
  if (guard.state === 'notice') {
    if (aware) {
      guard.lastSeenU = player.u;
      guard.lastSeenV = player.v;
      guard.noticeTimer += dt;
      guardFaceToward(player.u, player.v);
      // Notice complete → escalate to alert immediately
      if (guard.noticeTimer >= NOTICE_TIME) {
        guard.state = 'alert';
        return;
      }
    } else {
      // Player got away during notice — brief suspicious
      guard.state = 'suspicious';
      guard.suspiciousTimer = 1.5;
    }
    return;
  }

  // ── Suspicious state: guard walks to last-seen, looks around ──
  if (guard.state === 'suspicious') {
    // Alert pressure decays
    if (guard.alertTimer > 0) {
      guard.alertTimer = Math.max(0, guard.alertTimer - 0.5 * dt);
    }
    if (aware) {
      // Re-spotted — straight to alert (guard is already on edge)
      guard.state = 'alert';
      guard.lastSeenU = player.u;
      guard.lastSeenV = player.v;
      return;
    }
    const arrived = guardMoveToward(guard.lastSeenU, guard.lastSeenV, guard.speed, dt);
    if (arrived) {
      guard.suspiciousTimer -= dt;
      guard.walkPhase = 0;
      // Look around — cycle facing
      const lookPhase = Math.floor((2.5 - guard.suspiciousTimer) * 2.0) % 4;
      const lookDirs = ['down', 'left', 'up', 'right'];
      guard.facing = lookDirs[lookPhase];
      if (guard.suspiciousTimer <= 0) {
        guard.noticeTimer = 0;
        guard.alertTimer = 0;
        guardResumePatrol();
      }
    }
    return;
  }

  // ── Patrol state: normal waypoint following ──

  if (aware) {
    guard.state = 'notice';
    guard.noticeTimer = 0;
    guard.lastSeenU = player.u;
    guard.lastSeenV = player.v;
    guard.investigating = false;
    guard.investigateTarget = null;
    return;
  }

  // Investigation behavior — walk to noise, look around, then resume patrol
  if (guard.investigating) {
    if (guard.investigateWaitTimer > 0) {
      guard.investigateWaitTimer -= dt;
      guard.walkPhase = 0;
      if (guard.investigateWaitTimer <= 0) {
        guardResumePatrol();
      }
      return;
    }

    const tgt = guard.investigateTarget;
    if (guardMoveToward(tgt.u, tgt.v, guard.speed, dt)) {
      guard.investigateWaitTimer = 2.0;
      guard.facing = 'down';
    }
    return;
  }

  if (guard.waitTimer > 0) {
    guard.waitTimer -= dt;
    guard.walkPhase = 0;
    return;
  }

  const target = PATROL[guard.waypointIdx];
  const du = target.u - guard.u;
  const dv = target.v - guard.v;
  const dist = Math.hypot(du, dv);

  if (dist < 0.02) {
    guard.waypointIdx = (guard.waypointIdx + 1) % PATROL.length;
    guard.waitTimer = 0.8;
    const next = PATROL[guard.waypointIdx];
    guardFaceToward(next.u, next.v);
    return;
  }

  const step = guard.speed * dt;
  const ratio = Math.min(step / dist, 1);
  guard.u += du * ratio;
  guard.v += dv * ratio;
  guard.walkPhase += dt * 8;
  guardFaceToward(target.u, target.v);
}

// ─── Guard awareness circle visual ──────────────────────────────────────────

function drawGuardVision() {
  const gScreen = floorToScreen(guard.u, guard.v);

  // State-based ring color and radius
  let ringColor, ringAlpha, showRadius;
  if (detected) {
    ringColor = '#e04040';
    ringAlpha = 0.25;
    showRadius = AWARENESS_RADIUS;
  } else if (guard.state === 'alert') {
    const pulse = 0.5 + 0.5 * Math.sin(gameTime * 10);
    ringColor = '#e03020';
    ringAlpha = 0.18 + 0.12 * pulse;
    showRadius = AWARENESS_RADIUS;
  } else if (guard.state === 'notice') {
    const pulse = 0.5 + 0.5 * Math.sin(gameTime * 8);
    ringColor = '#e0a020';
    ringAlpha = 0.14 + 0.06 * pulse;
    showRadius = AWARENESS_RADIUS;
  } else if (guard.state === 'suspicious') {
    const fade = guard.suspiciousTimer / 2.5;
    ringColor = '#e0a040';
    ringAlpha = 0.08 * fade;
    showRadius = AWARENESS_RADIUS;
  } else {
    // Patrol: subtle awareness zone hint
    ringColor = '#c0c060';
    ringAlpha = 0.06;
    showRadius = AWARENESS_RADIUS;
  }

  // Draw awareness as a perspective-correct ellipse on the floor
  // Sample points around the circle in UV space, project to screen
  ctx.save();
  ctx.globalAlpha = ringAlpha;

  // Filled area
  ctx.fillStyle = ringColor;
  ctx.beginPath();
  const circleSteps = 24;
  for (let i = 0; i <= circleSteps; i++) {
    const a = (Math.PI * 2 * i) / circleSteps;
    const pu = Math.max(0, Math.min(1, guard.u + Math.cos(a) * showRadius));
    const pv = Math.max(0, Math.min(1, guard.v + Math.sin(a) * showRadius));
    const ps = floorToScreen(pu, pv);
    if (i === 0) ctx.moveTo(s(ps.x), s(ps.y));
    else ctx.lineTo(s(ps.x), s(ps.y));
  }
  ctx.closePath();
  ctx.fill();

  // Edge ring (slightly brighter)
  ctx.globalAlpha = ringAlpha * 1.5;
  ctx.strokeStyle = ringColor;
  ctx.lineWidth = s(1.5);
  ctx.stroke();

  ctx.restore();
}

// ─── Guard awareness indicator (! icon + pressure bar) ──────────────────────

function drawGuardIndicator() {
  if (detected || guard.state === 'patrol') return;

  const gs = floorToScreen(guard.u, guard.v);
  const depthScale = 0.5 + 0.5 * guard.v;
  const iconY = gs.y - 95 * depthScale;

  if (guard.state === 'notice') {
    // Quick "!" flash — short notice window
    const t = Math.min(guard.noticeTimer / 0.4, 1);
    const bob = Math.sin(gameTime * 12) * 2;
    ctx.save();
    const px = s(gs.x);
    const py = s(iconY + bob);
    // Yellow-orange circle, rapidly appearing
    ctx.fillStyle = `rgba(220,160,20,${0.5 + 0.4 * t})`;
    ctx.beginPath();
    ctx.arc(px, py, s(10 + 4 * t), 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${s(18)}px monospace`;
    ctx.fillStyle = '#fff';
    ctx.fillText('!', px, py);
    ctx.restore();
  } else if (guard.state === 'alert') {
    // Urgent "!!" — catch is imminent
    const t = Math.min(guard.alertTimer / 0.6, 1);
    const bob = Math.sin(gameTime * 16) * 1;
    ctx.save();
    const px = s(gs.x);
    const py = s(iconY + bob);
    // Red circle, pulsing urgently
    const pulse = 0.5 + 0.5 * Math.sin(gameTime * 14);
    ctx.fillStyle = `rgba(220,30,20,${0.7 + 0.25 * pulse})`;
    ctx.beginPath();
    ctx.arc(px, py, s(12 + 4 * t), 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${s(20 + 2 * t)}px monospace`;
    ctx.fillStyle = '#fff';
    ctx.fillText('!!', px, py);
    ctx.restore();
  } else if (guard.state === 'suspicious') {
    // Fading "?" — searching
    const fade = Math.min(guard.suspiciousTimer / 2.5, 1);
    const bob = Math.sin(gameTime * 4) * 2;
    ctx.save();
    const px = s(gs.x);
    const py = s(iconY + bob);
    ctx.globalAlpha = 0.4 + 0.4 * fade;
    ctx.fillStyle = 'rgba(180,120,20,0.6)';
    ctx.beginPath();
    ctx.arc(px, py, s(9), 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${s(14)}px monospace`;
    ctx.fillStyle = '#fff';
    ctx.fillText('?', px, py);
    ctx.restore();
  }
}

// ─── Reset helper ────────────────────────────────────────────────────────────

function resetCurrentRoom() {
  detected = false;
  hasKeycard = false;
  playerHidden = false;
  const cfg = ROOM_CONFIGS[currentRoom] || ROOM_CONFIGS[1];
  const startHS = getHotspot(cfg.startHotspot);
  player.u = startHS ? startHS.u : 0.50;
  player.v = startHS ? startHS.v : 0.85;
  player.facing = 'up';
  player.walkPhase = 0;
  player.currentHotspot = cfg.startHotspot;
  player.targetHotspot = null;
  player.walkProgress = 0;
  player.walkPath = [];
  player.walkPathIndex = 0;
  player.queuedDestination = null;
  guard.u = PATROL[0].u;
  guard.v = PATROL[0].v;
  guard.waypointIdx = 0;
  guard.waitTimer = 1.0;
  guard.facing = 'down';
  guard.walkPhase = 0;
  guard.investigating = false;
  guard.investigateTarget = null;
  guard.investigateWaitTimer = 0;
  guard.state = 'patrol';
  guard.noticeTimer = 0;
  guard.alertTimer = 0;
  guard.suspiciousTimer = 0;
  guard.lastSeenU = 0;
  guard.lastSeenV = 0;
  spoolKnocked = false;
  spoolNoiseTimer = 0;
}

const ROOM_CONFIGS = {
  1: { colliders: ROOM1_COLLIDERS, patrol: ROOM1_PATROL, zones: ROOM1_ZONES, hotspots: ROOM1_HOTSPOTS, startHotspot: 'r1_start' },
  2: { colliders: ROOM2_COLLIDERS, patrol: ROOM2_PATROL, zones: ROOM2_ZONES, hotspots: ROOM2_HOTSPOTS, startHotspot: 'r2_frontStart' },
  3: { colliders: ROOM3_COLLIDERS, patrol: ROOM3_PATROL, zones: ROOM3_ZONES, hotspots: ROOM3_HOTSPOTS, startHotspot: 'r3_start' },
};

function switchToRoom(n) {
  currentRoom = n;
  detected = false;
  hasKeycard = false;
  playerHidden = false;
  const cfg = ROOM_CONFIGS[n] || ROOM_CONFIGS[1];
  COLLIDERS = cfg.colliders;
  PATROL = cfg.patrol;
  ZONES = cfg.zones;
  HOTSPOTS = cfg.hotspots;
  const startHS = getHotspot(cfg.startHotspot);
  player.u = startHS ? startHS.u : 0.50;
  player.v = startHS ? startHS.v : 0.85;
  player.facing = 'up';
  player.walkPhase = 0;
  player.currentHotspot = cfg.startHotspot;
  player.targetHotspot = null;
  player.walkProgress = 0;
  player.walkPath = [];
  player.walkPathIndex = 0;
  player.queuedDestination = null;
  guard.u = PATROL[0].u;
  guard.v = PATROL[0].v;
  guard.waypointIdx = 0;
  guard.waitTimer = 1.0;
  guard.facing = 'down';
  guard.walkPhase = 0;
  guard.investigating = false;
  guard.investigateTarget = null;
  guard.investigateWaitTimer = 0;
  guard.state = 'patrol';
  guard.noticeTimer = 0;
  guard.alertTimer = 0;
  guard.suspiciousTimer = 0;
  guard.lastSeenU = 0;
  guard.lastSeenV = 0;
  spoolKnocked = false;
  spoolNoiseTimer = 0;
  roomTransitionTimer = 2.0;
}

function resetGame() {
  won = false;
  roomTransitionTimer = 0;
  currentRoom = 1;
  COLLIDERS = ROOM1_COLLIDERS;
  PATROL = ROOM1_PATROL;
  ZONES = ROOM1_ZONES;
  HOTSPOTS = ROOM1_HOTSPOTS;
  detected = false;
  hasKeycard = false;
  playerHidden = false;
  player.u = 0.15;
  player.v = 0.85;
  player.facing = 'up';
  player.walkPhase = 0;
  player.currentHotspot = 'r1_start';
  player.targetHotspot = null;
  player.walkProgress = 0;
  guard.u = PATROL[0].u;
  guard.v = PATROL[0].v;
  guard.waypointIdx = 0;
  guard.waitTimer = 1.0;
  guard.facing = 'down';
  guard.walkPhase = 0;
  guard.investigating = false;
  guard.investigateTarget = null;
  guard.investigateWaitTimer = 0;
  guard.state = 'patrol';
  guard.noticeTimer = 0;
  guard.alertTimer = 0;
  guard.suspiciousTimer = 0;
  guard.lastSeenU = 0;
  guard.lastSeenV = 0;
  spoolKnocked = false;
  spoolNoiseTimer = 0;
}

// ─── Character draw ──────────────────────────────────────────────────────────

function drawCharacter(pos, facing, type, walkPhase) {
  const cx = s(pos.x);
  const sc = scale;
  const c = sc * 1.0;

  // Walk cycle values
  const wp = walkPhase || 0;
  const walking = wp > 0;
  const legSwing = walking ? Math.sin(wp) * 6 : 0;           // leg offset in px-units
  const armSwing = walking ? Math.sin(wp + Math.PI) * 4 : 0; // counter to legs
  const bodyBob  = walking ? Math.abs(Math.sin(wp * 2)) * 1.5 : 0; // subtle up-down

  const cy = s(pos.y) - bodyBob * sc;

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

  // Ground shadow — outer soft spread
  ctx.save();
  const shGrad = ctx.createRadialGradient(cx, cy + sc * 2, 0, cx, cy + sc * 2, sc * 14);
  shGrad.addColorStop(0, 'rgba(0,0,0,0.35)');
  shGrad.addColorStop(0.5, 'rgba(0,0,0,0.18)');
  shGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = shGrad;
  ctx.beginPath();
  ctx.ellipse(cx, cy + sc * 2, sc * 14, sc * 6, 0, 0, Math.PI * 2);
  ctx.fill();
  // Contact ring — tight dark core at feet
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + sc * 2, sc * 7, sc * 3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // --- Legs (longer for adult proportion) ---
  const legW = 7, legH = 30, legGap = 1;
  const lLegOff = legSwing * c;   // left leg vertical offset
  const rLegOff = -legSwing * c;  // right leg opposite
  // Left leg
  const llGrad = ctx.createLinearGradient(cx - (legGap + legW) * c, 0, cx - legGap * c, 0);
  llGrad.addColorStop(0, legLo);
  llGrad.addColorStop(0.5, legHi);
  llGrad.addColorStop(1, legLo);
  ctx.fillStyle = llGrad;
  ctx.beginPath();
  ctx.roundRect(cx - (legGap + legW) * c, cy - legH * c + lLegOff, legW * c, legH * c, 2 * c);
  ctx.fill();
  // Right leg
  const rlGrad = ctx.createLinearGradient(cx + legGap * c, 0, cx + (legGap + legW) * c, 0);
  rlGrad.addColorStop(0, legLo);
  rlGrad.addColorStop(0.5, legHi);
  rlGrad.addColorStop(1, legLo);
  ctx.fillStyle = rlGrad;
  ctx.beginPath();
  ctx.roundRect(cx + legGap * c, cy - legH * c + rLegOff, legW * c, legH * c, 2 * c);
  ctx.fill();

  // Shoes
  ctx.fillStyle = '#1a1a1a';
  ctx.beginPath();
  ctx.ellipse(cx - (legGap + legW / 2) * c, cy - 1 * c + lLegOff, 6 * c, 3 * c, -0.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx + (legGap + legW / 2) * c, cy - 1 * c + rLegOff, 6 * c, 3 * c, 0.15, 0, Math.PI * 2);
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
  const lArmOff = armSwing * c;   // left arm vertical offset (counter to legs)
  const rArmOff = -armSwing * c;  // right arm opposite
  // Left arm
  const laGrad = ctx.createLinearGradient(cx - (torsoW / 2 + armW) * c, 0, cx - torsoW / 2 * c, 0);
  laGrad.addColorStop(0, armLo);
  laGrad.addColorStop(0.6, armHi);
  laGrad.addColorStop(1, armLo);
  ctx.fillStyle = laGrad;
  ctx.beginPath();
  ctx.roundRect(cx - (torsoW / 2 + armW) * c, cy - armTop * c + lArmOff, armW * c, armH * c, 3 * c);
  ctx.fill();
  // Right arm
  const raGrad = ctx.createLinearGradient(cx + torsoW / 2 * c, 0, cx + (torsoW / 2 + armW) * c, 0);
  raGrad.addColorStop(0, armLo);
  raGrad.addColorStop(0.4, armHi);
  raGrad.addColorStop(1, armLo);
  ctx.fillStyle = raGrad;
  ctx.beginPath();
  ctx.roundRect(cx + torsoW / 2 * c, cy - armTop * c + rArmOff, armW * c, armH * c, 3 * c);
  ctx.fill();

  // Hands
  const handY = cy - (armTop - armH) * c;
  ctx.fillStyle = skinLo;
  ctx.beginPath();
  ctx.arc(cx - (torsoW / 2 + armW / 2) * c, handY + lArmOff, 3.5 * c, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + (torsoW / 2 + armW / 2) * c, handY + rArmOff, 3.5 * c, 0, Math.PI * 2);
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

  // Clear edge-triggered keys at start of each frame
  // (processed once per frame, then cleared so they don't persist across early returns)
  const framePressed = {};
  for (const k in justPressed) { framePressed[k] = true; delete justPressed[k]; }

  if (roomTransitionTimer > 0) roomTransitionTimer -= dt;

  // Reset on R
  if (keys['r'] || keys['R']) {
    if (detected) {
      resetCurrentRoom();
      keys['r'] = false;
      keys['R'] = false;
      return;
    }
    if (won) {
      resetGame();
      keys['r'] = false;
      keys['R'] = false;
      return;
    }
  }

  if (detected || won) return;

  // Locker hide toggle — Room 3 only, not during detection
  if (currentRoom === 3 && !detected && (keys['e'] || keys['E'] || keys[' '])) {
    if (playerHidden) {
      // Exit locker — return to nearLocker hotspot
      playerHidden = false;
      const hs = getHotspot('r3_nearLocker');
      if (hs) {
        player.u = hs.u;
        player.v = hs.v;
        player.currentHotspot = 'r3_nearLocker';
        player.targetHotspot = null;
        player.walkPath = [];
        player.walkPathIndex = 0;
        player.queuedDestination = null;
      }
      player.facing = 'down';
      keys['e'] = false; keys['E'] = false; keys[' '] = false;
    } else if (player.currentHotspot === 'r3_nearLocker') {
      // At locker hotspot — hide
      playerHidden = true;
      player.walkPhase = 0;
      keys['e'] = false; keys['E'] = false; keys[' '] = false;
    }
  }

  // While hidden, skip movement and other interactions
  // Guard still patrols; playerHidden blocks LOS in guardCanSeePlayer
  if (playerHidden) {
    updateGuard(dt);
    return;
  }

  // ── Destination-based movement: click/tap to choose destination, auto-walk along path ──

  // Auto-walk along multi-waypoint path
  if (player.targetHotspot) {
    const tgt = getHotspot(player.targetHotspot);
    if (tgt) {
      const walkDist = Math.hypot(tgt.u - player.walkFromU, tgt.v - player.walkFromV);
      const progressPerSec = walkDist > 0 ? player.speed / walkDist : 10;
      player.walkProgress = Math.min(1, player.walkProgress + progressPerSec * dt);

      player.u = player.walkFromU + (tgt.u - player.walkFromU) * player.walkProgress;
      player.v = player.walkFromV + (tgt.v - player.walkFromV) * player.walkProgress;

      // Walk animation
      player.walkPhase += dt * 10;

      // Arrived at current waypoint
      if (player.walkProgress >= 1) {
        player.u = tgt.u;
        player.v = tgt.v;
        player.currentHotspot = player.targetHotspot;
        player.targetHotspot = null;
        player.walkProgress = 0;

        // Check for queued destination first (overrides remaining path)
        if (player.queuedDestination) {
          const queued = player.queuedDestination;
          player.queuedDestination = null;
          startWalkToDestination(queued);
        }
        // Otherwise continue along path to next waypoint
        else if (player.walkPath.length > 0 && player.walkPathIndex < player.walkPath.length - 1) {
          player.walkPathIndex++;
          const nextId = player.walkPath[player.walkPathIndex];
          const next = getHotspot(nextId);
          if (next) {
            player.targetHotspot = nextId;
            player.walkFromU = tgt.u;
            player.walkFromV = tgt.v;
            player.walkProgress = 0;
            player.currentHotspot = null;
            // Face toward next waypoint
            if (Math.abs(next.u - tgt.u) > Math.abs(next.v - tgt.v)) {
              player.facing = next.u > tgt.u ? 'right' : 'left';
            } else {
              player.facing = next.v > tgt.v ? 'down' : 'up';
            }
          } else {
            // Invalid next waypoint — stop here
            player.walkPath = [];
            player.walkPathIndex = 0;
            player.walkPhase = 0;
          }
        } else {
          // Path complete — stop
          player.walkPath = [];
          player.walkPathIndex = 0;
          player.walkPhase = 0;
        }
      }
    }
  } else if (player.currentHotspot) {
    // Idle at hotspot
    player.walkPhase = 0;
  }

  // Keycard pickup — press E or Space at keycard hotspot
  if (!hasKeycard && player.currentHotspot && (keys['e'] || keys['E'] || keys[' '])) {
    const keycardHotspots = {
      1: 'r1_frontDesk',
      2: 'r2_frontBench',
      3: 'r3_frontTable',
    };
    if (player.currentHotspot === keycardHotspots[currentRoom]) {
      hasKeycard = true;
      keys['e'] = false; keys['E'] = false; keys[' '] = false;
    }
  }

  // Spool knock interaction — Room 2 only, one-shot, not during detection
  if (currentRoom === 2 && !spoolKnocked && !detected &&
      player.currentHotspot === 'r2_frontSpool' &&
      (keys['e'] || keys['E'] || keys[' '])) {
    spoolKnocked = true;
    spoolNoiseTimer = 1.5;
    // Send guard to investigate — noise overrides alert/notice/suspicious
    guard.state = 'patrol';
    guard.noticeTimer = 0;
    guard.alertTimer = 0;
    guard.suspiciousTimer = 0;
    guard.investigating = true;
    guard.investigateTarget = { u: SPOOL_LAND.u, v: SPOOL_LAND.v };
    guard.investigateWaitTimer = 0;
    guard.waitTimer = 0;
    keys['e'] = false; keys['E'] = false; keys[' '] = false;
  }

  // Exit interaction — press E or Space at exit hotspot
  if (hasKeycard && player.currentHotspot && (keys['e'] || keys['E'] || keys[' '])) {
    const exitHotspots = {
      1: 'r1_exitDoor',
      2: 'r2_exitArea',
      3: 'r3_exitDoor',
    };
    if (player.currentHotspot === exitHotspots[currentRoom]) {
      keys['e'] = false; keys['E'] = false; keys[' '] = false;
      if (currentRoom === 1) {
        switchToRoom(2);
        return;
      } else if (currentRoom === 2) {
        switchToRoom(3);
        return;
      } else if (currentRoom === 3) {
        won = true;
      }
    }
  }

  // Guard AI (includes state machine: patrol → alert → suspicious → patrol, or caught)
  updateGuard(dt);
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

  if (currentRoom === 1) {
    sortable.push({ v: COLLIDERS[2].vMax, draw: drawDesk });
    sortable.push({ v: COLLIDERS[1].vMax, draw: () => drawServerRack(COLLIDERS[1]) });
    sortable.push({ v: COLLIDERS[0].vMax, draw: () => drawServerRack(COLLIDERS[0]) });
    sortable.push({ v: COLLIDERS[3].vMax, draw: () => drawCrates(COLLIDERS[3]) });
    // Decorative floor props (no colliders)
    sortable.push({ v: 0.36, draw: drawTrashBin });
    sortable.push({ v: 0.48, draw: drawFireExtinguisher });
  } else if (currentRoom === 2) {
    sortable.push({ v: COLLIDERS[0].vMax, draw: () => drawPartition(COLLIDERS[0]) });
    sortable.push({ v: COLLIDERS[1].vMax, draw: () => drawWorkbench(COLLIDERS[1]) });
    sortable.push({ v: COLLIDERS[2].vMax, draw: () => drawBarrels(COLLIDERS[2]) });
    sortable.push({ v: COLLIDERS[3].vMax, draw: () => drawToolCabinet(COLLIDERS[3]) });
    sortable.push({ v: COLLIDERS[4].vMax, draw: () => drawShelving(COLLIDERS[4]) });
    sortable.push({ v: COLLIDERS[5].vMax, draw: () => drawCrates(COLLIDERS[5]) });
    // Decorative floor props (no colliders)
    sortable.push({ v: 0.62, draw: drawMopBucket });
    // Fallen spool on floor (only when knocked)
    if (spoolKnocked) {
      sortable.push({ v: SPOOL_LAND.v, draw: drawFallenSpool });
    }
  } else if (currentRoom === 3) {
    sortable.push({ v: COLLIDERS[0].vMax, draw: () => drawEquipmentCounter(COLLIDERS[0]) });
    sortable.push({ v: COLLIDERS[1].vMax, draw: () => drawUtilTable(COLLIDERS[1]) });
    sortable.push({ v: COLLIDERS[2].vMax, draw: () => drawServerRack(COLLIDERS[2]) });
    sortable.push({ v: COLLIDERS[3].vMax, draw: () => drawLocker(COLLIDERS[3]) });
    sortable.push({ v: COLLIDERS[4].vMax, draw: () => drawCrates(COLLIDERS[4]) });
  }

  // Player (hidden when inside locker)
  if (!playerHidden) {
    sortable.push({
      v: player.v,
      draw: () => {
        const ps = floorToScreen(player.u, player.v);
        drawCharacter(ps, player.facing, 'player', player.walkPhase);
      }
    });
  }

  // Guard
  sortable.push({
    v: guard.v,
    draw: () => {
      const gs = floorToScreen(guard.u, guard.v);
      drawCharacter(gs, guard.facing, 'guard', guard.walkPhase);
    }
  });

  sortable.sort((a, b) => a.v - b.v);
  sortable.forEach(spr => spr.draw());

  // Guard awareness indicator (over sprites)
  drawGuardIndicator();

  // Noise ring effect (over everything, floor-level)
  drawNoiseRing();

  // Hidden-in-locker indicator
  if (playerHidden && currentRoom === 3 && !detected && !won) {
    ctx.textAlign = 'center';
    ctx.font = `bold ${s(14)}px monospace`;
    const htxt = '[E] Exit locker';
    const hw = ctx.measureText(htxt).width;
    const locker = COLLIDERS[3];
    const lpos = floorToScreen((locker.uMin + locker.uMax) / 2, locker.vMax + 0.02);
    const bob = Math.sin(gameTime * 3) * 2;
    const hy = s(lpos.y - 15 + bob);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.roundRect(s(lpos.x) - hw / 2 - s(8), hy - s(12), hw + s(16), s(20), s(6));
    ctx.fill();
    ctx.fillStyle = '#80e0ff';
    ctx.fillText(htxt, s(lpos.x), hy);
  }

  // Hotspot-based interaction prompts
  if (!detected && !won && !playerHidden && player.currentHotspot) {
    const keycardHotspots = { 1: 'r1_frontDesk', 2: 'r2_frontBench', 3: 'r3_frontTable' };
    const exitHotspots = { 1: 'r1_exitDoor', 2: 'r2_exitArea', 3: 'r3_exitDoor' };
    const hs = player.currentHotspot;

    function drawPrompt(text, color, promptU, promptV) {
      const promptPos = floorToScreen(promptU, promptV);
      const bob = Math.sin(gameTime * 4) * 3;
      const py = s(promptPos.y - 18 + bob);
      ctx.textAlign = 'center';
      ctx.font = `bold ${s(15)}px monospace`;
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.roundRect(s(promptPos.x) - tw / 2 - s(8), py - s(12), tw + s(16), s(20), s(6));
      ctx.fill();
      ctx.fillStyle = color;
      ctx.fillText(text, s(promptPos.x), py);
    }

    // Keycard prompt
    if (!hasKeycard && hs === keycardHotspots[currentRoom]) {
      drawPrompt('[E] Pick up keycard', '#80e0ff', player.u, player.v - 0.06);
    }

    // Exit prompt
    if (hasKeycard && hs === exitHotspots[currentRoom]) {
      drawPrompt('[E] Use exit', '#60ff60', player.u, player.v - 0.06);
    }

    // Spool knock prompt (Room 2)
    if (currentRoom === 2 && !spoolKnocked && hs === 'r2_frontSpool') {
      drawPrompt('[E] Knock spool', '#ffc040', player.u, player.v - 0.06);
    }

    // Locker hide prompt (Room 3)
    if (currentRoom === 3 && !playerHidden && hs === 'r3_nearLocker') {
      drawPrompt('[E] Hide in locker', '#ffc040', player.u, player.v - 0.06);
    }
  }

  // Objective status (bottom-left)
  if (!detected && !won) {
    ctx.textAlign = 'left';
    ctx.font = `${s(13)}px monospace`;
    if (!hasKeycard) {
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillText('Find the keycard', s(31), s(691));
      ctx.fillStyle = 'rgba(80,200,255,0.6)';
      ctx.fillText('Find the keycard', s(30), s(690));
    } else {
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillText('Reach the exit', s(31), s(691));
      ctx.fillStyle = 'rgba(64,224,64,0.7)';
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

  // Room transition label
  if (roomTransitionTimer > 0 && !detected && !won) {
    const roomNames = { 2: 'ROOM 2', 3: 'ROOM 3' };
    const roomSubs = { 2: 'Maintenance Workshop', 3: 'Server Closet' };
    const rName = roomNames[currentRoom] || ('ROOM ' + currentRoom);
    const rSub = roomSubs[currentRoom] || '';
    const alpha = Math.min(roomTransitionTimer / 0.5, 1) * 0.9;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center';
    ctx.font = `bold ${s(28)}px monospace`;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillText(rName, s(641), s(61));
    ctx.fillStyle = '#c0c0c0';
    ctx.fillText(rName, s(640), s(60));
    if (rSub) {
      ctx.font = `${s(13)}px monospace`;
      ctx.fillStyle = '#808080';
      ctx.fillText(rSub, s(640), s(82));
    }
    ctx.restore();
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
