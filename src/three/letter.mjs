import {
  CanvasTexture,
  CircleGeometry,
  Mesh,
  MeshStandardMaterial,
  SRGBColorSpace,
} from 'three';

// The initial is rendered with a 2D canvas into a texture that sits on a real, raised
// medallion. A canvas texture is used instead of TextGeometry because the project ships
// Inter as .otf only, and converting it to a three.js typeface JSON at runtime would add
// a font parser to the bundle for a single glyph.

const TEXTURE_SIZE = 512;

function drawLetter(context, letter) {
  const { width, height } = context.canvas;
  context.clearRect(0, 0, width, height);

  // Engraved outer ring, kept in the same monochrome language as the rest of the product.
  context.strokeStyle = 'rgba(255,255,255,0.42)';
  context.lineWidth = 7;
  context.beginPath();
  context.arc(width / 2, height / 2, width * 0.455, 0, Math.PI * 2);
  context.stroke();

  if (!letter) return;

  context.fillStyle = '#ffffff';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = `700 ${Math.round(height * 0.5)}px Inter, "Helvetica Neue", Arial, sans-serif`;
  context.fillText(letter, width / 2, height * 0.53);
}

function createLetterTexture(letter) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  if (!context) return null;
  drawLetter(context, letter);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  return {
    texture,
    redraw(next) {
      drawLetter(context, next);
      texture.needsUpdate = true;
    },
  };
}

const normalizeLetter = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 1);

/**
 * Circular alpha-textured plane that is placed just in front of the medallion body.
 */
export function createLetterFace({ radius = 0.24, letter = '' } = {}) {
  const letters = normalizeLetter(letter);
  const canvasTexture = createLetterTexture(letters);
  const geometry = new CircleGeometry(radius, 64);
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.42,
    metalness: 0.35,
    transparent: Boolean(canvasTexture),
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  if (canvasTexture) {
    material.map = canvasTexture.texture;
    material.needsUpdate = true;
  }

  const mesh = new Mesh(geometry, material);
  mesh.name = 'initial-letter-face';
  mesh.userData.keepMaterial = true;
  mesh.userData.noShadow = true;
  mesh.visible = Boolean(letters);

  let current = letters;

  function setLetter(next) {
    current = normalizeLetter(next);
    if (canvasTexture) canvasTexture.redraw(current);
    mesh.visible = Boolean(current);
    return current;
  }

  // Redraw once the web font is available so the glyph matches the brand typography.
  if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      if (canvasTexture) canvasTexture.redraw(current);
    }).catch(() => {});
  }

  function dispose() {
    geometry.dispose();
    material.dispose();
    if (canvasTexture) canvasTexture.texture.dispose();
  }

  return { mesh, setLetter, dispose };
}