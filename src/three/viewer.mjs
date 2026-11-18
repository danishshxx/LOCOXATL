import { StudioScene } from './scene.mjs';
import { FINISH_PRESETS } from './materials.mjs';

const PART_LABELS = {
  base: 'BASE',
  connector: 'RING',
  clasp: 'CLASP',
  pearl: 'PEARL',
  star: 'STAR',
  initial: 'INITIAL',
};

/**
 * DOM bridge for the 3D customizer. It owns the viewer chrome (explode / assemble /
 * reset, part list, selection inspector) and keeps the 3D state in sync with the
 * existing Custom Studio controls. It is loaded lazily, only when the studio needs it.
 */
export function mountStudioViewer(elements, options = {}) {
  const {
    canvas,
    stage,
    explodeButton,
    assembleButton,
    resetButton,
    partList,
    selectionName,
    selectionMeta,
    swatches,
    visibilityToggle,
    hint,
  } = elements;

  if (!canvas || !stage) throw new Error('3D viewer markup is missing.');

  const configuration = {
    base: options.base || 'heart',
    clasp: options.clasp || 'silver',
    addons: options.addons || [],
    initial: options.initial || '',
    finishes: {},
    hidden: [],
    designImageUrl: options.designImageUrl || '',
  };

  const scene = new StudioScene({
    canvas,
    host: stage,
    onSelect: (id) => handleSelection(id),
    onError: (error) => {
      stage.dataset.viewer = 'failed';
      document.dispatchEvent(new CustomEvent('locoxatl:viewer-unavailable', { detail: { message: error.message } }));
    },
  });
  scene.init();
  scene.applyConfiguration(configuration);

  let selectedId = null;
  let chips = new Map();

  function componentFor(id) {
    return scene.assembly.registry.get(id);
  }

  function buildPartList() {
    if (!partList) return;
    partList.innerHTML = '';
    chips = new Map();
    scene.assembly.registry.list().forEach((component) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'part-chip';
      chip.dataset.component = component.id;
      chip.innerHTML = `<i aria-hidden="true"></i><span>${PART_LABELS[component.id] || component.name.toUpperCase()}</span>`;
      chip.setAttribute('aria-pressed', 'false');
      chip.title = component.name;
      chip.addEventListener('click', () => {
        handleSelection(selectedId === component.id ? null : component.id);
        scene.select(selectedId);
      });
      partList.appendChild(chip);
      chips.set(component.id, chip);
    });
    syncPartList();
  }

  function syncPartList() {
    chips.forEach((chip, id) => {
      const component = componentFor(id);
      if (!component) return;
      chip.classList.toggle('is-selected', id === selectedId);
      chip.classList.toggle('is-off', !component.visible);
      chip.classList.toggle('is-on', component.visible);
      chip.setAttribute('aria-pressed', id === selectedId ? 'true' : 'false');
    });
  }

  function renderInspector() {
    const component = selectedId ? componentFor(selectedId) : null;
    if (selectionName) selectionName.textContent = component ? component.name.toUpperCase() : 'NO PART SELECTED';
    if (selectionMeta) {
      if (!component) selectionMeta.textContent = 'CLICK A PART TO INSPECT';
      else {
        const preset = FINISH_PRESETS.find((item) => item.id === component.finish);
        selectionMeta.textContent = preset ? preset.name.toUpperCase() : component.type.toUpperCase();
      }
    }

    if (swatches) {
      swatches.innerHTML = '';
      const presets = component
        ? FINISH_PRESETS.filter((preset) => component.finishes.includes(preset.id))
        : [];
      presets.forEach((preset) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'swatch';
        button.dataset.finish = preset.id;
        button.style.background = preset.swatch;
        button.title = preset.hint;
        button.setAttribute('aria-label', `Finish: ${preset.name}`);
        button.setAttribute('aria-pressed', component.finish === preset.id ? 'true' : 'false');
        button.addEventListener('click', () => {
          if (!selectedId) return;
          scene.setFinish(selectedId, preset.id);
          configuration.finishes[selectedId] = preset.id;
          renderInspector();
          syncPartList();
        });
        swatches.appendChild(button);
      });
      swatches.hidden = !component;
    }

    if (visibilityToggle) {
      const hideable = component && component.id !== 'base';
      visibilityToggle.hidden = !hideable;
      if (hideable) {
        visibilityToggle.textContent = component.visible ? 'HIDE PART' : 'SHOW PART';
        visibilityToggle.setAttribute('aria-pressed', component.visible ? 'false' : 'true');
      }
    }
  }

  function handleSelection(id) {
    selectedId = id && componentFor(id) ? id : null;
    scene.select(selectedId);
    renderInspector();
    syncPartList();
    document.dispatchEvent(new CustomEvent('locoxatl:component-selected', {
      detail: selectedId ? { id: selectedId, name: componentFor(selectedId).name } : null,
    }));
  }

  function toggleVisibility() {
    if (!selectedId) return;
    const component = componentFor(selectedId);
    if (!component || component.id === 'base') return;
    const next = !component.visible;

    if (component.removable && typeof options.onToggleAddon === 'function') {
      // Paid accessories belong to the shared configuration (and therefore to pricing),
      // so the studio owns that decision instead of the viewer.
      options.onToggleAddon(component.id, next);
      return;
    }

    scene.setVisible(selectedId, next);
    configuration.hidden = configuration.hidden.filter((id) => id !== selectedId);
    if (!next) configuration.hidden.push(selectedId);
    renderInspector();
    syncPartList();
  }

  if (visibilityToggle) visibilityToggle.addEventListener('click', toggleVisibility);

  if (explodeButton) {
    explodeButton.addEventListener('click', () => {
      scene.setExploded(true);
      explodeButton.setAttribute('aria-pressed', 'true');
      if (assembleButton) assembleButton.setAttribute('aria-pressed', 'false');
    });
  }

  if (assembleButton) {
    assembleButton.addEventListener('click', () => {
      scene.setExploded(false);
      assembleButton.setAttribute('aria-pressed', 'true');
      if (explodeButton) explodeButton.setAttribute('aria-pressed', 'false');
      if (hint) hint.textContent = 'ASSEMBLED · DRAG TO ROTATE';
    });
  }

  if (resetButton) {
    resetButton.addEventListener('click', () => {
      scene.setExploded(false);
      scene.resetCamera();
      handleSelection(null);
      if (explodeButton) explodeButton.setAttribute('aria-pressed', 'false');
      if (assembleButton) assembleButton.setAttribute('aria-pressed', 'false');
    });
  }

  buildPartList();
  renderInspector();
  stage.dataset.viewer = 'ready';

  const viewer = {
    scene,
    applyState(next = {}) {
      if (!next) return;
      if (next.base) configuration.base = next.base;
      if (next.clasp) configuration.clasp = next.clasp;
      if (Array.isArray(next.addons)) configuration.addons = next.addons;
      if (typeof next.initial === 'string') configuration.initial = next.initial;
      if (next.finishes) configuration.finishes = { ...configuration.finishes, ...next.finishes };
      if (Array.isArray(next.hidden)) configuration.hidden = next.hidden;
      if (typeof next.designImageUrl === 'string') configuration.designImageUrl = next.designImageUrl;
      scene.applyConfiguration(configuration);
      if (selectedId && !componentFor(selectedId)) handleSelection(null);
      renderInspector();
      syncPartList();
      if (hint) hint.textContent = 'DRAG TO ROTATE · SCROLL TO ZOOM · CLICK A PART';
      return configuration;
    },
    getSnapshot() {
      return scene.getSnapshot();
    },
    getConfiguration() {
      return JSON.parse(JSON.stringify(configuration));
    },
    getComponents() {
      return scene.assembly.snapshot();
    },
    select(id) {
      handleSelection(id);
    },
    dispose() {
      scene.dispose();
    },
  };

  window.LocoxatlStudio3D = viewer;
  document.dispatchEvent(new CustomEvent('locoxatl:viewer-ready'));
  return viewer;
}