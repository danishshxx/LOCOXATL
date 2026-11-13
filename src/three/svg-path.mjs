import { Shape } from 'three';

// SVG path data → THREE.Shape. Supports the subset of the SVG 1.1 path grammar used by
// the LOCOXATL charm silhouettes: M/m, L/l, H/h, V/v, C/c, S/s, Q/q, T/t and Z/z,
// including implicit command repetition (a bare coordinate after M repeats as L).
// A hand-written parser is used instead of three's SVGLoader because SVGLoader.parse()
// requires DOMParser, which would make the geometry builders untestable outside a browser.

const TOKEN = /([a-zA-Z])|([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;

const PARAM_COUNT = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, z: 0 };

function tokenize(pathData) {
  const tokens = [];
  let match;
  TOKEN.lastIndex = 0;
  while ((match = TOKEN.exec(pathData)) !== null) {
    if (match[1]) tokens.push({ command: match[1] });
    else tokens.push({ number: Number(match[2]) });
  }
  return tokens;
}

/**
 * Convert SVG path data into one THREE.Shape per subpath.
 * The resulting shapes stay in SVG coordinate space (y grows downward); callers are
 * expected to rotate the extruded geometry by Math.PI on X to get a y-up model.
 *
 * @param {string} pathData
 * @returns {Shape[]}
 */
export function svgPathToShapes(pathData) {
  const tokens = tokenize(pathData);
  const shapes = [];
  let shape = null;
  let start = { x: 0, y: 0 };
  let current = { x: 0, y: 0 };
  let previousControl = null;
  let previousCommand = '';
  let command = '';
  let index = 0;

  const closeCurrentShape = () => {
    if (!shape) return;
    shape.closePath();
    if (shape.getPoints().length > 2) shapes.push(shape);
    shape = null;
  };

  const ensureShape = () => {
    if (!shape) {
      shape = new Shape();
      shape.moveTo(start.x, start.y);
    }
    return shape;
  };

  while (index < tokens.length) {
    const token = tokens[index];
    if (token.command) {
      command = token.command;
      index += 1;
    } else if (!command) {
      throw new Error('SVG path data must start with a moveto command.');
    } else if (command === 'M') {
      command = 'L';
    } else if (command === 'm') {
      command = 'l';
    }

    const lower = command.toLowerCase();
    const relative = command === lower;
    const count = PARAM_COUNT[lower];

    if (lower === 'z') {
      if (shape) shape.closePath();
      closeCurrentShape();
      current = { ...start };
      previousControl = null;
      previousCommand = 'z';
      continue;
    }

    const values = tokens.slice(index, index + count).map((item) => item.number);
    if (values.length < count || values.some((value) => typeof value !== 'number' || Number.isNaN(value))) {
      throw new Error(`Incomplete SVG path command: ${command}`);
    }
    index += count;

    const target = ensureShape();
    const [a, b, c, d, e, f] = values;

    switch (lower) {
      case 'm': {
        current = relative ? { x: current.x + a, y: current.y + b } : { x: a, y: b };
        start = { ...current };
        target.moveTo(current.x, current.y);
        previousControl = null;
        break;
      }
      case 'l': {
        current = relative ? { x: current.x + a, y: current.y + b } : { x: a, y: b };
        target.lineTo(current.x, current.y);
        previousControl = null;
        break;
      }
      case 'h': {
        current = { x: relative ? current.x + a : a, y: current.y };
        target.lineTo(current.x, current.y);
        previousControl = null;
        break;
      }
      case 'v': {
        current = { x: current.x, y: relative ? current.y + a : a };
        target.lineTo(current.x, current.y);
        previousControl = null;
        break;
      }
      case 'c': {
        const from = { ...current };
        const controlA = relative ? { x: from.x + a, y: from.y + b } : { x: a, y: b };
        const controlB = relative ? { x: from.x + c, y: from.y + d } : { x: c, y: d };
        const end = relative ? { x: from.x + e, y: from.y + f } : { x: e, y: f };
        target.bezierCurveTo(controlA.x, controlA.y, controlB.x, controlB.y, end.x, end.y);
        current = end;
        previousControl = controlB;
        break;
      }
      case 's': {
        const from = { ...current };
        const reflected = previousControl && /[cs]/i.test(previousCommand)
          ? { x: from.x * 2 - previousControl.x, y: from.y * 2 - previousControl.y }
          : { ...from };
        const controlB = relative ? { x: from.x + a, y: from.y + b } : { x: a, y: b };
        const end = relative ? { x: from.x + c, y: from.y + d } : { x: c, y: d };
        target.bezierCurveTo(reflected.x, reflected.y, controlB.x, controlB.y, end.x, end.y);
        current = end;
        previousControl = controlB;
        break;
      }
      case 'q': {
        const from = { ...current };
        const control = relative ? { x: from.x + a, y: from.y + b } : { x: a, y: b };
        const end = relative ? { x: from.x + c, y: from.y + d } : { x: c, y: d };
        target.quadraticCurveTo(control.x, control.y, end.x, end.y);
        current = end;
        previousControl = control;
        break;
      }
      case 't': {
        const from = { ...current };
        const control = previousControl && /[qt]/i.test(previousCommand)
          ? { x: from.x * 2 - previousControl.x, y: from.y * 2 - previousControl.y }
          : { ...from };
        const end = relative ? { x: from.x + a, y: from.y + b } : { x: a, y: b };
        target.quadraticCurveTo(control.x, control.y, end.x, end.y);
        current = end;
        previousControl = control;
        break;
      }
      default:
        throw new Error(`Unsupported SVG path command: ${command}`);
    }

    previousCommand = command;
  }

  closeCurrentShape();
  if (!shapes.length) throw new Error('SVG path produced no usable shape.');
  return shapes;
}