const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = (file) => import(pathToFileURL(path.join(__dirname, '..', 'src', 'three', file)).href);

const BASES = ['heart', 'star', 'bow'];

test('every charm silhouette is parsed from the existing SVG path data into a measurably thick 3D body', async () => {
  const { buildCharmGeometry, CHARM_SILHOUETTES } = await load('shapes.mjs');
  assert.deepEqual(Object.keys(CHARM_SILHOUETTES).sort(), [...BASES].sort());

  for (const base of BASES) {
    const metrics = buildCharmGeometry(base, { size: 2.9 });
    const position = metrics.geometry.getAttribute('position');
    assert.ok(position.count > 100, `${base} should have real geometry, got ${position.count} vertices`);
    assert.ok(position.count < 8000, `${base} should stay low-poly, got ${position.count} vertices`);
    assert.ok(metrics.width > 2.5 && metrics.width < 3.4, `${base} width out of range: ${metrics.width}`);
    assert.ok(metrics.height > 2.2, `${base} height out of range: ${metrics.height}`);
    assert.ok(metrics.thickness > 0.4, `${base} needs visible thickness, got ${metrics.thickness}`);
    assert.ok(metrics.outline.length > 6, `${base} should expose a silhouette outline for attachments`);
    metrics.geometry.dispose();
  }
});

test('extruded charms are centred on the origin and keep correct normals', async () => {
  const { buildCharmGeometry } = await load('shapes.mjs');
  const { geometry } = buildCharmGeometry('heart', { size: 2.9 });
  geometry.computeBoundingBox();
  const { min, max } = geometry.boundingBox;
  assert.ok(Math.abs((min.x + max.x) / 2) < 0.01, 'charm should be centred on X');
  assert.ok(Math.abs((min.y + max.y) / 2) < 0.01, 'charm should be centred on Y');
  const normal = geometry.getAttribute('normal');
  assert.ok(normal && normal.count === geometry.getAttribute('position').count, 'normals must be generated');

  let upwardFacing = 0;
  for (let index = 0; index < normal.count; index += 1) {
    if (normal.getZ(index) > 0.95) upwardFacing += 1;
  }
  assert.ok(upwardFacing > 0, 'front faces should point towards +Z after the SVG flip');
  geometry.dispose();
});

test('the assembly exposes six independent, selectable components', async () => {
  const { CharmAssembly } = await load('assembly.mjs');
  const { createMaterialLibrary } = await load('materials.mjs');
  const materials = createMaterialLibrary();
  const assembly = new CharmAssembly({ materials });

  assembly.apply({ base: 'heart', clasp: 'silver', addons: [], initial: '' });

  const ids = assembly.registry.list().map((component) => component.id);
  assert.deepEqual(ids, ['base', 'connector', 'clasp', 'pearl', 'star', 'initial']);
  ids.forEach((id) => {
    const component = assembly.registry.get(id);
    assert.ok(component.group.isGroup, `${id} must be its own THREE.Group`);
    assert.ok(component.meshes.length > 0, `${id} should own at least one mesh`);
    component.meshes.forEach((mesh) => {
      assert.equal(mesh.userData.componentId, id, `${id} meshes must resolve back to the component`);
    });
  });

  assembly.registry.select('pearl');
  assert.equal(assembly.registry.selectedId, 'pearl');
  assert.ok(assembly.registry.marker, 'selection marker should exist');

  assembly.dispose();
  materials.dispose();
});

test('base switching rebuilds geometry and keeps every component selectable', async () => {
  const { CharmAssembly } = await load('assembly.mjs');
  const { createMaterialLibrary } = await load('materials.mjs');
  const materials = createMaterialLibrary();
  const assembly = new CharmAssembly({ materials });
  const seen = [];

  for (const base of BASES) {
    const result = assembly.apply({ base, clasp: 'black', addons: ['pearl', 'star', 'initial'], initial: 'K' });
    seen.push(result.baseChanged);
    assert.equal(assembly.baseId, base);
    assert.ok(assembly.metrics.thickness > 0.4);
    assembly.registry.list().forEach((component) => {
      component.meshes.forEach((mesh) => {
        assert.equal(mesh.userData.componentId, component.id, `${component.id} lost its id on ${base}`);
      });
    });
    assert.equal(assembly.initialLetter, 'K');
    assert.equal(assembly.registry.get('clasp').finish, 'black');
    assert.equal(assembly.registry.get('connector').finish, 'black');
  }

  assert.deepEqual(seen, [true, true, true]);
  assembly.dispose();
  materials.dispose();
});

test('add-ons, initial letter and clasp options drive component visibility and finishes', async () => {
  const { CharmAssembly } = await load('assembly.mjs');
  const { createMaterialLibrary } = await load('materials.mjs');
  const materials = createMaterialLibrary();
  const assembly = new CharmAssembly({ materials });

  assembly.apply({ base: 'heart', clasp: 'silver', addons: [], initial: '' });
  assert.equal(assembly.registry.get('pearl').visible, false);
  assert.equal(assembly.registry.get('star').visible, false);
  assert.equal(assembly.registry.get('initial').visible, false);

  assembly.apply({ base: 'heart', clasp: 'black', addons: ['pearl', 'star', 'initial'], initial: 'a' });
  assert.equal(assembly.registry.get('pearl').visible, true);
  assert.equal(assembly.registry.get('star').visible, true);
  assert.equal(assembly.registry.get('initial').visible, true);
  assert.equal(assembly.initialLetter, 'A', 'initial should be normalised to a single uppercase letter');
  assert.equal(assembly.registry.get('clasp').finish, 'black');

  // Selecting the initial without a letter keeps the medallion hidden.
  assembly.apply({ base: 'heart', clasp: 'silver', addons: ['initial'], initial: '' });
  assert.equal(assembly.registry.get('initial').visible, false);

  // Manual finish override survives.
  assembly.registry.setFinish('base', 'pearl');
  assert.equal(assembly.registry.get('base').finish, 'pearl');
  assert.equal(assembly.registry.setFinish('base', 'not-a-finish'), false);

  assembly.dispose();
  materials.dispose();
});

test('explode separates the parts and assemble restores the exact original transforms', async () => {
  const { CharmAssembly } = await load('assembly.mjs');
  const { createMaterialLibrary } = await load('materials.mjs');
  const materials = createMaterialLibrary();
  const assembly = new CharmAssembly({ materials });
  assembly.apply({ base: 'bow', clasp: 'silver', addons: ['pearl', 'star', 'initial'], initial: 'M' });

  const assembled = assembly.registry.list().map((component) => component.group.position.clone());

  assembly.registry.setExplode(1);
  const exploded = assembly.registry.list().map((component) => component.group.position.clone());
  const baseExploded = assembly.registry.get('base').group.position;
  assert.ok(baseExploded.length() < 1e-6, 'the base charm anchors the exploded view');

  const moved = exploded.filter((position, index) => position.distanceTo(assembled[index]) > 0.3).length;
  assert.ok(moved >= 4, `at least four parts should move, got ${moved}`);

  // Parts must not collide with each other in the exploded view.
  for (let a = 0; a < exploded.length; a += 1) {
    for (let b = a + 1; b < exploded.length; b += 1) {
      assert.ok(exploded[a].distanceTo(exploded[b]) > 0.2, 'exploded parts should stay separated');
    }
  }

  assembly.registry.setExplode(0);
  assembly.registry.list().forEach((component, index) => {
    assert.ok(component.group.position.distanceTo(assembled[index]) < 1e-9, `${component.id} did not return home`);
  });

  assembly.dispose();
  materials.dispose();
});

test('the component snapshot preserves configuration and both transforms for the order', async () => {
  const { CharmAssembly } = await load('assembly.mjs');
  const { createMaterialLibrary } = await load('materials.mjs');
  const materials = createMaterialLibrary();
  const assembly = new CharmAssembly({ materials });
  assembly.apply({ base: 'star', clasp: 'black', addons: ['pearl'], initial: 'Z' });

  const snapshot = assembly.snapshot();
  assert.equal(snapshot.length, 6);
  const pearl = snapshot.find((component) => component.id === 'pearl');
  assert.equal(pearl.visible, true);
  assert.equal(pearl.finish, 'pearl');
  assert.ok(Array.isArray(pearl.original.position) && pearl.original.position.length === 3);
  assert.ok(Array.isArray(pearl.current.position) && pearl.current.position.length === 3);
  assert.ok(pearl.availableFinishes.includes('pearl'));

  const initial = snapshot.find((component) => component.id === 'initial');
  assert.equal(initial.visible, true);

  const json = JSON.stringify({ components: snapshot });
  assert.ok(json.length < 20000, 'snapshot must stay small enough for a JSON column');

  assembly.dispose();
  materials.dispose();
});

test('dangling add-ons are attached to the actual silhouette edge', async () => {
  const { CharmAssembly } = await load('assembly.mjs');
  const { createMaterialLibrary } = await load('materials.mjs');
  const materials = createMaterialLibrary();
  const assembly = new CharmAssembly({ materials });

  for (const base of BASES) {
    assembly.apply({ base, clasp: 'silver', addons: ['pearl', 'star'], initial: '' });
    for (const id of ['pearl', 'star']) {
      const group = assembly.registry.get(id).group;
      const ring = assembly.hangers[id].ring.position;
      const wire = assembly.hangers[id].wire;
      const side = id === 'pearl' ? 'right' : 'left';
      const edge = assembly.edgeXAt(group.position.y + ring.y, side);
      assert.equal(typeof edge, 'number', `${base}/${id} should resolve a silhouette edge point`);
      assert.ok(Math.abs(group.position.x + ring.x - edge) < 1e-6, `${base}/${id} hanger must end on the charm edge`);
      assert.ok(wire.scale.y > 0.2, `${base}/${id} hanger wire should span the gap`);
    }
  }

  assembly.dispose();
  materials.dispose();
});