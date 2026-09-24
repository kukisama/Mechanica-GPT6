import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { ENGINE } from './simulation.js';

export const WORLD_SCALE = 0.02;
const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const V3 = (x, y, z = 0) => new THREE.Vector3(x, y, z);

export const PART_DETAILS = Object.freeze({
  cylinder: '气缸体为活塞导向，与缸盖共同形成燃烧空间。剖视移去了前半侧外壳，以暴露内部结构。',
  piston: '活塞承受燃气压力，沿气缸上下运动。顶部凹腔表示柴油机燃烧室；环带表示活塞环。',
  rod: '连杆连接活塞销与曲柄销，将活塞的往复运动传递给曲轴。两个销轴之间的距离始终不变。',
  crank: '曲轴把往复运动转换为旋转运动。飞轮储存转动能量，帮助发动机越过非做功冲程。',
  valves: '左侧进气门吸入空气，右侧排气门排出废气。弹簧帮助气门回座；配气机构按教学需要简化。',
  injector: '喷油器在压缩末期向高温空气中喷入雾化柴油。这是压燃过程，不存在火花塞点火。',
});

/** All visible engine components are real, lit 3D meshes. No model downloads. */
export class EngineScene {
  constructor(container, labelLayer, callbacks = {}) {
    this.container = container;
    this.labelLayer = labelLayer;
    this.callbacks = callbacks;
    this.materialsByPart = new Map();
    this.pickables = [];
    this.labels = [];
    this.mode = 'cutaway';
    this.selectedPart = null;
    this.particlesEnabled = true;
    this.labelsEnabled = true;
    this.lastAngle = null;
    this.disposed = false;
    this.needsRender = true;
    this.abort = new AbortController();
    this.temp = new THREE.Object3D();
    this.vector = new THREE.Vector3();
    this.direction = new THREE.Vector3();
    this.projected = new THREE.Vector3();

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    const canvas = this.renderer.domElement;
    canvas.setAttribute('aria-label', '可交互的三维柴油机模型');
    canvas.setAttribute('aria-describedby', 'scene-instructions keyboard-scene-help');
    canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-roledescription', '三维模型观察器');
    canvas.setAttribute('aria-keyshortcuts', 'W A S D Shift+W Shift+A Shift+S Shift+D + - R Space ArrowLeft ArrowRight');
    canvas.tabIndex = 0;
    container.prepend(canvas);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(39, 1, 0.1, 100);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 24;
    this.controls.minPolarAngle = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.82;
    this.controls.maxTargetRadius = 3;
    this.controls.cursor.set(0, 2.15, 0);
    this.controls.autoRotateSpeed = 0.65;
    this.controls.addEventListener('start', () => this.callbacks.onCameraChange?.());
    this.controls.addEventListener('change', () => { this.needsRender = true; });

    this.setupLighting();
    this.createStage();
    this.root = new THREE.Group();
    this.root.name = 'diesel-engine';
    this.scene.add(this.root);
    this.createMaterials();
    this.createEngine();
    this.createLabels();
    this.setMode('cutaway');

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.setCamera('perspective');
    this.bindPointerSelection();
  }

  refreshEnvironment() {
    this.environmentTarget?.dispose();
    const room = new RoomEnvironment();
    const generator = new THREE.PMREMGenerator(this.renderer);
    // Broad studio reflections do not need expensive 256px GGX convolution.
    // Keeping this small also makes software WebGL usable on remote desktops.
    this.environmentTarget = generator.fromScene(room, 0, 0.1, 100, { size: 64 });
    this.scene.environment = this.environmentTarget.texture;
    this.scene.environmentIntensity = 0.7;
    room.dispose();
    generator.dispose();
    this.environmentGeneration = (this.environmentGeneration ?? 0) + 1;
    this.needsRender = true;
  }

  setupLighting() {
    this.refreshEnvironment();
    this.scene.add(new THREE.HemisphereLight(0xd4f3f3, 0x21353e, 2.0));
    const key = new THREE.DirectionalLight(0xe2f7ff, 3.8);
    key.position.set(4, 9, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -5, right: 5, top: 7, bottom: -4, near: 0.5, far: 24 });
    key.shadow.normalBias = 0.035;
    key.shadow.bias = -0.0004;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x79d7bb, 3.1);
    rim.position.set(-4, 5, -4);
    this.scene.add(rim);
    const warm = new THREE.DirectionalLight(0xf6cca0, 1.7);
    warm.position.set(5, 2, -2);
    this.scene.add(warm);
    this.burnLight = new THREE.PointLight(0xffa344, 0, 3, 1.7);
    this.scene.add(this.burnLight);
  }

  createStage() {
    const platform = new THREE.Mesh(
      new THREE.CylinderGeometry(3.15, 3.24, 0.12, 96),
      new THREE.MeshStandardMaterial({ color: 0x17292d, roughness: 0.8, metalness: 0.35 }),
    );
    platform.position.y = -1.57;
    platform.receiveShadow = true;
    this.scene.add(platform);
    for (const radius of [2.55, 3.04]) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(radius, 0.008, 4, 100),
        new THREE.MeshBasicMaterial({ color: 0x46695e, transparent: true, opacity: 0.48 }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = -1.502;
      this.scene.add(ring);
    }
    const grid = new THREE.GridHelper(18, 36, 0x375950, 0x304c48);
    grid.position.y = -1.66;
    grid.material.transparent = true;
    grid.material.opacity = 0.22;
    grid.material.depthWrite = false;
    this.scene.add(grid);
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.ShadowMaterial({ opacity: 0.22 }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -1.65;
    shadow.receiveShadow = true;
    this.scene.add(shadow);
  }

  material(part, color, options = {}) {
    const material = new THREE.MeshStandardMaterial({ color, metalness: 0.72, roughness: 0.28, ...options });
    if (!this.materialsByPart.has(part)) this.materialsByPart.set(part, []);
    this.materialsByPart.get(part).push(material);
    return material;
  }

  createMaterials() {
    this.m = {
      housing: this.material('cylinder', 0x436d60, { metalness: 0.6, roughness: 0.42, side: THREE.DoubleSide }),
      liner: this.material('cylinder', 0x91b3b3, { side: THREE.DoubleSide, roughness: 0.21 }),
      cut: this.material('cylinder', 0xb8ad86, { roughness: 0.44 }),
      cylinderBolt: this.material('cylinder', 0xa2b5bc, { roughness: 0.22 }),
      piston: this.material('piston', 0xd0dce0, { metalness: 0.84, roughness: 0.25 }),
      pistonRing: this.material('piston', 0x334751, { metalness: 0.91, roughness: 0.22 }),
      pistonPin: this.material('piston', 0x96b5c5, { metalness: 0.9 }),
      rod: this.material('rod', 0xbda880, { metalness: 0.78, roughness: 0.3 }),
      rodEdge: this.material('rod', 0xe0ceb0, { metalness: 0.85, roughness: 0.24 }),
      crank: this.material('crank', 0x758d9b, { metalness: 0.87, roughness: 0.24 }),
      crankDark: this.material('crank', 0x334b53, { metalness: 0.82, roughness: 0.33 }),
      crankAccent: this.material('crank', 0xb3ac8f, { metalness: 0.8 }),
      valve: this.material('valves', 0xadc4cb, { metalness: 0.9, roughness: 0.23 }),
      spring: this.material('valves', 0x718a94, { metalness: 0.91, roughness: 0.2 }),
      intake: this.material('valves', 0x4bc4d3, { transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide, metalness: 0.25 }),
      exhaust: this.material('valves', 0xbd9479, { transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide, metalness: 0.25 }),
      intakeRim: this.material('valves', 0x53a9b6),
      exhaustRim: this.material('valves', 0xa5866e),
      injector: this.material('injector', 0xbfac77, { metalness: 0.83, roughness: 0.29 }),
      injectorDark: this.material('injector', 0x334447, { metalness: 0.8, roughness: 0.25 }),
    };
  }

  mesh(parent, geometry, material, part, position = [0, 0, 0]) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    mesh.castShadow = !material.transparent;
    mesh.receiveShadow = true;
    mesh.userData.part = part;
    parent.add(mesh);
    if (part) this.pickables.push(mesh);
    return mesh;
  }

  box(parent, size, position, material, part, radius = 0.035) {
    return this.mesh(parent, new RoundedBoxGeometry(...size, 2, radius), material, part, position);
  }

  cylinder(parent, radius, height, position, material, part, axis = 'y', segments = 40) {
    const mesh = this.mesh(parent, new THREE.CylinderGeometry(radius, radius, height, segments), material, part, position);
    if (axis === 'z') mesh.rotation.x = Math.PI / 2;
    if (axis === 'x') mesh.rotation.z = Math.PI / 2;
    return mesh;
  }

  torus(parent, radius, tube, position, material, part, axis = 'z', arc = TAU) {
    const mesh = this.mesh(parent, new THREE.TorusGeometry(radius, tube, 8, 64, arc), material, part, position);
    if (axis === 'y') mesh.rotation.x = Math.PI / 2;
    if (axis === 'x') mesh.rotation.y = Math.PI / 2;
    return mesh;
  }

  sleeve(parent, inner, outer, bottom, top, start, span, material) {
    const points = [[inner, bottom], [outer, bottom], [outer, top], [inner, top], [inner, bottom]];
    return this.mesh(parent, new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), 64, start, span), material, 'cylinder');
  }

  createEngine() {
    const scale = WORLD_SCALE;
    this.crankRadius = ENGINE.stroke / 2 * scale;
    this.rodLength = ENGINE.rodLength * scale;
    this.pistonCrownOffset = 0.42;
    this.headY = (ENGINE.rodLength + ENGINE.stroke / 2) * scale
      + this.pistonCrownOffset + ENGINE.stroke * scale / (ENGINE.compressionRatio - 1);
    this.rearShell = new THREE.Group();
    this.frontShell = new THREE.Group();
    this.cutFaces = new THREE.Group();
    this.root.add(this.rearShell, this.frontShell, this.cutFaces);
    this.createCylinder();
    this.createCrank();
    this.createPistonAndRod();
    this.createHead();
    this.createGas();
  }

  createCylinder() {
    for (const [parent, start] of [[this.rearShell, Math.PI / 2], [this.frontShell, -Math.PI / 2]]) {
      this.sleeve(parent, 0.87, 0.95, 1.68, this.headY, start, Math.PI, this.m.liner);
      this.sleeve(parent, 0.95, 1.085, 1.66, this.headY + 0.07, start, Math.PI, this.m.housing);
      for (let i = 0; i < 9; i++) {
        const y = 1.9 + i * 0.265;
        this.sleeve(parent, 1.065, 1.19, y, y + 0.068, start, Math.PI, this.m.housing);
      }
      this.sleeve(parent, 0.87, 1.2, 1.67, 1.85, start, Math.PI, this.m.housing);
      const z = parent === this.rearShell ? -0.47 : 0.47;
      this.box(parent, [2.54, 0.32, 0.94], [0, this.headY + 0.20, z], this.m.housing, 'cylinder');
      this.box(parent, [2.62, 0.09, 0.98], [0, this.headY + 0.40, z], this.m.liner, 'cylinder', 0.02);
      for (const x of [-1.07, 1.07]) {
        this.cylinder(parent, 0.076, 0.18, [x, this.headY + 0.47, z * 1.5], this.m.cylinderBolt, 'cylinder', 'y', 6);
        this.cylinder(parent, 0.097, 0.035, [x, this.headY + 0.40, z * 1.5], this.m.cylinderBolt, 'cylinder');
      }
    }
    for (const x of [-0.99, 0.99]) {
      this.box(this.cutFaces, [0.235, this.headY - 1.66, 0.032], [x, (this.headY + 1.66) / 2, 0.018], this.m.cut, 'cylinder', 0.006);
    }
    this.box(this.cutFaces, [2.51, 0.31, 0.027], [0, this.headY + 0.20, 0.012], this.m.cut, 'cylinder', 0.012);

    for (const x of [-1.23, 1.23]) {
      this.box(this.root, [0.24, 2.95, 0.43], [x, 0.11, -0.38], this.m.housing, 'cylinder', 0.055);
      this.box(this.root, [0.72, 0.18, 1.65], [x, -1.33, 0], this.m.housing, 'cylinder');
      for (const z of [-0.62, 0.62]) {
        this.cylinder(this.root, 0.09, 0.13, [x, -1.22, z], this.m.cylinderBolt, 'cylinder', 'y', 6);
      }
    }
    this.box(this.root, [2.92, 0.15, 1.95], [0, -1.46, 0], this.m.housing, 'cylinder');
    for (const z of [-0.77, 0.77]) {
      this.box(this.root, [0.77, 0.63, 0.31], [0, -0.11, z], this.m.housing, 'cylinder', 0.09);
      this.torus(this.root, 0.25, 0.068, [0, 0, z + 0.17], this.m.cylinderBolt, 'cylinder');
    }
  }

  createCrank() {
    this.crank = new THREE.Group();
    this.crank.name = 'crankshaft';
    this.root.add(this.crank);
    for (const z of [-0.80, 0.80]) {
      this.cylinder(this.crank, 0.205, 0.75, [0, 0, z], this.m.crank, 'crank', 'z');
    }
    this.cylinder(this.crank, 0.23, 0.94, [0, this.crankRadius, 0], this.m.crankAccent, 'crank', 'z');
    for (const z of [-0.43, 0.43]) {
      this.box(this.crank, [0.52, 1.14, 0.23], [0, 0.44, z], this.m.crank, 'crank', 0.12);
      this.cylinder(this.crank, 0.35, 0.23, [0, this.crankRadius, z], this.m.crank, 'crank', 'z');
      this.cylinder(this.crank, 0.36, 0.25, [0, 0, z], this.m.crank, 'crank', 'z');
      const counterweight = new THREE.Shape();
      counterweight.moveTo(-0.67, 0.05);
      counterweight.lineTo(-0.96, -0.43);
      counterweight.absarc(0, -0.12, 1.0, Math.PI * 1.1, Math.PI * 1.9, false);
      counterweight.lineTo(0.67, 0.05);
      counterweight.closePath();
      const geometry = new THREE.ExtrudeGeometry(counterweight, { depth: 0.20, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 2, steps: 1 });
      this.mesh(this.crank, geometry, this.m.crankDark, 'crank', [0, 0, z - 0.10]);
      this.cylinder(this.crank, 0.10, 0.03, [0, this.crankRadius, z + (z > 0 ? 0.14 : -0.14)], this.m.crankAccent, 'crank', 'z', 6);
    }

    const wheel = new THREE.Group();
    wheel.position.z = -1.2;
    this.crank.add(wheel);
    this.torus(wheel, 1.16, 0.16, [0, 0, 0], this.m.crankDark, 'crank');
    this.torus(wheel, 1.22, 0.028, [0, 0, 0.14], this.m.crankAccent, 'crank');
    this.cylinder(wheel, 0.37, 0.28, [0, 0, 0], this.m.crank, 'crank', 'z');
    for (let i = 0; i < 8; i++) {
      const angle = i / 8 * TAU;
      const spoke = this.box(wheel, [0.15, 0.83, 0.15], [Math.sin(angle) * 0.70, Math.cos(angle) * 0.70, 0], this.m.crank, 'crank');
      spoke.rotation.z = -angle;
    }
    const teeth = new THREE.InstancedMesh(new THREE.BoxGeometry(0.075, 0.10, 0.21), this.m.crankAccent, 48);
    for (let i = 0; i < 48; i++) {
      const angle = i / 48 * TAU;
      this.temp.position.set(Math.sin(angle) * 1.32, Math.cos(angle) * 1.32, 0);
      this.temp.rotation.set(0, 0, -angle);
      this.temp.scale.setScalar(1);
      this.temp.updateMatrix();
      teeth.setMatrixAt(i, this.temp.matrix);
    }
    teeth.castShadow = true;
    teeth.userData.part = 'crank';
    this.pickables.push(teeth);
    wheel.add(teeth);
    this.cylinder(this.crank, 0.30, 0.14, [0, 0, 1.22], this.m.crank, 'crank', 'z');
    this.cylinder(this.crank, 0.125, 0.15, [0, 0, 1.32], this.m.crankAccent, 'crank', 'z', 6);
    this.crankPin = new THREE.Object3D();
    this.crankPin.name = 'crank-pin';
    this.crankPin.position.y = this.crankRadius;
    this.crank.add(this.crankPin);
  }

  createPistonAndRod() {
    this.piston = new THREE.Group();
    this.piston.name = 'piston';
    this.root.add(this.piston);
    // A lathed, genuinely recessed piston crown and hollow skirt.
    const profile = [
      [0.68, -0.43], [0.835, -0.43], [0.85, -0.30], [0.85, 0.32],
      [0.82, 0.42], [0.46, 0.42], [0.41, 0.38], [0.35, 0.25],
      [0.16, 0.22], [0, 0.29], [0, 0.08], [0.68, 0.08], [0.68, -0.43],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    this.mesh(this.piston, new THREE.LatheGeometry(profile, 96), this.m.piston, 'piston');
    for (const y of [0.31, 0.205, 0.085]) {
      this.torus(this.piston, 0.851, 0.020, [0, y, 0], this.m.pistonRing, 'piston', 'y');
    }
    this.cylinder(this.piston, 0.112, 1.72, [0, 0, 0], this.m.pistonPin, 'piston', 'z');
    for (const z of [-0.855, 0.855]) {
      this.torus(this.piston, 0.115, 0.017, [0, 0, z], this.m.pistonRing, 'piston');
    }

    this.rod = new THREE.Group();
    this.rod.name = 'connecting-rod';
    this.root.add(this.rod);
    this.box(this.rod, [0.245, this.rodLength - 0.40, 0.16], [0, this.rodLength / 2, 0], this.m.rod, 'rod');
    for (const z of [-0.12, 0.12]) {
      this.box(this.rod, [0.32, this.rodLength - 0.58, 0.07], [0, this.rodLength / 2, z], this.m.rodEdge, 'rod', 0.02);
    }
    this.torus(this.rod, 0.29, 0.08, [0, 0, 0], this.m.rod, 'rod');
    this.torus(this.rod, 0.17, 0.06, [0, this.rodLength, 0], this.m.rodEdge, 'rod');
    this.box(this.rod, [0.66, 0.16, 0.32], [0, -0.20, 0], this.m.rod, 'rod');
    for (const x of [-0.24, 0.24]) {
      this.cylinder(this.rod, 0.052, 0.25, [x, -0.21, 0], this.m.rodEdge, 'rod', 'y', 6);
    }
    this.rodSmallEnd = new THREE.Object3D();
    this.rodSmallEnd.position.y = this.rodLength;
    this.rod.add(this.rodSmallEnd);
  }

  createValve(x) {
    const assembly = new THREE.Group();
    assembly.position.set(x, this.headY, 0.12);
    this.root.add(assembly);
    const moving = new THREE.Group();
    assembly.add(moving);
    this.cylinder(moving, 0.225, 0.055, [0, 0.015, 0], this.m.valve, 'valves');
    this.mesh(moving, new THREE.CylinderGeometry(0.075, 0.20, 0.095, 32), this.m.valve, 'valves', [0, 0.08, 0]);
    this.cylinder(moving, 0.039, 1.04, [0, 0.57, 0], this.m.valve, 'valves');
    this.cylinder(assembly, 0.085, 0.34, [0, 0.43, 0], this.m.spring, 'valves');
    this.cylinder(assembly, 0.165, 0.06, [0, 0.49, 0], this.m.valve, 'valves');
    this.cylinder(moving, 0.17, 0.06, [0, 1.10, 0], this.m.valve, 'valves');
    const helix = [];
    for (let i = 0; i <= 140; i++) {
      const t = i / 140;
      helix.push(V3(Math.cos(t * TAU * 7) * 0.12, t * 0.57, Math.sin(t * TAU * 7) * 0.12));
    }
    const spring = this.mesh(assembly, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(helix), 140, 0.022, 6, false), this.m.spring, 'valves', [0, 0.52, 0]);
    return { assembly, moving, spring };
  }

  createHead() {
    this.intakeValve = this.createValve(-0.47);
    this.exhaustValve = this.createValve(0.47);
    this.injector = new THREE.Group();
    this.injector.position.set(0, this.headY, 0.015);
    this.root.add(this.injector);
    this.cylinder(this.injector, 0.068, 0.42, [0, 0.19, 0], this.m.injector, 'injector');
    this.mesh(this.injector, new THREE.ConeGeometry(0.063, 0.15, 24), this.m.injectorDark, 'injector', [0, 0.012, 0]).rotation.z = Math.PI;
    this.cylinder(this.injector, 0.12, 0.56, [0, 0.64, 0], this.m.injector, 'injector');
    this.cylinder(this.injector, 0.17, 0.19, [0, 0.85, 0], this.m.injectorDark, 'injector', 'y', 6);
    this.cylinder(this.injector, 0.115, 0.27, [0, 1.08, 0], this.m.injector, 'injector');
    this.cylinder(this.injector, 0.15, 0.17, [0, 1.28, 0], this.m.injectorDark, 'injector');
    for (const y of [0.43, 0.52, 0.97]) {
      this.torus(this.injector, 0.126, 0.018, [0, y, 0], this.m.injectorDark, 'injector', 'y');
    }
    const fuelLine = new THREE.CatmullRomCurve3([V3(0.08, 1.12, 0), V3(0.48, 1.37, 0), V3(0.97, 1.34, -0.17), V3(1.24, 0.85, -0.36)]);
    this.mesh(this.injector, new THREE.TubeGeometry(fuelLine, 40, 0.038, 8, false), this.m.injector, 'injector');

    this.intakeCurve = new THREE.CatmullRomCurve3([
      V3(-2.62, this.headY + 0.58, 0.02), V3(-1.90, this.headY + 0.58, 0.02),
      V3(-1.02, this.headY + 0.42, 0.08), V3(-0.47, this.headY + 0.20, 0.12),
      V3(-0.47, this.headY - 0.07, 0.12),
    ]);
    this.exhaustCurve = new THREE.CatmullRomCurve3([
      V3(0.47, this.headY - 0.07, 0.12), V3(0.47, this.headY + 0.20, 0.12),
      V3(1.02, this.headY + 0.42, 0.08), V3(1.90, this.headY + 0.58, 0.02),
      V3(2.62, this.headY + 0.58, 0.02),
    ]);
    for (const [curve, material] of [[this.intakeCurve, this.m.intake], [this.exhaustCurve, this.m.exhaust]]) {
      this.mesh(this.root, new THREE.TubeGeometry(curve, 50, 0.21, 16, false), material, 'valves');
    }
    for (const side of [-1, 1]) {
      for (const x of [2.56, 1.70]) {
        this.torus(this.root, 0.23, 0.035, [side * x, this.headY + 0.58, 0.02], side < 0 ? this.m.intakeRim : this.m.exhaustRim, 'valves', 'x');
      }
    }
  }

  createFlowParticles(color, count) {
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false });
    const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.035, 6, 4), material, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    this.root.add(mesh);
    return mesh;
  }

  createGas() {
    this.gasMaterial = new THREE.MeshBasicMaterial({ color: 0x55cbdc, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false });
    this.gas = new THREE.Mesh(new THREE.CylinderGeometry(0.835, 0.835, 1, 48), this.gasMaterial);
    this.gas.renderOrder = 2;
    this.root.add(this.gas);
    const positions = new Float32Array(105 * 3);
    this.gasPositions = positions;
    this.gasGeometry = new THREE.BufferGeometry();
    this.gasGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.gasPoints = new THREE.Points(this.gasGeometry, new THREE.PointsMaterial({ color: 0x85ecff, size: 0.045, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.gasPoints.frustumCulled = false;
    this.root.add(this.gasPoints);
    this.intakeParticles = this.createFlowParticles(0x85edff, 23);
    this.exhaustParticles = this.createFlowParticles(0xc8b9a3, 23);
    this.fuelParticles = this.createFlowParticles(0xffd685, 32);
  }

  createLabels() {
    const entries = [
      ['进气道', 'intake', '#55cbdc', 'left'],
      ['喷油器', 'injector', '#f5ad66', 'right'],
      ['排气道', 'exhaust', '#bfa98e', 'right'],
      ['活塞', 'piston', '#d3e2e9', 'right'],
      ['连杆', 'rod', '#c8b58e', 'left'],
      ['曲轴', 'crank', '#a4bac5', 'right'],
    ];
    for (const [text, key, color, side] of entries) {
      const element = document.createElement('div');
      element.className = `model-label ${side}`;
      element.style.setProperty('--label-color', color);
      const dot = document.createElement('span');
      dot.className = 'label-dot';
      const line = document.createElement('span');
      line.className = 'label-line';
      const label = document.createElement('span');
      label.className = 'label-text';
      label.textContent = text;
      element.append(dot, line, label);
      this.labelLayer.append(element);
      this.labels.push({ key, side, element, width: element.offsetWidth, point: new THREE.Vector3() });
    }
  }

  setMode(mode) {
    if (!['cutaway', 'xray', 'solid'].includes(mode)) return;
    this.mode = mode;
    this.frontShell.visible = mode !== 'cutaway';
    this.cutFaces.visible = mode === 'cutaway';
    for (const name of ['housing', 'liner']) {
      const material = this.m[name];
      material.transparent = mode === 'xray';
      material.opacity = mode === 'xray' ? 0.14 : 1;
      material.depthWrite = mode !== 'xray';
      material.needsUpdate = true;
    }
    for (const group of [this.frontShell, this.rearShell]) {
      group.traverse(object => {
        if (object.isMesh) object.castShadow = mode !== 'xray';
      });
    }
    this.needsRender = true;
    this.renderer.shadowMap.needsUpdate = true;
    this.updateLabelVisibility();
  }

  setLabels(enabled) {
    this.labelsEnabled = enabled;
    this.updateLabelVisibility();
  }

  updateLabelVisibility() {
    this.labelLayer.hidden = !this.labelsEnabled;
    this.needsRender = true;
    for (const label of this.labels) {
      label.hiddenInMode = this.mode === 'solid' && ['piston', 'rod'].includes(label.key);
    }
  }

  setParticles(enabled) {
    this.particlesEnabled = enabled;
    this.lastAngle = null;
  }

  selectPart(part) {
    this.selectedPart = PART_DETAILS[part] ? part : null;
    this.needsRender = true;
    for (const [key, materials] of this.materialsByPart) {
      for (const material of materials) {
        material.emissive.set(key === this.selectedPart ? 0x3ba87e : 0x000000);
        material.emissiveIntensity = key === this.selectedPart ? 0.42 : 0;
      }
    }
  }

  resize() {
    const { width, height } = this.container.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;
    const previousAspect = this.camera.aspect;
    this.width = width;
    this.height = height;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.needsRender = true;
    if (this.currentCamera && Math.abs(previousAspect - this.camera.aspect) > 0.3) {
      this.setCamera(this.currentCamera);
    }
  }

  setCamera(preset = 'perspective') {
    const directions = {
      perspective: V3(5.3, 3.15, 10.5).normalize(),
      front: V3(0, 0.4, 12).normalize(),
      side: V3(12, 1.3, 0.3).normalize(),
    };
    if (!directions[preset]) return;
    this.currentCamera = preset;
    this.controls.autoRotate = false;
    // Flush orbit damping so reset remains exact even during a drag.
    this.controls.enableDamping = false;
    this.controls.update();
    const aspect = this.camera.aspect;
    const distance = Math.max(12.5, 8.5 / Math.max(aspect, 0.48));
    this.controls.target.set(0, 2.13, 0);
    this.camera.position.copy(directions[preset]).multiplyScalar(distance).add(this.controls.target);
    this.controls.update();
    this.controls.enableDamping = true;
  }

  keyboardCamera(key, shiftKey = false) {
    const direction = { a: [1, 0], d: [-1, 0], w: [0, 1], s: [0, -1] }[key];
    if (direction) {
      this.currentCamera = null;
      this.callbacks.onCameraChange?.();
      if (shiftKey) this.controls.pan(direction[0] * 22, -direction[1] * 22);
      else {
        this.controls.rotateLeft(direction[0] * 0.13);
        this.controls.rotateUp(direction[1] * 0.13);
      }
      this.controls.update();
      return true;
    }
    if (['+', '=', '-', '_'].includes(key)) {
      this.zoom(key === '+' || key === '=' ? 0.90 : 1.11);
      return true;
    }
    return false;
  }

  zoom(factor) {
    this.vector.copy(this.camera.position).sub(this.controls.target).multiplyScalar(factor);
    this.vector.clampLength(this.controls.minDistance, this.controls.maxDistance);
    this.camera.position.copy(this.controls.target).add(this.vector);
    this.controls.update();
  }

  bindPointerSelection() {
    const canvas = this.renderer.domElement;
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let down = null;
    canvas.addEventListener('pointerdown', event => {
      if (event.button === 0) down = { x: event.clientX, y: event.clientY };
    }, { signal: this.abort.signal });
    canvas.addEventListener('pointerup', event => {
      if (!down || event.button !== 0 || Math.hypot(down.x - event.clientX, down.y - event.clientY) > 5) {
        down = null;
        return;
      }
      down = null;
      const rect = canvas.getBoundingClientRect();
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      raycaster.setFromCamera(pointer, this.camera);
      const visible = this.pickables.filter(object => {
        for (let parent = object; parent; parent = parent.parent) if (!parent.visible) return false;
        return true;
      });
      const hit = raycaster.intersectObjects(visible, false)[0];
      this.callbacks.onPartSelect?.(hit?.object.userData.part ?? null);
    }, { signal: this.abort.signal });
    canvas.addEventListener('pointercancel', () => { down = null; }, { signal: this.abort.signal });
  }

  updateFlow(mesh, curve, phase, enabled) {
    mesh.visible = this.particlesEnabled && enabled;
    if (!mesh.visible) return;
    for (let i = 0; i < mesh.count; i++) {
      const t = (i / mesh.count + phase) % 1;
      curve.getPoint(t, this.vector);
      this.temp.position.copy(this.vector);
      this.temp.position.y += Math.sin(i * 8.73) * 0.055;
      this.temp.position.z += Math.cos(i * 4.9) * 0.07;
      this.temp.rotation.set(0, 0, 0);
      this.temp.scale.setScalar(0.6 + (i % 5) * 0.15);
      this.temp.updateMatrix();
      mesh.setMatrixAt(i, this.temp.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  updateEngine(state) {
    this.needsRender = true;
    this.renderer.shadowMap.needsUpdate = true;
    const scale = WORLD_SCALE;
    this.piston.position.y = state.pistonY * scale;
    this.crank.rotation.z = -state.radians;
    this.rod.position.set(state.crankX * scale, state.crankY * scale, 0);
    this.direction.set(-state.crankX, state.pistonY - state.crankY, 0).normalize();
    this.rod.quaternion.setFromUnitVectors(UP, this.direction);
    for (const [valve, lift] of [[this.intakeValve, state.intakeLift], [this.exhaustValve, state.exhaustLift]]) {
      valve.moving.position.y = -lift * scale;
      valve.spring.scale.y = (0.57 - lift * scale) / 0.57;
    }

    const pistonTop = this.piston.position.y + this.pistonCrownOffset;
    const chamberHeight = Math.max(0.015, this.headY - pistonTop);
    this.gas.scale.y = chamberHeight;
    this.gas.position.y = pistonTop + chamberHeight / 2;
    this.gasMaterial.color.set(state.stroke.color);
    this.gasMaterial.opacity = state.strokeIndex === 2 ? 0.09 + state.combustion * 0.16 : 0.055;
    this.gas.visible = this.particlesEnabled;
    this.gasPoints.visible = this.particlesEnabled;
    this.gasPoints.material.color.set(state.stroke.color);
    this.gasPoints.material.size = state.strokeIndex === 2 ? 0.060 : 0.038;
    for (let i = 0; i < this.gasPositions.length / 3; i++) {
      const spin = i * 2.39996 + state.radians * 0.7;
      const radius = 0.77 * Math.sqrt(((i * 37) % 103) / 103);
      const height = ((i * 13.37) % 1) * 0.88 + 0.06;
      this.gasPositions[i * 3] = Math.cos(spin) * radius;
      this.gasPositions[i * 3 + 1] = pistonTop + chamberHeight * height;
      this.gasPositions[i * 3 + 2] = Math.sin(spin) * radius;
    }
    this.gasGeometry.attributes.position.needsUpdate = true;
    this.burnLight.position.set(0, this.headY - chamberHeight * 0.4, 0.28);
    this.burnLight.intensity = this.particlesEnabled ? state.combustion * 5 : 0;
    this.updateFlow(this.intakeParticles, this.intakeCurve, state.angle / 80, state.intakeLift > 0.1);
    this.updateFlow(this.exhaustParticles, this.exhaustCurve, state.angle / 80, state.exhaustLift > 0.1);
    this.fuelParticles.visible = this.particlesEnabled && state.injection > 0;
    if (this.fuelParticles.visible) {
      for (let i = 0; i < this.fuelParticles.count; i++) {
        const t = ((i / this.fuelParticles.count + state.angle / 13) % 1);
        const sprayAngle = i * 2.39996;
        const depth = Math.min(chamberHeight * 0.91, 0.68) * t;
        const radius = Math.min(0.64, depth * 1.3);
        this.temp.position.set(Math.cos(sprayAngle) * radius, this.headY - 0.015 - depth, Math.sin(sprayAngle) * radius);
        this.temp.rotation.set(0, 0, 0);
        this.temp.scale.setScalar(0.4 + t * 0.6);
        this.temp.updateMatrix();
        this.fuelParticles.setMatrixAt(i, this.temp.matrix);
      }
      this.fuelParticles.instanceMatrix.needsUpdate = true;
    }

    const points = {
      intake: [-2.1, this.headY + 0.62, 0.08],
      injector: [0.10, this.headY + 1.12, 0.08],
      exhaust: [2.15, this.headY + 0.60, 0.08],
      piston: [0.72, this.piston.position.y + 0.20, 0.30],
      rod: [state.crankX * scale * 0.5 - 0.1, (state.pistonY + state.crankY) * scale * 0.5, 0.10],
      crank: [0.33, 0.05, 1.34],
    };
    for (const label of this.labels) label.point.set(...points[label.key]);
    this.lastAngle = state.angle;
  }

  updateLabels() {
    if (!this.labelsEnabled) return;
    for (const { element, point, side, width, hiddenInMode } of this.labels) {
      this.projected.copy(point).project(this.camera);
      const x = (this.projected.x * 0.5 + 0.5) * this.width;
      const y = (-this.projected.y * 0.5 + 0.5) * this.height;
      const inFrame = this.projected.z > -1 && this.projected.z < 1 && x > 8 && x < this.width - 8 && y > 55 && y < this.height - 63;
      element.style.display = !hiddenInMode && inFrame ? 'flex' : 'none';
      const left = Math.max(8, Math.min(this.width - width - 8, side === 'left' ? x - width : x));
      element.style.transform = `translate(${left.toFixed(1)}px, ${y.toFixed(1)}px) translateY(-50%)`;
    }
  }

  render(state, elapsedSeconds = 0) {
    if (this.disposed) return;
    if (this.lastAngle !== state.angle) this.updateEngine(state);
    this.controls.update(Math.min(elapsedSeconds, 0.1));
    // Pausing must also let the GPU rest. Orbit changes and UI actions
    // invalidate the frame, so interactive inspection still works paused.
    if (!this.needsRender) return;
    this.camera.updateMatrixWorld();
    this.updateLabels();
    this.renderer.render(this.scene, this.camera);
    this.needsRender = false;
  }

  diagnostics() {
    this.root.updateMatrixWorld(true);
    const crankPin = this.crankPin.getWorldPosition(new THREE.Vector3());
    const rodBigEnd = this.rod.getWorldPosition(new THREE.Vector3());
    const rodSmallEnd = this.rodSmallEnd.getWorldPosition(new THREE.Vector3());
    const pistonPin = this.piston.getWorldPosition(new THREE.Vector3());
    return {
      renderer: 'WebGL2',
      mode: this.mode,
      selectedPart: this.selectedPart,
      meshCount: this.pickables.length,
      triangles: this.renderer.info.render.triangles,
      renderCalls: this.renderer.info.render.calls,
      frames: this.renderer.info.render.frame,
      environmentGeneration: this.environmentGeneration,
      camera: this.camera.position.toArray(),
      target: this.controls.target.toArray(),
      pistonPin: pistonPin.toArray(),
      crankPin: crankPin.toArray(),
      rodLength: rodBigEnd.distanceTo(rodSmallEnd),
      bigEndError: crankPin.distanceTo(rodBigEnd),
      smallEndError: pistonPin.distanceTo(rodSmallEnd),
      frontShellVisible: this.frontShell.visible,
      shellOpacity: this.m.housing.opacity,
      intakeLift: -this.intakeValve.moving.position.y / WORLD_SCALE,
      exhaustLift: -this.exhaustValve.moving.position.y / WORLD_SCALE,
      particlesVisible: this.gasPoints.visible,
      fuelVisible: this.fuelParticles.visible,
      contextLost: this.renderer.getContext().isContextLost(),
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.setAnimationLoop(null);
    const geometries = new Set();
    const materials = new Set();
    this.scene.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      if (object.material) {
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
      }
    });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
    this.environmentTarget.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelLayer.replaceChildren();
  }
}