import {
  CylinderGeometry,
  ExtrudeGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { svgPathToShapes } from './svg-path.mjs';

// The three base silhouettes are the exact path data already used by the Custom Studio
// SVG preview. They are now turned into real extruded geometry instead of flat artwork.

export const CHARM_SILHOUETTES = {
  heart: {
    id: 'heart',
    name: 'Cloud Heart',
    path: 'M200 199c-27-37-78-21-69 23 7 34 69 76 69 76s62-42 69-76c9-44-42-60-69-23Z',
    bevelRatio: 0.016,
    thicknessRatio: 0.17,
  },
  star: {
    id: 'star',
    name: 'Orbit Star',
    path: 'm200 187 21 43 47 5-35 31 10 47-43-24-43 24 10-47-35-31 47-5Z',
    bevelRatio: 0.009,
    thicknessRatio: 0.19,
  },
  bow: {
    id: 'bow',
    name: 'Soft Ribbon',
    path: 'M200 213c-26-35-68-28-67 8 1 24 30 42 64 31-8 24-7 46 3 61 10-15 11-37 3-61 34 11 63-7 64-31 1-36-41-43-67-8Z',
    bevelRatio: 0.012,
    thicknessRatio: 0.17,
    knot: { x: 200, y: 236, radius: 13, height: 16 },
  },
};

function measureShapes(shapes) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  shapes.forEach((shape) => {
    shape.getPoints(24).forEach((point) => {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    });
  });
  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) {
    throw new Error('Charm silhouette has no measurable area.');
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    longest: Math.max(maxX - minX, maxY - minY),
  };
}

/**
 * Extrude a charm silhouette into a beveled, y-up slab centred on the origin.
 *
 * The SVG coordinate system grows downward, so the extruded geometry is rotated by
 * Math.PI on X (a proper rotation, which keeps winding order and normals intact)
 * before it is centred and normalised to `size` world units on its longest axis.
 */
export function buildCharmGeometry(baseId, { size = 2.9, curveSegments = 20, bevelSegments = 3 } = {}) {
  const silhouette = CHARM_SILHOUETTES[baseId];
  if (!silhouette) throw new RangeError(`Unknown charm silhouette: ${baseId}`);

  const shapes = svgPathToShapes(silhouette.path);
  const bounds = measureShapes(shapes);
  const bevel = Math.max(0.5, bounds.longest * silhouette.bevelRatio);
  const depth = bounds.longest * silhouette.thicknessRatio;

  const geometry = new ExtrudeGeometry(shapes, {
    depth,
    curveSegments,
    steps: 1,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments,
    bevelOffset: 0,
  });

  geometry.rotateX(Math.PI);
  geometry.center();

  const scale = size / bounds.longest;
  geometry.scale(scale, scale, scale);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();

  const box = geometry.boundingBox;
  const width = box.max.x - box.min.x;
  const height = box.max.y - box.min.y;
  const thickness = box.max.z - box.min.z;

  const toWorld = (svgX, svgY) => new Vector3(
    (svgX - bounds.centerX) * scale,
    (bounds.centerY - svgY) * scale,
    0,
  );

  const outline = shapes[0].getPoints(72).map((point) => toWorld(point.x, point.y));

  return {
    geometry,
    bounds,
    width,
    height,
    thickness,
    scale,
    outline,
    top: toWorld(bounds.centerX, bounds.minY),
    bottom: toWorld(bounds.centerX, bounds.maxY),
    toWorld,
  };
}

/** Small five-point star used for the Mini Star add-on. */
export function createMiniStarGeometry(size = 0.62) {
  const { geometry } = buildCharmGeometry('star', { size, curveSegments: 24, bevelSegments: 2 });
  return geometry;
}

/** Rounded knot that sits on top of the Soft Ribbon silhouette. */
export function createRibbonKnotGeometry(radius, height) {
  const geometry = new SphereGeometry(1, 40, 24);
  geometry.scale(radius, height, radius * 0.78);
  geometry.computeVertexNormals();
  return geometry;
}

/** Ring / loop geometry. Torus lies in the XY plane, facing the camera by default. */
export function createLoopGeometry(radius = 0.28, tube = 0.06, segments = 48) {
  return new TorusGeometry(radius, tube, 16, segments);
}

/** Small pin used to connect a dangling add-on to the charm. */
export function createPinGeometry(length, radius = 0.024) {
  return new CylinderGeometry(radius, radius, length, 12, 1);
}

/** Disc medallion body for the initial letter, facing +Z. */
export function createMedallionGeometry(radius = 0.26, thickness = 0.075) {
  const geometry = new CylinderGeometry(radius, radius, thickness, 64, 1);
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

/** Soft pearl body. Slightly flattened sphere reads as a drilled pearl. */
export function createPearlGeometry(radius = 0.26) {
  const geometry = new SphereGeometry(radius, 48, 32);
  geometry.scale(1, 1.06, 0.96);
  geometry.computeVertexNormals();
  return geometry;
}