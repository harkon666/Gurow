import type { CameraState, Point } from './protocol'

/**
 * Returns current device pixel ratio safely across browser and SSR environments.
 */
export function getCanvasDpr(): number {
  if (typeof window === 'undefined') return 1
  return window.devicePixelRatio || 1
}

/**
 * Converts CSS pointer client coordinates to engine logical screen coordinates.
 */
export function cssToLogicalPoint(
  clientX: number,
  clientY: number,
  canvasRect: DOMRect
): Point {
  return {
    x: clientX - canvasRect.left,
    y: clientY - canvasRect.top,
  }
}

/**
 * The engine camera (`screen = world * zoom + offset`) as a CSS transform with
 * origin 0 0, so world-space labels follow pan and zoom through one style change.
 */
export function cameraToCssTransform(camera: CameraState): string {
  return `translate(${camera.offset_x}px, ${camera.offset_y}px) scale(${camera.zoom})`
}

/**
 * Calculates physical pixel dimensions for canvas buffer given logical dimensions and DPR.
 */
export function toCanvasBufferSize(
  cssWidth: number,
  cssHeight: number,
  dpr: number
): { width: number; height: number } {
  const safeDpr = dpr > 0 ? dpr : 1
  return {
    width: Math.max(1, Math.floor(cssWidth * safeDpr)),
    height: Math.max(1, Math.floor(cssHeight * safeDpr)),
  }
}

