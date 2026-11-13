# LOCOXATL — Premium 3D Custom Studio

The Custom Studio preview is a procedural Three.js scene. No Blender, no GLB export and no
build step: the models are generated in the browser from the same SVG silhouettes that the
flat preview already uses.

## How it is wired

```
studio.html
├── <script type="importmap">          # maps "three" to the vendored build
├── src/studio.js                      # existing controls, pricing, checkout payload
│    └── import('src/three/viewer.mjs')  # lazy, only when the preview nears the viewport
└── src/three/
     ├── svg-path.mjs    # SVG path data → THREE.Shape (no DOMParser, works headless)
     ├── shapes.mjs      # extrusion, bevels, pearls, rings, medallions, mini star
     ├── materials.mjs   # acrylic / pearl / silver / satin black presets + cache
     ├── letter.mjs      # initial letter as a canvas texture on a raised medallion
     ├── components.mjs  # CharmComponent + ComponentRegistry (select, hide, explode)
     ├── assembly.mjs    # the six-part jewellery assembly and its layout rules
     ├── scene.mjs       # renderer, studio environment, lights, orbit, raycast, dispose
     └── viewer.mjs      # DOM bridge: toolbar, part list, inspector, snapshot
```

`src/studio.js` stays a classic script. It never imports Three.js at parse time; the
module is fetched with a dynamic `import()` built from the script's own URL, and only when
`IntersectionObserver` reports the preview area is close to the viewport. If WebGL is
missing or the module fails to load, the approved SVG preview stays visible and the rest of
the journey is unaffected.

## The three base charms

| Studio control | Silhouette source | Geometry |
|---|---|---|
| Heart | existing `Cloud Heart` SVG path | `ExtrudeGeometry`, depth ≈ 17% of width, beveled on both faces |
| Star | existing `Orbit Star` SVG path | same extrusion with a tighter bevel so the points stay crisp |
| Ribbon | existing `Soft Ribbon` SVG path | same extrusion plus a separate rounded knot mesh |

The SVG coordinate system grows downward, so the extruded geometry is rotated by `Math.PI`
on X (a rotation, not a mirror, which keeps winding order and normals correct), then
centred and normalised to 2.9 world units on its longest axis.

Polygon budget per charm: heart ≈ 3.8k vertices, star ≈ 470, bow ≈ 5.7k — small enough for
mobile GPUs and for on-demand rendering.

## Modular components

Every part is its own `THREE.Group` with a stable id, name, type, finish, visibility,
original transform and current transform:

| id | Name | Notes |
|---|---|---|
| `base` | Base charm | rebuilt when the silhouette changes |
| `connector` | Connector ring | ring + bail that meets the charm's top edge |
| `clasp` | Clasp | silver or black, driven by the existing clasp control |
| `pearl` | Pearl drop | hanger wire stretched to the real silhouette edge |
| `star` | Mini star | same attachment rule as the pearl |
| `initial` | Initial letter | raised medallion + canvas letter face |

Nothing is merged into a single mesh. The registry supports selecting a part, hiding it,
re-finishing it, exploding it, and serialising it for the order.

## Interaction

- Orbit with drag, zoom with wheel or pinch, pan with right-drag or two fingers.
- Click a part (or a part chip) to select it; a thin marker ring and the inspector show it.
- The inspector offers the finishes that component supports and a hide/show action.
  Hiding a paid accessory routes through the studio so the checkbox, price and 3D stay in
  sync.
- `EXPLODE` separates the parts along hand-authored offsets, `ASSEMBLE` restores the exact
  original transforms, `RESET CAMERA` refits the view and clears the selection.
- Motion respects `prefers-reduced-motion`.

## Rendering

- Three.js `0.187.0` and its matching `OrbitControls` are vendored from the installed
  package. The module and core files total about 2.1 MB unminified; no upgrade or source
  rewrite is needed for the current lazy-loaded development delivery.
- `MeshPhysicalMaterial` with clearcoat for acrylic, iridescence/sheen for pearl, metalness
  1 for silver and satin black.
- Studio environment built from emissive panels (bright key softbox, strip lights, dark
  room) baked with `PMREMGenerator`, plus key/fill/rim directional lights and a soft
  `ShadowMaterial` floor.
- ACES filmic tone mapping, `sRGB` output, device pixel ratio capped at 2.
- Frames are rendered on demand: interaction, tweens and resizes. An idle studio costs no
  GPU time.
- Everything is disposed on `pagehide`: geometries, materials, render target, renderer,
  resize/pointer listeners.

## Initial letter

Letters use a canvas texture (Inter, 512 px, engraved ring) on a raised medallion instead of
`TextGeometry`, because the project ships Inter as `.otf` only and converting it to a
three.js typeface JSON would add a font parser for a single glyph. The letter is re-drawn
once `document.fonts.ready` resolves so it matches the brand typography. `A–Z` and `0–9` are
accepted, uppercased, one character.

The current treatment is intentional; a font conversion or extra geometry dependency has
not been added, avoiding font-format and visual-regression risk for a single character.

## Extending later

- **GLB/GLTF models**: swap the `buildCharmGeometry` call in `assembly.mjs` for
  `GLTFLoader`; the component registry and viewer do not care how geometry was produced.
- **More finishes**: add a factory to `materials.mjs` and add the id to the component's
  `finishes` list.
- **More add-ons**: create a component in `assembly.mjs`, add the anchor in `ANCHORS` and
  the price in `src/options.js`.

## Testing

`npm test` includes headless (no WebGL) checks for extrusion size,
thickness, vertex budget, centring, normals, component ids, base switching, finish and
visibility rules, exploded/assembled transforms, snapshot shape and that each dangle's
hanger ends exactly on the silhouette edge. Browser behaviour (rendering, orbit, click
selection, explode animation, responsive canvas and storefront flow) can be checked in
headless Chrome with the optional `puppeteer-core` dependency and
`node tools/verify-studio.cjs`; see the README for setup.