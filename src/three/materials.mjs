import { MeshPhysicalMaterial } from 'three';

// Finish presets for the LOCOXATL customizer. Every preset stays inside the monochrome
// brand palette; the difference is surface treatment, not colour variety.
// Materials are cached and shared between components, so they must never be mutated
// per component. Selection feedback is drawn with a marker instead of an emissive tint.

export const FINISH_PRESETS = [
  { id: 'acrylic', name: 'Glossy acrylic', swatch: '#fbfbfb', hint: 'Polished white acrylic' },
  { id: 'pearl', name: 'Pearl', swatch: '#f4f1ec', hint: 'Soft iridescent pearl' },
  { id: 'silver', name: 'Polished silver', swatch: '#cfd2d6', hint: 'Mirror-polished metal' },
  { id: 'black', name: 'Satin black', swatch: '#1b1b1d', hint: 'Matte black metal' },
];

const PRESET_IDS = new Set(FINISH_PRESETS.map((preset) => preset.id));

export function isFinishPreset(id) {
  return PRESET_IDS.has(id);
}

export function createMaterialLibrary() {
  const cache = new Map();

  const factories = {
    acrylic: () => new MeshPhysicalMaterial({
      color: 0xe8ebef,
      metalness: 0,
      roughness: 0.055,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      reflectivity: 0.66,
      ior: 1.49,
      specularIntensity: 1.1,
      envMapIntensity: 1.25,
    }),
    pearl: () => new MeshPhysicalMaterial({
      color: 0xe4e0d9,
      metalness: 0,
      roughness: 0.14,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      iridescence: 0.55,
      iridescenceIOR: 1.4,
      iridescenceThicknessMinimum: 120,
      iridescenceThicknessMaximum: 380,
      sheen: 0.45,
      sheenColor: 0xffffff,
      sheenRoughness: 0.5,
      envMapIntensity: 1.35,
    }),
    silver: () => new MeshPhysicalMaterial({
      color: 0xc2c7cd,
      metalness: 1,
      roughness: 0.14,
      clearcoat: 0.4,
      clearcoatRoughness: 0.12,
      envMapIntensity: 1.35,
    }),
    black: () => new MeshPhysicalMaterial({
      color: 0x191b1d,
      metalness: 0.92,
      roughness: 0.34,
      clearcoat: 0.35,
      clearcoatRoughness: 0.28,
      envMapIntensity: 0.95,
    }),
  };

  function get(id) {
    const key = isFinishPreset(id) ? id : 'acrylic';
    if (!cache.has(key)) cache.set(key, factories[key]());
    return cache.get(key);
  }

  function dispose() {
    cache.forEach((material) => material.dispose());
    cache.clear();
  }

  return { get, dispose };
}