import type { Point, Rect } from './protocol'

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
 * Maps engine screen rect to CSS layout for HTML overlay positioning.
 * Engine screen coordinates match logical CSS pixels.
 */
export function screenToCssRect(
  screenRect: Rect
): { left: number; top: number; width: number; height: number } {
  return {
    left: screenRect.x,
    top: screenRect.y,
    width: screenRect.width,
    height: screenRect.height,
  }
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

