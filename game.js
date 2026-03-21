'use strict';

// ─── Canvas setup ────────────────────────────────────────────────────────────
const canvas = document.getElementById('gameCanvas');
const uiCanvas = document.getElementById('uiCanvas');
const ctx = uiCanvas.getContext('2d');

let W, H, scale;

// ─── Global error display ─────────────────────────────────────────────────────
window.onerror = function(msg, url, line, col, error) {
  const c = document.getElementById('uiCanvas');
  if (c) {
    const cx = c.getContext('2d');
    cx.fillStyle = '#000';
    cx.fillRect(0, 0, c.width, c.height);
    cx.fillStyle = '#ff4040';
    cx.font = '20px monospace';
    cx.fillText('ERROR: ' + msg, 20, 40);
    cx.fillStyle = '#aaa';
    cx.font = '14px monospace';
    cx.fillText('Line: ' + line + ', Col: ' + col, 20, 70);
    if (error && error.stack) {
      const stackLines = error.stack.split('\n').slice(0, 5);
      stackLines.forEach((sl, i) => cx.fillText(sl.trim(), 20, 100 + i * 20));
    }
  }
};

// ─── Three.js globals ────────────────────────────────────────────────────────
let scene3D, camera3D, renderer3D;
let playerModel, guardModel;
let currentRoomMeshes = [];
const WORLD_W = 20, WORLD_D = 15, WORLD_H = 6;
const WALL_H = 3; // Cutaway wall height for diorama presentation

function resize() {
  W = window.innerWidth;
  H = window.innerHeight;
  uiCanvas.width = W;
  uiCanvas.height = H;
  scale = Math.min(W / 1280, H / 720);
  if (renderer3D) {
    renderer3D.setSize(W, H);
    camera3D.aspect = W / H;
    camera3D.updateProjectionMatrix();
  }
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
// Maps UV floor coordinates (0-1) to 3D world position
function uvToWorld(u, v) {
  return new THREE.Vector3((u - 0.5) * WORLD_W, 0, (v - 0.5) * WORLD_D);
}

// Projects UV floor coordinates to 2D screen space via Three.js camera
let _projVec = null;
function floorToScreen(u, v) {
  if (!camera3D) {
    // Fallback before Three.js init (uses old bilinear interpolation)
    const { floorTL, floorTR, floorBL, floorBR } = ROOM;
    return {
      x: (1-u)*(1-v)*floorTL.x + u*(1-v)*floorTR.x + (1-u)*v*floorBL.x + u*v*floorBR.x,
      y: (1-u)*(1-v)*floorTL.y + u*(1-v)*floorTR.y + (1-u)*v*floorBL.y + u*v*floorBR.y,
    };
  }
  if (!_projVec) _projVec = new THREE.Vector3();
  _projVec.set((u - 0.5) * WORLD_W, 0, (v - 0.5) * WORLD_D);
  _projVec.project(camera3D);
  // Map NDC to screen pixels, then to design-space (accounting for letterbox offset)
  const screenX = (_projVec.x * 0.5 + 0.5) * W;
  const screenY = (-_projVec.y * 0.5 + 0.5) * H;
  const translateX = (W - 1280 * scale) / 2;
  const translateY = (H - 720 * scale) / 2;
  return {
    x: (screenX - translateX) / scale,
    y: (screenY - translateY) / scale,
  };
}

// ─── Three.js Initialization ─────────────────────────────────────────────────

function createFloorTexture(palIdx) {
  const tc = document.createElement('canvas');
  tc.width = 1024; tc.height = 1024;
  const t = tc.getContext('2d');
  // Base floor color — Room 1 is clean tech facility, bright polished floor
  const bases = { 1: [180,185,195], 2: [52,46,40], 3: [38,48,60] };
  const b = bases[palIdx] || bases[1];
  t.fillStyle = `rgb(${b[0]},${b[1]},${b[2]})`;
  t.fillRect(0, 0, 1024, 1024);
  // Noise/grain for concrete texture
  for (let i = 0; i < 8000; i++) {
    const nx = Math.random() * 1024, ny = Math.random() * 1024;
    const v = Math.random() * 30 - 15;
    t.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v) / 255})`;
    t.fillRect(nx, ny, 1 + Math.random() * 3, 1 + Math.random() * 3);
  }
  // Tile grid — lighter for Room 1's bright floor
  const tileSize = 1024 / 8;
  t.strokeStyle = palIdx === 1 ? 'rgba(0,0,0,0.15)' : 'rgba(0,0,0,0.35)';
  t.lineWidth = palIdx === 1 ? 1.5 : 2;
  for (let i = 0; i <= 8; i++) {
    t.beginPath(); t.moveTo(i * tileSize, 0); t.lineTo(i * tileSize, 1024); t.stroke();
    t.beginPath(); t.moveTo(0, i * tileSize); t.lineTo(1024, i * tileSize); t.stroke();
  }
  // Tile highlight edges
  t.strokeStyle = `rgba(200,210,230,0.08)`;
  t.lineWidth = 1;
  for (let i = 0; i <= 8; i++) {
    t.beginPath(); t.moveTo(i * tileSize + 2, 0); t.lineTo(i * tileSize + 2, 1024); t.stroke();
    t.beginPath(); t.moveTo(0, i * tileSize + 2); t.lineTo(1024, i * tileSize + 2); t.stroke();
  }
  // Subtle stains/wear marks
  for (let s = 0; s < 6; s++) {
    const sx = Math.random() * 1024, sy = Math.random() * 1024, sr = 40 + Math.random() * 80;
    const sg = t.createRadialGradient(sx, sy, 0, sx, sy, sr);
    sg.addColorStop(0, `rgba(${b[0]-15},${b[1]-12},${b[2]-10},0.3)`);
    sg.addColorStop(1, 'rgba(0,0,0,0)');
    t.fillStyle = sg;
    t.beginPath(); t.ellipse(sx, sy, sr, sr * 0.7, Math.random() * Math.PI, 0, Math.PI * 2); t.fill();
  }
  // Scuff marks
  for (let s = 0; s < 12; s++) {
    const sx = Math.random() * 1024, sy = Math.random() * 1024;
    t.strokeStyle = `rgba(0,0,0,${0.03 + Math.random() * 0.06})`;
    t.lineWidth = 1 + Math.random() * 2;
    t.beginPath();
    t.moveTo(sx, sy);
    t.lineTo(sx + (Math.random() - 0.5) * 60, sy + (Math.random() - 0.5) * 60);
    t.stroke();
  }
  return new THREE.CanvasTexture(tc);
}

function createWallTexture(palIdx, w, h) {
  const tc = document.createElement('canvas');
  tc.width = w || 1024; tc.height = h || 512;
  const t = tc.getContext('2d');
  const cw = tc.width, ch = tc.height;
  const bases = { 1: [70,80,100], 2: [55,48,42], 3: [34,44,58] };
  const b = bases[palIdx] || bases[1];
  // Base color
  t.fillStyle = `rgb(${b[0]},${b[1]},${b[2]})`;
  t.fillRect(0, 0, cw, ch);
  // Subtle vertical gradient (darker at bottom)
  const vg = t.createLinearGradient(0, 0, 0, ch);
  vg.addColorStop(0, 'rgba(180,190,210,0.06)');
  vg.addColorStop(0.5, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.15)');
  t.fillStyle = vg;
  t.fillRect(0, 0, cw, ch);
  // Concrete noise
  for (let i = 0; i < 5000; i++) {
    const nx = Math.random() * cw, ny = Math.random() * ch;
    const v = Math.random() * 20 - 10;
    t.fillStyle = `rgba(${v > 0 ? 200 : 0},${v > 0 ? 200 : 0},${v > 0 ? 200 : 0},${Math.abs(v) / 300})`;
    t.fillRect(nx, ny, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
  // Horizontal panel seams (industrial panels)
  const panelH = ch / 4;
  for (let i = 1; i < 4; i++) {
    const y = i * panelH;
    // Dark seam line
    t.strokeStyle = 'rgba(0,0,0,0.35)';
    t.lineWidth = 2;
    t.beginPath(); t.moveTo(0, y); t.lineTo(cw, y); t.stroke();
    // Light highlight below
    t.strokeStyle = 'rgba(200,210,230,0.08)';
    t.lineWidth = 1;
    t.beginPath(); t.moveTo(0, y + 2); t.lineTo(cw, y + 2); t.stroke();
  }
  // Vertical seams
  const panelW = cw / 4;
  for (let i = 1; i < 4; i++) {
    t.strokeStyle = 'rgba(0,0,0,0.25)';
    t.lineWidth = 1.5;
    t.beginPath(); t.moveTo(i * panelW, 0); t.lineTo(i * panelW, ch); t.stroke();
  }
  // Rivets/bolts at seam intersections
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const rx = c * panelW + panelW / 2, ry = r * panelH + panelH / 2;
      // Bolt pairs at top-left of each panel
      for (const [ox, oy] of [[8, 8], [panelW - 8, 8], [8, panelH - 8], [panelW - 8, panelH - 8]]) {
        const bx = c * panelW + ox, by = r * panelH + oy;
        if (bx < cw && by < ch) {
          t.fillStyle = 'rgba(100,110,130,0.2)';
          t.beginPath(); t.arc(bx, by, 2.5, 0, Math.PI * 2); t.fill();
          t.fillStyle = 'rgba(200,210,230,0.08)';
          t.beginPath(); t.arc(bx, by - 0.5, 1, 0, Math.PI * 2); t.fill();
        }
      }
    }
  }
  // Water stain drip from top
  for (let s = 0; s < 3; s++) {
    const sx = Math.random() * cw;
    const sg = t.createLinearGradient(sx, 0, sx, ch * 0.5);
    sg.addColorStop(0, 'rgba(30,40,30,0.12)');
    sg.addColorStop(0.5, 'rgba(30,40,30,0.04)');
    sg.addColorStop(1, 'rgba(0,0,0,0)');
    t.fillStyle = sg;
    t.fillRect(sx - 8, 0, 16 + Math.random() * 10, ch * 0.5);
  }
  // Grime at bottom
  const gg = t.createLinearGradient(0, ch - 60, 0, ch);
  gg.addColorStop(0, 'rgba(0,0,0,0)');
  gg.addColorStop(1, 'rgba(20,15,10,0.2)');
  t.fillStyle = gg;
  t.fillRect(0, ch - 60, cw, 60);
  return new THREE.CanvasTexture(tc);
}

function createRoom3D(roomNum) {
  // Clear old room meshes
  for (const m of currentRoomMeshes) scene3D.remove(m);
  currentRoomMeshes = [];

  // Re-setup lights for new room palette
  setupLights();

  const rn = roomNum || 1;
  const floorTex = createFloorTexture(rn);
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  const wallTex = createWallTexture(rn);
  wallTex.wrapS = wallTex.wrapT = THREE.RepeatWrapping;
  const sideWallTex = createWallTexture(rn, 512, 512);

  // Floor
  const floorGeom = new THREE.PlaneGeometry(WORLD_W, WORLD_D);
  const floorRoughness = rn === 1 ? 0.55 : 0.82;
  const floorMetalness = rn === 1 ? 0.05 : 0.02;
  const floorMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: floorRoughness, metalness: floorMetalness, side: THREE.DoubleSide });
  const floor = new THREE.Mesh(floorGeom, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene3D.add(floor);
  currentRoomMeshes.push(floor);

  // Walls — low cutaway height (stage-set borders, not full enclosure)
  // Back wall
  const bwGeom = new THREE.PlaneGeometry(WORLD_W, WALL_H);
  const bwMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.8, metalness: 0.02, side: THREE.DoubleSide });
  const backWall = new THREE.Mesh(bwGeom, bwMat);
  backWall.position.set(0, WALL_H / 2, -WORLD_D / 2);
  backWall.receiveShadow = true;
  scene3D.add(backWall);
  currentRoomMeshes.push(backWall);

  // Left wall
  const lwGeom = new THREE.PlaneGeometry(WORLD_D, WALL_H);
  const lwMat = new THREE.MeshStandardMaterial({ map: sideWallTex, roughness: 0.8, metalness: 0.02, side: THREE.DoubleSide });
  const leftWall = new THREE.Mesh(lwGeom, lwMat);
  leftWall.position.set(-WORLD_W / 2, WALL_H / 2, 0);
  leftWall.rotation.y = Math.PI / 2;
  leftWall.receiveShadow = true;
  scene3D.add(leftWall);
  currentRoomMeshes.push(leftWall);

  // Right wall
  const rwGeom = new THREE.PlaneGeometry(WORLD_D, WALL_H);
  const rwMat = new THREE.MeshStandardMaterial({ map: sideWallTex, roughness: 0.8, metalness: 0.02, side: THREE.DoubleSide });
  const rightWall = new THREE.Mesh(rwGeom, rwMat);
  rightWall.position.set(WORLD_W / 2, WALL_H / 2, 0);
  rightWall.rotation.y = -Math.PI / 2;
  rightWall.receiveShadow = true;
  scene3D.add(rightWall);
  currentRoomMeshes.push(rightWall);

  // Ceiling removed — cutaway diorama presentation

  // Horizontal pipe near ceiling on back wall
  const pipeGeom = new THREE.CylinderGeometry(0.08, 0.08, WORLD_W - 2, 8);
  const pipeMat = new THREE.MeshStandardMaterial({ color: 0x5a6070, roughness: 0.4, metalness: 0.6 });
  const pipe = new THREE.Mesh(pipeGeom, pipeMat);
  pipe.rotation.z = Math.PI / 2;
  pipe.position.set(0, WALL_H - 0.3, -WORLD_D / 2 + 0.15);
  pipe.castShadow = true;
  scene3D.add(pipe);
  currentRoomMeshes.push(pipe);

  // Pipe brackets
  const bracketGeom = new THREE.BoxGeometry(0.05, 0.3, 0.15);
  const bracketMat = new THREE.MeshStandardMaterial({ color: 0x4a5060, roughness: 0.5, metalness: 0.5 });
  for (const bx of [-6, -2, 2, 6]) {
    const bracket = new THREE.Mesh(bracketGeom, bracketMat);
    bracket.position.set(bx, WALL_H - 0.3, -WORLD_D / 2 + 0.1);
    scene3D.add(bracket);
    currentRoomMeshes.push(bracket);
  }

  // Vertical pipe on left wall
  const vpGeom = new THREE.CylinderGeometry(0.06, 0.06, WALL_H, 8);
  const vp = new THREE.Mesh(vpGeom, pipeMat);
  vp.position.set(-WORLD_W / 2 + 0.15, WALL_H / 2, -WORLD_D / 2 + 2);
  scene3D.add(vp);
  currentRoomMeshes.push(vp);

  // Baseboard strips
  const bbGeom = new THREE.BoxGeometry(WORLD_W, 0.15, 0.08);
  const bbMat = new THREE.MeshStandardMaterial({ color: 0x1a2230, roughness: 0.6, metalness: 0.3 });
  const bbBack = new THREE.Mesh(bbGeom, bbMat);
  bbBack.position.set(0, 0.075, -WORLD_D / 2 + 0.04);
  scene3D.add(bbBack);
  currentRoomMeshes.push(bbBack);
  const bbLGeom = new THREE.BoxGeometry(0.08, 0.15, WORLD_D);
  const bbL = new THREE.Mesh(bbLGeom, bbMat);
  bbL.position.set(-WORLD_W / 2 + 0.04, 0.075, 0);
  scene3D.add(bbL);
  currentRoomMeshes.push(bbL);
  const bbR = new THREE.Mesh(bbLGeom, bbMat);
  bbR.position.set(WORLD_W / 2 - 0.04, 0.075, 0);
  scene3D.add(bbR);
  currentRoomMeshes.push(bbR);

  // Corner shadows — dark gradient planes in room corners for depth
  createCornerShadows();

  // Exit door
  createExitDoor3D(rn);

  // Furniture
  createFurniture3D(rn);

  // Ceiling light fixtures
  createCeilingLights3D();
}

function createCornerShadows() {
  const hw = WORLD_W / 2;
  const hd = WORLD_D / 2;
  const shadowSize = 3.5;

  // Create gradient shadow textures for corners
  function makeCornerShadowTex() {
    const tc = document.createElement('canvas');
    tc.width = 128; tc.height = 128;
    const t = tc.getContext('2d');
    const grad = t.createRadialGradient(128, 128, 0, 128, 128, 180);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.3, 'rgba(0,0,0,0.1)');
    grad.addColorStop(0.6, 'rgba(0,0,0,0.25)');
    grad.addColorStop(1, 'rgba(0,0,0,0.4)');
    t.fillStyle = grad;
    t.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(tc);
  }

  // Floor corner shadows (back corners only — front corners removed for clean cutaway)
  const corners = [
    { x: -hw, z: -hd },  // back-left
    { x: hw, z: -hd },   // back-right
  ];

  for (const corner of corners) {
    const shadowGeom = new THREE.PlaneGeometry(shadowSize, shadowSize);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: makeCornerShadowTex(),
      transparent: true,
      depthWrite: false,
      blending: THREE.MultiplyBlending,
    });
    const shadow = new THREE.Mesh(shadowGeom, shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(corner.x, 0.005, corner.z);
    scene3D.add(shadow);
    currentRoomMeshes.push(shadow);
  }

  // Wall-floor edge shadows along back wall
  const edgeTc = document.createElement('canvas');
  edgeTc.width = 256; edgeTc.height = 64;
  const edgeCtx = edgeTc.getContext('2d');
  const edgeGrad = edgeCtx.createLinearGradient(0, 0, 0, 64);
  edgeGrad.addColorStop(0, 'rgba(0,0,0,0.5)');
  edgeGrad.addColorStop(0.5, 'rgba(0,0,0,0.15)');
  edgeGrad.addColorStop(1, 'rgba(0,0,0,0)');
  edgeCtx.fillStyle = edgeGrad;
  edgeCtx.fillRect(0, 0, 256, 64);
  const edgeTex = new THREE.CanvasTexture(edgeTc);

  // Back wall floor shadow
  const backEdgeGeom = new THREE.PlaneGeometry(WORLD_W, 2.0);
  const backEdgeMat = new THREE.MeshBasicMaterial({
    map: edgeTex,
    transparent: true,
    depthWrite: false,
  });
  const backEdge = new THREE.Mesh(backEdgeGeom, backEdgeMat);
  backEdge.rotation.x = -Math.PI / 2;
  backEdge.position.set(0, 0.006, -hd + 1.0);
  scene3D.add(backEdge);
  currentRoomMeshes.push(backEdge);

  // Left wall floor shadow
  const sideEdgeGeom = new THREE.PlaneGeometry(WORLD_D, 1.5);
  const leftEdge = new THREE.Mesh(sideEdgeGeom, backEdgeMat.clone());
  leftEdge.rotation.x = -Math.PI / 2;
  leftEdge.rotation.z = Math.PI / 2;
  leftEdge.position.set(-hw + 0.75, 0.006, 0);
  scene3D.add(leftEdge);
  currentRoomMeshes.push(leftEdge);

  // Right wall floor shadow
  const rightEdge = new THREE.Mesh(sideEdgeGeom, backEdgeMat.clone());
  rightEdge.rotation.x = -Math.PI / 2;
  rightEdge.rotation.z = -Math.PI / 2;
  rightEdge.position.set(hw - 0.75, 0.006, 0);
  scene3D.add(rightEdge);
  currentRoomMeshes.push(rightEdge);

  // Ceiling removed — cutaway diorama presentation
}

function createCeilingLights3D() {
  // Physical fixtures removed — cutaway diorama has no visible ceiling
  // Spotlights in setupLighting3D provide the actual illumination
}

function createExitDoor3D(roomNum) {
  // Door position depends on room
  const isRight = roomNum === 1;
  const doorW = 1.5, doorH = 2.2;
  const doorGeom = new THREE.PlaneGeometry(doorW, doorH);
  const doorMat = new THREE.MeshStandardMaterial({ color: 0x585b62, roughness: 0.6, metalness: 0.3 });
  const door = new THREE.Mesh(doorGeom, doorMat);

  if (isRight) {
    door.position.set(WORLD_W / 2 - 0.01, doorH / 2, -WORLD_D / 2 + 5);
    door.rotation.y = -Math.PI / 2;
  } else {
    door.position.set(-WORLD_W / 2 + 0.01, doorH / 2, WORLD_D * 0.1);
    door.rotation.y = Math.PI / 2;
  }
  scene3D.add(door);
  currentRoomMeshes.push(door);

  // Door frame
  const frameGeom = new THREE.BoxGeometry(0.1, doorH + 0.2, doorW + 0.2);
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x484b52, roughness: 0.5, metalness: 0.4 });
  const frame = new THREE.Mesh(frameGeom, frameMat);
  frame.position.copy(door.position);
  frame.position.x += isRight ? -0.05 : 0.05;
  scene3D.add(frame);
  currentRoomMeshes.push(frame);

  // EXIT sign
  const signGeom = new THREE.PlaneGeometry(0.6, 0.2);
  const signCanvas = document.createElement('canvas');
  signCanvas.width = 128; signCanvas.height = 48;
  const sc = signCanvas.getContext('2d');
  sc.fillStyle = '#1a1a1a';
  sc.fillRect(0, 0, 128, 48);
  sc.fillStyle = '#e04040';
  sc.font = 'bold 30px monospace';
  sc.textAlign = 'center';
  sc.fillText('EXIT', 64, 35);
  const signTex = new THREE.CanvasTexture(signCanvas);
  const signMat = new THREE.MeshStandardMaterial({ map: signTex, emissive: 0xe04040, emissiveIntensity: 0.3 });
  const sign = new THREE.Mesh(signGeom, signMat);
  sign.position.copy(door.position);
  sign.position.y = doorH + 0.3;
  sign.rotation.y = door.rotation.y;
  scene3D.add(sign);
  currentRoomMeshes.push(sign);

  // Status light
  const lightGeom = new THREE.SphereGeometry(0.06, 8, 8);
  const exitLightMat = new THREE.MeshStandardMaterial({
    color: 0xe04040, emissive: 0xe04040, emissiveIntensity: 0.8
  });
  const exitLight = new THREE.Mesh(lightGeom, exitLightMat);
  exitLight.position.copy(door.position);
  exitLight.position.y = doorH - 0.3;
  exitLight.position.x += isRight ? -0.08 : 0.08;
  exitLight.name = 'exitLight';
  scene3D.add(exitLight);
  currentRoomMeshes.push(exitLight);
}

function addBox(x, y, z, w, h, d, color, opts) {
  const geom = new THREE.BoxGeometry(w, h, d);
  const matOpts = {
    color,
    roughness: opts?.roughness ?? 0.7,
    metalness: opts?.metalness ?? 0.1,
  };
  if (opts?.emissive) { matOpts.emissive = opts.emissive; matOpts.emissiveIntensity = opts.emissiveIntensity ?? 0.3; }
  const mat = new THREE.MeshStandardMaterial(matOpts);
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(x, y, z);
  if (opts?.rotY) mesh.rotation.y = opts.rotY;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene3D.add(mesh);
  currentRoomMeshes.push(mesh);
  return mesh;
}

function createFurniture3D(roomNum) {
  if (roomNum === 1) {
    // ─── Desk — sleek modern control desk ───
    addBox(5.5, 0.9, -4, 5, 0.12, 2.0, 0xc0cad0, { metalness: 0.6, roughness: 0.25 }); // polished surface
    addBox(3.3, 0.45, -4, 0.08, 0.9, 1.8, 0x8090a0, { metalness: 0.5 }); // left leg
    addBox(7.7, 0.45, -4, 0.08, 0.9, 1.8, 0x8090a0, { metalness: 0.5 }); // right leg
    addBox(5.5, 0.45, -4.9, 5, 0.78, 0.06, 0x505a65, { metalness: 0.3 }); // back modesty panel
    // Desk drawer unit
    addBox(4.0, 0.45, -4, 1.0, 0.8, 1.4, 0x606a75, { metalness: 0.35, roughness: 0.5 });
    addBox(4.0, 0.65, -3.28, 0.8, 0.04, 0.02, 0x909aa0, { metalness: 0.5 }); // drawer handle
    addBox(4.0, 0.35, -3.28, 0.8, 0.04, 0.02, 0x909aa0, { metalness: 0.5 }); // lower handle
    // Monitor — larger with brighter screen
    addBox(7.0, 1.45, -4.2, 1.2, 0.8, 0.06, 0x1a1a22, { metalness: 0.4, roughness: 0.3 }); // bezel
    addBox(7.0, 1.47, -4.17, 1.05, 0.62, 0.02, 0x1840a0, { emissive: 0x2050c0, emissiveIntensity: 0.7 }); // screen
    addBox(7.0, 1.0, -4.1, 0.15, 0.12, 0.4, 0x404550, { metalness: 0.5 }); // stand neck
    addBox(7.0, 0.96, -4.0, 0.4, 0.02, 0.25, 0x505560, { metalness: 0.5 }); // stand base
    // Keyboard + mouse
    addBox(6.3, 0.97, -3.4, 0.65, 0.02, 0.22, 0x303540, { roughness: 0.6 }); // keyboard
    addBox(7.1, 0.97, -3.4, 0.15, 0.02, 0.1, 0x303540, { roughness: 0.6 }); // mouse
    // Coffee mug on desk
    const mugGeom = new THREE.CylinderGeometry(0.06, 0.06, 0.12, 10);
    const mugMat = new THREE.MeshStandardMaterial({ color: 0xe0e0e0, roughness: 0.4 });
    const mug = new THREE.Mesh(mugGeom, mugMat);
    mug.position.set(5.0, 1.02, -3.5);
    scene3D.add(mug); currentRoomMeshes.push(mug);

    // ─── Server rack 1 — detailed with proper shelves ───
    addBox(-2, 1.5, -6.8, 2.2, 3.0, 1.0, 0x303840, { metalness: 0.55, roughness: 0.35 }); // main body
    addBox(-2, 0.3, -6.8, 2.3, 0.06, 1.05, 0x404850); // base platform
    // Rack unit panels
    addBox(-2, 2.6, -6.28, 1.9, 0.5, 0.04, 0x252a32, { metalness: 0.4 });
    addBox(-2, 1.9, -6.28, 1.9, 0.5, 0.04, 0x252a32, { metalness: 0.4 });
    addBox(-2, 1.2, -6.28, 1.9, 0.5, 0.04, 0x252a32, { metalness: 0.4 });
    // LED indicators — green/amber/blue
    addBox(-2.5, 2.7, -6.25, 0.06, 0.06, 0.02, 0x00ff40, { emissive: 0x00ff40, emissiveIntensity: 1.0 });
    addBox(-2.3, 2.7, -6.25, 0.06, 0.06, 0.02, 0x00ff40, { emissive: 0x00ff40, emissiveIntensity: 0.8 });
    addBox(-2.1, 2.7, -6.25, 0.06, 0.06, 0.02, 0x00ff40, { emissive: 0x00ff40, emissiveIntensity: 0.6 });
    addBox(-1.5, 2.7, -6.25, 0.06, 0.06, 0.02, 0xff8000, { emissive: 0xff8000, emissiveIntensity: 0.5 });
    addBox(-2.5, 2.0, -6.25, 0.06, 0.06, 0.02, 0x4090ff, { emissive: 0x4090ff, emissiveIntensity: 0.7 });
    addBox(-2.3, 2.0, -6.25, 0.06, 0.06, 0.02, 0x00ff40, { emissive: 0x00ff40, emissiveIntensity: 0.6 });
    addBox(-1.5, 1.3, -6.25, 0.06, 0.06, 0.02, 0xff3000, { emissive: 0xff3000, emissiveIntensity: 0.5 });

    // ─── Server rack 2 — matching ───
    addBox(1.5, 1.5, -6.8, 2.2, 3.0, 1.0, 0x303840, { metalness: 0.55, roughness: 0.35 });
    addBox(1.5, 0.3, -6.8, 2.3, 0.06, 1.05, 0x404850);
    addBox(1.5, 2.6, -6.28, 1.9, 0.5, 0.04, 0x252a32, { metalness: 0.4 });
    addBox(1.5, 1.9, -6.28, 1.9, 0.5, 0.04, 0x252a32, { metalness: 0.4 });
    addBox(1.5, 1.2, -6.28, 1.9, 0.5, 0.04, 0x252a32, { metalness: 0.4 });
    addBox(1.0, 2.7, -6.25, 0.06, 0.06, 0.02, 0x00ff40, { emissive: 0x00ff40, emissiveIntensity: 1.0 });
    addBox(1.2, 2.7, -6.25, 0.06, 0.06, 0.02, 0x00ff40, { emissive: 0x00ff40, emissiveIntensity: 0.8 });
    addBox(2.0, 2.7, -6.25, 0.06, 0.06, 0.02, 0x4090ff, { emissive: 0x4090ff, emissiveIntensity: 0.7 });
    addBox(1.0, 2.0, -6.25, 0.06, 0.06, 0.02, 0x00ff40, { emissive: 0x00ff40, emissiveIntensity: 0.6 });
    addBox(1.2, 2.0, -6.25, 0.06, 0.06, 0.02, 0x00ff40, { emissive: 0x00ff40, emissiveIntensity: 0.5 });

    // ─── Supply crates — stacked, clean wooden with metal edges ───
    addBox(-4.5, 0.5, 3.5, 2.0, 1.0, 1.5, 0xa08848, { roughness: 0.8 }); // bottom crate
    addBox(-4.5, 0.02, 3.5, 2.05, 0.04, 1.55, 0x6a5838); // bottom band
    addBox(-4.5, 0.98, 3.5, 2.05, 0.04, 1.55, 0x6a5838); // top band
    addBox(-4.5, 1.2, 3.5, 1.6, 0.7, 1.2, 0x907838, { roughness: 0.8 }); // top crate
    addBox(-4.5, 0.87, 3.5, 1.65, 0.04, 1.25, 0x5a4828); // top crate band

    // ─── Wall-mounted cable tray along back wall ───
    addBox(5, 2.0, -7.2, 6, 0.06, 0.3, 0x606870, { metalness: 0.5, roughness: 0.4 });
    // Cable bundle on tray
    addBox(5, 2.06, -7.15, 5.5, 0.08, 0.15, 0x2a2a35, { roughness: 0.8 });

    // ─── Small wall panel / access terminal on right wall ───
    addBox(9.95, 1.5, -2, 0.06, 0.6, 0.4, 0x404850, { metalness: 0.4 });
    addBox(9.92, 1.55, -2, 0.02, 0.15, 0.1, 0x20a040, { emissive: 0x20a040, emissiveIntensity: 0.5 }); // green indicator
    // Keycard on desk — glowing 3D card
    const kcGroup = new THREE.Group();
    const kcBody = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.02, 0.3),
      new THREE.MeshStandardMaterial({ color: 0x30b0f0, emissive: 0x30b0f0, emissiveIntensity: 0.6, roughness: 0.3, metalness: 0.4 })
    );
    kcGroup.add(kcBody);
    // Gold chip
    const kcChip = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.025, 0.08),
      new THREE.MeshStandardMaterial({ color: 0xf0d060, emissive: 0xf0d060, emissiveIntensity: 0.3, metalness: 0.7 })
    );
    kcChip.position.set(-0.1, 0.005, 0);
    kcGroup.add(kcChip);
    // Magnetic stripe
    const kcStripe = new THREE.Mesh(
      new THREE.BoxGeometry(0.35, 0.025, 0.05),
      new THREE.MeshStandardMaterial({ color: 0x70d0ff, emissive: 0x70d0ff, emissiveIntensity: 0.4 })
    );
    kcStripe.position.set(0, 0.005, -0.08);
    kcGroup.add(kcStripe);
    // Glow light under card
    const kcGlow = new THREE.PointLight(0x50c8ff, 8, 3);
    kcGlow.position.set(0, 0.1, 0);
    kcGroup.add(kcGlow);
    kcGroup.position.set(5.5, 0.98, -3.5);
    scene3D.add(kcGroup);
    currentRoomMeshes.push(kcGroup);
    keycardMesh3D = kcGroup;

    // Fire extinguisher — red with details
    const feGeom = new THREE.CylinderGeometry(0.12, 0.14, 0.6, 12);
    const feMat = new THREE.MeshStandardMaterial({ color: 0xcc2020, roughness: 0.35, metalness: 0.3 });
    const fe = new THREE.Mesh(feGeom, feMat);
    fe.position.set(-9, 0.3, 3);
    fe.castShadow = true;
    scene3D.add(fe);
    currentRoomMeshes.push(fe);
    // Fire extinguisher nozzle
    const fnGeom = new THREE.CylinderGeometry(0.02, 0.04, 0.12, 6);
    const fnMat = new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.6 });
    const fn = new THREE.Mesh(fnGeom, fnMat);
    fn.position.set(-9, 0.65, 3);
    scene3D.add(fn);
    currentRoomMeshes.push(fn);
  } else if (roomNum === 2) {
    // Partition wall
    addBox(-0.8, 1.8, -3.8, 1.2, 3.6, 0.15, 0x4a505a, { metalness: 0.2 });
    // Workbench (left of partition)
    addBox(-5.5, 0.85, -5.5, 6.0, 0.12, 1.5, 0xb0a888);
    addBox(-7.5, 0.42, -5.5, 0.12, 0.85, 1.3, 0x8a8268);
    addBox(-3.5, 0.42, -5.5, 0.12, 0.85, 1.3, 0x8a8268);
    // Barrels
    for (let i = 0; i < 3; i++) {
      const bc = [0x2244aa, 0xcc2222, 0xccaa22][i];
      const bGeom = new THREE.CylinderGeometry(0.5, 0.5, 1.2, 12);
      const bMat = new THREE.MeshStandardMaterial({ color: bc, roughness: 0.5, metalness: 0.2 });
      const barrel = new THREE.Mesh(bGeom, bMat);
      barrel.position.set(-7.5 + i * 1.3, 0.6, -0.5);
      barrel.castShadow = true;
      scene3D.add(barrel);
      currentRoomMeshes.push(barrel);
    }
    // Green cabinet
    addBox(3, 1.3, -5.5, 2.4, 2.6, 1.2, 0x2a6a2a, { roughness: 0.6, metalness: 0.15 });
    // Shelving unit (right)
    addBox(7.5, 1.2, -2, 3.0, 2.4, 1.0, 0x5a4a3a);
    // Crates near center
    addBox(2.5, 0.4, 1.5, 2.0, 0.8, 1.2, 0x7a6a50);
    addBox(2.5, 0.9, 1.5, 1.5, 0.5, 1.0, 0x6a5a40);
    // Mop bucket
    const mbGeom = new THREE.CylinderGeometry(0.2, 0.18, 0.35, 8);
    const mbMat = new THREE.MeshStandardMaterial({ color: 0x4466aa, roughness: 0.5 });
    const mb = new THREE.Mesh(mbGeom, mbMat);
    mb.position.set(-2, 0.175, 2);
    scene3D.add(mb);
    currentRoomMeshes.push(mb);
  } else if (roomNum === 3) {
    // Horizontal partition
    addBox(-1, 1.5, -0.5, 12, 3.0, 0.15, 0x4a505a, { metalness: 0.2 });
    // Utility table (north)
    addBox(-5.5, 0.7, -5, 4.5, 0.1, 1.5, 0x7a8a9a, { metalness: 0.3 });
    addBox(-5.5, 0.35, -5, 0.1, 0.7, 1.3, 0x5a6a7a);
    // Server rack (north)
    addBox(2, 1.5, -5.5, 3.0, 3.0, 1.2, 0x3a3e48, { metalness: 0.4, roughness: 0.5 });
    // Locker (south)
    addBox(7, 1.0, 3, 2.5, 2.0, 1.5, 0x5a6a7a, { metalness: 0.3 });
    // Crates (south)
    addBox(-3, 0.5, 3, 3.0, 1.0, 1.8, 0x7a6a50);
  }
}

function createCharacterModel(type) {
  const group = new THREE.Group();
  const isGuard = type === 'guard';
  const torsoColor = isGuard ? 0x555560 : 0x4a78b8;
  const legColor = isGuard ? 0x3a3a42 : 0x2e4068;
  const skinColor = 0xe4b080;

  // Legs
  const legGeom = new THREE.CylinderGeometry(0.1, 0.1, 0.6, 6);
  const legMat = new THREE.MeshStandardMaterial({ color: legColor, roughness: 0.7 });
  const leftLeg = new THREE.Mesh(legGeom, legMat);
  leftLeg.position.set(-0.12, 0.3, 0);
  leftLeg.name = 'leftLeg';
  group.add(leftLeg);
  const rightLeg = new THREE.Mesh(legGeom, legMat);
  rightLeg.position.set(0.12, 0.3, 0);
  rightLeg.name = 'rightLeg';
  group.add(rightLeg);

  // Torso
  const torsoGeom = new THREE.BoxGeometry(0.45, 0.65, 0.25);
  const torsoMat = new THREE.MeshStandardMaterial({ color: torsoColor, roughness: 0.6 });
  const torso = new THREE.Mesh(torsoGeom, torsoMat);
  torso.position.y = 0.92;
  torso.castShadow = true;
  group.add(torso);

  // Arms
  const armGeom = new THREE.CylinderGeometry(0.07, 0.07, 0.5, 6);
  const armMat = new THREE.MeshStandardMaterial({ color: torsoColor, roughness: 0.6 });
  const leftArm = new THREE.Mesh(armGeom, armMat);
  leftArm.position.set(-0.30, 0.85, 0);
  leftArm.name = 'leftArm';
  group.add(leftArm);
  const rightArm = new THREE.Mesh(armGeom, armMat);
  rightArm.position.set(0.30, 0.85, 0);
  rightArm.name = 'rightArm';
  group.add(rightArm);

  // Neck
  const neckGeom = new THREE.CylinderGeometry(0.06, 0.08, 0.12, 6);
  const skinMat = new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.8 });
  const neck = new THREE.Mesh(neckGeom, skinMat);
  neck.position.y = 1.30;
  group.add(neck);

  // Head
  const headGeom = new THREE.SphereGeometry(0.18, 12, 10);
  const head = new THREE.Mesh(headGeom, skinMat);
  head.position.y = 1.52;
  head.castShadow = true;
  group.add(head);

  // Hair/beret
  if (isGuard) {
    const beretGeom = new THREE.SphereGeometry(0.19, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    const beretMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8 });
    const beret = new THREE.Mesh(beretGeom, beretMat);
    beret.position.y = 1.54;
    group.add(beret);
  } else {
    const hairGeom = new THREE.SphereGeometry(0.19, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55);
    const hairMat = new THREE.MeshStandardMaterial({ color: 0x3a2810, roughness: 0.9 });
    const hair = new THREE.Mesh(hairGeom, hairMat);
    hair.position.y = 1.55;
    group.add(hair);
  }

  // Shoes
  const shoeGeom = new THREE.BoxGeometry(0.14, 0.06, 0.22);
  const shoeMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8 });
  const ls = new THREE.Mesh(shoeGeom, shoeMat);
  ls.position.set(-0.12, 0.03, 0.03);
  group.add(ls);
  const rs = new THREE.Mesh(shoeGeom, shoeMat);
  rs.position.set(0.12, 0.03, 0.03);
  group.add(rs);

  group.castShadow = true;
  return group;
}

let currentLights = [];

function setupLights() {
  // Remove old lights
  for (const l of currentLights) scene3D.remove(l);
  currentLights = [];

  function addLight(light) {
    scene3D.add(light);
    currentLights.push(light);
    return light;
  }

  // Ambient light — subtle fill, let spotlights do the work
  addLight(new THREE.AmbientLight(0x4a5a80, 1.2));

  // Hemisphere light for natural fill (sky/ground)
  addLight(new THREE.HemisphereLight(0x6080b0, 0x303840, 0.8));

  // Two ceiling spotlights with shadows
  const lightColors = { 1: 0xc8d4f0, 2: 0xf0dcc0, 3: 0xb0c0e0 };
  const lc = lightColors[currentRoom] || lightColors[1];

  const spot1 = new THREE.SpotLight(lc, 1400, 35, Math.PI / 3.5, 0.7, 1.5);
  spot1.position.set(-3, WALL_H + 3, -WORLD_D / 2 + 1.5);
  spot1.target.position.set(-3, 0, 2);
  spot1.castShadow = true;
  spot1.shadow.mapSize.set(1024, 1024);
  spot1.shadow.camera.near = 0.5;
  spot1.shadow.camera.far = 25;
  spot1.shadow.bias = -0.002;
  addLight(spot1);
  scene3D.add(spot1.target);

  const spot2 = new THREE.SpotLight(lc, 1400, 35, Math.PI / 3.5, 0.7, 1.5);
  spot2.position.set(3, WALL_H + 3, -WORLD_D / 2 + 1.5);
  spot2.target.position.set(3, 0, 2);
  spot2.castShadow = true;
  spot2.shadow.mapSize.set(1024, 1024);
  spot2.shadow.camera.near = 0.5;
  spot2.shadow.camera.far = 25;
  spot2.shadow.bias = -0.002;
  addLight(spot2);
  scene3D.add(spot2.target);

  // Fill light from front — brighter for visibility
  const fill = new THREE.PointLight(0x6080a0, 150, 35);
  fill.position.set(0, 3, WORLD_D / 2 + 2);
  addLight(fill);

  // Back wall fill to brighten the rear
  const backFill = new THREE.PointLight(0x506080, 80, 25);
  backFill.position.set(0, 4, -WORLD_D / 2 + 2);
  addLight(backFill);
}

function initThreeJS() {
  // WebGL renderer on main canvas
  renderer3D = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer3D.setSize(W, H);
  renderer3D.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer3D.shadowMap.enabled = true;
  renderer3D.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer3D.toneMapping = THREE.ACESFilmicToneMapping;
  renderer3D.toneMappingExposure = 1.2;

  // Scene
  scene3D = new THREE.Scene();
  scene3D.background = new THREE.Color(0x0e1420);
  scene3D.fog = new THREE.FogExp2(0x0e1420, 0.015);

  // Camera — cutaway diorama view: frames the playable floor, not the room volume
  camera3D = new THREE.PerspectiveCamera(50, W / H, 0.1, 100);
  camera3D.position.set(0, 9, 17);
  camera3D.lookAt(0, 0, 1.5);

  // Room geometry (also sets up lights)
  createRoom3D(currentRoom);

  // Characters
  playerModel = createCharacterModel('player');
  guardModel = createCharacterModel('guard');
  scene3D.add(playerModel);
  scene3D.add(guardModel);
}

function updateCharacterModel(model, u, v, facing, walkPhase) {
  const wp = uvToWorld(u, v);
  model.position.set(wp.x, 0, wp.z);

  // Face direction
  const facingAngles = { up: Math.PI, down: 0, left: Math.PI / 2, right: -Math.PI / 2 };
  model.rotation.y = facingAngles[facing] || 0;

  // Walk animation
  if (walkPhase > 0) {
    const swing = Math.sin(walkPhase) * 0.3;
    const ll = model.getObjectByName('leftLeg');
    const rl = model.getObjectByName('rightLeg');
    const la = model.getObjectByName('leftArm');
    const ra = model.getObjectByName('rightArm');
    if (ll) ll.rotation.x = swing;
    if (rl) rl.rotation.x = -swing;
    if (la) la.rotation.x = -swing * 0.7;
    if (ra) ra.rotation.x = swing * 0.7;
  } else {
    // Reset limbs
    ['leftLeg', 'rightLeg', 'leftArm', 'rightArm'].forEach(n => {
      const part = model.getObjectByName(n);
      if (part) part.rotation.x = 0;
    });
  }
}

// Update exit light color based on keycard status
function updateExitLight() {
  const light = scene3D.getObjectByName('exitLight');
  if (light) {
    const c = hasKeycard ? 0x40e040 : 0xe04040;
    light.material.color.setHex(c);
    light.material.emissive.setHex(c);
  }
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
  { id: 'rack1',  uMin: 0.06, vMin: 0.15, uMax: 0.21, vMax: 0.38, cover: ['south'] },  // cover from guard when north
  { id: 'rack2',  uMin: 0.41, vMin: 0.10, uMax: 0.55, vMax: 0.34, cover: ['south', 'west'] },  // guard approaches from east/south
  { id: 'desk',   uMin: 0.66, vMin: 0.08, uMax: 0.92, vMax: 0.30, cover: ['south'] },  // cover from guard when north
  { id: 'crates', uMin: 0.27, vMin: 0.50, uMax: 0.42, vMax: 0.67, cover: ['north', 'south', 'west', 'east'] },  // all sides
];

const ROOM2_COLLIDERS = [
  // Partition wall: runs from back wall down, gap at bottom (v > 0.62)
  { id: 'partition', uMin: 0.40, vMin: 0.02, uMax: 0.46, vMax: 0.62 },
  // Back area (left of partition)
  { id: 'workbench', uMin: 0.05, vMin: 0.08, uMax: 0.36, vMax: 0.24, cover: ['south'] },  // cover from guard when north
  { id: 'barrels',   uMin: 0.06, vMin: 0.42, uMax: 0.20, vMax: 0.56, cover: ['south', 'north', 'east'] },  // all accessible sides
  // Front area (right of partition)
  { id: 'cabinet',   uMin: 0.56, vMin: 0.08, uMax: 0.68, vMax: 0.28, cover: ['south'] },  // cover from guard when north
  { id: 'shelving',  uMin: 0.74, vMin: 0.36, uMax: 0.90, vMax: 0.54, cover: ['south', 'west'] },  // guard from north/east
  { id: 'crates2',   uMin: 0.56, vMin: 0.50, uMax: 0.70, vMax: 0.62, cover: ['north', 'south', 'west'] },  // guard from all patrol directions
];

const ROOM3_COLLIDERS = [
  // Horizontal partition: gap on right (u > 0.64), attached to left wall
  { id: 'partitionR3', uMin: 0.02, vMin: 0.40, uMax: 0.64, vMax: 0.46 },
  // North corridor (above partition)
  { id: 'utilTable',   uMin: 0.08, vMin: 0.08, uMax: 0.32, vMax: 0.22, cover: ['south'] },  // cover from guard
  { id: 'rackR3',     uMin: 0.44, vMin: 0.08, uMax: 0.60, vMax: 0.28, cover: ['south', 'west'] },  // guard from east/south
  // South corridor (below partition)
  { id: 'locker',     uMin: 0.76, vMin: 0.54, uMax: 0.90, vMax: 0.72, cover: ['west'] },  // cover + playerHidden mechanic
  { id: 'cratesR3',   uMin: 0.20, vMin: 0.58, uMax: 0.38, vMax: 0.72, cover: ['west', 'east'] },  // guard from both sides
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
  { id: 'r1_behindCrates',u: 0.35, v: 0.78, edges: ['r1_start', 'r1_blCorner', 'r1_midFloor', 'r1_southOfCrates'] },
  { id: 'r1_brCorner',    u: 0.80, v: 0.80, edges: ['r1_midFloor', 'r1_exitDoor'] },
  // Mid row — westCrates routes west of crate box (u < 0.27)
  { id: 'r1_westCrates',  u: 0.22, v: 0.45, edges: ['r1_blCorner', 'r1_southCrates', 'r1_leftOfRack1', 'r1_westCratesCover'] },
  { id: 'r1_leftOfRack1', u: 0.10, v: 0.45, edges: ['r1_blCorner', 'r1_frontRack1', 'r1_westCrates'] },
  { id: 'r1_southCrates', u: 0.35, v: 0.46, edges: ['r1_westCrates', 'r1_midUpper', 'r1_eastOfCrates'] },
  { id: 'r1_midFloor',    u: 0.58, v: 0.60, edges: ['r1_behindCrates', 'r1_brCorner', 'r1_eastOfCrates', 'r1_exitDoor'] },
  { id: 'r1_exitDoor',    u: 0.90, v: 0.55, edges: ['r1_brCorner', 'r1_eastOfCrates', 'r1_midFloor', 'r1_frontDesk'] },
  { id: 'r1_eastOfCrates',u: 0.58, v: 0.45, edges: ['r1_midFloor', 'r1_exitDoor', 'r1_southCrates', 'r1_midUpper', 'r1_frontDesk', 'r1_frontRack2', 'r1_eastCratesCover'] },
  // Cover position south of crates — cover from guard when guard is north (v < 0.50)
  { id: 'r1_southOfCrates',u: 0.35, v: 0.70, edges: ['r1_behindCrates'] },
  // Upper row — approach positions south of props with comfortable margin
  { id: 'r1_frontRack1',  u: 0.14, v: 0.43, edges: ['r1_leftOfRack1', 'r1_midUpper'] },
  { id: 'r1_midUpper',    u: 0.36, v: 0.38, edges: ['r1_frontRack1', 'r1_southCrates', 'r1_eastOfCrates', 'r1_frontRack2'] },
  { id: 'r1_frontRack2',  u: 0.48, v: 0.38, edges: ['r1_midUpper', 'r1_eastOfCrates', 'r1_frontDesk', 'r1_westRack2'] },
  { id: 'r1_frontDesk',   u: 0.78, v: 0.36, edges: ['r1_frontRack2', 'r1_eastOfCrates', 'r1_exitDoor'] },
  // Cover positions for rack2 west face and crates west face
  { id: 'r1_westRack2',   u: 0.37, v: 0.22, edges: ['r1_frontRack2', 'r1_midUpper'] },
  { id: 'r1_westCratesCover', u: 0.23, v: 0.58, edges: ['r1_westCrates', 'r1_blCorner'] },
  { id: 'r1_eastCratesCover', u: 0.46, v: 0.58, edges: ['r1_eastOfCrates', 'r1_midFloor'] },
];

const ROOM2_HOTSPOTS = [
  // Back area (left of partition) — u=0.22 stays east of barrels (uMax=0.20)
  { id: 'r2_backStart',    u: 0.22, v: 0.75, edges: ['r2_backCenter', 'r2_gapSouth', 'r2_behindBarrels', 'r2_exitArea'] },
  { id: 'r2_backCenter',   u: 0.22, v: 0.38, edges: ['r2_backStart', 'r2_frontBench', 'r2_behindBarrels'] },
  { id: 'r2_frontBench',   u: 0.22, v: 0.28, edges: ['r2_backCenter'] },
  { id: 'r2_behindBarrels',u: 0.24, v: 0.59, edges: ['r2_backCenter', 'r2_backStart'] },
  // Gap corridor — comfortable margin below partition (vMax=0.62)
  { id: 'r2_gapSouth',     u: 0.43, v: 0.75, edges: ['r2_backStart', 'r2_gapNorth', 'r2_frontStart', 'r2_exitArea'] },
  { id: 'r2_gapNorth',     u: 0.43, v: 0.66, edges: ['r2_gapSouth', 'r2_westCrates', 'r2_frontLower'] },
  // Front area (right of partition)
  { id: 'r2_frontStart',   u: 0.85, v: 0.85, edges: ['r2_gapSouth', 'r2_frontLower', 'r2_exitArea'] },
  { id: 'r2_frontLower',   u: 0.72, v: 0.65, edges: ['r2_frontStart', 'r2_frontShelving', 'r2_westCrates', 'r2_southShelving'] },
  { id: 'r2_westCrates',   u: 0.52, v: 0.65, edges: ['r2_frontLower', 'r2_frontSpool', 'r2_exitArea'] },
  { id: 'r2_frontSpool',   u: 0.52, v: 0.38, edges: ['r2_westCrates', 'r2_frontCabinet', 'r2_frontShelving', 'r2_northCrates2'] },
  // Cover position north of crates2
  { id: 'r2_northCrates2', u: 0.62, v: 0.46, edges: ['r2_frontSpool', 'r2_frontShelving'] },
  { id: 'r2_frontCabinet', u: 0.62, v: 0.33, edges: ['r2_frontSpool', 'r2_frontShelving'] },
  { id: 'r2_frontShelving',u: 0.72, v: 0.45, edges: ['r2_frontLower', 'r2_frontSpool', 'r2_frontCabinet', 'r2_northCrates2'] },
  // Cover position south of shelving — cover from guard when guard goes north (v < 0.36)
  { id: 'r2_southShelving',u: 0.80, v: 0.58, edges: ['r2_frontLower'] },
  { id: 'r2_exitArea',     u: 0.08, v: 0.62, edges: ['r2_backStart', 'r2_frontStart', 'r2_gapSouth', 'r2_westCrates'] },
];

const ROOM3_HOTSPOTS = [
  // South corridor (player enters here)
  { id: 'r3_start',       u: 0.85, v: 0.85, edges: ['r3_nearLocker', 'r3_southCenter'] },
  { id: 'r3_nearLocker',  u: 0.83, v: 0.76, edges: ['r3_start', 'r3_southCenter', 'r3_westLocker'] },
  { id: 'r3_westLocker',  u: 0.70, v: 0.76, edges: ['r3_nearLocker', 'r3_southCenter', 'r3_gapSouth'] },
  { id: 'r3_southCenter', u: 0.50, v: 0.78, edges: ['r3_start', 'r3_nearLocker', 'r3_westLocker', 'r3_nearCrates', 'r3_exitDoor'] },
  { id: 'r3_nearCrates',  u: 0.30, v: 0.78, edges: ['r3_southCenter', 'r3_exitDoor'] },
  { id: 'r3_exitDoor',    u: 0.08, v: 0.76, edges: ['r3_southCenter', 'r3_nearCrates', 'r3_westOfCrates'] },
  // Cover position west of crates — cover from guard when guard is east (u > 0.38)
  { id: 'r3_westOfCrates',u: 0.16, v: 0.65, edges: ['r3_exitDoor'] },
  // Gap passage (right side, between corridors)
  { id: 'r3_gapSouth',    u: 0.72, v: 0.50, edges: ['r3_westLocker', 'r3_gapNorth'] },
  { id: 'r3_gapNorth',    u: 0.70, v: 0.36, edges: ['r3_gapSouth', 'r3_northEast'] },
  // North corridor — approach positions south of props with comfortable margin
  { id: 'r3_northEast',   u: 0.62, v: 0.32, edges: ['r3_gapNorth', 'r3_frontRack'] },
  { id: 'r3_frontRack',   u: 0.52, v: 0.34, edges: ['r3_northEast', 'r3_northCenter'] },
  { id: 'r3_northCenter', u: 0.39, v: 0.30, edges: ['r3_frontRack', 'r3_frontTable'] },
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

// Dijkstra from startId to goalId along hotspot edges, weighted by Euclidean distance.
// Returns array of hotspot IDs (excluding startId, including goalId), or null if unreachable.
// For ~15-node graphs this is trivial cost and produces the physically shortest path.
function findPath(startId, goalId) {
  if (startId === goalId) return [];
  const dist = {};
  const parent = {};
  const visited = new Set();
  dist[startId] = 0;
  while (true) {
    // Find unvisited node with smallest distance
    let current = null, minDist = Infinity;
    for (const id in dist) {
      if (!visited.has(id) && dist[id] < minDist) {
        minDist = dist[id];
        current = id;
      }
    }
    if (current === null) return null; // unreachable
    if (current === goalId) {
      const path = [];
      let id = goalId;
      while (id !== startId) {
        path.push(id);
        id = parent[id];
      }
      path.reverse();
      return path;
    }
    visited.add(current);
    const node = getHotspot(current);
    if (!node) continue;
    for (const neighborId of node.edges) {
      if (visited.has(neighborId)) continue;
      const neighbor = getHotspot(neighborId);
      if (!neighbor) continue;
      const edgeDist = Math.hypot(neighbor.u - node.u, neighbor.v - node.v);
      const newDist = dist[current] + edgeDist;
      if (!(neighborId in dist) || newDist < dist[neighborId]) {
        dist[neighborId] = newDist;
        parent[neighborId] = current;
      }
    }
  }
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

// Return set of all hotspot IDs reachable via edges from startId
function getReachableSet(startId) {
  const reachable = new Set([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift();
    const node = getHotspot(current);
    if (!node) continue;
    for (const neighborId of node.edges) {
      if (!reachable.has(neighborId)) {
        reachable.add(neighborId);
        queue.push(neighborId);
      }
    }
  }
  return reachable;
}

// Find closest reachable hotspot to a screen-space click point.
// reachableSet filters out unreachable nodes; maxDist caps screen distance.
function findClickedHotspot(screenX, screenY, maxDist, reachableSet) {
  let bestId = null, bestDist = Infinity;
  for (const h of HOTSPOTS) {
    // Skip hotspots the player can't reach
    if (reachableSet && !reachableSet.has(h.id)) continue;
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

  const clickX = e.clientX;
  const clickY = e.clientY;

  // Handle lockpick clicks
  if (lockpick.active && !lockpick.success && !lockpick.failed) {
    lockpickClick();
    return;
  }

  // Handle crafting panel clicks when open
  if (inventoryOpen && inventory.length >= 2) {
    const offsetX = (W - 1280 * scale) / 2;
    const offsetY = (H - 720 * scale) / 2;
    const panelW = 280 * scale;
    const panelH = 200 * scale;
    const px = 640 * scale + offsetX - panelW / 2;
    const py = 360 * scale + offsetY - panelH / 2;

    if (clickX >= px && clickX <= px + panelW && clickY >= py && clickY <= py + panelH) {
      // Click is inside crafting panel — find which slot
      const gridStartX = px + 20 * scale;
      const gridStartY = py + 50 * scale;
      const slotSize = 36 * scale;
      const gap = 8 * scale;
      const cols = 5;

      for (let i = 0; i < inventory.length; i++) {
        const row = Math.floor(i / cols);
        const col = i % cols;
        const sx = gridStartX + col * (slotSize + gap);
        const sy = gridStartY + row * (slotSize + gap);
        if (clickX >= sx && clickX <= sx + slotSize && clickY >= sy && clickY <= sy + slotSize) {
          const idx = selectedForCraft.indexOf(i);
          if (idx >= 0) {
            selectedForCraft.splice(idx, 1);
          } else if (selectedForCraft.length < 2) {
            selectedForCraft.push(i);
          }
          // Try crafting when 2 items selected
          if (selectedForCraft.length === 2) {
            craftingSlots = [inventory[selectedForCraft[0]], inventory[selectedForCraft[1]]];
            if (tryCraft()) {
              selectedForCraft = [];
            } else {
              // Invalid combo — flash and reset
              selectedForCraft = [];
              craftingSlots = [null, null];
            }
          }
          return;
        }
      }
      return; // clicked inside panel but not on a slot
    }
    // Click outside panel — close it
    inventoryOpen = false;
    selectedForCraft = [];
    return;
  }

  // Ignore movement if player is hidden
  if (playerHidden) return;

  // Generous hit radius — covers most of the floor so clicks feel natural
  const hitRadius = 100 * scale;

  // Determine reachability from player's effective position
  let fromId = player.currentHotspot;
  if (!fromId && player.walkPath.length > 0) {
    // Mid-walk: reachability from walk destination
    fromId = player.walkPath[player.walkPath.length - 1];
  } else if (!fromId && player.targetHotspot) {
    fromId = player.targetHotspot;
  }
  const reachable = fromId ? getReachableSet(fromId) : null;

  // Exit door click area — the door is on the wall but the floor hotspot is far away,
  // so we need a special check for clicks on the exit door surface
  let clickedId = findClickedHotspot(clickX, clickY, hitRadius, reachable);
  if (!clickedId) {
    const exitIds = { 1: 'r1_exitDoor', 2: 'r2_exitArea', 3: 'r3_exitDoor' };
    const exitId = exitIds[currentRoom];
    if (exitId && (!reachable || reachable.has(exitId))) {
      // Check if click is near the exit door on the wall (larger radius for wall doors)
      const wallHitRadius = 220 * scale;
      const doorHs = getHotspot(exitId);
      if (doorHs) {
        const doorScreenPos = floorToScreen(doorHs.u, doorHs.v);
        const drawX = doorScreenPos.x * scale + (W - 1280 * scale) / 2;
        const drawY = doorScreenPos.y * scale + (H - 720 * scale) / 2;
        // For wall-mounted doors, extend the hit area upward (wall is above floor)
        const adjustedClickY = clickY + 80 * scale;
        const d = Math.hypot(clickX - drawX, adjustedClickY - drawY);
        if (d <= wallHitRadius) clickedId = exitId;
      }
    }
  }
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
let keycardMesh3D = null;
let won = false;
let gameTime = 0;
let currentRoom = 1;
let roomTransitionTimer = 0;
let spoolKnocked = false;
let spoolNoiseTimer = 0;
let playerHidden = false;

// ─── Inventory & Crafting System ─────────────────────────────────────────────
const ITEMS = {
  test_tube: { name: 'Test Tube',     icon: '🧪', desc: 'Glass vial — can be thrown to create noise' },
  cable:     { name: 'Cable',         icon: '🔌', desc: 'Insulated cable from the workbench' },
  cloth:     { name: 'Cloth',         icon: '🧶', desc: 'Torn lab cloth — useful for traps' },
  battery:   { name: 'Battery',       icon: '🔋', desc: 'Small rechargeable cell' },
  circuit:   { name: 'Circuit Board', icon: '💾', desc: 'Salvaged from facility hardware' },
  chemical:  { name: 'Chemical',      icon: '⚗️', desc: 'Unknown reactive compound' },
  // Crafted items
  trap:      { name: 'Trap',          icon: '🪤', desc: 'Slows guard for 5s' },
  jammer:    { name: 'Jammer',        icon: '📡', desc: 'Disables detection for 10s' },
  smoke:     { name: 'Smoke Bomb',    icon: '💨', desc: 'Creates a smoke cloud — distracts guard' },
};

// Crafting recipes: [item1, item2] → result
const RECIPES = [
  { ingredients: ['cable', 'cloth'],     result: 'trap' },       // slows guard 5s
  { ingredients: ['battery', 'circuit'], result: 'jammer' },     // disables detection 10s
  { ingredients: ['test_tube', 'chemical'], result: 'smoke' },   // smoke cloud distraction
];

// Items placed in each room — { itemId, hotspot, picked }
// Room 1: no items (tutorial — learn movement, stealth, keycard)
// Room 2: learn distraction — test tube can be thrown for noise, cable+cloth carry over
// Room 3: advanced crafting — battery+circuit=jammer, chemical+test_tube(carried)=smoke
const ROOM_ITEMS = {
  1: [],
  2: [
    { itemId: 'test_tube', hotspot: 'r2_backCenter',    picked: false },  // on workbench edge — throwable distraction
    { itemId: 'cable',     hotspot: 'r2_frontCabinet',  picked: false },  // in cabinet area — for trap crafting
    { itemId: 'cloth',     hotspot: 'r2_westCrates',    picked: false },  // in crates — cable+cloth=trap
  ],
  3: [
    { itemId: 'battery',  hotspot: 'r3_northEast',    picked: false },  // on equipment — for jammer
    { itemId: 'circuit',  hotspot: 'r3_frontRack',    picked: false },  // in server rack — battery+circuit=jammer
    { itemId: 'chemical', hotspot: 'r3_northCenter',  picked: false },  // on lab table — test_tube+chemical=smoke
  ],
};

const inventory = [];     // array of item IDs the player has
let inventoryOpen = false;
let craftingSlots = [null, null];  // two slots for combining
let craftResult = null;
let craftAnimTimer = 0;
let itemPickupAnim = { active: false, itemId: null, timer: 0, x: 0, y: 0 };

function getActiveRoomItems() {
  return ROOM_ITEMS[currentRoom] || [];
}

function tryPickupItem() {
  if (!player.currentHotspot) return false;
  const items = getActiveRoomItems();
  for (const item of items) {
    if (!item.picked && item.hotspot === player.currentHotspot) {
      item.picked = true;
      inventory.push(item.itemId);
      // Trigger pickup animation
      const hs = getHotspot(item.hotspot);
      if (hs) {
        const pos = floorToScreen(hs.u, hs.v);
        itemPickupAnim = { active: true, itemId: item.itemId, timer: 0.8, x: pos.x, y: pos.y };
      }
      return true;
    }
  }
  return false;
}

function tryCraft() {
  if (!craftingSlots[0] || !craftingSlots[1]) return false;
  for (const recipe of RECIPES) {
    const [a, b] = recipe.ingredients;
    if ((craftingSlots[0] === a && craftingSlots[1] === b) ||
        (craftingSlots[0] === b && craftingSlots[1] === a)) {
      // Remove ingredients from inventory
      const idx1 = inventory.indexOf(craftingSlots[0]);
      if (idx1 >= 0) inventory.splice(idx1, 1);
      const idx2 = inventory.indexOf(craftingSlots[1]);
      if (idx2 >= 0) inventory.splice(idx2, 1);
      // Add result
      inventory.push(recipe.result);
      craftResult = recipe.result;
      craftAnimTimer = 1.5;
      craftingSlots = [null, null];
      return true;
    }
  }
  return false;
}

function useItem(itemId) {
  const idx = inventory.indexOf(itemId);
  if (idx < 0) return false;

  if (itemId === 'test_tube' && player.currentHotspot) {
    // Throw test tube — shatters and creates noise to lure guard
    const hs = getHotspot(player.currentHotspot);
    if (hs) {
      inventory.splice(idx, 1);
      guard.investigating = true;
      guard.investigateTarget = { u: hs.u, v: hs.v };
      guard.investigateWaitTimer = 4;
      spoolNoiseTimer = 2.0;
      return true;
    }
  }

  if (itemId === 'smoke' && player.currentHotspot) {
    // Smoke bomb — creates a cloud that distracts guard (same as noise but longer)
    const hs = getHotspot(player.currentHotspot);
    if (hs) {
      inventory.splice(idx, 1);
      guard.investigating = true;
      guard.investigateTarget = { u: hs.u, v: hs.v };
      guard.investigateWaitTimer = 6;
      spoolNoiseTimer = 3.0;
      return true;
    }
  }

  if (itemId === 'trap' && player.currentHotspot) {
    // Place trap at current position — guard slows when passing near
    const hs = getHotspot(player.currentHotspot);
    if (hs) {
      inventory.splice(idx, 1);
      placedTraps.push({ u: hs.u, v: hs.v, active: true, timer: 15 });
      return true;
    }
  }

  if (itemId === 'jammer') {
    // Disable detection for 10 seconds
    inventory.splice(idx, 1);
    jammerActiveTimer = 10;
    return true;
  }

  return false;
}

let placedTraps = [];
let jammerActiveTimer = 0;
let guardSlowTimer = 0;

// ─── Star Rating System ──────────────────────────────────────────────────────
const STAR_TARGETS = {
  1: { time: 30 },  // Room 1: complete under 30s for 2 stars
  2: { time: 45 },  // Room 2: complete under 45s for 2 stars
  3: { time: 50 },  // Room 3: complete under 50s for 2 stars
};

const starData = {
  roomStartTime: 0,    // when player entered current room
  roomElapsed: 0,      // time spent in current room
  usedCover: false,     // did player use cover this room?
  wasNoticed: false,    // was guard ever in notice/alert state?
  roomStars: { 1: 0, 2: 0, 3: 0 },  // best stars per room
  totalStars: 0,
  showResult: false,
  resultTimer: 0,
  earnedStars: 0,
};

function resetStarTracking() {
  starData.roomStartTime = gameTime;
  starData.roomElapsed = 0;
  starData.usedCover = false;
  starData.wasNoticed = false;
}

function calculateStars() {
  let stars = 1; // always get 1 star for completing
  const target = STAR_TARGETS[currentRoom];
  if (target && starData.roomElapsed <= target.time) {
    stars = 2; // completed fast
  }
  if (stars >= 2 && !starData.usedCover && !starData.wasNoticed) {
    stars = 3; // ghost mode — fast + no cover + never noticed
  }
  return stars;
}

function showStarResult(stars) {
  starData.earnedStars = stars;
  starData.showResult = true;
  starData.resultTimer = 2.5;
  // Update best
  if (stars > starData.roomStars[currentRoom]) {
    starData.roomStars[currentRoom] = stars;
  }
  starData.totalStars = starData.roomStars[1] + starData.roomStars[2] + starData.roomStars[3];
}

// ─── Lockpick Mini-Game: Safe Dial ───────────────────────────────────────────
const lockpick = {
  active: false,
  // Dial state
  dialAngle: 0,           // current dial angle in radians
  targets: [],            // array of target angles (radians)
  currentTarget: 0,       // which target we're trying to hit
  direction: 1,           // 1 = clockwise, -1 = counter-clockwise (alternates)
  sweetSpot: 0.15,        // radians tolerance
  timeLimit: 15,
  timer: 0,
  success: false,
  failed: false,
  onComplete: null,
  fadeTimer: 0,
  // Tension bar — builds when near sweet spot
  tension: 0,
  shakeAmount: 0,
  unlockedTumbler: [],    // visual feedback for solved tumblers
};

function startLockpick(numTumblers, timeLimit, onComplete) {
  lockpick.active = true;
  lockpick.timeLimit = timeLimit || 15;
  lockpick.timer = lockpick.timeLimit;
  lockpick.success = false;
  lockpick.failed = false;
  lockpick.onComplete = onComplete;
  lockpick.fadeTimer = 0;
  lockpick.dialAngle = 0;
  lockpick.currentTarget = 0;
  lockpick.direction = 1;
  lockpick.tension = 0;
  lockpick.shakeAmount = 0;
  lockpick.unlockedTumbler = [];
  lockpick.targets = [];
  const n = numTumblers || 3;
  lockpick.sweetSpot = n <= 3 ? 0.18 : 0.14;
  for (let i = 0; i < n; i++) {
    // Random target angles, well separated
    lockpick.targets.push(Math.PI * 0.4 + Math.random() * Math.PI * 1.2);
  }
}

function updateLockpick(dt) {
  if (!lockpick.active) return;
  if (lockpick.success || lockpick.failed) {
    lockpick.fadeTimer += dt;
    if (lockpick.fadeTimer > 1.5) {
      lockpick.active = false;
      if (lockpick.success && lockpick.onComplete) {
        lockpick.onComplete();
      }
    }
    return;
  }

  lockpick.timer -= dt;
  if (lockpick.timer <= 0) {
    lockpick.failed = true;
    lockpick.fadeTimer = 0;
    return;
  }

  // Auto-rotate dial
  const speed = 1.8 + lockpick.currentTarget * 0.3; // faster each tumbler
  lockpick.dialAngle += lockpick.direction * speed * dt;
  // Keep in 0-2PI
  if (lockpick.dialAngle > Math.PI * 2) lockpick.dialAngle -= Math.PI * 2;
  if (lockpick.dialAngle < 0) lockpick.dialAngle += Math.PI * 2;

  // Tension feedback — how close to target?
  const target = lockpick.targets[lockpick.currentTarget];
  let diff = Math.abs(lockpick.dialAngle - target);
  if (diff > Math.PI) diff = Math.PI * 2 - diff;
  lockpick.tension = Math.max(0, 1 - diff / 0.5);
  lockpick.shakeAmount = lockpick.tension * 2;
}

function lockpickClick() {
  if (!lockpick.active || lockpick.success || lockpick.failed) return;

  const target = lockpick.targets[lockpick.currentTarget];
  let diff = Math.abs(lockpick.dialAngle - target);
  if (diff > Math.PI) diff = Math.PI * 2 - diff;

  if (diff < lockpick.sweetSpot) {
    // Tumbler solved!
    lockpick.unlockedTumbler.push(lockpick.currentTarget);
    lockpick.currentTarget++;
    lockpick.direction *= -1; // reverse direction for next
    if (lockpick.currentTarget >= lockpick.targets.length) {
      lockpick.success = true;
      lockpick.fadeTimer = 0;
    }
  } else {
    // Wrong — reset progress
    lockpick.currentTarget = 0;
    lockpick.unlockedTumbler = [];
    lockpick.direction = 1;
    lockpick.shakeAmount = 5;
  }
}

function drawLockpick() {
  if (!lockpick.active) return;

  const cx = 640, cy = 340;
  const dialR = 110;
  const shk = lockpick.shakeAmount > 0.1 ? (Math.random() - 0.5) * lockpick.shakeAmount : 0;
  lockpick.shakeAmount *= 0.9;

  // Darken background
  ctx.fillStyle = 'rgba(0,0,0,0.8)';
  ctx.fillRect(0, 0, s(1280), s(720));

  ctx.save();
  ctx.translate(s(shk), s(shk * 0.5));

  // ── Lock body (metallic rectangle) ──
  const bodyW = 320, bodyH = 320;
  const bx = cx - bodyW / 2, by = cy - bodyH / 2 + 10;
  const bodyGrad = ctx.createLinearGradient(s(bx), s(by), s(bx + bodyW), s(by + bodyH));
  bodyGrad.addColorStop(0, '#2a2a30');
  bodyGrad.addColorStop(0.3, '#3a3a42');
  bodyGrad.addColorStop(0.7, '#3a3a42');
  bodyGrad.addColorStop(1, '#22222a');
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.roundRect(s(bx), s(by), s(bodyW), s(bodyH), s(12));
  ctx.fill();
  // Metallic edge
  ctx.strokeStyle = '#555';
  ctx.lineWidth = s(3);
  ctx.stroke();
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = s(1);
  ctx.beginPath();
  ctx.roundRect(s(bx + 3), s(by + 3), s(bodyW - 6), s(bodyH - 6), s(10));
  ctx.stroke();

  // ── Dial background (dark circle) ──
  const dialCX = s(cx), dialCY = s(cy);
  const dR = s(dialR);

  // Outer ring — brushed metal
  const outerGrad = ctx.createRadialGradient(dialCX, dialCY, dR - s(8), dialCX, dialCY, dR + s(5));
  outerGrad.addColorStop(0, '#555860');
  outerGrad.addColorStop(0.5, '#70747c');
  outerGrad.addColorStop(1, '#40444c');
  ctx.fillStyle = outerGrad;
  ctx.beginPath();
  ctx.arc(dialCX, dialCY, dR + s(5), 0, Math.PI * 2);
  ctx.fill();

  // Inner dial face
  const faceGrad = ctx.createRadialGradient(dialCX - s(20), dialCY - s(20), 0, dialCX, dialCY, dR);
  faceGrad.addColorStop(0, '#2e3038');
  faceGrad.addColorStop(1, '#1a1c22');
  ctx.fillStyle = faceGrad;
  ctx.beginPath();
  ctx.arc(dialCX, dialCY, dR - s(5), 0, Math.PI * 2);
  ctx.fill();

  // ── Number ticks around dial ──
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    const isMajor = i % 5 === 0;
    const innerR = isMajor ? dR - s(28) : dR - s(18);
    const outerR2 = dR - s(10);
    ctx.strokeStyle = isMajor ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.15)';
    ctx.lineWidth = isMajor ? s(2) : s(1);
    ctx.beginPath();
    ctx.moveTo(dialCX + Math.cos(a) * innerR, dialCY + Math.sin(a) * innerR);
    ctx.lineTo(dialCX + Math.cos(a) * outerR2, dialCY + Math.sin(a) * outerR2);
    ctx.stroke();
    if (isMajor) {
      const numR = dR - s(36);
      ctx.font = `${s(10)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillText(`${i}`, dialCX + Math.cos(a) * numR, dialCY + Math.sin(a) * numR);
    }
  }

  // ── Sweet spot indicator (subtle glow at target angle) ──
  if (lockpick.currentTarget < lockpick.targets.length) {
    const target = lockpick.targets[lockpick.currentTarget];
    // Subtle golden arc at target
    ctx.strokeStyle = `rgba(255,200,60,${0.15 + lockpick.tension * 0.4})`;
    ctx.lineWidth = s(6);
    ctx.beginPath();
    ctx.arc(dialCX, dialCY, dR - s(16), target - lockpick.sweetSpot, target + lockpick.sweetSpot);
    ctx.stroke();
  }

  // ── Rotating dial pointer ──
  const pAngle = lockpick.dialAngle;
  const pointerLen = dR - s(20);
  // Pointer line
  ctx.strokeStyle = '#e04040';
  ctx.lineWidth = s(3);
  ctx.beginPath();
  ctx.moveTo(dialCX, dialCY);
  ctx.lineTo(dialCX + Math.cos(pAngle) * pointerLen, dialCY + Math.sin(pAngle) * pointerLen);
  ctx.stroke();
  // Pointer tip
  ctx.fillStyle = '#ff4444';
  ctx.beginPath();
  ctx.arc(dialCX + Math.cos(pAngle) * pointerLen, dialCY + Math.sin(pAngle) * pointerLen, s(5), 0, Math.PI * 2);
  ctx.fill();
  // Center cap
  const capGrad = ctx.createRadialGradient(dialCX, dialCY, 0, dialCX, dialCY, s(12));
  capGrad.addColorStop(0, '#606468');
  capGrad.addColorStop(1, '#303338');
  ctx.fillStyle = capGrad;
  ctx.beginPath();
  ctx.arc(dialCX, dialCY, s(12), 0, Math.PI * 2);
  ctx.fill();

  // ── Tumbler indicators (below dial) ──
  const tumblerY = cy + dialR + 30;
  const totalT = lockpick.targets.length;
  const tSize = 16;
  const tGap = 8;
  const tStartX = cx - (totalT * tSize + (totalT - 1) * tGap) / 2;
  for (let i = 0; i < totalT; i++) {
    const tx = tStartX + i * (tSize + tGap);
    const solved = lockpick.unlockedTumbler.includes(i);
    ctx.fillStyle = solved ? '#40c040' : (i === lockpick.currentTarget ? 'rgba(255,200,60,0.5)' : 'rgba(255,255,255,0.15)');
    ctx.beginPath();
    ctx.arc(s(tx + tSize / 2), s(tumblerY), s(tSize / 2), 0, Math.PI * 2);
    ctx.fill();
    if (solved) {
      ctx.font = `bold ${s(10)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.fillText('✓', s(tx + tSize / 2), s(tumblerY));
    }
  }

  // ── Timer bar ──
  const timerPct = Math.max(0, lockpick.timer / lockpick.timeLimit);
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.beginPath();
  ctx.roundRect(s(bx + 20), s(by + bodyH - 30), s(bodyW - 40), s(8), s(4));
  ctx.fill();
  ctx.fillStyle = timerPct > 0.3 ? '#40e040' : '#ff4040';
  ctx.beginPath();
  ctx.roundRect(s(bx + 20), s(by + bodyH - 30), s((bodyW - 40) * timerPct), s(8), s(4));
  ctx.fill();

  // ── Title ──
  ctx.font = `bold ${s(14)}px monospace`;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd740';
  ctx.fillText('CRACK THE SAFE', s(cx), s(by + 22));

  // ── Tension feedback text ──
  if (lockpick.tension > 0.3 && !lockpick.success && !lockpick.failed) {
    ctx.font = `${s(11)}px monospace`;
    ctx.fillStyle = `rgba(255,200,60,${lockpick.tension})`;
    ctx.fillText('Getting closer...', s(cx), s(by + bodyH - 42));
  }

  // ── Instructions ──
  ctx.font = `${s(10)}px monospace`;
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillText('Click when pointer is in the golden zone', s(cx), s(by + bodyH - 10));

  ctx.restore();

  // ── Success/Fail overlay ──
  if (lockpick.success) {
    const alpha = Math.min(lockpick.fadeTimer / 0.5, 1);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(0,40,0,0.4)';
    ctx.fillRect(0, 0, s(1280), s(720));
    ctx.font = `bold ${s(32)}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#40ff40';
    ctx.fillText('SAFE CRACKED', s(640), s(350));
    ctx.restore();
  }
  if (lockpick.failed) {
    const alpha = Math.min(lockpick.fadeTimer / 0.5, 1);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(40,0,0,0.4)';
    ctx.fillRect(0, 0, s(1280), s(720));
    ctx.font = `bold ${s(32)}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ff4040';
    ctx.fillText('LOCK JAMMED', s(640), s(350));
    ctx.font = `${s(14)}px monospace`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Try again...', s(640), s(385));
    ctx.restore();
  }
}

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
  const COVER_DIST = 0.10;  // how close to the face the player must be
  const COVER_PAD = 0.04;   // how much the collider expands for the LOS check
  for (const b of COLLIDERS) {
    if (!b.cover) continue;
    for (const face of b.cover) {
      let nearFace = false;
      let guardOnOppositeSide = false;
      // Lateral tolerance matches COVER_DIST so cover works at natural approach margins
      const COVER_LAT = COVER_DIST;
      if (face === 'south') {
        nearFace = player.v > b.vMax && player.v < b.vMax + COVER_DIST &&
                   player.u > b.uMin - COVER_LAT && player.u < b.uMax + COVER_LAT;
        guardOnOppositeSide = guard.v < b.vMax;  // guard is not south of collider
      } else if (face === 'north') {
        nearFace = player.v < b.vMin && player.v > b.vMin - COVER_DIST &&
                   player.u > b.uMin - COVER_LAT && player.u < b.uMax + COVER_LAT;
        guardOnOppositeSide = guard.v > b.vMin;  // guard is not north of collider
      } else if (face === 'east') {
        nearFace = player.u > b.uMax && player.u < b.uMax + COVER_DIST &&
                   player.v > b.vMin - COVER_LAT && player.v < b.vMax + COVER_LAT;
        guardOnOppositeSide = guard.u < b.uMax;  // guard is not east of collider
      } else if (face === 'west') {
        nearFace = player.u < b.uMin && player.u > b.uMin - COVER_DIST &&
                   player.v > b.vMin - COVER_LAT && player.v < b.vMax + COVER_LAT;
        guardOnOppositeSide = guard.u > b.uMin;  // guard is not west of collider
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
            starData.usedCover = true;
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
  if (lockpick.active) return false;  // crouched at lock, not visible
  if (jammerActiveTimer > 0) return false;  // jammer blocks detection

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
  1: { // Server Room: cold steel and blue LED glow — high-tech facility
    backWall:  ['#384450', '#303a46', '#283240'],
    leftWall:  ['#2a3440', '#303a48', '#364050'],
    rightWall: ['#364050', '#303a48', '#2c3644'],
    floor:     ['#3a4250', '#343c4a', '#2e3644'],
    tileGroove: 'rgba(0,0,40,0.25)',
    tileHighlight: 'rgba(160,190,240,0.07)',
    seamDark:  'rgba(0,0,40,0.22)',
    seamLight: 'rgba(180,200,240,0.05)',
    baseboard: '#1a2230',
    baseHighlight: '#4e5668',
  },
  2: { // Maintenance Workshop: warm industrial amber — rust and grease
    backWall:  ['#48403a', '#3e3630', '#342c26'],
    leftWall:  ['#302a24', '#3a342e', '#44403a'],
    rightWall: ['#44403a', '#3a342e', '#342e28'],
    floor:     ['#443c34', '#3c3630', '#342e28'],
    tileGroove: 'rgba(50,25,0,0.25)',
    tileHighlight: 'rgba(220,190,140,0.06)',
    seamDark:  'rgba(50,25,0,0.22)',
    seamLight: 'rgba(220,190,140,0.05)',
    baseboard: '#241e18',
    baseHighlight: '#5a5040',
  },
  3: { // Server Closet: deep blue with cyan accents — claustrophobic tech
    backWall:  ['#303c50', '#283446', '#22303e'],
    leftWall:  ['#202c40', '#263450', '#2c3a56'],
    rightWall: ['#2c3a56', '#263450', '#222e44'],
    floor:     ['#344050', '#2e3a48', '#283440'],
    tileGroove: 'rgba(0,15,60,0.25)',
    tileHighlight: 'rgba(140,170,220,0.07)',
    seamDark:  'rgba(0,15,60,0.22)',
    seamLight: 'rgba(140,170,220,0.05)',
    baseboard: '#182438',
    baseHighlight: '#445268',
  },
};

function drawRoom() {
  const { floorTL, floorTR, floorBL, floorBR,
          ceilTL, ceilTR, leftWallTop, rightWallTop } = ROOM;
  const pal = ROOM_PALETTES[currentRoom] || ROOM_PALETTES[1];

  // ── Back wall ──
  const backGrad = ctx.createLinearGradient(s(260), s(60), s(260), s(270));
  backGrad.addColorStop(0, pal.backWall[0]);
  backGrad.addColorStop(0.4, pal.backWall[1]);
  backGrad.addColorStop(1, pal.backWall[2]);
  roomPath([ceilTL, ceilTR, floorTR, floorTL]);
  ctx.fillStyle = backGrad;
  ctx.fill();

  // Concrete panel lines on back wall
  ctx.save();
  roomPath([ceilTL, ceilTR, floorTR, floorTL]);
  ctx.clip();
  // Horizontal seams — deeper grooves
  ctx.strokeStyle = pal.seamDark;
  ctx.lineWidth = s(1.2);
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
  // Panel rivet dots at seam intersections
  ctx.fillStyle = 'rgba(120,130,150,0.12)';
  for (let row = 1; row <= 7; row++) {
    for (let col = 1; col <= 5; col++) {
      const tv = row / 8;
      const th = col / 6;
      const rx = ceilTL.x + (ceilTR.x - ceilTL.x) * th;
      const ry = ceilTL.y + (floorTL.y - ceilTL.y) * tv;
      const rx2 = floorTL.x + (floorTR.x - floorTL.x) * th;
      const ry2 = floorTL.y;
      const ix = rx + (rx2 - rx) * tv;
      const iy = ry;
      ctx.beginPath();
      ctx.arc(s(ix), s(iy), s(1.5), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Subtle stain/variation overlays on back wall
  const stainGrad = ctx.createRadialGradient(
    s(500), s(180), 0, s(500), s(180), s(140)
  );
  stainGrad.addColorStop(0, 'rgba(0,0,0,0.06)');
  stainGrad.addColorStop(0.6, 'rgba(0,0,0,0.03)');
  stainGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = stainGrad;
  ctx.fillRect(s(ceilTL.x), s(ceilTL.y), s(ceilTR.x - ceilTL.x), s(floorTL.y - ceilTL.y));
  // Water stain / discoloration patch
  const stain2 = ctx.createRadialGradient(s(750), s(200), 0, s(750), s(200), s(80));
  stain2.addColorStop(0, 'rgba(60,50,30,0.06)');
  stain2.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = stain2;
  ctx.fillRect(s(670), s(140), s(180), s(120));
  // Horizontal conduit pipe near ceiling
  const pipeY = ceilTL.y + (floorTL.y - ceilTL.y) * 0.12;
  const pipeGrad = ctx.createLinearGradient(0, s(pipeY - 3), 0, s(pipeY + 3));
  pipeGrad.addColorStop(0, 'rgba(80,85,95,0.35)');
  pipeGrad.addColorStop(0.3, 'rgba(100,105,115,0.3)');
  pipeGrad.addColorStop(0.7, 'rgba(70,75,85,0.35)');
  pipeGrad.addColorStop(1, 'rgba(50,55,65,0.4)');
  ctx.fillStyle = pipeGrad;
  const pLx = ceilTL.x + (floorTL.x - ceilTL.x) * 0.12;
  const pRx = ceilTR.x + (floorTR.x - ceilTR.x) * 0.12;
  ctx.fillRect(s(pLx), s(pipeY - 3), s(pRx - pLx), s(6));
  // Pipe brackets
  ctx.fillStyle = 'rgba(60,65,75,0.3)';
  for (const bk of [0.2, 0.4, 0.6, 0.8]) {
    const bx = pLx + (pRx - pLx) * bk;
    ctx.fillRect(s(bx - 2), s(pipeY - 5), s(4), s(10));
  }
  ctx.restore();

  // ── Left side wall ──
  const leftGrad = ctx.createLinearGradient(s(80), s(130), s(260), s(270));
  leftGrad.addColorStop(0, pal.leftWall[0]);
  leftGrad.addColorStop(0.35, pal.leftWall[1]);
  leftGrad.addColorStop(1, pal.leftWall[2]);
  roomPath([leftWallTop, ceilTL, floorTL, floorBL]);
  ctx.fillStyle = leftGrad;
  ctx.fill();
  // Left wall panel seams and detail
  ctx.save();
  roomPath([leftWallTop, ceilTL, floorTL, floorBL]);
  ctx.clip();
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = s(1);
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
    // Highlight
    ctx.strokeStyle = 'rgba(160,170,190,0.04)';
    ctx.beginPath();
    ctx.moveTo(s(x1 + 1), s(y1 + 1));
    ctx.lineTo(s(x2 + 1), s(y2 + 1));
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  }
  // Vertical pipe on left wall
  const lpx1 = leftWallTop.x + (ceilTL.x - leftWallTop.x) * 0.15;
  const lpy1 = leftWallTop.y + (ceilTL.y - leftWallTop.y) * 0.15;
  const lpx2 = floorBL.x + (floorTL.x - floorBL.x) * 0.15;
  const lpy2 = floorBL.y + (floorTL.y - floorBL.y) * 0.15;
  const lwPipeGrad = ctx.createLinearGradient(s(lpx1 - 3), 0, s(lpx1 + 3), 0);
  lwPipeGrad.addColorStop(0, 'rgba(50,55,65,0.3)');
  lwPipeGrad.addColorStop(0.4, 'rgba(90,95,105,0.25)');
  lwPipeGrad.addColorStop(1, 'rgba(40,45,55,0.35)');
  ctx.strokeStyle = lwPipeGrad;
  ctx.lineWidth = s(5);
  ctx.beginPath();
  ctx.moveTo(s(lpx1), s(lpy1));
  ctx.lineTo(s(lpx2), s(lpy2));
  ctx.stroke();
  // Ambient shadow at bottom of left wall
  const lwShadow = ctx.createLinearGradient(s(floorBL.x), s(floorBL.y - 40), s(floorBL.x), s(floorBL.y));
  lwShadow.addColorStop(0, 'rgba(0,0,0,0)');
  lwShadow.addColorStop(1, 'rgba(0,0,0,0.15)');
  ctx.fillStyle = lwShadow;
  roomPath([
    { x: leftWallTop.x, y: floorBL.y - 40 },
    { x: ceilTL.x, y: floorTL.y - 40 },
    floorTL, floorBL
  ]);
  ctx.fill();
  ctx.restore();

  // ── Right side wall ──
  const rightGrad = ctx.createLinearGradient(s(1020), s(270), s(1200), s(130));
  rightGrad.addColorStop(0, pal.rightWall[0]);
  rightGrad.addColorStop(0.35, pal.rightWall[1]);
  rightGrad.addColorStop(1, pal.rightWall[2]);
  roomPath([ceilTR, rightWallTop, floorBR, floorTR]);
  ctx.fillStyle = rightGrad;
  ctx.fill();
  // Right wall panel seams and detail
  ctx.save();
  roomPath([ceilTR, rightWallTop, floorBR, floorTR]);
  ctx.clip();
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = s(1);
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
    // Highlight
    ctx.strokeStyle = 'rgba(160,170,190,0.04)';
    ctx.beginPath();
    ctx.moveTo(s(x1 - 1), s(y1 + 1));
    ctx.lineTo(s(x2 - 1), s(y2 + 1));
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  }
  // Vertical conduit on right wall
  const rpx1 = ceilTR.x + (rightWallTop.x - ceilTR.x) * 0.85;
  const rpy1 = ceilTR.y + (rightWallTop.y - ceilTR.y) * 0.85;
  const rpx2 = floorTR.x + (floorBR.x - floorTR.x) * 0.85;
  const rpy2 = floorTR.y + (floorBR.y - floorTR.y) * 0.85;
  const rwPipeGrad = ctx.createLinearGradient(s(rpx1 - 3), 0, s(rpx1 + 3), 0);
  rwPipeGrad.addColorStop(0, 'rgba(40,45,55,0.35)');
  rwPipeGrad.addColorStop(0.6, 'rgba(90,95,105,0.25)');
  rwPipeGrad.addColorStop(1, 'rgba(50,55,65,0.3)');
  ctx.strokeStyle = rwPipeGrad;
  ctx.lineWidth = s(4);
  ctx.beginPath();
  ctx.moveTo(s(rpx1), s(rpy1));
  ctx.lineTo(s(rpx2), s(rpy2));
  ctx.stroke();
  // Ambient shadow at bottom of right wall
  const rwShadow = ctx.createLinearGradient(s(floorBR.x), s(floorBR.y - 40), s(floorBR.x), s(floorBR.y));
  rwShadow.addColorStop(0, 'rgba(0,0,0,0)');
  rwShadow.addColorStop(1, 'rgba(0,0,0,0.15)');
  ctx.fillStyle = rwShadow;
  roomPath([
    { x: ceilTR.x, y: floorTR.y - 40 },
    { x: rightWallTop.x, y: floorBR.y - 40 },
    floorBR, floorTR
  ]);
  ctx.fill();
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
  floorGrad.addColorStop(0.35, pal.floor[1]);
  floorGrad.addColorStop(1, pal.floor[2]);
  roomPath([floorTL, floorTR, floorBR, floorBL]);
  ctx.fillStyle = floorGrad;
  ctx.fill();

  // Floor tile grid — deeper, more visible tiles
  ctx.save();
  roomPath([floorTL, floorTR, floorBR, floorBL]);
  ctx.clip();
  const gridH = 12;
  const gridV = 16;
  // Tile groove (dark line) — stronger
  ctx.strokeStyle = pal.tileGroove;
  ctx.lineWidth = s(1.4);
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
  // Tile highlight (light line offset by 1px from each groove) — stronger
  ctx.strokeStyle = pal.tileHighlight;
  ctx.lineWidth = s(0.8);
  for (let i = 0; i <= gridH; i++) {
    const t = i / gridH;
    const lx1 = floorTL.x + (floorBL.x - floorTL.x) * t;
    const ly1 = floorTL.y + (floorBL.y - floorTL.y) * t + 1.5;
    const lx2 = floorTR.x + (floorBR.x - floorTR.x) * t;
    const ly2 = floorTR.y + (floorBR.y - floorTR.y) * t + 1.5;
    ctx.beginPath();
    ctx.moveTo(s(lx1), s(ly1));
    ctx.lineTo(s(lx2), s(ly2));
    ctx.stroke();
  }
  // Subtle floor reflection/sheen — specular highlight near light positions
  for (const t of [0.3, 0.7]) {
    const reflPos = floorToScreen(t, 0.30);
    const reflGrad = ctx.createRadialGradient(
      s(reflPos.x), s(reflPos.y), 0,
      s(reflPos.x), s(reflPos.y), s(100)
    );
    reflGrad.addColorStop(0, 'rgba(200,210,230,0.04)');
    reflGrad.addColorStop(0.5, 'rgba(200,210,230,0.02)');
    reflGrad.addColorStop(1, 'rgba(200,210,230,0)');
    ctx.fillStyle = reflGrad;
    ctx.beginPath();
    ctx.ellipse(s(reflPos.x), s(reflPos.y), s(100), s(60), 0, 0, Math.PI * 2);
    ctx.fill();
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

  // ── Metal baseboard strips — industrial kick plates ──
  // Dark groove (thicker)
  ctx.strokeStyle = pal.baseboard;
  ctx.lineWidth = s(5);
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
  // Metal highlight — brighter
  ctx.strokeStyle = pal.baseHighlight;
  ctx.lineWidth = s(1.5);
  ctx.beginPath();
  ctx.moveTo(s(floorTL.x), s(floorTL.y + 1.5));
  ctx.lineTo(s(floorTR.x), s(floorTR.y + 1.5));
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s(floorTL.x + 0.5), s(floorTL.y + 1.5));
  ctx.lineTo(s(floorBL.x + 0.5), s(floorBL.y + 1.5));
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s(floorTR.x - 0.5), s(floorTR.y + 1.5));
  ctx.lineTo(s(floorBR.x - 0.5), s(floorBR.y + 1.5));
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
  // Back wall AO — stronger, wider
  const backAO = ctx.createLinearGradient(s(640), s(floorTL.y), s(640), s(floorTL.y + 70));
  backAO.addColorStop(0, 'rgba(0,0,0,0.40)');
  backAO.addColorStop(0.3, 'rgba(0,0,0,0.18)');
  backAO.addColorStop(0.7, 'rgba(0,0,0,0.06)');
  backAO.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = backAO;
  ctx.fillRect(s(floorTL.x), s(floorTL.y), s(floorTR.x - floorTL.x), s(70));

  // Left wall AO — stronger
  const leftAO = ctx.createLinearGradient(s(floorTL.x), s(floorTL.y), s(floorTL.x + 65), s(floorTL.y + 20));
  leftAO.addColorStop(0, 'rgba(0,0,0,0.32)');
  leftAO.addColorStop(0.5, 'rgba(0,0,0,0.10)');
  leftAO.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = leftAO;
  ctx.beginPath();
  ctx.moveTo(s(floorTL.x), s(floorTL.y));
  ctx.lineTo(s(floorBL.x), s(floorBL.y));
  ctx.lineTo(s(floorBL.x + 70), s(floorBL.y));
  ctx.lineTo(s(floorTL.x + 65), s(floorTL.y));
  ctx.closePath();
  ctx.fill();

  // Right wall AO — stronger
  const rightAO = ctx.createLinearGradient(s(floorTR.x), s(floorTR.y), s(floorTR.x - 65), s(floorTR.y + 20));
  rightAO.addColorStop(0, 'rgba(0,0,0,0.32)');
  rightAO.addColorStop(0.5, 'rgba(0,0,0,0.10)');
  rightAO.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rightAO;
  ctx.beginPath();
  ctx.moveTo(s(floorTR.x), s(floorTR.y));
  ctx.lineTo(s(floorBR.x), s(floorBR.y));
  ctx.lineTo(s(floorBR.x - 70), s(floorBR.y));
  ctx.lineTo(s(floorTR.x - 65), s(floorTR.y));
  ctx.closePath();
  ctx.fill();

  // Corner AO puddles — stronger, deeper shadows
  const cornerR = 65;
  // Back-left corner
  const blcGrad = ctx.createRadialGradient(s(floorTL.x), s(floorTL.y), 0, s(floorTL.x), s(floorTL.y), s(cornerR));
  blcGrad.addColorStop(0, 'rgba(0,0,0,0.35)');
  blcGrad.addColorStop(0.4, 'rgba(0,0,0,0.14)');
  blcGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = blcGrad;
  ctx.fillRect(s(floorTL.x), s(floorTL.y), s(cornerR), s(cornerR));
  // Back-right corner
  const brcGrad = ctx.createRadialGradient(s(floorTR.x), s(floorTR.y), 0, s(floorTR.x), s(floorTR.y), s(cornerR));
  brcGrad.addColorStop(0, 'rgba(0,0,0,0.35)');
  brcGrad.addColorStop(0.4, 'rgba(0,0,0,0.14)');
  brcGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = brcGrad;
  ctx.fillRect(s(floorTR.x - cornerR), s(floorTR.y), s(cornerR), s(cornerR));
  // Front-left corner
  const flcR = 45;
  const flcGrad = ctx.createRadialGradient(s(floorBL.x), s(floorBL.y), 0, s(floorBL.x), s(floorBL.y), s(flcR));
  flcGrad.addColorStop(0, 'rgba(0,0,0,0.22)');
  flcGrad.addColorStop(0.5, 'rgba(0,0,0,0.08)');
  flcGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = flcGrad;
  ctx.fillRect(s(floorBL.x), s(floorBL.y - flcR), s(flcR), s(flcR));
  // Front-right corner
  const frcGrad = ctx.createRadialGradient(s(floorBR.x), s(floorBR.y), 0, s(floorBR.x), s(floorBR.y), s(flcR));
  frcGrad.addColorStop(0, 'rgba(0,0,0,0.22)');
  frcGrad.addColorStop(0.5, 'rgba(0,0,0,0.08)');
  frcGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = frcGrad;
  ctx.fillRect(s(floorBR.x - flcR), s(floorBR.y - flcR), s(flcR), s(flcR));

  ctx.restore();
}

// Per-room light tints: [diffuser edge, diffuser mid, diffuser center, glow RGBA]
const LIGHT_TINTS = {
  1: { de: '#c8ccd6', dm: '#e0e4f0', dc: '#eef4ff', glow: '190,200,240' }, // cool white
  2: { de: '#d6c8b0', dm: '#eedcca', dc: '#fae8d4', glow: '240,215,175' }, // warm amber
  3: { de: '#b8c8dc', dm: '#d0e0f4', dc: '#e0eeff', glow: '160,185,240' }, // cool blue
};

function drawCeilingLight(lx, ly) {
  const fixtW = 110, fixtH = 6;
  const lt = LIGHT_TINTS[currentRoom] || LIGHT_TINTS[1];

  // Visible light beam from fixture downward — trapezoid cone
  ctx.save();
  const beamBot = ly + 220;
  const beamGrad = ctx.createLinearGradient(0, s(ly), 0, s(beamBot));
  beamGrad.addColorStop(0, `rgba(${lt.glow},0.10)`);
  beamGrad.addColorStop(0.3, `rgba(${lt.glow},0.05)`);
  beamGrad.addColorStop(0.7, `rgba(${lt.glow},0.02)`);
  beamGrad.addColorStop(1, `rgba(${lt.glow},0)`);
  ctx.fillStyle = beamGrad;
  ctx.beginPath();
  ctx.moveTo(s(lx - fixtW / 2 + 10), s(ly + fixtH));
  ctx.lineTo(s(lx + fixtW / 2 - 10), s(ly + fixtH));
  ctx.lineTo(s(lx + fixtW / 2 + 50), s(beamBot));
  ctx.lineTo(s(lx - fixtW / 2 - 50), s(beamBot));
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Housing (dark metal surround with depth)
  ctx.fillStyle = '#3a3d44';
  ctx.fillRect(s(lx - fixtW / 2 - 4), s(ly - 2), s(fixtW + 8), s(fixtH + 4));
  ctx.fillStyle = '#50535a';
  ctx.fillRect(s(lx - fixtW / 2 - 3), s(ly - 1), s(fixtW + 6), s(fixtH + 2));
  // Diffuser panel (bright — tinted per room)
  const diffGrad = ctx.createLinearGradient(s(lx - fixtW / 2), 0, s(lx + fixtW / 2), 0);
  diffGrad.addColorStop(0, lt.de);
  diffGrad.addColorStop(0.2, lt.dm);
  diffGrad.addColorStop(0.5, lt.dc);
  diffGrad.addColorStop(0.8, lt.dm);
  diffGrad.addColorStop(1, lt.de);
  ctx.fillStyle = diffGrad;
  ctx.fillRect(s(lx - fixtW / 2), s(ly), s(fixtW), s(fixtH));
  // Center hotspot line — brighter
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = s(1.2);
  ctx.beginPath();
  ctx.moveTo(s(lx - fixtW / 2 + 8), s(ly + fixtH / 2));
  ctx.lineTo(s(lx + fixtW / 2 - 8), s(ly + fixtH / 2));
  ctx.stroke();
  // Bright glow halo around fixture
  const haloGrad = ctx.createRadialGradient(s(lx), s(ly + 2), s(8), s(lx), s(ly + 2), s(120));
  haloGrad.addColorStop(0, `rgba(${lt.glow},0.22)`);
  haloGrad.addColorStop(0.3, `rgba(${lt.glow},0.10)`);
  haloGrad.addColorStop(0.6, `rgba(${lt.glow},0.04)`);
  haloGrad.addColorStop(1, `rgba(${lt.glow},0)`);
  ctx.fillStyle = haloGrad;
  ctx.fillRect(s(lx - 120), s(ly - 50), s(240), s(130));
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
  const effectiveSpd = guardSlowTimer > 0 ? spd * 0.4 : spd;
  const step = effectiveSpd * dt;
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
    starData.wasNoticed = true;
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
  // Reset room items
  const roomItems = ROOM_ITEMS[currentRoom] || [];
  for (const item of roomItems) item.picked = false;
  // Keep inventory but clear active effects
  placedTraps = [];
  jammerActiveTimer = 0;
  guardSlowTimer = 0;
  inventoryOpen = false;
  selectedForCraft = [];
  resetStarTracking();
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
  // Reset items in new room
  const newRoomItems = ROOM_ITEMS[n] || [];
  for (const item of newRoomItems) item.picked = false;
  placedTraps = [];
  jammerActiveTimer = 0;
  guardSlowTimer = 0;
  inventoryOpen = false;
  selectedForCraft = [];
  resetStarTracking();
  // Rebuild 3D room
  if (scene3D) {
    createRoom3D(n);
  }
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
  // Full reset of inventory and items
  inventory.length = 0;
  inventoryOpen = false;
  selectedForCraft = [];
  placedTraps = [];
  jammerActiveTimer = 0;
  guardSlowTimer = 0;
  craftAnimTimer = 0;
  craftResult = null;
  for (const roomId in ROOM_ITEMS) {
    for (const item of ROOM_ITEMS[roomId]) item.picked = false;
  }
  resetStarTracking();
  starData.roomStars = { 1: 0, 2: 0, 3: 0 };
  starData.totalStars = 0;
  starData.showResult = false;
  // Rebuild 3D room
  if (scene3D) {
    createRoom3D(1);
  }
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

  // Palette — richer, more saturated colors
  const torsoHi  = isGuard ? '#555560' : '#6090d0';
  const torsoLo  = isGuard ? '#303038' : '#3860a0';
  const legHi    = isGuard ? '#3a3a42' : '#384878';
  const legLo    = isGuard ? '#222228' : '#243058';
  const armHi    = isGuard ? '#484850' : '#5080c0';
  const armLo    = isGuard ? '#2e2e36' : '#3868a8';
  const skinHi   = '#e4b080';
  const skinLo   = '#c89060';

  // Ground shadow — richer, more realistic
  ctx.save();
  const shGrad = ctx.createRadialGradient(cx, cy + sc * 2, 0, cx, cy + sc * 2, sc * 18);
  shGrad.addColorStop(0, 'rgba(0,0,0,0.45)');
  shGrad.addColorStop(0.3, 'rgba(0,0,0,0.25)');
  shGrad.addColorStop(0.7, 'rgba(0,0,0,0.10)');
  shGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = shGrad;
  ctx.beginPath();
  ctx.ellipse(cx, cy + sc * 2, sc * 18, sc * 7, 0, 0, Math.PI * 2);
  ctx.fill();
  // Contact ring — tight dark core at feet
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + sc * 2, sc * 8, sc * 3.5, 0, 0, Math.PI * 2);
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

  // Track room time for star rating
  if (!detected && !won) {
    starData.roomElapsed = gameTime - starData.roomStartTime;
  }

  // Star result display timer
  if (starData.showResult) {
    starData.resultTimer -= dt;
    if (starData.resultTimer <= 0) starData.showResult = false;
  }

  // Reset on R
  if (keys['r'] || keys['R']) {
    if (detected) {
      // Cancel lockpick if active
      lockpick.active = false;
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
  // Room 1: direct pickup (tutorial). Room 2+: requires lockpick mini-game
  if (!hasKeycard && !lockpick.active && player.currentHotspot && (keys['e'] || keys['E'] || keys[' '])) {
    const keycardHotspots = {
      1: 'r1_frontDesk',
      2: 'r2_frontBench',
      3: 'r3_frontTable',
    };
    if (player.currentHotspot === keycardHotspots[currentRoom]) {
      if (currentRoom === 1) {
        // Direct pickup for tutorial room
        hasKeycard = true;
      } else {
        // Start safe-cracking mini-game
        const tumblers = currentRoom === 2 ? 3 : 4;
        const time = currentRoom === 2 ? 18 : 15;
        startLockpick(tumblers, time, () => { hasKeycard = true; });
      }
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

  // Item pickup — press E at hotspot with item
  if (player.currentHotspot && (keys['e'] || keys['E'] || keys[' '])) {
    if (tryPickupItem()) {
      keys['e'] = false; keys['E'] = false; keys[' '] = false;
    }
  }

  // Toggle inventory with Tab or I
  if (framePressed['Tab'] || framePressed['i'] || framePressed['I']) {
    inventoryOpen = !inventoryOpen;
    selectedForCraft = [];
  }

  // Use selected item with U key
  if (framePressed['u'] || framePressed['U']) {
    if (inventoryOpen && selectedForCraft.length === 1) {
      const itemId = inventory[selectedForCraft[0]];
      if (useItem(itemId)) {
        selectedForCraft = [];
        if (inventory.length === 0) inventoryOpen = false;
      }
    }
  }

  // Update timers
  if (itemPickupAnim.active) {
    itemPickupAnim.timer -= dt;
    if (itemPickupAnim.timer <= 0) itemPickupAnim.active = false;
  }
  if (craftAnimTimer > 0) craftAnimTimer -= dt;
  if (jammerActiveTimer > 0) jammerActiveTimer -= dt;
  if (guardSlowTimer > 0) guardSlowTimer -= dt;

  // Update traps
  for (const trap of placedTraps) {
    if (trap.active) {
      trap.timer -= dt;
      if (trap.timer <= 0) { trap.active = false; continue; }
      // Check if guard walks over trap
      const td = Math.hypot(guard.u - trap.u, guard.v - trap.v);
      if (td < 0.08) {
        guardSlowTimer = 5;
        trap.active = false;
      }
    }
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
      // Calculate stars for completed room
      const stars = calculateStars();
      showStarResult(stars);
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

  // Lockpick mini-game update (guard still patrols but can't detect you while focused on lock)
  if (lockpick.active) {
    updateLockpick(dt);
    // Guard patrols but player is crouched/hidden at the lock — not detectable
    // (guard awareness is blocked by the lockpick state in guardAwareOfPlayer)
    updateGuard(dt);
    return;
  }

  // Guard AI (includes state machine: patrol → alert → suspicious → patrol, or caught)
  updateGuard(dt);
}

// ─── Inventory UI drawing ────────────────────────────────────────────────────
function drawFloorItems() {
  const items = getActiveRoomItems();
  for (const item of items) {
    if (item.picked) continue;
    const hs = getHotspot(item.hotspot);
    if (!hs) continue;
    const pos = floorToScreen(hs.u, hs.v);
    const ix = s(pos.x);
    const iy = s(pos.y) - s(20);
    const bob = Math.sin(gameTime * 3 + hs.u * 10) * 3;

    // Glow circle on floor
    const glowR = s(12);
    const glow = ctx.createRadialGradient(ix, iy + s(20), 0, ix, iy + s(20), glowR);
    glow.addColorStop(0, 'rgba(255,220,80,0.25)');
    glow.addColorStop(1, 'rgba(255,220,80,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.ellipse(ix, iy + s(20), glowR, glowR * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Item icon background
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.arc(ix, iy + bob * scale, s(10), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,220,80,0.6)';
    ctx.lineWidth = s(1.5);
    ctx.stroke();

    // Item icon (emoji)
    const itemDef = ITEMS[item.itemId];
    if (itemDef) {
      ctx.font = `${s(12)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.fillText(itemDef.icon, ix, iy + bob * scale);
    }
  }
}

function drawPickupAnimation() {
  if (!itemPickupAnim.active) return;
  const t = 1 - itemPickupAnim.timer / 0.8;
  const itemDef = ITEMS[itemPickupAnim.itemId];
  if (!itemDef) return;
  const ix = s(itemPickupAnim.x);
  const iy = s(itemPickupAnim.y) - t * s(60);
  const alpha = 1 - t;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `bold ${s(14)}px monospace`;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd740';
  ctx.fillText(`+ ${itemDef.name}`, ix, iy);
  ctx.restore();
}

function drawInventoryHUD() {
  // Mini inventory bar at bottom-right
  if (inventory.length === 0 && !inventoryOpen) return;

  const barX = s(1280 - 40 * Math.max(inventory.length, 1) - 10);
  const barY = s(660);
  const slotSize = s(32);
  const gap = s(6);

  // Background bar
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.beginPath();
  ctx.roundRect(barX - s(6), barY - s(4), inventory.length * (slotSize + gap) + s(12), slotSize + s(8), s(6));
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = s(1);
  ctx.stroke();

  // Inventory label
  ctx.font = `${s(9)}px monospace`;
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillText('[TAB] Inventory', barX - s(4), barY - s(8));

  for (let i = 0; i < inventory.length; i++) {
    const itemDef = ITEMS[inventory[i]];
    if (!itemDef) continue;
    const sx = barX + i * (slotSize + gap);

    // Slot background
    ctx.fillStyle = 'rgba(40,40,60,0.8)';
    ctx.beginPath();
    ctx.roundRect(sx, barY, slotSize, slotSize, s(4));
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,220,80,0.3)';
    ctx.lineWidth = s(1);
    ctx.stroke();

    // Icon
    ctx.font = `${s(16)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(itemDef.icon, sx + slotSize / 2, barY + slotSize / 2);
  }

  // Crafting panel (when inventory is open)
  if (inventoryOpen && inventory.length >= 2) {
    drawCraftingPanel();
  }
}

let craftHoverSlot = -1;
let selectedForCraft = [];

function drawCraftingPanel() {
  const panelW = s(280);
  const panelH = s(200);
  const px = s(640) - panelW / 2;
  const py = s(360) - panelH / 2;

  // Panel background
  ctx.fillStyle = 'rgba(10,10,20,0.9)';
  ctx.beginPath();
  ctx.roundRect(px, py, panelW, panelH, s(8));
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,220,80,0.3)';
  ctx.lineWidth = s(1.5);
  ctx.stroke();

  // Title
  ctx.font = `bold ${s(14)}px monospace`;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd740';
  ctx.fillText('CRAFTING', px + panelW / 2, py + s(22));

  ctx.font = `${s(10)}px monospace`;
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillText('Click two items to combine', px + panelW / 2, py + s(38));

  // Inventory grid
  const gridStartX = px + s(20);
  const gridStartY = py + s(50);
  const slotSize = s(36);
  const gap = s(8);
  const cols = 5;

  for (let i = 0; i < inventory.length; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const sx = gridStartX + col * (slotSize + gap);
    const sy = gridStartY + row * (slotSize + gap);

    const isSelected = selectedForCraft.includes(i);

    ctx.fillStyle = isSelected ? 'rgba(255,180,0,0.3)' : 'rgba(40,40,60,0.8)';
    ctx.beginPath();
    ctx.roundRect(sx, sy, slotSize, slotSize, s(4));
    ctx.fill();
    ctx.strokeStyle = isSelected ? '#ffd740' : 'rgba(255,255,255,0.2)';
    ctx.lineWidth = isSelected ? s(2) : s(1);
    ctx.stroke();

    const itemDef = ITEMS[inventory[i]];
    if (itemDef) {
      ctx.font = `${s(18)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.fillText(itemDef.icon, sx + slotSize / 2, sy + slotSize / 2);
    }
  }

  // Craft result animation
  if (craftAnimTimer > 0 && craftResult) {
    const itemDef = ITEMS[craftResult];
    if (itemDef) {
      const alpha = Math.min(craftAnimTimer / 0.5, 1);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = `bold ${s(16)}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#40ff40';
      ctx.fillText(`Crafted: ${itemDef.icon} ${itemDef.name}!`, px + panelW / 2, py + panelH - s(20));
      ctx.restore();
    }
  }

  // "Use" hint for usable items
  if (selectedForCraft.length === 1) {
    const selItem = inventory[selectedForCraft[0]];
    if (selItem === 'test_tube' || selItem === 'smoke' || selItem === 'trap' || selItem === 'jammer') {
      ctx.font = `${s(10)}px monospace`;
      ctx.fillStyle = '#80e0ff';
      ctx.textAlign = 'center';
      ctx.fillText(`Press [U] to use ${ITEMS[selItem].name}`, px + panelW / 2, py + panelH - s(8));
    }
  }
}

// ─── Render ──────────────────────────────────────────────────────────────────
// ─── Atmospheric post-processing ────────────────────────────────────────────
function drawAtmosphere() {
  // Three.js handles light pools via spotlights, so skip 2D light pools.

  // ── Proximity danger tint — more dramatic red haze ──
  const du = player.u - guard.u;
  const dv = player.v - guard.v;
  const dist = Math.hypot(du, dv);
  if (dist < 0.35 && !detected && !won && !playerHidden) {
    const intensity = Math.max(0, 1 - dist / 0.35) * 0.30;
    ctx.fillStyle = `rgba(200,20,0,${intensity.toFixed(3)})`;
    ctx.fillRect(0, 0, s(1280), s(720));
    // Pulsing edge glow — more dramatic
    const pulse = 0.5 + Math.sin(gameTime * 6) * 0.5;
    const edgeGrad = ctx.createRadialGradient(
      s(640), s(360), s(180),
      s(640), s(360), s(640)
    );
    edgeGrad.addColorStop(0, 'rgba(200,20,0,0)');
    edgeGrad.addColorStop(1, `rgba(200,20,0,${(intensity * pulse * 0.5).toFixed(3)})`);
    ctx.fillStyle = edgeGrad;
    ctx.fillRect(0, 0, s(1280), s(720));
  }

  // ── Heavy cinematic vignette — deep, rich darkness at edges ──
  const vigW = s(1280), vigH = s(720);
  const vigGrad = ctx.createRadialGradient(
    vigW / 2, vigH / 2, Math.min(vigW, vigH) * 0.22,
    vigW / 2, vigH / 2, Math.max(vigW, vigH) * 0.68
  );
  vigGrad.addColorStop(0, 'rgba(0,0,0,0)');
  vigGrad.addColorStop(0.4, 'rgba(0,0,0,0.10)');
  vigGrad.addColorStop(0.7, 'rgba(0,0,0,0.30)');
  vigGrad.addColorStop(0.9, 'rgba(0,0,0,0.50)');
  vigGrad.addColorStop(1, 'rgba(0,0,0,0.65)');
  ctx.fillStyle = vigGrad;
  ctx.fillRect(0, 0, vigW, vigH);

  // ── Film grain — subtle noise for cinematic feel ──
  ctx.save();
  ctx.globalAlpha = 0.035;
  for (let i = 0; i < 120; i++) {
    const gx = Math.random() * 1280;
    const gy = Math.random() * 720;
    const gs = 1 + Math.random() * 2.5;
    ctx.fillStyle = Math.random() > 0.5 ? '#fff' : '#000';
    ctx.fillRect(s(gx), s(gy), s(gs), s(gs));
  }
  ctx.restore();
}

function render() {
  // ─── Three.js 3D rendering ──────────────────────────────────────────────────
  if (renderer3D && scene3D && camera3D) {
    try {
      // Update 3D character models
      if (playerModel) {
        playerModel.visible = !playerHidden;
        if (!playerHidden) {
          updateCharacterModel(playerModel, player.u, player.v, player.facing, player.walkPhase);
        }
      }
      if (guardModel) {
        updateCharacterModel(guardModel, guard.u, guard.v, guard.facing, guard.walkPhase);
      }
      // Keycard 3D: hide when picked, bob when visible
      if (keycardMesh3D) {
        keycardMesh3D.visible = !hasKeycard;
        if (!hasKeycard) {
          keycardMesh3D.position.y = 0.98 + Math.sin(gameTime * 3) * 0.05;
          keycardMesh3D.rotation.y = gameTime * 0.5;
        }
      }
      updateExitLight();
      renderer3D.render(scene3D, camera3D);
    } catch (e) {
      // Show render error on UI canvas
      ctx.fillStyle = '#ff4040';
      ctx.font = '16px monospace';
      ctx.fillText('Render error: ' + e.message, 20, 60);
    }
  }

  // ─── 2D UI overlay on uiCanvas ──────────────────────────────────────────────
  ctx.clearRect(0, 0, W, H);

  ctx.save();
  ctx.translate((W - 1280 * scale) / 2, (H - 720 * scale) / 2);

  // Guard vision cone (2D overlay on floor)
  drawGuardVision();

  // Collectible items on the floor (2D icons)
  drawFloorItems();

  // Placed traps visualization
  for (const trap of placedTraps) {
    if (!trap.active) continue;
    const tp = floorToScreen(trap.u, trap.v);
    const tGlow = ctx.createRadialGradient(s(tp.x), s(tp.y), 0, s(tp.x), s(tp.y), s(15));
    tGlow.addColorStop(0, 'rgba(255,100,0,0.3)');
    tGlow.addColorStop(1, 'rgba(255,100,0,0)');
    ctx.fillStyle = tGlow;
    ctx.beginPath();
    ctx.ellipse(s(tp.x), s(tp.y), s(15), s(8), 0, 0, Math.PI * 2);
    ctx.fill();
  }

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
      const kcText = currentRoom === 1 ? '[E] Pick up keycard' : '[E] Crack the safe';
      drawPrompt(kcText, '#80e0ff', player.u, player.v - 0.06);
    }

    // Exit prompt
    if (hasKeycard && hs === exitHotspots[currentRoom]) {
      drawPrompt('[E] Use exit', '#60ff60', player.u, player.v - 0.06);
    }

    // Spool knock prompt (Room 2) — use smaller v offset to avoid prompt clipping into wall
    if (currentRoom === 2 && !spoolKnocked && hs === 'r2_frontSpool') {
      drawPrompt('[E] Knock spool', '#ffc040', player.u, player.v - 0.02);
    }

    // Locker hide prompt (Room 3)
    if (currentRoom === 3 && !playerHidden && hs === 'r3_nearLocker') {
      drawPrompt('[E] Hide in locker', '#ffc040', player.u, player.v - 0.06);
    }

    // Item pickup prompt
    const roomItems = getActiveRoomItems();
    for (const item of roomItems) {
      if (!item.picked && item.hotspot === hs) {
        const itemDef = ITEMS[item.itemId];
        if (itemDef) {
          drawPrompt(`[E] Pick up ${itemDef.name}`, '#ffd740', player.u, player.v - 0.10);
        }
      }
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
    ctx.fillText('MISSION COMPLETE', s(640), s(310));

    // Show per-room stars
    ctx.font = `${s(20)}px sans-serif`;
    ctx.fillStyle = '#ffd740';
    for (let r = 1; r <= 3; r++) {
      const rs = starData.roomStars[r] || 0;
      const starStr = '★'.repeat(rs) + '☆'.repeat(3 - rs);
      ctx.fillText(`Room ${r}: ${starStr}`, s(640), s(345 + (r - 1) * 28));
    }
    ctx.font = `bold ${s(16)}px monospace`;
    ctx.fillStyle = '#ffd740';
    ctx.fillText(`Total: ${starData.totalStars} / 9 Stars`, s(640), s(430));

    ctx.fillStyle = '#ffffff';
    ctx.font = `${s(14)}px monospace`;
    ctx.fillText('Press R to play again', s(640), s(460));
  }

  // Atmospheric post-processing
  drawAtmosphere();

  // Lockpick mini-game overlay
  drawLockpick();

  // Item pickup animation
  drawPickupAnimation();

  // Inventory HUD
  drawInventoryHUD();

  // Star rating HUD (top-left)
  if (!detected && !won) {
    ctx.textAlign = 'left';
    // Total stars across all rooms
    ctx.font = `bold ${s(13)}px monospace`;
    ctx.fillStyle = 'rgba(255,220,80,0.7)';
    const starText = '★'.repeat(starData.totalStars) + '☆'.repeat(9 - starData.totalStars);
    ctx.fillText(starText, s(30), s(25));
    // Current room timer
    ctx.font = `${s(11)}px monospace`;
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    const elapsed = Math.floor(starData.roomElapsed);
    const target = STAR_TARGETS[currentRoom];
    const timeColor = target && elapsed <= target.time ? 'rgba(100,255,100,0.5)' : 'rgba(255,100,100,0.5)';
    ctx.fillStyle = timeColor;
    ctx.fillText(`${elapsed}s`, s(30), s(42));
    if (target) {
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillText(` / ${target.time}s`, s(30 + ctx.measureText(`${elapsed}s`).width / scale), s(42));
    }
  }

  // Star result popup (when completing a room)
  if (starData.showResult) {
    const alpha = Math.min(starData.resultTimer / 0.5, 1) * 0.95;
    ctx.save();
    ctx.globalAlpha = alpha;
    const rpW = 220, rpH = 80;
    const rpX = 640 - rpW / 2, rpY = 120;
    ctx.fillStyle = 'rgba(10,10,20,0.9)';
    ctx.beginPath();
    ctx.roundRect(s(rpX), s(rpY), s(rpW), s(rpH), s(8));
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,220,80,0.4)';
    ctx.lineWidth = s(1.5);
    ctx.stroke();
    // Stars
    ctx.font = `${s(28)}px sans-serif`;
    ctx.textAlign = 'center';
    const starStr = '★'.repeat(starData.earnedStars) + '☆'.repeat(3 - starData.earnedStars);
    ctx.fillStyle = '#ffd740';
    ctx.fillText(starStr, s(640), s(rpY + 38));
    // Label
    ctx.font = `${s(11)}px monospace`;
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    const labels = { 1: 'Complete', 2: 'Speed Run', 3: 'Ghost' };
    ctx.fillText(labels[starData.earnedStars] || 'Complete', s(640), s(rpY + 60));
    ctx.restore();
  }

  // Win overlay — show final star count
  // (this overrides the generic win text below if stars are displayed)

  // Jammer active indicator
  if (jammerActiveTimer > 0) {
    ctx.font = `bold ${s(12)}px monospace`;
    ctx.textAlign = 'right';
    ctx.fillStyle = `rgba(0,200,255,${0.5 + Math.sin(gameTime * 4) * 0.3})`;
    ctx.fillText(`JAMMER: ${Math.ceil(jammerActiveTimer)}s`, s(1250), s(30));
  }

  // Guard slow indicator
  if (guardSlowTimer > 0) {
    ctx.font = `bold ${s(12)}px monospace`;
    ctx.textAlign = 'right';
    ctx.fillStyle = `rgba(255,150,0,${0.5 + Math.sin(gameTime * 4) * 0.3})`;
    ctx.fillText(`TRAP ACTIVE: ${Math.ceil(guardSlowTimer)}s`, s(1250), s(48));
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

// Initialize Three.js before starting the game loop
if (typeof THREE !== 'undefined') {
  try {
    initThreeJS();
  } catch (e) {
    console.error('Three.js init failed:', e);
    ctx.fillStyle = '#ff4040';
    ctx.font = '20px monospace';
    ctx.fillText('Three.js init failed: ' + e.message, 20, 40);
  }
} else {
  console.error('THREE is not defined — CDN may have failed to load');
  ctx.fillStyle = '#ff4040';
  ctx.font = '20px monospace';
  ctx.fillText('Error: Three.js library failed to load', 20, 40);
  ctx.fillStyle = '#aaa';
  ctx.font = '14px monospace';
  ctx.fillText('Check network connection / CDN availability', 20, 70);
}

function loop(timestamp) {
  const dt = Math.min((timestamp - lastTime) / 1000, 0.05);
  lastTime = timestamp;
  update(dt);
  render();
  requestAnimationFrame(loop);
}

requestAnimationFrame(ts => { lastTime = ts; requestAnimationFrame(loop); });
