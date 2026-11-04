/** Where DotGrid.tsx puts its layer for a React Flow viewport: its grid step and dot radius as drawn, and its transform. */
export type DotGridLayout = { step: number; radius: number; x: number; y: number; scale: number };

/**
 * The layer is drawn at the zoom rounded down to a quarter octave and scaled up from there (by less than 19%), so
 * zooming repaints it only when the zoom crosses one of those steps. It's shifted by the pan modulo one grid step on
 * screen, moved one step back to cover the edge: the grid repeats every step, so that looks the same as the full pan.
 * Returns null when the dots would be under half a pixel across: they can't be seen there.
 */
export function dotGridLayout(x: number, y: number, zoom: number, gap = 20, size = 1): DotGridLayout | null {
  if (size * zoom < 0.5) return null;
  const drawn = 2 ** (Math.floor(Math.log2(zoom) * 4) / 4);
  const scale = zoom / drawn;
  const onScreen = gap * zoom;
  const shift = (v: number) => (((v % onScreen) + onScreen) % onScreen) - onScreen;
  return { step: gap * drawn, radius: (size * drawn) / 2, x: shift(x), y: shift(y), scale };
}
