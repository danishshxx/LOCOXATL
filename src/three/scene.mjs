import {
  ACESFilmicToneMapping,
  AmbientLight,
  BackSide,
  Box3,
  BoxGeometry,
  DirectionalLight,
  DoubleSide,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  PCFSoftShadowMap,
  PMREMGenerator,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  SRGBColorSpace,
  Scene,
  ShadowMaterial,
  Sphere,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CharmAssembly } from './assembly.mjs';
import { createMaterialLibrary } from './materials.mjs';

const DEFAULT_VIEW = new Vector3(0.22, 0.16, 1).normalize();
const EASE = (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2);

/**
 * Premium studio scene for the Custom Studio preview.
 *
 * Rendering is on demand: frames are only produced after interaction, a tween or a
 * resize, so an idle page costs no GPU time. Everything created here is disposed by
 * `dispose()`.
 */
export class StudioScene {
  constructor({ canvas, host, onSelect = () => {}, onError = () => {} }) {
    if (!canvas) throw new Error('StudioScene needs a canvas element.');
    this.canvas = canvas;
    this.host = host || canvas.parentElement;
    this.onSelect = onSelect;
    this.onError = onError;

    this.disposed = false;
    this.frame = 0;
    this.tween = null;
    this.cameraTween = null;
    this.userAdjustedCamera = false;
    this.materials = createMaterialLibrary();
    this.raycaster = new Raycaster();
    this.pointer = new Vector2();
  }

  init() {
    this.renderer = new WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.setClearAlpha(0);

    this.scene = new Scene();

    this.camera = new PerspectiveCamera(32, 1, 0.1, 100);
    this.camera.position.copy(DEFAULT_VIEW).multiplyScalar(9);

    this.createEnvironment();
    this.createLights();

    this.assembly = new CharmAssembly({ materials: this.materials });
    this.scene.add(this.assembly.root);

    this.createShadowCatcher();
    this.shadowDirty = true;

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.rotateSpeed = 0.72;
    this.controls.zoomSpeed = 0.85;
    this.controls.panSpeed = 0.7;
    this.controls.minDistance = 3.4;
    this.controls.maxDistance = 17;
    this.controls.minPolarAngle = 0.32;
    this.controls.maxPolarAngle = 2.82;
    this.controls.addEventListener('start', () => { this.userAdjustedCamera = true; });
    this.controls.addEventListener('change', () => this.requestRender());

    this.bindPointerEvents();
    this.bindResize();
    this.bindContextLoss();

    this.resize();
    this.requestRender();
    return this;
  }

  createEnvironment() {
    // A small studio built out of emissive panels. Glossy acrylic and polished metal need
    // bright highlights next to dark areas, so the room is deliberately dark with a large
    // key softbox and two strip lights instead of a uniformly white environment.
    const envScene = new Scene();

    const room = new Mesh(
      new BoxGeometry(14, 14, 14),
      new MeshBasicMaterial({ color: 0x494c50, side: BackSide }),
    );
    envScene.add(room);

    const addPanel = (width, height, intensity, position) => {
      const material = new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide });
      material.color.multiplyScalar(intensity);
      const panel = new Mesh(new PlaneGeometry(width, height), material);
      panel.position.set(...position);
      panel.lookAt(0, 0, 0);
      envScene.add(panel);
    };

    addPanel(7, 7, 1.7, [-3.6, 4.8, 3.4]);   // key softbox
    addPanel(5.6, 4.6, 2.6, [0.4, 2.2, 6.4]);  // camera-side softbox: the broad reflection on the face
    addPanel(5.6, 4.6, 0.15, [-2.4, -2.6, 6.0]); // low bounce so the face is not lit flat
    addPanel(3.2, 8, 1.0, [5.4, 0.8, 1.2]);   // right strip light
    addPanel(3.2, 8, 0.6, [-5.4, 0.2, -1.2]); // left fill strip
    addPanel(11, 11, 0.18, [0, -6.4, 0]);     // floor bounce

    const pmrem = new PMREMGenerator(this.renderer);
    this.environmentTarget = pmrem.fromScene(envScene, 0.03);
    this.scene.environment = this.environmentTarget.texture;
    this.scene.environmentIntensity = 0.8;
    pmrem.dispose();

    envScene.traverse((object) => {
      if (!object.isMesh) return;
      object.geometry.dispose();
      object.material.dispose();
    });
  }

  createLights() {
    this.scene.add(new AmbientLight(0xffffff, 0.06));
    this.scene.add(new HemisphereLight(0xffffff, 0x9aa0a6, 0.1));

    const key = new DirectionalLight(0xffffff, 1.5);
    key.position.set(3.4, 5.6, 5.0);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.radius = 5;
    key.shadow.bias = -0.0008;
    key.shadow.normalBias = 0.02;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 26;
    key.shadow.camera.left = -5;
    key.shadow.camera.right = 5;
    key.shadow.camera.top = 6;
    key.shadow.camera.bottom = -6;
    this.scene.add(key);
    this.keyLight = key;

    const fill = new DirectionalLight(0xffffff, 0.22);
    fill.position.set(-5.5, 1.2, 3.4);
    this.scene.add(fill);

    // Two rims from behind to carve the acrylic edges out of the background.
    const rimLeft = new DirectionalLight(0xffffff, 0.85);
    rimLeft.position.set(-3.4, 2.4, -4.6);
    this.scene.add(rimLeft);

    const rimRight = new DirectionalLight(0xffffff, 0.6);
    rimRight.position.set(3.8, 1.2, -4.2);
    this.scene.add(rimRight);
  }

  createShadowCatcher() {
    const geometry = new PlaneGeometry(26, 26);
    const material = new ShadowMaterial({ color: 0x000000, opacity: 0.26, transparent: true });
    const plane = new Mesh(geometry, material);
    plane.rotation.x = -Math.PI / 2;
    plane.receiveShadow = true;
    plane.name = 'shadow-catcher';
    this.scene.add(plane);
    this.shadowPlane = plane;
  }

  bindPointerEvents() {
    let downPoint = null;
    let hoverAt = 0;

    const onPointerDown = (event) => {
      downPoint = { x: event.clientX, y: event.clientY, time: Date.now() };
    };

    const onPointerUp = (event) => {
      if (!downPoint) return;
      const travel = Math.hypot(event.clientX - downPoint.x, event.clientY - downPoint.y);
      const elapsed = Date.now() - downPoint.time;
      downPoint = null;
      if (travel > 6 || elapsed > 700) return;
      this.pick(event.clientX, event.clientY);
    };

    const onPointerMove = (event) => {
      if (event.buttons !== 0) return;
      const now = Date.now();
      if (now - hoverAt < 90) return;
      hoverAt = now;
      const hit = this.pick(event.clientX, event.clientY, { silent: true });
      this.canvas.style.cursor = hit ? 'pointer' : 'grab';
    };

    const onPointerCancel = () => { downPoint = null; };
    const onPointerLeave = () => { this.canvas.style.cursor = ''; };

    this.canvas.addEventListener('pointerdown', onPointerDown);
    this.canvas.addEventListener('pointerup', onPointerUp);
    this.canvas.addEventListener('pointermove', onPointerMove);
    this.canvas.addEventListener('pointercancel', onPointerCancel);
    this.canvas.addEventListener('pointerleave', onPointerLeave);

    this.unbindPointer = () => {
      this.canvas.removeEventListener('pointerdown', onPointerDown);
      this.canvas.removeEventListener('pointerup', onPointerUp);
      this.canvas.removeEventListener('pointermove', onPointerMove);
      this.canvas.removeEventListener('pointercancel', onPointerCancel);
      this.canvas.removeEventListener('pointerleave', onPointerLeave);
    };
  }

  pick(clientX, clientY, { silent = false } = {}) {
    if (!this.assembly) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const targets = this.assembly.registry.list()
      .filter((component) => component.visible)
      .map((component) => component.group);
    const hits = this.raycaster.intersectObjects(targets, true)
      .filter((hit) => hit.object.userData.componentId && hit.object.name !== 'selection-marker');
    const hit = hits[0] || null;
    if (!silent) this.onSelect(hit ? hit.object.userData.componentId : null);
    return hit ? hit.object.userData.componentId : null;
  }

  bindResize() {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    window.addEventListener('orientationchange', this.handleOrientation = () => this.resize());
  }

  bindContextLoss() {
    this.handleContextLost = (event) => {
      event.preventDefault();
      this.onError(new Error('WebGL context lost'));
    };
    this.canvas.addEventListener('webglcontextlost', this.handleContextLost);
  }

  /** Frame the whole assembly, taking the current aspect ratio into account. */
  fitCamera({ immediate = false } = {}) {
    const box = new Box3().setFromObject(this.assembly.root);
    const sphere = box.getBoundingSphere(new Sphere());
    const center = sphere.center.clone();
    const radius = Math.max(sphere.radius, 1);

    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const limitingHalf = Math.min(vFov / 2, hFov / 2);
    const distance = (radius / Math.sin(limitingHalf)) * 0.92;
    const clamped = Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance, distance));
    const position = center.clone().add(DEFAULT_VIEW.clone().multiplyScalar(clamped));

    this.controls.target.copy(center);
    if (immediate) {
      this.camera.position.copy(position);
      this.camera.lookAt(center);
      this.camera.updateProjectionMatrix();
      this.controls.update();
      this.requestRender();
      return;
    }
    this.cameraTween = {
      fromPosition: this.camera.position.clone(),
      toPosition: position,
      fromTarget: this.controls.target.clone(),
      toTarget: center,
      start: performance.now(),
      duration: this.motionDuration(520),
    };
    this.requestRender();
  }

  motionDuration(duration) {
    if (typeof window !== 'undefined' && window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return 1;
    }
    return duration;
  }

  resize() {
    if (this.disposed || !this.renderer) return;
    const width = Math.max(1, Math.round(this.host.clientWidth));
    const height = Math.max(1, Math.round(this.host.clientHeight));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (!this.userAdjustedCamera) this.fitCamera({ immediate: true });
    this.requestRender();
  }

  requestRender() {
    if (this.disposed) return;
    if (this.frame) return;
    this.frame = requestAnimationFrame(this.tick);
  }

  tick = (now) => {
    this.frame = 0;
    if (this.disposed) return;
    let again = false;

    if (this.controls && this.controls.update()) again = true;

    if (this.tween) {
      const progress = Math.min(1, (now - this.tween.start) / this.tween.duration);
      this.assembly.registry.setExplode(this.tween.from + (this.tween.to - this.tween.from) * EASE(progress));
      again = true;
      if (progress >= 1) this.tween = null;
    }

    if (this.cameraTween) {
      const progress = Math.min(1, (now - this.cameraTween.start) / this.cameraTween.duration);
      const eased = EASE(progress);
      this.camera.position.lerpVectors(this.cameraTween.fromPosition, this.cameraTween.toPosition, eased);
      this.controls.target.lerpVectors(this.cameraTween.fromTarget, this.cameraTween.toTarget, eased);
      this.camera.lookAt(this.controls.target);
      again = true;
      if (progress >= 1) this.cameraTween = null;
    }

    if (this.shadowPlane && (this.tween || this.shadowDirty)) {
      const box = new Box3().setFromObject(this.assembly.root);
      if (!box.isEmpty()) this.shadowPlane.position.y = box.min.y - 0.34;
      this.shadowDirty = Boolean(this.tween);
    }

    this.renderer.render(this.scene, this.camera);
    if (again) this.requestRender();
  };

  applyConfiguration(configuration) {
    const result = this.assembly.apply(configuration);
    if (result.baseChanged) this.fitCamera();
    this.refreshShadowCamera();
    this.shadowDirty = true;
    this.requestRender();
    return result;
  }

  refreshShadowCamera() {
    const box = new Box3().setFromObject(this.assembly.root);
    if (box.isEmpty() || !this.keyLight) return;
    const radius = Math.max(box.getSize(new Vector3()).length() * 0.75, 2);
    const camera = this.keyLight.shadow.camera;
    camera.left = -radius;
    camera.right = radius;
    camera.top = radius;
    camera.bottom = -radius;
    camera.updateProjectionMatrix();
  }

  select(id) {
    const component = this.assembly.registry.select(id);
    this.requestRender();
    return component;
  }

  setVisible(id, visible) {
    const result = this.assembly.registry.setVisible(id, visible);
    this.requestRender();
    return result;
  }

  setFinish(id, finishId) {
    const result = this.assembly.registry.setFinish(id, finishId);
    this.requestRender();
    return result;
  }

  setExploded(exploded) {
    const to = exploded ? 1 : 0;
    const from = this.assembly.registry.explodeValue;
    if (Math.abs(to - from) < 0.001) return;
    this.tween = {
      from,
      to,
      start: performance.now(),
      duration: this.motionDuration(exploded ? 720 : 620),
    };
    this.requestRender();
  }

  get exploded() {
    return this.assembly.registry.explodeValue >= 0.5;
  }

  resetCamera() {
    this.userAdjustedCamera = false;
    this.fitCamera();
  }

  getSnapshot() {
    return {
      engine: 'locoxatl-three',
      version: 1,
      explode: Number(this.assembly.registry.explodeValue.toFixed(3)),
      components: this.assembly.snapshot(),
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    if (this.resizeObserver) this.resizeObserver.disconnect();
    window.removeEventListener('orientationchange', this.handleOrientation);
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    if (this.unbindPointer) this.unbindPointer();
    if (this.controls) this.controls.dispose();
    if (this.assembly) this.assembly.dispose();
    if (this.materials) this.materials.dispose();
    if (this.shadowPlane) {
      this.shadowPlane.geometry.dispose();
      this.shadowPlane.material.dispose();
    }
    if (this.environmentTarget) this.environmentTarget.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      const gl = this.renderer.getContext();
      if (gl && gl.getExtension('WEBGL_lose_context')) gl.getExtension('WEBGL_lose_context').loseContext();
    }
    if (this.scene) this.scene.clear();
    this.canvas.style.cursor = '';
  }
}