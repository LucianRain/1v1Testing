import * as THREE from 'three';
import { PeerNetwork, formatRoomCode, toPeerId } from './network.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ARENA_HALF = 18;
const MOVE_SPEED = 9;
const PLAYER_RADIUS = 0.6;
const PROJECTILE_SPEED = 26;
const PROJECTILE_RADIUS = 0.15;
const SHOOT_COOLDOWN = 0.35;
const MAX_HP = 100;
const DAMAGE_PER_HIT = 12;
const STATE_SEND_HZ = 25;
const OBSTACLES = [
  { x: 6, z: 4, w: 2.5, h: 1.6, d: 2.5 },
  { x: -6, z: -4, w: 2.5, h: 1.6, d: 2.5 },
  { x: -7, z: 6, w: 2, h: 1.2, d: 2 },
  { x: 7, z: -6, w: 2, h: 1.2, d: 2 },
];

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const canvas = document.getElementById('game-canvas');
const hud = document.getElementById('hud');
const crosshair = document.getElementById('crosshair');
const menuOverlay = document.getElementById('menu-overlay');
const gameoverOverlay = document.getElementById('gameover-overlay');
const gameoverTitle = document.getElementById('gameover-title');
const connLostOverlay = document.getElementById('conn-lost-overlay');
const hpMeEl = document.getElementById('hp-me');
const hpThemEl = document.getElementById('hp-them');

const btnHost = document.getElementById('btn-host');
const btnJoin = document.getElementById('btn-join');
const btnRematch = document.getElementById('btn-rematch');
const btnReload = document.getElementById('btn-reload');
const hostCodeWrap = document.getElementById('host-code-wrap');
const hostCodeEl = document.getElementById('host-code');
const hostStatusEl = document.getElementById('host-status');
const joinCodeInput = document.getElementById('join-code-input');
const joinStatusEl = document.getElementById('join-status');

hud.classList.add('hidden');
crosshair.classList.add('hidden');

// ---------------------------------------------------------------------------
// Three.js scene setup
// ---------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x11111a);
scene.fog = new THREE.Fog(0x11111a, 30, 60);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 200);

const hemiLight = new THREE.HemisphereLight(0x8899ff, 0x111122, 0.9);
scene.add(hemiLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
dirLight.position.set(10, 20, 8);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
dirLight.shadow.camera.left = -25;
dirLight.shadow.camera.right = 25;
dirLight.shadow.camera.top = 25;
dirLight.shadow.camera.bottom = -25;
scene.add(dirLight);

// Ground
const groundGeo = new THREE.PlaneGeometry(ARENA_HALF * 2, ARENA_HALF * 2);
const groundMat = new THREE.MeshStandardMaterial({ color: 0x22232f, roughness: 0.9 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(ARENA_HALF * 2, 24, 0x3a3b52, 0x2a2b3d);
grid.position.y = 0.01;
scene.add(grid);

// Boundary walls (visual only, movement is clamped in code)
const wallMat = new THREE.MeshStandardMaterial({ color: 0x3a3b52, roughness: 0.8 });
const wallHeight = 2;
[
  [0, -ARENA_HALF, ARENA_HALF * 2, 0.4],
  [0, ARENA_HALF, ARENA_HALF * 2, 0.4],
  [-ARENA_HALF, 0, 0.4, ARENA_HALF * 2],
  [ARENA_HALF, 0, 0.4, ARENA_HALF * 2],
].forEach(([x, z, w, d]) => {
  const wall = new THREE.Mesh(new THREE.BoxGeometry(w, wallHeight, d), wallMat);
  wall.position.set(x, wallHeight / 2, z);
  wall.castShadow = true;
  wall.receiveShadow = true;
  scene.add(wall);
});

// Obstacles
const obstacleMat = new THREE.MeshStandardMaterial({ color: 0x4a4b66, roughness: 0.7 });
OBSTACLES.forEach((o) => {
  const box = new THREE.Mesh(new THREE.BoxGeometry(o.w, o.h, o.d), obstacleMat);
  box.position.set(o.x, o.h / 2, o.z);
  box.castShadow = true;
  box.receiveShadow = true;
  scene.add(box);
});

function makePlayerMesh(color) {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(PLAYER_RADIUS, 0.9, 6, 12),
    new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.1 })
  );
  body.position.y = 1.05;
  body.castShadow = true;
  group.add(body);

  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.18, 0.5, 8),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 })
  );
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 1.05, 0.75);
  group.add(nose);

  return group;
}

const meMesh = makePlayerMesh(0x4aa8ff);
const themMesh = makePlayerMesh(0xff5566);
themMesh.visible = false;
scene.add(meMesh, themMesh);

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

const net = new PeerNetwork();

const me = {
  pos: new THREE.Vector3(0, 0, 8),
  yaw: Math.PI,
  hp: MAX_HP,
  shootCooldown: 0,
  alive: true,
};

const them = {
  pos: new THREE.Vector3(0, 0, -8),
  yaw: 0,
  hp: MAX_HP,
  alive: true,
  lastUpdate: 0,
};

const keys = { w: false, a: false, s: false, d: false };
const mouseWorld = new THREE.Vector3();
const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const mouseNdc = new THREE.Vector2();

let projectileId = 0;
const myProjectiles = new Map(); // id -> {mesh, dir, alive}
const theirProjectiles = new Map();

let gameActive = false;
let stateSendAccum = 0;
let camSide = 1; // which way the chase camera sits relative to the player, based on spawn side
const clock = new THREE.Clock();

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

window.addEventListener('keydown', (e) => setKey(e.code, true));
window.addEventListener('keyup', (e) => setKey(e.code, false));

function setKey(code, val) {
  if (code === 'KeyW' || code === 'ArrowUp') keys.w = val;
  if (code === 'KeyS' || code === 'ArrowDown') keys.s = val;
  if (code === 'KeyA' || code === 'ArrowLeft') keys.a = val;
  if (code === 'KeyD' || code === 'ArrowRight') keys.d = val;
}

window.addEventListener('mousemove', (e) => {
  mouseNdc.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouseNdc.y = -(e.clientY / window.innerHeight) * 2 + 1;
});

window.addEventListener('mousedown', (e) => {
  if (e.button === 0 && gameActive) tryShoot();
});

// ---------------------------------------------------------------------------
// Networking wiring
// ---------------------------------------------------------------------------

net.addEventListener('connected', () => {
  hostStatusEl.textContent = 'Opponent connected! Starting...';
  joinStatusEl.textContent = 'Connected! Starting...';
  setTimeout(startGame, 500);
});

net.addEventListener('close', () => {
  if (gameActive) {
    gameActive = false;
    connLostOverlay.classList.remove('hidden');
  }
});

net.addEventListener('data', (e) => {
  const msg = e.detail;
  switch (msg.t) {
    case 'state':
      them.pos.set(msg.x, 0, msg.z);
      them.yaw = msg.ry;
      them.lastUpdate = performance.now();
      break;
    case 'shoot':
      spawnProjectile(theirProjectiles, new THREE.Vector3(msg.x, 0.9, msg.z), new THREE.Vector3(msg.dx, 0, msg.dz), 0xff5566);
      break;
    case 'hp':
      them.hp = msg.hp;
      updateHpBars();
      break;
    case 'dead':
      onOpponentDead();
      break;
    case 'rematch':
      resetLocalState();
      gameoverOverlay.classList.add('hidden');
      connLostOverlay.classList.add('hidden');
      if (!gameActive) {
        gameActive = true;
        clock.getDelta(); // discard the paused-time delta
        animate();
      }
      break;
    default:
      break;
  }
});

btnHost.addEventListener('click', async () => {
  btnHost.disabled = true;
  hostStatusEl.textContent = 'Creating room...';
  try {
    const id = await net.host();
    hostCodeWrap.classList.remove('hidden');
    hostCodeEl.textContent = formatRoomCode(id);
    hostStatusEl.textContent = 'Waiting for opponent to join...';
    hostCodeEl.addEventListener('click', () => {
      navigator.clipboard?.writeText(formatRoomCode(id)).catch(() => {});
    });
  } catch (err) {
    hostStatusEl.textContent = `Error: ${err.message || err}`;
    btnHost.disabled = false;
  }
});

btnJoin.addEventListener('click', async () => {
  const code = joinCodeInput.value.trim();
  if (!code) {
    joinStatusEl.textContent = 'Enter a room code first.';
    return;
  }
  btnJoin.disabled = true;
  joinStatusEl.textContent = 'Connecting...';
  try {
    await net.join(toPeerId(code));
  } catch (err) {
    joinStatusEl.textContent = `Error: ${err.message || err}`;
    btnJoin.disabled = false;
  }
});

btnRematch.addEventListener('click', () => {
  resetLocalState();
  net.send({ t: 'rematch' });
  gameoverOverlay.classList.add('hidden');
  if (!gameActive) {
    gameActive = true;
    clock.getDelta();
    animate();
  }
});

btnReload.addEventListener('click', () => window.location.reload());

// ---------------------------------------------------------------------------
// Game flow
// ---------------------------------------------------------------------------

function startGame() {
  resetLocalState();
  them.pos.set(0, 0, net.role === 'host' ? -8 : 8);
  them.yaw = net.role === 'host' ? 0 : Math.PI;
  camSide = net.role === 'host' ? 1 : -1;
  menuOverlay.classList.add('hidden');
  hud.classList.remove('hidden');
  crosshair.classList.remove('hidden');
  themMesh.visible = true;
  gameActive = true;
  updateHpBars();
  clock.start();
  animate();
}

function resetLocalState() {
  me.pos.set(0, 0, net.role === 'host' ? 8 : -8);
  me.yaw = net.role === 'host' ? Math.PI : 0;
  me.hp = MAX_HP;
  me.alive = true;
  myProjectiles.forEach((p) => scene.remove(p.mesh));
  myProjectiles.clear();
  theirProjectiles.forEach((p) => scene.remove(p.mesh));
  theirProjectiles.clear();
  updateHpBars();
}

function onOpponentDead() {
  if (!gameActive) return;
  gameActive = false;
  gameoverTitle.textContent = 'You Win!';
  gameoverOverlay.classList.remove('hidden');
}

function onSelfDead() {
  gameActive = false;
  net.send({ t: 'dead' });
  gameoverTitle.textContent = 'You Lose';
  gameoverOverlay.classList.remove('hidden');
}

function updateHpBars() {
  hpMeEl.style.width = `${Math.max(0, me.hp)}%`;
  hpThemEl.style.width = `${Math.max(0, them.hp)}%`;
}

// ---------------------------------------------------------------------------
// Shooting / projectiles
// ---------------------------------------------------------------------------

function tryShoot() {
  if (me.shootCooldown > 0 || !me.alive) return;
  me.shootCooldown = SHOOT_COOLDOWN;

  const dir = new THREE.Vector3(Math.sin(me.yaw), 0, Math.cos(me.yaw));
  const origin = new THREE.Vector3(me.pos.x, 0.9, me.pos.z).addScaledVector(dir, PLAYER_RADIUS + 0.3);

  spawnProjectile(myProjectiles, origin, dir, 0x4aa8ff);
  net.send({ t: 'shoot', x: origin.x, z: origin.z, dx: dir.x, dz: dir.z });
}

function spawnProjectile(map, origin, dir, color) {
  const geo = new THREE.SphereGeometry(PROJECTILE_RADIUS, 8, 8);
  const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.5 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(origin);
  scene.add(mesh);
  const id = projectileId++;
  map.set(id, { mesh, dir: dir.clone(), life: 3 });
}

function updateProjectiles(dt) {
  updateProjectileSet(myProjectiles, dt, null); // my shots don't damage me
  updateProjectileSet(theirProjectiles, dt, me); // their shots can hit me
}

function updateProjectileSet(map, dt, hittable) {
  for (const [id, p] of map) {
    p.mesh.position.addScaledVector(p.dir, PROJECTILE_SPEED * dt);
    p.life -= dt;

    let remove = false;

    if (p.life <= 0) remove = true;
    if (Math.abs(p.mesh.position.x) > ARENA_HALF || Math.abs(p.mesh.position.z) > ARENA_HALF) remove = true;

    for (const o of OBSTACLES) {
      if (
        p.mesh.position.x > o.x - o.w / 2 &&
        p.mesh.position.x < o.x + o.w / 2 &&
        p.mesh.position.z > o.z - o.d / 2 &&
        p.mesh.position.z < o.z + o.d / 2
      ) {
        remove = true;
      }
    }

    if (hittable && hittable.alive) {
      const dx = p.mesh.position.x - hittable.pos.x;
      const dz = p.mesh.position.z - hittable.pos.z;
      if (dx * dx + dz * dz < (PLAYER_RADIUS + PROJECTILE_RADIUS) ** 2) {
        remove = true;
        applyDamageToMe(DAMAGE_PER_HIT);
      }
    }

    if (remove) {
      scene.remove(p.mesh);
      map.delete(id);
    }
  }
}

function applyDamageToMe(amount) {
  if (!me.alive) return;
  me.hp = Math.max(0, me.hp - amount);
  updateHpBars();
  net.send({ t: 'hp', hp: me.hp });
  if (me.hp <= 0) {
    me.alive = false;
    onSelfDead();
  }
}

// ---------------------------------------------------------------------------
// Movement / aiming
// ---------------------------------------------------------------------------

function updateAim() {
  raycaster.setFromCamera(mouseNdc, camera);
  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(groundPlane, hit)) {
    mouseWorld.copy(hit);
    const dx = mouseWorld.x - me.pos.x;
    const dz = mouseWorld.z - me.pos.z;
    me.yaw = Math.atan2(dx, dz);
  }
}

function updateMovement(dt) {
  let mx = 0;
  let mz = 0;
  if (keys.w) mz -= 1;
  if (keys.s) mz += 1;
  if (keys.a) mx -= 1;
  if (keys.d) mx += 1;

  if (mx !== 0 || mz !== 0) {
    const len = Math.hypot(mx, mz);
    mx /= len;
    mz /= len;

    const nextX = me.pos.x + mx * MOVE_SPEED * dt;
    const nextZ = me.pos.z + mz * MOVE_SPEED * dt;

    if (!collidesObstacle(nextX, me.pos.z)) me.pos.x = nextX;
    if (!collidesObstacle(me.pos.x, nextZ)) me.pos.z = nextZ;

    me.pos.x = THREE.MathUtils.clamp(me.pos.x, -ARENA_HALF + PLAYER_RADIUS, ARENA_HALF - PLAYER_RADIUS);
    me.pos.z = THREE.MathUtils.clamp(me.pos.z, -ARENA_HALF + PLAYER_RADIUS, ARENA_HALF - PLAYER_RADIUS);
  }
}

function collidesObstacle(x, z) {
  for (const o of OBSTACLES) {
    const halfW = o.w / 2 + PLAYER_RADIUS;
    const halfD = o.d / 2 + PLAYER_RADIUS;
    if (x > o.x - halfW && x < o.x + halfW && z > o.z - halfD && z < o.z + halfD) {
      return true;
    }
  }
  return false;
}

function updateCamera() {
  camera.position.set(me.pos.x, 13, me.pos.z + camSide * 9);
  camera.lookAt(me.pos.x, 1, me.pos.z);
}

// ---------------------------------------------------------------------------
// Sync meshes
// ---------------------------------------------------------------------------

function syncMeshes() {
  meMesh.position.set(me.pos.x, 0, me.pos.z);
  meMesh.rotation.y = me.yaw;

  themMesh.position.set(them.pos.x, 0, them.pos.z);
  themMesh.rotation.y = them.yaw;
  themMesh.visible = them.alive;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

function animate() {
  if (!gameActive) {
    // keep rendering a still frame for overlays, but stop the loop otherwise
    if (!gameoverOverlay.classList.contains('hidden') || !connLostOverlay.classList.contains('hidden')) {
      renderer.render(scene, camera);
    }
    return;
  }

  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);

  if (me.shootCooldown > 0) me.shootCooldown -= dt;

  updateAim();
  updateMovement(dt);
  updateProjectiles(dt);
  syncMeshes();
  updateCamera();

  stateSendAccum += dt;
  if (stateSendAccum >= 1 / STATE_SEND_HZ) {
    stateSendAccum = 0;
    net.send({ t: 'state', x: me.pos.x, z: me.pos.z, ry: me.yaw });
  }

  renderer.render(scene, camera);
}

// Kick off an initial static render so the arena is visible behind the menu.
camera.position.set(0, 13, 9);
camera.lookAt(0, 1, 0);
renderer.render(scene, camera);
