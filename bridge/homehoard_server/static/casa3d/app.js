// La casa en 3D. Pinta la escena que calcula el servidor (GET /api/house3d/scene) a partir del plano 2D: no hay
// geometría propia aquí, solo cajas, cámara y lo que se puede hacer con ellas (buscar, abrir fichas, pasear, exportar).
import * as THREE from './vendor/three/three.module.min.js';

const params = new URLSearchParams(location.search);
const EMBED = params.has('embed');
const $ = (id) => document.getElementById(id);
const root = document.documentElement;
try { if (localStorage.getItem('homehoard.theme') === 'light') root.dataset.theme = 'light'; } catch { /* sin almacenamiento */ }
if (EMBED) root.classList.add('embed');
const LIGHT = root.dataset.theme === 'light';
const css = (name) => getComputedStyle(root).getPropertyValue(name).trim();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n, d = 1) => Number(n).toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d });

async function api(path, body) {
  const res = await fetch(path, body === undefined ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// ---------------------------------------------------------------------------- estado
const canvas = $('view');
const labelsEl = $('labels');
const state = { data: null, version: null, mode: 'orbit', walls: 'cut', tags: false, floor: null, edit: null, selected: null, hovered: null, found: null };
const STATUS_COLOR = { ok: 0x3d8fd6, due: 0xd4a843, overdue: 0xd8432f };
const FURNITURE_COLOR = { fridge: 0xcfd6d8, box: 0xb9995f, shelf: 0x96693f, wardrobe: 0x8e6238, closet: 0x8e6238, chest: 0x7d5a38, nightstand: 0xa57a4c };
const KIND_LABEL = { wardrobe: 'Armario', dresser: 'Cómoda', drawer: 'Cajón', shelf: 'Estantería', cabinet: 'Alacena', box: 'Caja', fridge: 'Nevera',
  nightstand: 'Mesita', chest: 'Baúl', desk: 'Escritorio', closet: 'Armario' };
const SIDE_LABEL = { n: 'norte', e: 'este', s: 'sur', w: 'oeste' };
const CUT_INTERIOR = 1.05, CUT_NEAR = 0.22, EYE = 1.6, BODY = 0.3, ORBIT_FOV = 46, WALK_FOV = 68;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(css('--bg'));
const camera = new THREE.PerspectiveCamera(ORBIT_FOV, 1, 0.05, 400);
const hemi = new THREE.HemisphereLight(0xffffff, LIGHT ? 0xb9ad9a : 0x6f6457, LIGHT ? 2.0 : 1.7);
const sun = new THREE.DirectionalLight(0xfff0db, LIGHT ? 2.3 : 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(hemi, sun, sun.target);
const BOX = new THREE.BoxGeometry(1, 1, 1);
const raycaster = new THREE.Raycaster();
let world = null;
let ground = null;
let walls = [];        // {wall, floor, parts:[{mesh, box}], cap, goal, cx, cz}
let pickables = [];
let labels = [];       // {el, pos, show}
const itemsById = new Map(), furnitureById = new Map(), roomsById = new Map(), openingsById = new Map(), floorsById = new Map();
let colliders = [];    // {floor, x0, x1, z0, z1}
let beam = null;

// ---------------------------------------------------------------------------- cámara
const orbit = { target: new THREE.Vector3(), radius: 12, theta: 0.6, phi: 0.95 };
const orbitGoal = { target: new THREE.Vector3(), radius: 12, theta: 0.6, phi: 0.95 };
const walk = { pos: new THREE.Vector3(), yaw: 0, pitch: -0.08, floor: null };
const walkGoal = { pos: null, yaw: null };
const keys = new Set();

function frameAll(instant) {
  const b = boundsOfView();
  if (!b) return;
  orbitGoal.target.set((b.min.x + b.max.x) / 2, b.min.y + 0.3, (b.min.z + b.max.z) / 2);
  const sphere = 0.5 * Math.hypot(b.max.x - b.min.x, b.max.z - b.min.z, b.max.y - b.min.y);
  const aspect = Math.max(0.4, canvas.clientWidth / Math.max(1, canvas.clientHeight));
  const half = THREE.MathUtils.degToRad(ORBIT_FOV / 2);
  orbitGoal.radius = Math.min(Math.max(sphere / Math.sin(Math.min(half, Math.atan(Math.tan(half) * aspect))) * 0.9, 5), 140);
  orbitGoal.theta = 0.5;
  orbitGoal.phi = 0.8;
  if (instant) copyOrbit(orbit, orbitGoal);
}

function boundsOfView() {
  const d = state.data;
  if (!d || !d.bounds) return null;
  const floors = d.floors.filter((f) => !state.floor || f.id === state.floor);
  const box = new THREE.Box3();
  for (const f of floors) for (const r of f.rooms) {
    box.expandByPoint(new THREE.Vector3(r.rect.x0, f.elevation, r.rect.z0));
    box.expandByPoint(new THREE.Vector3(r.rect.x1, f.elevation + f.height, r.rect.z1));
  }
  return box.isEmpty() ? null : box;
}

function copyOrbit(a, b) { a.target.copy(b.target); a.radius = b.radius; a.theta = b.theta; a.phi = b.phi; }

function orbitFromPose(position, target) {
  const v = new THREE.Vector3().subVectors(new THREE.Vector3(...position), new THREE.Vector3(...target));
  const r = Math.max(v.length(), 0.5);
  return { target: new THREE.Vector3(...target), radius: r, theta: Math.atan2(v.x, v.z), phi: Math.acos(THREE.MathUtils.clamp(v.y / r, -1, 1)) };
}

function flyOrbit(pose) {
  orbitGoal.target.copy(pose.target);
  orbitGoal.radius = pose.radius;
  orbitGoal.phi = THREE.MathUtils.clamp(pose.phi, 0.12, 1.45);
  // el camino corto alrededor de la casa
  let d = pose.theta - orbit.theta;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  orbitGoal.theta = orbit.theta + d;
}

function updateCamera(dt) {
  const k = 1 - Math.exp(-dt * 7);
  if (state.mode === 'orbit') {
    orbit.target.lerp(orbitGoal.target, k);
    orbit.radius += (orbitGoal.radius - orbit.radius) * k;
    orbit.theta += (orbitGoal.theta - orbit.theta) * k;
    orbit.phi += (orbitGoal.phi - orbit.phi) * k;
    const s = Math.sin(orbit.phi);
    camera.position.set(orbit.target.x + orbit.radius * s * Math.sin(orbit.theta), orbit.target.y + orbit.radius * Math.cos(orbit.phi),
      orbit.target.z + orbit.radius * s * Math.cos(orbit.theta));
    camera.lookAt(orbit.target);
    return;
  }
  if (walkGoal.pos) {
    walk.pos.lerp(walkGoal.pos, k);
    if (walk.pos.distanceTo(walkGoal.pos) < 0.02) walkGoal.pos = null;
  }
  if (walkGoal.yaw !== null) {
    let d = walkGoal.yaw - walk.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    walk.yaw += d * k;
    if (Math.abs(d) < 0.01) walkGoal.yaw = null;
  }
  const turn = (keys.has('turnleft') ? 1 : 0) - (keys.has('turnright') ? 1 : 0);
  if (turn) { walk.yaw += turn * dt * 1.9; walkGoal.yaw = null; }
  const ahead = (keys.has('forward') ? 1 : 0) - (keys.has('back') ? 1 : 0);
  const side = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
  if (ahead || side) {
    walkGoal.pos = null;
    const speed = (keys.has('fast') ? 4.2 : 2.1) * dt / Math.hypot(ahead, side);
    const fx = -Math.sin(walk.yaw), fz = -Math.cos(walk.yaw);
    stepWalk((fx * ahead - fz * side) * speed, (fz * ahead + fx * side) * speed);
  }
  camera.position.copy(walk.pos);
  camera.rotation.set(walk.pitch, walk.yaw, 0, 'YXZ');
}

function blocked(x, z) {
  for (const c of colliders) {
    if (c.floor !== walk.floor) continue;
    const dx = x - Math.max(c.x0, Math.min(x, c.x1)), dz = z - Math.max(c.z0, Math.min(z, c.z1));
    if (dx * dx + dz * dz < BODY * BODY) return true;
  }
  return false;
}

function stepWalk(dx, dz) {
  const free = blocked(walk.pos.x, walk.pos.z);     // dentro de un mueble (tras un salto): se deja salir
  if (free || !blocked(walk.pos.x + dx, walk.pos.z)) walk.pos.x += dx;
  if (free || !blocked(walk.pos.x, walk.pos.z + dz)) walk.pos.z += dz;
}

// ---------------------------------------------------------------------------- construir la escena
function mat(color, extra) { return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...extra }); }

function boxMesh(min, max, material) {
  const mesh = new THREE.Mesh(BOX, material);
  mesh.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  mesh.scale.set(Math.max(max[0] - min[0], 0.001), Math.max(max[1] - min[1], 0.001), Math.max(max[2] - min[2], 0.001));
  return mesh;
}

// Un mueble es la caja del plano con algo de forma: la estantería enseña sus baldas, el armario y la nevera sus puertas.
function furnitureMesh(f) {
  const color = FURNITURE_COLOR[f.kind] ?? 0xa67c52;
  const w = f.box.max[0] - f.box.min[0], h = f.box.max[1] - f.box.min[1], d = f.box.max[2] - f.box.min[2];
  const open = f.kind === 'shelf';
  const body = boxMesh(f.box.min, f.box.max, mat(color, { roughness: 0.78, transparent: open, opacity: open ? 0 : 1, depthWrite: !open }));
  body.userData.pick = { kind: 'container', id: f.id };
  body.castShadow = body.receiveShadow = !open;
  const line = new THREE.LineBasicMaterial({ color: 0x2c2016, transparent: true, opacity: 0.6 });
  const part = (min, max, tone) => {
    const m = boxMesh(min, max, mat(new THREE.Color(color).multiplyScalar(tone), { roughness: 0.8 }));
    m.castShadow = m.receiveShadow = true;
    m.position.sub(body.position).divide(body.scale);     // hijo del cuerpo: en su espacio de caja unidad
    m.scale.divide(body.scale);
    body.add(m);
  };
  const [x0, y0, z0] = f.box.min, [x1, y1, z1] = f.box.max, t = 0.03;
  if (open) {
    const along = w >= d;
    if (along) { part([x0, y0, z0], [x0 + t, y1, z1], 0.85); part([x1 - t, y0, z0], [x1, y1, z1], 0.85); }
    else { part([x0, y0, z0], [x1, y1, z0 + t], 0.85); part([x0, y0, z1 - t], [x1, y1, z1], 0.85); }
    const n = Math.max(2, Math.round(h / 0.42));
    for (let i = 0; i <= n; i++) { const y = y0 + (h - t) * i / n; part([x0, y, z0], [x1, y + t, z1], 1); }
  } else {
    body.add(new THREE.LineSegments(new THREE.EdgesGeometry(BOX), line));
    const seams = [];
    if (f.kind === 'wardrobe' || f.kind === 'closet' || f.kind === 'cabinet') {
      const n = Math.max(2, Math.round(Math.max(w, d) / 0.55));
      for (let i = 1; i < n; i++) seams.push(w >= d ? [[-0.5 + i / n, -0.5, 0.502], [-0.5 + i / n, 0.5, 0.502]] : [[0.502, -0.5, -0.5 + i / n], [0.502, 0.5, -0.5 + i / n]]);
    } else if (f.kind === 'fridge') seams.push([[-0.5, 0.18, 0.502], [0.5, 0.18, 0.502]]);
    else if (f.kind === 'dresser' || f.kind === 'drawer' || f.kind === 'nightstand') {
      const n = Math.max(2, Math.round(h / 0.25));
      for (let i = 1; i < n; i++) seams.push([[-0.5, -0.5 + i / n, 0.502], [0.5, -0.5 + i / n, 0.502]]);
    }
    if (seams.length) body.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(seams.flat().map((p) => new THREE.Vector3(...p))), line));
  }
  return body;
}

function addLabel(cls, htmlText, pos, show, onClick) {
  const el = document.createElement('div');
  el.className = 'label ' + cls;
  el.innerHTML = htmlText;
  el.style.display = 'none';
  if (onClick) el.addEventListener('click', onClick);
  labelsEl.appendChild(el);
  const entry = { el, pos, show, lift: cls.startsWith('room') ? '-50%' : '-100%', walkPos: null };
  labels.push(entry);
  return entry;
}

function disposeWorld() {
  if (world) {
    world.traverse((o) => { if (o.material && o.material.dispose) o.material.dispose(); if (o.geometry && o.geometry !== BOX) o.geometry.dispose(); });
    scene.remove(world);
  }
  if (ground) { scene.remove(ground); ground.geometry.dispose(); ground.material.dispose(); ground = null; }
  labelsEl.innerHTML = '';
  walls = []; pickables = []; labels = []; colliders = []; beam = null;
  itemsById.clear(); furnitureById.clear(); roomsById.clear(); openingsById.clear(); floorsById.clear();
}

function buildWorld(data) {
  disposeWorld();
  world = new THREE.Group();
  scene.add(world);
  if (!data.bounds) return;
  const b = data.bounds;
  const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2, span = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2], 4);
  ground = new THREE.Mesh(new THREE.CircleGeometry(span * 4, 64), mat(LIGHT ? 0xe6e0d2 : 0x2a2520, { roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(cx, b.min[1] - 0.02, cz);
  ground.receiveShadow = true;
  scene.add(ground);
  sun.position.set(cx + span * 0.55, b.max[1] + span * 1.25, cz + span * 0.35);
  sun.target.position.set(cx, 0, cz);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -span * 1.1; sc.right = sc.top = span * 1.1; sc.near = 0.5; sc.far = span * 4 + 20;
  sc.updateProjectionMatrix();

  const wallMat = mat(LIGHT ? 0xf6f1e7 : 0xe9e1d3, { roughness: 0.92 });
  const glassMat = mat(0x8fc4e8, { transparent: true, opacity: 0.42, roughness: 0.15, depthWrite: false });
  const doorMat = mat(0x8a6240, { roughness: 0.7 });
  const skirtMat = mat(LIGHT ? 0xcfc6b4 : 0xb9ad99, { roughness: 0.9 });
  const partMat = { solid: wallMat, sill: wallMat, lintel: wallMat, glass: glassMat, door: doorMat };
  const blend = new THREE.Color(LIGHT ? 0xf0e7d6 : 0xd9c9ad);

  for (const floor of data.floors) {
    floorsById.set(floor.id, floor);
    const group = new THREE.Group();
    group.userData.floor = floor.id;
    world.add(group);
    for (const room of floor.rooms) {
      roomsById.set(room.id, { room, floor });
      const slab = boxMesh([room.rect.x0, floor.elevation - 0.06, room.rect.z0], [room.rect.x1, floor.elevation, room.rect.z1],
        mat(new THREE.Color(room.color).lerp(blend, 0.5), { roughness: 0.95 }));
      slab.receiveShadow = true;
      slab.userData.pick = { kind: 'room', id: room.id };
      group.add(slab);
      pickables.push(slab);
      room.mesh = slab;
      const due = data.items.filter((i) => i.room_id === room.id && i.status === 'overdue').length + (room.status === 'overdue' ? 1 : 0);
      addLabel('room', `<b>${esc(room.name)}</b><span>${room.items === 1 ? '1 objeto' : room.items + ' objetos'}${due ? ` · <span class="warn">${due} vencida${due > 1 ? 's' : ''}</span>` : ''}</span>`,
        new THREE.Vector3(room.center[0], floor.elevation + 0.02, room.center[2]),
        () => floorShown(floor.id) && !state.edit, () => select('room', room.id, true))
        .walkPos = new THREE.Vector3(room.center[0], floor.elevation + 2.15, room.center[2]);
    }
    for (const wall of floor.walls) {
      const entry = { wall, floor: floor.id, parts: [], cap: -1, applied: null, base: floor.elevation,
        cx: wall.axis === 'x' ? (wall.lo + wall.hi) / 2 : wall.fixed, cz: wall.axis === 'x' ? wall.fixed : (wall.lo + wall.hi) / 2 };
      for (const box of wall.boxes) {
        const mesh = boxMesh(box.min, box.max, partMat[box.part]);
        mesh.castShadow = box.part !== 'glass';
        mesh.receiveShadow = box.part !== 'glass';
        mesh.userData.pick = box.opening_id ? { kind: 'opening', id: box.opening_id } : { kind: 'wall', id: wall.id };
        mesh.userData.wall = entry;
        group.add(mesh);
        pickables.push(mesh);
        entry.parts.push({ mesh, box });
        if (box.part === 'solid' || box.part === 'sill') {
          colliders.push({ floor: floor.id, x0: box.min[0], x1: box.max[0], z0: box.min[2], z1: box.max[2] });
          const g = 0.006, skirt = { part: 'skirt', min: [box.min[0] - g, box.min[1], box.min[2] - g], max: [box.max[0] + g, box.min[1] + 0.09, box.max[2] + g] };
          const base = boxMesh(skirt.min, skirt.max, skirtMat);
          base.receiveShadow = true;
          base.userData.pick = { kind: 'wall', id: wall.id };
          base.userData.wall = entry;
          group.add(base);
          pickables.push(base);
          entry.parts.push({ mesh: base, box: skirt });
        }
      }
      walls.push(entry);
    }
    for (const o of floor.openings) openingsById.set(o.id, { opening: o, floor });
    for (const f of floor.furniture) {
      const mesh = furnitureMesh(f);
      group.add(mesh);
      pickables.push(mesh);
      furnitureById.set(f.id, { furniture: f, floor, mesh });
      if (f.box.max[1] - f.box.min[1] > 0.3) colliders.push({ floor: floor.id, x0: f.box.min[0], x1: f.box.max[0], z0: f.box.min[2], z1: f.box.max[2] });
      const top = new THREE.Vector3((f.box.min[0] + f.box.max[0]) / 2, f.box.max[1] + 0.05, (f.box.min[2] + f.box.max[2]) / 2);
      addLabel('furniture', esc(f.name), top, () => floorShown(floor.id) && (state.hovered?.id === f.id || (state.selected?.kind === 'container' && state.selected.id === f.id)));
      if (f.status !== 'ok') addLabel('alert' + (f.status === 'due' ? ' due' : ''), '!', top.clone().setY(top.y + 0.25), () => floorShown(floor.id));
    }
  }
  const stem = new THREE.CylinderGeometry(0.012, 0.012, 0.2, 6);
  const head = new THREE.SphereGeometry(0.075, 20, 14);
  const hit = new THREE.SphereGeometry(0.15, 8, 6);
  const ring = new THREE.TorusGeometry(0.13, 0.014, 8, 32);
  for (const item of data.items) {
    const floor = floorsById.get(item.floor_id);
    const group = new THREE.Group();
    group.position.set(...item.position);
    group.userData.floor = item.floor_id;
    const color = STATUS_COLOR[item.status] ?? STATUS_COLOR.ok;
    const stemMesh = new THREE.Mesh(stem, mat(0x4a4038));
    stemMesh.position.y = 0.1;
    const headMesh = new THREE.Mesh(head, mat(color, { roughness: 0.35, emissive: color, emissiveIntensity: 0.25 }));
    headMesh.position.y = 0.26;
    headMesh.castShadow = true;
    const hitMesh = new THREE.Mesh(hit, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    hitMesh.position.y = 0.22;
    hitMesh.userData.pick = { kind: 'item', id: item.id };
    group.add(stemMesh, headMesh, hitMesh);
    let pulse = null;
    if (item.status !== 'ok') {
      pulse = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }));
      pulse.rotation.x = Math.PI / 2;
      pulse.position.y = 0.012;
      group.add(pulse);
    }
    world.add(group);
    pickables.push(hitMesh);
    const anchor = new THREE.Vector3(item.position[0], item.position[1] + 0.36, item.position[2]);
    const entry = { item, floor, group, head: headMesh, pulse, anchor };
    itemsById.set(item.id, entry);
    addLabel('item ' + item.status, esc(item.name), anchor, () => floorShown(item.floor_id) && (state.tags || state.hovered?.id === item.id
      || (state.selected?.kind === 'item' && state.selected.id === item.id)) && state.found !== item.id);
    addLabel('item found', esc(item.name), anchor, () => floorShown(item.floor_id) && state.found === item.id);
    if (item.status !== 'ok') {
      addLabel('alert' + (item.status === 'due' ? ' due' : ''), '!', anchor,
        () => floorShown(item.floor_id) && !state.tags && state.hovered?.id !== item.id && state.found !== item.id
          && !(state.selected?.kind === 'item' && state.selected.id === item.id));
    }
  }
  applyFloorFilter();
  highlight();
}

const floorShown = (id) => !state.floor || state.floor === id;

function applyFloorFilter() {
  if (!world) return;
  for (const child of world.children) child.visible = floorShown(child.userData.floor);
}

function updateWalls(dt) {
  const k = 1 - Math.exp(-dt * 9);
  for (const w of walls) {
    let goal = floorsById.get(w.floor).height;
    if (state.mode === 'orbit' && state.walls === 'cut' && !state.edit) {
      if (!w.wall.exterior) goal = CUT_INTERIOR;
      else if ((camera.position.x - w.cx) * w.wall.normal[0] + (camera.position.z - w.cz) * w.wall.normal[1] > 0.3) goal = CUT_NEAR;
    }
    if (w.cap < 0) w.cap = goal;
    else if (Math.abs(w.cap - goal) < 0.004) w.cap = goal;
    else w.cap += (goal - w.cap) * k;
    if (w.applied === w.cap) continue;
    w.applied = w.cap;
    const top = w.base + w.cap;
    for (const { mesh, box } of w.parts) {
      const y0 = box.min[1], y1 = Math.min(box.max[1], top);
      mesh.visible = y1 - y0 > 0.01;
      if (!mesh.visible) continue;
      mesh.scale.y = y1 - y0;
      mesh.position.y = (y0 + y1) / 2;
    }
  }
}

function updateLabels() {
  const w = canvas.clientWidth, h = canvas.clientHeight, v = new THREE.Vector3();
  for (const L of labels) {
    let on = L.show();
    if (on) {
      v.copy(state.mode === 'walk' && L.walkPos ? L.walkPos : L.pos).project(camera);
      on = v.z > -1 && v.z < 1 && Math.abs(v.x) < 1.15 && Math.abs(v.y) < 1.15;
    }
    if (!on) { if (L.on !== false) { L.el.style.display = 'none'; L.on = false; } continue; }
    if (L.on !== true) { L.el.style.display = ''; L.on = true; }
    L.el.style.transform = `translate(${((v.x + 1) / 2 * w).toFixed(1)}px, ${((1 - v.y) / 2 * h).toFixed(1)}px) translate(-50%, ${L.lift})`;
  }
}

// ---------------------------------------------------------------------------- selección y fichas
function highlight() {
  const sel = state.selected;
  for (const [id, e] of itemsById) {
    const on = (sel?.kind === 'item' && sel.id === id) || state.found === id;
    e.head.scale.setScalar(on ? 1.5 : state.hovered?.id === id ? 1.25 : 1);
    e.head.material.emissiveIntensity = on ? 0.9 : 0.25;
  }
  for (const [id, e] of furnitureById) {
    const glow = sel?.kind === 'container' && sel.id === id ? 0x6b3d10 : state.hovered?.id === id ? 0x2a1a08 : 0;
    e.mesh.traverse((o) => { if (o.isMesh) o.material.emissive.setHex(glow); });
  }
  for (const [id, e] of roomsById) e.room.mesh.material.emissive.setHex(sel?.kind === 'room' && sel.id === id ? 0x4a3210 : 0);
}

function setBeam(position) {
  if (beam) { world.remove(beam); beam.geometry.dispose(); beam.material.dispose(); beam = null; }
  if (!position || !world) return;
  beam = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 6, 24, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
  beam.position.set(position[0], position[1] + 3, position[2]);
  world.add(beam);
}

const dot = (status) => `<span class="dot ${status === 'ok' ? '' : status}"></span>`;
const taskRows = (tasks) => tasks.map((t) => `<li class="task ${t.group === 'overdue' ? 'overdue' : t.group === 'month' ? 'due' : ''}">${dot(t.group === 'overdue' ? 'overdue' : t.group === 'month' ? 'due' : 'ok')}<span>${esc(t.title)}</span><small>${esc(t.when || t.next_due || '')}</small></li>`).join('');
const itemRows = (items) => items.map((i) => `<li>${dot(i.status)}<button type="button" data-item="${esc(i.id)}">${esc(i.name)}${i.quantity > 1 ? ` × ${i.quantity}` : ''}</button></li>`).join('');

function showCard(inner) {
  const card = $('card');
  card.innerHTML = `<button class="close" type="button" aria-label="Cerrar">×</button>` + inner;
  card.hidden = false;
  card.querySelector('.close').onclick = () => select(null);
  card.querySelectorAll('[data-item]').forEach((b) => { b.onclick = () => focusItem(b.dataset.item); });
  card.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => openInApp(b.dataset.open); });
  card.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => focusItem(b.dataset.go); });
}

function renderCard() {
  const sel = state.selected, d = state.data;
  if (!sel) { $('card').hidden = true; return; }
  if (sel.kind === 'item') {
    const e = itemsById.get(sel.id);
    if (!e) return select(null);
    const i = e.item;
    showCard(`<div class="kind">Objeto</div><h2>${esc(i.name)}${i.quantity > 1 ? ` × ${i.quantity}` : ''}</h2><div class="where">${esc(i.location)}</div>`
      + (i.photo ? `<img src="${esc(i.photo)}" alt="">` : '') + (i.note ? `<p>${esc(i.note)}</p>` : '')
      + (i.tasks.length ? `<h3>Mantenimiento</h3><ul>${taskRows(i.tasks)}</ul>` : '')
      + `<div class="actions"><button class="primary" type="button" data-open="/item/${esc(i.id)}">Abrir ficha</button><button type="button" data-go="${esc(i.id)}">Llevarme hasta él</button></div>`);
  } else if (sel.kind === 'container') {
    const e = furnitureById.get(sel.id);
    if (!e) return select(null);
    const f = e.furniture, inside = d.items.filter((i) => i.furniture_id === f.id);
    showCard(`<div class="kind">${esc(KIND_LABEL[f.kind] || 'Mueble')}</div><h2>${esc(f.name)}</h2><div class="where">${esc(roomsById.get(f.room_id)?.room.name || '')}${f.placed ? '' : ' · sin sitio en el plano: colocado junto a la pared'}</div>`
      + (f.tasks.length ? `<h3>Mantenimiento</h3><ul>${taskRows(f.tasks)}</ul>` : '')
      + (inside.length ? `<h3>${inside.length === 1 ? '1 objeto' : inside.length + ' objetos'}</h3><ul>${itemRows(inside)}</ul>` : '<p>No guarda ningún objeto.</p>')
      + `<div class="actions"><button class="primary" type="button" data-open="/container/${esc(f.id)}">Abrir mueble</button></div>`);
  } else if (sel.kind === 'room') {
    const e = roomsById.get(sel.id);
    if (!e) return select(null);
    const r = e.room, inside = d.items.filter((i) => i.room_id === r.id);
    showCard(`<div class="kind">Habitación · ${esc(e.floor.name)}</div><h2>${esc(r.name)}</h2><div class="where">${num(r.width_m)} × ${num(r.depth_m)} m · ${num(r.area_m2)} m²${r.placed ? '' : ' · sin medidas en el plano'}</div>`
      + (r.tasks.length ? `<h3>Mantenimiento</h3><ul>${taskRows(r.tasks)}</ul>` : '')
      + (inside.length ? `<h3>${inside.length === 1 ? '1 objeto' : inside.length + ' objetos'}</h3><ul>${itemRows(inside)}</ul>` : '<p>Todavía no hay objetos aquí.</p>')
      + `<div class="actions"><button class="primary" type="button" data-open="/room/${esc(r.id)}">Abrir habitación</button><button type="button" id="card-walk">Pasear por aquí</button></div>`);
    $('card-walk').onclick = () => enterWalk(r.id);
  } else if (sel.kind === 'opening') {
    const e = openingsById.get(sel.id);
    if (!e) return select(null);
    const o = e.opening;
    const between = o.other_room_name ? `entre ${esc(o.room_name)} y ${esc(o.other_room_name)}` : `${esc(o.room_name)}, pared ${SIDE_LABEL[o.side]}`;
    showCard(`<div class="kind">${esc(o.label)}</div><h2>${o.kind === 'door' ? 'Puerta' : 'Ventana'} de ${num(o.width_cm, 0)} cm</h2><div class="where">${between}</div>`
      + (o.inferred ? `<p>HomeHoard la supone porque las dos habitaciones se tocan en el plano. Puedes dejarla fija, o colocar la puerta de verdad en otro punto de esa pared.</p><div class="actions"><button class="primary" type="button" id="op-keep">Dejarla fija</button></div>`
        : `<div class="actions"><button class="danger" type="button" id="op-remove">Quitar</button></div>`));
    if (o.inferred) $('op-keep').onclick = () => changeOpenings({ action: 'add', room: o.room_id, side: o.side, kind: 'door', offset_cm: o.offset_cm, width_cm: o.width_cm }, 'Puerta guardada en el plano.');
    else $('op-remove').onclick = () => changeOpenings({ action: 'remove', opening: o.id }, `${o.kind === 'door' ? 'Puerta' : 'Ventana'} quitada.`);
  } else if (sel.kind === 'alerts') {
    const tasks = d.maintenance.tasks;
    showCard(`<div class="kind">Mantenimiento</div><h2>${d.maintenance.overdue} vencida${d.maintenance.overdue === 1 ? '' : 's'}${d.maintenance.due ? ` · ${d.maintenance.due} este mes` : ''}</h2><ul>`
      + tasks.map((t) => `<li class="task ${t.group === 'overdue' ? 'overdue' : 'due'}">${dot(t.group === 'overdue' ? 'overdue' : 'due')}<button type="button" data-task="${esc(t.id)}">${esc(t.title)}<br><span style="color:var(--muted)">${esc(t.target_name || '')}</span></button><small>${esc(t.when)}</small></li>`).join('')
      + `</ul><div class="actions"><button class="primary" type="button" data-open="/maintenance">Abrir Mantenimiento</button></div>`);
    $('card').querySelectorAll('[data-task]').forEach((b) => { b.onclick = () => {
      const t = tasks.find((x) => x.id === b.dataset.task);
      if (t.target_kind === 'item') focusItem(t.target_id);
      else if (t.target_kind === 'room') select('room', t.target_id, true);
      else if (t.target_kind === 'container') select('container', furnitureOf(t.target_id) || t.target_id, true);
    }; });
  }
}

function furnitureOf(containerId) {
  if (furnitureById.has(containerId)) return containerId;
  const item = state.data.items.find((i) => i.container_id === containerId && i.furniture_id);
  return item ? item.furniture_id : null;
}

function select(kind, id, fly) {
  state.selected = kind ? { kind, id } : null;
  if (!kind || kind !== 'item') { state.found = null; setBeam(null); }
  highlight();
  renderCard();
  if (!fly || !kind) return;
  let floor = null, center = null, radius = 7;
  if (kind === 'room' && roomsById.has(id)) {
    const e = roomsById.get(id);
    floor = e.floor.id; center = e.room.center; radius = Math.max(e.room.width_m, e.room.depth_m) * 1.5 + 3;
  } else if (kind === 'container' && furnitureById.has(id)) {
    const e = furnitureById.get(id), b = e.furniture.box;
    floor = e.floor.id; center = [(b.min[0] + b.max[0]) / 2, b.max[1], (b.min[2] + b.max[2]) / 2]; radius = 4.5;
  }
  if (!center) return;
  if (state.floor && state.floor !== floor) setFloor(floor);
  if (state.mode === 'orbit') flyOrbit({ target: new THREE.Vector3(center[0], center[1] + 0.3, center[2]), radius, theta: orbit.theta, phi: Math.min(orbit.phi, 0.9) });
  else if (kind === 'room') teleport([center[0], center[1] + EYE, center[2]], null, floor);
}

function openInApp(path) {
  if (EMBED && window.parent !== window) window.parent.postMessage({ source: 'homehoard-casa3d', type: 'open', path }, location.origin);
  else location.href = path;
}

function toast(text, error) {
  const el = $('toast');
  el.textContent = text;
  el.className = error ? 'error' : '';
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, error ? 7000 : 4200);
}

// ---------------------------------------------------------------------------- buscar y llevar la cámara
async function focusItem(id, known) {
  let loc = known;
  if (!loc) {
    const found = await api('/api/house3d/locate?q=' + encodeURIComponent(id)).catch((e) => ({ status: 'error', message: e.message }));
    loc = found.best;
    if (!loc) return toast(found.message || 'No encuentro ese objeto en la casa.', true);
  }
  if (!itemsById.has(loc.id)) await reload();
  if (!itemsById.has(loc.id)) return toast('Ese objeto no está en ninguna habitación del plano.', true);
  if (state.floor && loc.floor && state.floor !== loc.floor.id) setFloor(loc.floor.id);
  state.found = loc.id;
  select('item', loc.id);
  setBeam(loc.position);
  if (state.mode === 'orbit') flyOrbit(orbitFromPose(loc.camera.position, loc.camera.target));
  else teleport(loc.walk.position, loc.walk.target, loc.floor?.id);
  toast(`${loc.name}: ${loc.where}`);
}

let searchTimer = 0, searchSeq = 0, lastMatches = [];
function runSearch(now) {
  clearTimeout(searchTimer);
  const q = $('search').value.trim();
  const list = $('results');
  if (!q) { list.hidden = true; lastMatches = []; return Promise.resolve(); }
  const go = async () => {
    const seq = ++searchSeq;
    const found = await api('/api/house3d/locate?limit=8&q=' + encodeURIComponent(q)).catch((e) => ({ status: 'error', matches: [], message: e.message }));
    if (seq !== searchSeq) return;
    lastMatches = found.matches || [];
    list.innerHTML = lastMatches.length
      ? lastMatches.map((m, i) => `<li data-i="${i}" class="${i === 0 ? 'on' : ''}">${dot(m.status)}<span class="name">${esc(m.name)}${m.quantity > 1 ? ` × ${m.quantity}` : ''}</span><span class="where">${esc(m.where)}</span></li>`).join('')
      : `<li class="none">${esc(found.message || 'No hay ningún objeto con ese nombre.')}</li>`;
    list.hidden = false;
    list.querySelectorAll('li[data-i]').forEach((li) => { li.onclick = () => pickResult(Number(li.dataset.i)); });
  };
  if (now) return go();
  searchTimer = setTimeout(go, 220);
  return Promise.resolve();
}

function pickResult(i) {
  const m = lastMatches[i];
  if (!m) return;
  $('results').hidden = true;
  focusItem(m.id, m);
}

// ---------------------------------------------------------------------------- modos
function setMode(mode, roomId) {
  if (mode === state.mode) return;
  if (mode === 'walk') return enterWalk(roomId);
  state.mode = 'orbit';
  const fx = -Math.sin(walk.yaw), fz = -Math.cos(walk.yaw);
  const f = floorsById.get(walk.floor);
  copyOrbit(orbit, { target: new THREE.Vector3(walk.pos.x + fx * 1.5, (f?.elevation ?? 0) + 0.4, walk.pos.z + fz * 1.5), radius: 3, theta: walk.yaw, phi: 1.2 });
  copyOrbit(orbitGoal, orbit);
  orbitGoal.radius = 9; orbitGoal.phi = 0.86;
  syncUi();
}

function enterWalk(roomId) {
  const d = state.data;
  if (!d || d.empty) return;
  let entry = roomId ? roomsById.get(roomId) : null;
  if (!entry && state.selected) {
    const s = state.selected;
    const rid = s.kind === 'room' ? s.id : s.kind === 'item' ? itemsById.get(s.id)?.item.room_id : s.kind === 'container' ? furnitureById.get(s.id)?.furniture.room_id : null;
    entry = rid ? roomsById.get(rid) : null;
  }
  if (!entry) {
    let best = Infinity;
    for (const e of roomsById.values()) {
      if (!floorShown(e.floor.id)) continue;
      const dist = Math.hypot(e.room.center[0] - orbitGoal.target.x, e.room.center[2] - orbitGoal.target.z);
      if (dist < best) { best = dist; entry = e; }
    }
  }
  if (!entry) return;
  state.mode = 'walk';
  walk.floor = entry.floor.id;
  walk.pos.set(entry.room.center[0], entry.floor.elevation + EYE, entry.room.center[2]);
  if (blocked(walk.pos.x, walk.pos.z)) freeSpot(entry.room);
  walk.yaw = orbit.theta;
  walk.pitch = -0.06;
  walkGoal.pos = null; walkGoal.yaw = null;
  if (state.selected?.kind === 'item') {
    const p = itemsById.get(state.selected.id)?.item.position;
    if (p && Math.hypot(p[0] - walk.pos.x, p[2] - walk.pos.z) > 0.4) walk.yaw = Math.atan2(-(p[0] - walk.pos.x), -(p[2] - walk.pos.z));
  }
  syncUi();
  canvas.focus();
}

function freeSpot(room) {
  const r = room.rect;
  for (let i = 1; i < 40; i++) {
    const x = r.x0 + 0.35 + ((i * 0.618) % 1) * Math.max(0.01, r.x1 - r.x0 - 0.7), z = r.z0 + 0.35 + ((i * 0.381) % 1) * Math.max(0.01, r.z1 - r.z0 - 0.7);
    if (!blocked(x, z)) { walk.pos.x = x; walk.pos.z = z; return; }
  }
}

function teleport(position, lookAt, floorId) {
  if (floorId) walk.floor = floorId;
  walkGoal.pos = new THREE.Vector3(...position);
  if (lookAt) {
    walkGoal.yaw = Math.atan2(-(lookAt[0] - position[0]), -(lookAt[2] - position[2]));
    const flat = Math.hypot(lookAt[0] - position[0], lookAt[2] - position[2]);
    walk.pitch = THREE.MathUtils.clamp(Math.atan2(lookAt[1] - position[1], Math.max(flat, 0.2)), -1.1, 0.6);
  }
}

function setFloor(id) {
  state.floor = id || null;
  applyFloorFilter();
  if (state.mode === 'orbit') frameAll(false);
  else if (id && walk.floor !== id) {
    const first = floorsById.get(id)?.rooms[0];
    if (first) { walk.floor = id; walk.pos.set(first.center[0], floorsById.get(id).elevation + EYE, first.center[2]); }
  }
  syncUi();
}

function syncUi() {
  const d = state.data;
  const fov = state.mode === 'walk' ? WALK_FOV : ORBIT_FOV;
  if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
  $('mode-orbit').classList.toggle('on', state.mode === 'orbit');
  $('mode-walk').classList.toggle('on', state.mode === 'walk');
  $('walls').textContent = state.walls === 'cut' ? 'Muros: corte' : 'Muros: enteros';
  $('walls').disabled = state.mode === 'walk' || !!state.edit;
  $('tags').classList.toggle('on', state.tags);
  $('edit').classList.toggle('on', !!state.edit);
  $('editbar').hidden = !state.edit;
  $('edit-door').classList.toggle('on', state.edit === 'door');
  $('edit-window').classList.toggle('on', state.edit === 'window');
  $('pad').hidden = state.mode !== 'walk';
  canvas.classList.toggle('placing', !!state.edit);
  $('hint').textContent = state.edit ? 'Pulsa en un muro para colocar la puerta o la ventana · pulsa una que ya exista para quitarla'
    : state.mode === 'walk' ? 'Arrastra para mirar · W A S D o las flechas para caminar · pulsa en el suelo para ir hasta allí'
      : 'Arrastra para girar · rueda para acercar · botón derecho o Mayús para desplazar · pulsa un objeto para ver su ficha';
  if (!d) return;
  const floors = $('floors');
  floors.hidden = d.floors.length < 2;
  if (!floors.hidden) {
    floors.innerHTML = `<button type="button" data-floor="" class="${state.floor ? '' : 'on'}">Todas</button>`
      + d.floors.map((f) => `<button type="button" data-floor="${esc(f.id)}" class="${state.floor === f.id ? 'on' : ''}">${esc(f.name)}</button>`).join('');
    floors.querySelectorAll('button').forEach((b) => { b.onclick = () => setFloor(b.dataset.floor); });
  }
  const m = d.maintenance, alerts = $('alerts');
  alerts.hidden = !(m.overdue || m.due);
  if (!alerts.hidden) {
    alerts.innerHTML = `<span class="dot ${m.overdue ? 'overdue' : 'due'}"></span>` + (m.overdue ? `${m.overdue} mantenimiento${m.overdue > 1 ? 's' : ''} vencido${m.overdue > 1 ? 's' : ''}` : `${m.due} mantenimiento${m.due > 1 ? 's' : ''} este mes`)
      + (m.overdue && m.due ? ` · ${m.due} este mes` : '');
  }
  $('wall-height').value = d.settings.wall_height_cm;
  $('infer-doors').checked = d.settings.infer_doors;
}

// ---------------------------------------------------------------------------- puertas y ventanas
async function changeOpenings(body, done) {
  try {
    await api('/api/house3d/openings', body);
    await reload();
    if (done) toast(done);
    if (EMBED && window.parent !== window) window.parent.postMessage({ source: 'homehoard-casa3d', type: 'changed' }, location.origin);
    select(null);
  } catch (e) { toast(e.message, true); }
}

function placeOpening(hit) {
  const entry = hit.object.userData.wall, wall = entry.wall, edge = wall.edges[0];
  const room = roomsById.get(edge.room_id)?.room;
  if (!room) return;
  const width = state.edit === 'door' ? 82 : 120;
  const along = wall.axis === 'x' ? hit.point.x : hit.point.z;
  const lo = wall.axis === 'x' ? room.rect.x0 : room.rect.z0;
  changeOpenings({ action: 'add', room: room.id, side: edge.side, kind: state.edit, offset_cm: Math.max(0, Math.round((along - lo) * 100 - width / 2)), width_cm: width },
    `${state.edit === 'door' ? 'Puerta' : 'Ventana'} colocada en ${room.name}, pared ${SIDE_LABEL[edge.side]}.`);
}

// ---------------------------------------------------------------------------- puntero
const pointers = new Map();
let down = null, pinch = 0;

function pick(ev, kinds) {
  const r = canvas.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera);
  for (const hit of raycaster.intersectObjects(pickables, false)) {
    let o = hit.object, shown = true;
    for (let p = o; p; p = p.parent) if (!p.visible) { shown = false; break; }
    if (!shown) continue;
    const kind = o.userData.pick.kind;
    if (kinds && !kinds.includes(kind)) { if (kind === 'wall' || kind === 'opening') return null; continue; }
    return hit;
  }
  return null;
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false, pan: e.button !== 0 || e.shiftKey };
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
  canvas.classList.add('dragging');
  $('results').hidden = true;
});
canvas.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return hover(e);
  const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
  prev.x = e.clientX; prev.y = e.clientY;
  if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) down.moved = true;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()], dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (state.mode === 'orbit' && pinch) orbitGoal.radius = THREE.MathUtils.clamp(orbitGoal.radius * pinch / Math.max(dist, 1), 1.5, 150);
    pinch = dist;
    if (state.mode === 'orbit') pan(dx / 2, dy / 2);
    return;
  }
  if (state.mode === 'walk') {
    walk.yaw += dx * 0.0042; walk.pitch = THREE.MathUtils.clamp(walk.pitch + dy * 0.003, -1.2, 1.0); walkGoal.yaw = null;
  } else if (down?.pan) pan(dx, dy);
  else {
    orbitGoal.theta -= dx * 0.0055;
    orbitGoal.phi = THREE.MathUtils.clamp(orbitGoal.phi - dy * 0.0045, 0.06, 1.5);
  }
});
function pan(dx, dy) {
  const s = orbit.radius * 0.0016, c = Math.cos(orbit.theta), n = Math.sin(orbit.theta);
  orbitGoal.target.x -= (c * dx + n * dy) * s;
  orbitGoal.target.z -= (-n * dx + c * dy) * s;
}
function release(e) {
  const was = down;
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = 0;
  if (!pointers.size) { canvas.classList.remove('dragging'); down = null; }
  if (was && !was.moved && performance.now() - was.t < 600 && e.type === 'pointerup') click(e);
}
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (state.mode === 'orbit') orbitGoal.radius = THREE.MathUtils.clamp(orbitGoal.radius * Math.exp(e.deltaY * 0.0011), 1.5, 150);
  else { const f = -e.deltaY * 0.002; stepWalk(-Math.sin(walk.yaw) * f, -Math.cos(walk.yaw) * f); }
}, { passive: false });

function hover(e) {
  const hit = pick(e, state.edit ? ['wall', 'opening'] : ['item', 'container']);
  const p = hit ? hit.object.userData.pick : null;
  const next = p && (p.kind === 'item' || p.kind === 'container') ? p : null;
  canvas.classList.toggle('pointing', !!p && !state.edit);
  if (next?.id !== state.hovered?.id) { state.hovered = next; highlight(); }
}

function click(e) {
  if (state.edit) {
    const hit = pick(e, ['wall', 'opening']);
    if (!hit) return;
    const p = hit.object.userData.pick;
    if (p.kind === 'opening') select('opening', p.id);
    else placeOpening(hit);
    return;
  }
  const hit = pick(e, ['item', 'container', 'room', 'opening']);
  if (!hit) return select(null);
  const p = hit.object.userData.pick;
  if (p.kind === 'room' && state.mode === 'walk') {
    const entry = roomsById.get(p.id);
    if (!blocked(hit.point.x, hit.point.z) || walk.floor !== entry.floor.id) {
      teleport([hit.point.x, entry.floor.elevation + EYE, hit.point.z], null, entry.floor.id);
      walkGoal.yaw = Math.atan2(-(hit.point.x - walk.pos.x), -(hit.point.z - walk.pos.z));
    }
    return;
  }
  select(p.kind, p.id);
}

const KEYMAP = { KeyW: 'forward', ArrowUp: 'forward', KeyS: 'back', ArrowDown: 'back', KeyA: 'left', KeyD: 'right', ArrowLeft: 'turnleft', ArrowRight: 'turnright',
  KeyQ: 'turnleft', KeyE: 'turnright', ShiftLeft: 'fast', ShiftRight: 'fast' };
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.key === '/') { e.preventDefault(); $('search').focus(); return; }
  if (e.key === 'Escape') { if (state.edit) { state.edit = null; syncUi(); } else select(null); return; }
  const k = KEYMAP[e.code];
  if (!k) return;
  if (state.mode === 'walk') { keys.add(k); e.preventDefault(); }
  else if (k === 'turnleft') orbitGoal.theta += 0.25;
  else if (k === 'turnright') orbitGoal.theta -= 0.25;
});
window.addEventListener('keyup', (e) => { const k = KEYMAP[e.code]; if (k) keys.delete(k); });
window.addEventListener('blur', () => keys.clear());
$('pad').querySelectorAll('button').forEach((b) => {
  const k = b.dataset.key;
  const on = (e) => { e.preventDefault(); keys.add(k); b.classList.add('down'); };
  const off = () => { keys.delete(k); b.classList.remove('down'); };
  b.addEventListener('pointerdown', on);
  for (const name of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(name, off);
});

// ---------------------------------------------------------------------------- barra
$('mode-orbit').onclick = () => setMode('orbit');
$('mode-walk').onclick = () => setMode('walk');
$('walls').onclick = () => { state.walls = state.walls === 'cut' ? 'full' : 'cut'; syncUi(); };
$('tags').onclick = () => { state.tags = !state.tags; syncUi(); };
$('frame').onclick = () => { if (state.mode !== 'orbit') setMode('orbit'); frameAll(false); };
$('edit').onclick = () => { state.edit = state.edit ? null : 'door'; if (state.edit && state.mode !== 'orbit') setMode('orbit'); select(null); syncUi(); };
$('edit-door').onclick = () => { state.edit = 'door'; syncUi(); };
$('edit-window').onclick = () => { state.edit = 'window'; syncUi(); };
$('edit-done').onclick = () => { state.edit = null; select(null); syncUi(); };
$('wall-height').onchange = (e) => {
  const v = Math.round(Number(e.target.value));
  if (!(v >= 200 && v <= 400)) { toast('La altura de los muros va de 200 a 400 cm.', true); e.target.value = state.data.settings.wall_height_cm; return; }
  changeOpenings({ action: 'settings', wall_height_cm: v }, `Muros a ${v} cm.`);
};
$('infer-doors').onchange = (e) => changeOpenings({ action: 'settings', infer_doors: e.target.checked }, e.target.checked ? 'Puertas supuestas entre habitaciones contiguas.' : 'Solo las puertas colocadas a mano.');
$('export').onclick = () => {
  const a = document.createElement('a');
  a.href = '/api/house3d/export.glb';
  a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
  toast('Descargando la casa en GLB (metros, con habitaciones, muebles y objetos con su nombre).');
};
$('vulcan').onclick = async () => {
  const b = $('vulcan');
  b.disabled = true; b.textContent = 'Enviando…';
  try {
    const r = await api('/api/house3d/export', { format: 'glb', send_to_vulcan: true });
    if (r.vulcan?.ok) toast(`La casa está en la biblioteca de Vulcan (maqueta ${r.vulcan.scale}${r.vulcan.model_id ? `, modelo ${r.vulcan.model_id}` : ''}).`);
    else toast(r.vulcan?.message || 'Vulcan no ha aceptado el archivo.', true);
  } catch (e) { toast(e.message, true); }
  b.disabled = false; b.textContent = 'Enviar a Vulcan';
};
$('alerts').onclick = () => select('alerts', 'all');
$('search').addEventListener('input', () => runSearch(false));
$('search').addEventListener('focus', () => { if (lastMatches.length) $('results').hidden = false; });
$('search').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  await runSearch(true);
  if (lastMatches.length) pickResult(0);
});
if (EMBED) $('home-link').addEventListener('click', (e) => { e.preventDefault(); openInApp('/plan'); });
$('empty-link').addEventListener('click', (e) => { if (EMBED) { e.preventDefault(); window.parent.postMessage({ source: 'homehoard-casa3d', type: 'view', view: '2d' }, location.origin); } });

// ---------------------------------------------------------------------------- datos
async function reload() {
  const data = await api('/api/house3d/scene');
  state.data = data;
  $('home-name').textContent = data.home?.name || 'Casa en 3D';
  document.title = `${data.home?.name || 'HomeHoard'} · Casa en 3D`;
  $('empty').hidden = !data.empty;
  if (data.empty) $('empty-text').textContent = (data.message || '') + ' Dibuja las habitaciones en el plano y aquí aparecerán levantadas, con sus muebles y objetos.';
  if (state.floor && !data.floors.some((f) => f.id === state.floor)) state.floor = null;
  buildWorld(data);
  if (state.selected && state.selected.kind !== 'alerts') {
    const maps = { item: itemsById, container: furnitureById, room: roomsById, opening: openingsById };
    if (!maps[state.selected.kind]?.has(state.selected.id)) state.selected = null;
  }
  if (state.found && itemsById.has(state.found)) setBeam(itemsById.get(state.found).item.position); else state.found = null;
  highlight();
  renderCard();
  syncUi();
  return data;
}

async function watch() {
  try {
    const info = await api('/api/home/version');
    if (state.version !== null && info.version !== state.version && !pointers.size) await reload();
    state.version = info.version;
  } catch { /* el ordenador puede estar cerrado un momento */ }
  setTimeout(watch, 4000);
}

function resize() {
  const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// Al pasear, un plano pequeño desde arriba dice dónde estás y hacia dónde miras.
const mini = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 300);
mini.up.set(0, 0, -1);
mini.layers.enable(1);
const me = new THREE.Group();
{
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.8, 16), new THREE.MeshBasicMaterial({ color: 0xff9d2e }));
  cone.rotation.x = -Math.PI / 2;
  cone.layers.set(1);
  me.add(cone);
  scene.add(me);
}
const miniBg = new THREE.Color(LIGHT ? 0xe9e4d8 : 0x16130f);

function renderMini() {
  const frame = $('mini');
  const f = state.mode === 'walk' ? floorsById.get(walk.floor) : null;
  frame.hidden = !f;
  if (!f) return;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const r of f.rooms) { x0 = Math.min(x0, r.rect.x0); x1 = Math.max(x1, r.rect.x1); z0 = Math.min(z0, r.rect.z0); z1 = Math.max(z1, r.rect.z1); }
  const k = Math.max(x1 - x0, z1 - z0) / 2 + 0.5, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const size = Math.round(Math.min(210, canvas.clientWidth * 0.3, canvas.clientHeight * 0.36));
  mini.left = -k; mini.right = k; mini.top = k; mini.bottom = -k; mini.near = 0.1; mini.far = f.height + 30;
  mini.position.set(cx, f.elevation + f.height + 25, cz);
  mini.lookAt(cx, f.elevation, cz);
  mini.updateProjectionMatrix();
  me.position.set(walk.pos.x, f.elevation + f.height + 2, walk.pos.z);
  me.rotation.y = walk.yaw;
  me.scale.setScalar(Math.max(1, k / 5));
  const x = 12, top = 58, y = canvas.clientHeight - top - size;
  frame.style.cssText = `left:${x}px;top:${top}px;width:${size}px;height:${size}px`;
  const bg = scene.background;
  scene.background = miniBg;
  renderer.setScissorTest(true);
  renderer.setViewport(x, y, size, size);
  renderer.setScissor(x, y, size, size);
  renderer.render(scene, mini);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, canvas.clientWidth, canvas.clientHeight);
  scene.background = bg;
}

let last = performance.now();
function tick(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  updateCamera(dt);
  updateWalls(dt);
  const t = now / 1000;
  for (const e of itemsById.values()) {
    const dist = camera.position.distanceTo(e.anchor);
    e.group.scale.setScalar(state.mode === 'walk' ? THREE.MathUtils.clamp(dist / 5, 0.4, 1) : THREE.MathUtils.clamp(dist / 11, 0.75, 2.4));
    if (e.pulse) { const s = 1 + 0.35 * (0.5 + 0.5 * Math.sin(t * 3.2)); e.pulse.scale.set(s, s, 1); e.pulse.material.opacity = 1.25 - s * 0.6; }
  }
  if (beam) beam.material.opacity = 0.16 + 0.08 * Math.sin(t * 4);
  renderer.render(scene, camera);
  renderMini();
  updateLabels();
  requestAnimationFrame(tick);
}

async function start() {
  resize();
  syncUi();
  try {
    const data = await reload();
    frameAll(true);
    api('/api/house3d/vulcan').then((v) => { $('vulcan').hidden = !v.available; }).catch(() => {});
    const wanted = params.get('objeto') || params.get('buscar');
    if (params.get('modo') === 'paseo' && !data.empty) enterWalk();
    if (wanted && !data.empty) { $('search').value = params.get('buscar') || ''; await focusItem(wanted); }
  } catch (e) {
    $('empty').hidden = false;
    $('empty').querySelector('h1').textContent = 'Sin conexión con el ordenador';
    $('empty-text').textContent = e.message;
  }
  watch();
  requestAnimationFrame(tick);
}

window.casa3d = { state, focusItem, select, setMode, setFloor, reload, frameAll, camera, orbit, orbitGoal, walk, itemsById };
start();
