import { useStore } from "@xyflow/react";
import { dotGridLayout } from "./dotGridLayout.ts";

/**
 * The dot grid behind a React Flow canvas, in place of its `<Background>`: that's an SVG pattern the size of the
 * canvas, which WebKit repaints on every frame of a pan or zoom, most of a frame on an Intel Mac (M4-E2). This is one
 * CSS layer that the compositor moves and scales; it repaints only now and then while zooming (`dotGridLayout`).
 */
export function DotGrid({ gap = 20, size = 1 }: { gap?: number; size?: number }) {
  const [x, y, zoom] = useStore((s) => s.transform);
  const grid = dotGridLayout(x, y, zoom, gap, size);
  if (!grid) return null;
  return (
    <div
      className="dot-grid"
      aria-hidden
      style={{
        width: `calc(100% + ${2 * grid.step}px)`,
        height: `calc(100% + ${2 * grid.step}px)`,
        backgroundImage: `radial-gradient(circle, var(--dot-grid-color) ${grid.radius}px, transparent ${grid.radius}px)`,
        backgroundSize: `${grid.step}px ${grid.step}px`,
        transform: `translate3d(${grid.x}px, ${grid.y}px, 0) scale(${grid.scale})`,
      }}
    />
  );
}
