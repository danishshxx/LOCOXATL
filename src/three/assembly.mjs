import { Group, Mesh, MeshBasicMaterial, TorusGeometry, Vector3 } from 'three';
import { CharmComponent, ComponentRegistry } from './components.mjs';
import {
  CHARM_SILHOUETTES,
  buildCharmGeometry,
  createLoopGeometry,
  createMedallionGeometry,
  createMiniStarGeometry,
  createPearlGeometry,
  createPinGeometry,
  createRibbonKnotGeometry,
} from './shapes.mjs';
import { createLetterFace } from './letter.mjs';

export const CHARM_SIZE = 2.9;

// Anchor points in the original SVG canvas space (viewBox 0 0 400 420). They reproduce
// the add-on positions already used by the flat preview, so the 3D composition keeps the
// same visual arrangement as the approved artwork.
const ANCHORS = {
  pearlBail: { x: 260, y: 285 },
  pearlCenter: { x: 260, y: 321 },
  starBail: { x: 132, y: 291 },
  starCenter: { x: 132, y: 318 },
  initial: { x: 200, y: 268 },
};

const PEARL_RADIUS = 0.3;
const MINI_STAR_SIZE = 0.74;
const MEDALLION_RADIUS = 0.3;

const EXPLODE = {
  base: [0, 0, 0],
  connector: [0, 0.9, 0.85],
  clasp: [0, 1.8, 1.5],
  pearl: [1.15, -0.55, 1.0],
  star: [-1.15, -0.55, 1.0],
  initial: [0, -0.15, 1.45],
};

function createSelectionMarker() {
  const geometry = new TorusGeometry(1, 0.0075, 8, 108);
  const material = new MeshBasicMaterial({
    color: 0x111111,
    transparent: true,
    opacity: 0.42,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'selection-marker';
  mesh.renderOrder = 20;
  return mesh;
}

export class CharmAssembly {
  constructor({ materials, size = CHARM_SIZE }) {
    this.materials = materials;
    this.size = size;
    this.root = new Group();
    this.root.name = 'locoxatl-assembly';
    this.ownedGeometries = new Set();
    this.baseId = null;
    this.metrics = null;
    this.initialLetter = '';
    this.registry = new ComponentRegistry({
      root: this.root,
      materials,
      markerFactory: createSelectionMarker,
    });
    this.createComponents();
  }

  own(geometry) {
    this.ownedGeometries.add(geometry);
    return geometry;
  }

  mesh(geometry, finishId, extra = {}) {
    this.own(geometry);
    const mesh = new Mesh(geometry, this.materials.get(finishId));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    Object.assign(mesh.userData, extra);
    return mesh;
  }

  createComponents() {
    const registry = this.registry;

    // 01 — Base charm. Rebuilt whenever the customer switches silhouette.
    const baseGroup = new Group();
    baseGroup.name = 'base-charm';
    this.baseGroup = baseGroup;
    this.baseMesh = null;
    this.knotMesh = null;
    registry.add(new CharmComponent({
      id: 'base',
      name: 'Base charm',
      type: 'base',
      group: baseGroup,
      finishes: ['acrylic', 'pearl', 'silver', 'black'],
      defaultFinish: 'acrylic',
      explodeOffset: EXPLODE.base,
    }));

    // 02 — Connector ring (hardware that links the charm to the clasp).
    const connectorGroup = new Group();
    const connectorRing = this.mesh(createLoopGeometry(0.3, 0.062, 56), 'silver');
    const connectorBail = this.mesh(createLoopGeometry(0.078, 0.026, 36), 'silver');
    connectorBail.position.y = -0.36;
    connectorGroup.add(connectorRing, connectorBail);
    registry.add(new CharmComponent({
      id: 'connector',
      name: 'Connector ring',
      type: 'connector',
      group: connectorGroup,
      finishes: ['silver', 'black'],
      defaultFinish: 'silver',
      explodeOffset: EXPLODE.connector,
    }));

    // 03 — Clasp. Silver or black, driven by the existing clasp control.
    const claspGroup = new Group();
    const claspRing = this.mesh(createLoopGeometry(0.16, 0.052, 48), 'silver');
    claspRing.scale.set(1, 1.4, 1);
    const claspLever = this.mesh(createPinGeometry(0.26, 0.026), 'silver');
    claspLever.position.set(0.012, -0.2, 0);
    claspLever.rotation.z = 0.16;
    const claspSwivel = this.mesh(createLoopGeometry(0.07, 0.022, 28), 'silver');
    claspSwivel.position.y = -0.34;
    claspGroup.add(claspRing, claspLever, claspSwivel);
    registry.add(new CharmComponent({
      id: 'clasp',
      name: 'Clasp',
      type: 'clasp',
      group: claspGroup,
      finishes: ['silver', 'black'],
      defaultFinish: 'silver',
      explodeOffset: EXPLODE.clasp,
    }));

    // 04 — Pearl drop.
    const pearlGroup = new Group();
    const pearlBody = this.mesh(createPearlGeometry(PEARL_RADIUS), 'pearl');
    const pearlBail = this.mesh(createLoopGeometry(0.072, 0.022, 32), 'silver');
    pearlBail.position.y = PEARL_RADIUS + 0.07;
    // Hanger wire that reaches from the pearl bail to the actual charm edge. It is a unit
    // cylinder scaled and rotated by layout(), so the drop always looks attached no matter
    // which silhouette is selected.
    const pearlHanger = this.mesh(createPinGeometry(1, 0.02), 'silver');
    const pearlJumpRing = this.mesh(createLoopGeometry(0.045, 0.014, 20), 'silver');
    pearlGroup.add(pearlBody, pearlBail, pearlHanger, pearlJumpRing);
    this.hangers = { ...(this.hangers || {}), pearl: { wire: pearlHanger, ring: pearlJumpRing, bailTop: PEARL_RADIUS + 0.14, side: 'right' } };
    pearlGroup.visible = false;
    registry.add(new CharmComponent({
      id: 'pearl',
      name: 'Pearl drop',
      type: 'pearl',
      group: pearlGroup,
      finishes: ['pearl', 'silver', 'black'],
      defaultFinish: 'pearl',
      explodeOffset: EXPLODE.pearl,
      removable: true,
    }));

    // 05 — Mini star.
    const starGroup = new Group();
    const starBody = this.mesh(createMiniStarGeometry(MINI_STAR_SIZE), 'acrylic');
    const starBail = this.mesh(createLoopGeometry(0.062, 0.02, 32), 'silver');
    starBail.position.y = MINI_STAR_SIZE * 0.52;
    const starHanger = this.mesh(createPinGeometry(1, 0.02), 'silver');
    const starJumpRing = this.mesh(createLoopGeometry(0.045, 0.014, 20), 'silver');
    starGroup.add(starBody, starBail, starHanger, starJumpRing);
    this.hangers = { ...(this.hangers || {}), star: { wire: starHanger, ring: starJumpRing, bailTop: MINI_STAR_SIZE * 0.52 + 0.07, side: 'left' } };
    starGroup.visible = false;
    registry.add(new CharmComponent({
      id: 'star',
      name: 'Mini star',
      type: 'star',
      group: starGroup,
      finishes: ['acrylic', 'pearl', 'silver', 'black'],
      defaultFinish: 'acrylic',
      explodeOffset: EXPLODE.star,
      removable: true,
    }));

    // 06 — Initial medallion with the engraved letter face.
    const initialGroup = new Group();
    const medallion = this.mesh(createMedallionGeometry(MEDALLION_RADIUS, 0.075), 'silver');
    const medallionRim = this.mesh(new TorusGeometry(MEDALLION_RADIUS * 0.99, 0.016, 12, 72), 'silver');
    const letterFace = createLetterFace({ radius: MEDALLION_RADIUS * 0.9, letter: '' });
    letterFace.mesh.position.z = 0.041;
    initialGroup.add(medallion, medallionRim, letterFace.mesh);
    initialGroup.visible = false;
    this.letterFace = letterFace;
    registry.add(new CharmComponent({
      id: 'initial',
      name: 'Initial letter',
      type: 'initial',
      group: initialGroup,
      finishes: ['black', 'silver'],
      defaultFinish: 'black',
      explodeOffset: EXPLODE.initial,
      removable: true,
    }));
  }

  /** Rebuild the base silhouette geometry and re-lay out every attached component. */
  setBase(baseId) {
    if (!CHARM_SILHOUETTES[baseId]) throw new RangeError(`Unknown base charm: ${baseId}`);
    if (this.baseId === baseId) return false;

    if (this.baseMesh) {
      this.baseGroup.remove(this.baseMesh);
      this.baseMesh.geometry.dispose();
      this.ownedGeometries.delete(this.baseMesh.geometry);
      this.baseMesh = null;
    }
    if (this.knotMesh) {
      this.baseGroup.remove(this.knotMesh);
      this.knotMesh.geometry.dispose();
      this.ownedGeometries.delete(this.knotMesh.geometry);
      this.knotMesh = null;
    }

    const metrics = buildCharmGeometry(baseId, { size: this.size });
    this.metrics = metrics;
    this.baseId = baseId;

    this.baseMesh = new Mesh(metrics.geometry, this.materials.get('acrylic'));
    this.baseMesh.name = `charm-body:${baseId}`;
    this.baseGroup.add(this.baseMesh);
    this.ownedGeometries.add(metrics.geometry);

    const silhouette = CHARM_SILHOUETTES[baseId];
    if (silhouette.knot) {
      const radius = silhouette.knot.radius * metrics.scale;
      const height = silhouette.knot.height * metrics.scale;
      const knotGeometry = createRibbonKnotGeometry(radius, height * 1.1);
      this.knotMesh = new Mesh(knotGeometry, this.materials.get('acrylic'));
      this.knotMesh.name = 'ribbon-knot';
      this.knotMesh.position.copy(metrics.toWorld(silhouette.knot.x, silhouette.knot.y));
      this.knotMesh.position.z = metrics.thickness / 2 - radius * 0.35;
      this.baseGroup.add(this.knotMesh);
      this.ownedGeometries.add(knotGeometry);
    }

    // The base component owns freshly created meshes; refresh its mesh bookkeeping.
    this.registry.get('base').refresh();
    this.applyFinish('base', this.registry.get('base').finish);
    this.layout();
    return true;
  }

  layout() {
    const { metrics } = this;
    if (!metrics) return;
    const front = metrics.thickness / 2;
    const top = metrics.top.y;

    this.registry.get('connector').group.position.set(0, top + 0.44, 0);
    this.registry.get('clasp').group.position.set(0, top + 1.19, 0);
    this.registry.get('pearl').group.position.copy(metrics.toWorld(ANCHORS.pearlCenter.x, ANCHORS.pearlCenter.y))
      .setZ(front + 0.02);
    this.registry.get('star').group.position.copy(metrics.toWorld(ANCHORS.starCenter.x, ANCHORS.starCenter.y))
      .setZ(front + 0.02);
    this.registry.get('initial').group.position.copy(metrics.toWorld(ANCHORS.initial.x, ANCHORS.initial.y))
      .setZ(front + 0.035);

    this.attachHanger('pearl');
    this.attachHanger('star');

    // Layout defines the assembled position, so it becomes the new "original" transform.
    this.registry.list().forEach((component) => {
      component.captureOriginalTransform();
      component.applyExplode(this.registry.explodeValue);
    });
    if (this.registry.selectedId) this.registry.select(this.registry.selectedId);
  }

  /** Right/left silhouette intersection at a given height (world units, y-up). */
  edgeXAt(y, side) {
    const outline = this.metrics ? this.metrics.outline : null;
    if (!outline || !outline.length) return null;
    const crossings = [];
    for (let index = 0; index < outline.length; index += 1) {
      const a = outline[index];
      const b = outline[(index + 1) % outline.length];
      if ((a.y - y) * (b.y - y) > 0) continue;
      if (Math.abs(b.y - a.y) < 1e-6) continue;
      const t = (y - a.y) / (b.y - a.y);
      if (t < 0 || t > 1) continue;
      crossings.push(a.x + (b.x - a.x) * t);
    }
    if (!crossings.length) return null;
    return side === 'right' ? Math.max(...crossings) : Math.min(...crossings);
  }

  /**
   * Stretch a dangling add-on's hanger wire so it meets the charm silhouette. Without this
   * the pearl and mini star float next to the charm instead of hanging from it.
   */
  attachHanger(id) {
    const hanger = this.hangers && this.hangers[id];
    const component = this.registry.get(id);
    if (!hanger || !component || !this.metrics) return;

    const group = component.group;
    const start = new Vector3(0, hanger.bailTop, 0);
    const reach = 0.42;
    const targetY = group.position.y + hanger.bailTop + reach;
    const edge = this.edgeXAt(targetY, hanger.side);
    const fallbackX = group.position.x + (hanger.side === 'right' ? -0.3 : 0.3);
    const end = new Vector3((edge === null ? fallbackX : edge) - group.position.x, hanger.bailTop + reach, 0);

    const direction = new Vector3().subVectors(end, start);
    const length = direction.length();
    hanger.wire.position.copy(start).addScaledVector(direction, 0.5);
    hanger.wire.scale.set(1, Math.max(0.05, length), 1);
    hanger.wire.rotation.z = -Math.atan2(direction.x, direction.y);
    hanger.ring.position.copy(end);
  }

  applyFinish(componentId, finishId) {
    return this.registry.setFinish(componentId, finishId);
  }

  setInitialLetter(letter) {
    this.initialLetter = this.letterFace.setLetter(letter);
    return this.initialLetter;
  }

  /**
   * Apply a full customer configuration.
   * @returns {{baseChanged: boolean, layoutVersion: number}}
   */
  apply(configuration = {}) {
    const baseChanged = configuration.base ? this.setBase(configuration.base) : false;
    const finishes = configuration.finishes || {};
    const hidden = new Set(configuration.hidden || []);
    const addons = new Set(configuration.addons || []);

    const letter = String(configuration.initial || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 1);
    this.setInitialLetter(letter);

    const metalFinish = configuration.clasp === 'black' ? 'black' : 'silver';
    const hardware = new Set(['clasp', 'connector']);
    const finishFor = (component) => finishes[component.id]
      || (hardware.has(component.id) ? metalFinish : component.defaultFinish);

    const visibility = {
      base: true,
      connector: true,
      clasp: true,
      pearl: addons.has('pearl'),
      star: addons.has('star'),
      // A letter can only be rendered when one was typed; the medallion follows it.
      initial: Boolean(letter),
    };

    this.registry.list().forEach((component) => {
      this.registry.setFinish(component.id, finishFor(component));
      const shouldBeVisible = visibility[component.id] === true && !hidden.has(component.id);
      this.registry.setVisible(component.id, shouldBeVisible);
    });

    return { baseChanged };
  }

  snapshot() {
    return this.registry.snapshot();
  }

  dispose() {
    this.ownedGeometries.forEach((geometry) => geometry.dispose());
    this.ownedGeometries.clear();
    if (this.letterFace) this.letterFace.dispose();
    if (this.registry.marker) {
      this.registry.marker.geometry.dispose();
      this.registry.marker.material.dispose();
    }
  }
}