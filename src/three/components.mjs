import { Box3, Group, Sphere, Vector3 } from 'three';

// Component model for the LOCOXATL customizer.
// Every part of the jewellery is an independent object with its own identity, finish,
// visibility and transform. Nothing is merged into a single mesh, so parts can be
// selected, hidden, re-finished, exploded and re-assembled individually.

const round = (value) => Math.round(value * 10000) / 10000;
const roundArray = (array) => array.map(round);

export class CharmComponent {
  constructor({
    id,
    name,
    type,
    group,
    finishes,
    defaultFinish = 'acrylic',
    explodeOffset = [0, 0, 0],
    removable = false,
  }) {
    if (!id || !name || !type) throw new Error('A component needs an id, name and type.');
    if (!(group instanceof Group)) throw new Error(`Component ${id} needs a THREE.Group.`);

    this.id = id;
    this.name = name;
    this.type = type;
    this.group = group;
    this.finishes = [...finishes];
    this.removable = removable;
    this.finish = defaultFinish;
    this.explodeOffset = new Vector3(...explodeOffset);
    this.meshes = [];
    this.original = null;
    this.visible = group.visible;

    group.name = `component:${id}`;
    group.userData.componentId = id;
    group.traverse((object) => {
      object.userData.componentId = id;
      if (object.isMesh) {
        object.castShadow = !object.userData.noShadow;
        object.receiveShadow = !object.userData.noShadow;
        this.meshes.push(object);
      }
    });

    this.captureOriginalTransform();
  }

  captureOriginalTransform() {
    this.original = {
      position: this.group.position.clone(),
      quaternion: this.group.quaternion.clone(),
      scale: this.group.scale.clone(),
    };
  }

  /**
   * Re-index the meshes of this component. Needed after geometry is rebuilt (for example
   * when the customer switches the base silhouette) so raycasting still resolves the
   * component and new meshes inherit shadow flags.
   */
  refresh() {
    this.meshes = [];
    this.group.traverse((object) => {
      object.userData.componentId = this.id;
      if (!object.isMesh) return;
      object.castShadow = !object.userData.noShadow;
      object.receiveShadow = !object.userData.noShadow;
      this.meshes.push(object);
    });
    this.visible = this.group.visible;
    return this;
  }

  restoreTransform() {
    if (!this.original) return;
    this.group.position.copy(this.original.position);
    this.group.quaternion.copy(this.original.quaternion);
    this.group.scale.copy(this.original.scale);
  }

  /** Move the part towards its exploded position. `t` is 0 (assembled) → 1 (exploded). */
  applyExplode(t) {
    if (!this.original) return;
    this.group.position.copy(this.original.position).addScaledVector(this.explodeOffset, t);
  }

  setFinish(finishId, materials) {
    if (!this.finishes.includes(finishId)) return false;
    this.group.traverse((object) => {
      if (!object.isMesh || object.userData.keepMaterial) return;
      object.material = materials.get(finishId);
    });
    this.finish = finishId;
    return true;
  }

  setVisible(visible) {
    this.visible = Boolean(visible);
    this.group.visible = this.visible;
    return this.visible;
  }

  get currentTransform() {
    const { position, quaternion, scale } = this.group;
    return {
      position: roundArray(position.toArray()),
      rotation: roundArray([quaternion.x, quaternion.y, quaternion.z, quaternion.w]),
      scale: roundArray(scale.toArray()),
    };
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      finish: this.finish,
      availableFinishes: [...this.finishes],
      visible: this.visible,
      editable: { finish: this.finishes.length > 1, visibility: true },
      original: this.original
        ? {
          position: roundArray(this.original.position.toArray()),
          rotation: roundArray([
            this.original.quaternion.x,
            this.original.quaternion.y,
            this.original.quaternion.z,
            this.original.quaternion.w,
          ]),
          scale: roundArray(this.original.scale.toArray()),
        }
        : null,
      current: this.currentTransform,
    };
  }
}

export class ComponentRegistry {
  constructor({ root, materials, markerFactory }) {
    if (!(root instanceof Group)) throw new Error('ComponentRegistry needs a root THREE.Group.');
    this.root = root;
    this.materials = materials;
    this.components = new Map();
    this.selectedId = null;
    this.explodeValue = 0;
    this.marker = markerFactory ? markerFactory() : null;
    if (this.marker) {
      this.marker.visible = false;
      this.marker.userData.keepMaterial = true;
      this.marker.userData.noShadow = true;
    }
  }

  add(component) {
    if (this.components.has(component.id)) throw new Error(`Duplicate component id: ${component.id}`);
    this.components.set(component.id, component);
    if (!this.root.children.includes(component.group)) this.root.add(component.group);
    return component;
  }

  get(id) {
    return this.components.get(id) || null;
  }

  list() {
    return [...this.components.values()];
  }

  select(id) {
    const next = id ? this.get(id) : null;
    this.selectedId = next ? next.id : null;
    if (this.marker) {
      if (this.marker.parent) this.marker.parent.remove(this.marker);
      if (next && next.visible) {
        this.marker.visible = true;
        this.placeMarker(next);
        next.group.add(this.marker);
      } else {
        this.marker.visible = false;
      }
    }
    return next;
  }

  placeMarker(component) {
    const box = new Box3().setFromObject(component.group);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new Sphere());
    const radius = Math.max(sphere.radius, 0.18) * 1.02;
    const center = box.getCenter(new Vector3());
    component.group.worldToLocal(center);
    this.marker.position.copy(center);
    this.marker.scale.setScalar(radius);
  }

  get selected() {
    return this.selectedId ? this.get(this.selectedId) : null;
  }

  setExplode(value) {
    this.explodeValue = Math.min(1, Math.max(0, value));
    this.list().forEach((component) => component.applyExplode(this.explodeValue));
    if (this.marker && this.marker.parent) this.placeMarker(this.selected || this.get('base'));
    return this.explodeValue;
  }

  setVisible(id, visible) {
    const component = this.get(id);
    if (!component) return false;
    component.setVisible(visible);
    if (!visible && this.selectedId === id) this.select(null);
    return component.visible;
  }

  setFinish(id, finishId) {
    const component = this.get(id);
    if (!component) return false;
    return component.setFinish(finishId, this.materials);
  }

  snapshot() {
    return this.list().map((component) => component.toJSON());
  }
}