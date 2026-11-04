import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dotGridLayout } from "./dotGridLayout.ts";

describe("the dot grid's layer", () => {
  it("isn't drawn when the dots would be under half a pixel", () => {
    assert.equal(dotGridLayout(0, 0, 0.1), null);
    assert.equal(dotGridLayout(0, 0, 0.49), null);
    assert.notEqual(dotGridLayout(0, 0, 0.5), null);
    assert.notEqual(dotGridLayout(0, 0, 0.25, 20, 2), null);
  });

  it("shows the grid at the zoom's own step, scaled up by less than a quarter octave", () => {
    for (const zoom of [0.5, 0.6, 0.77, 1, 1.18, 1.19, 1.5, 2]) {
      const g = dotGridLayout(0, 0, zoom);
      assert.ok(g);
      assert.ok(g.scale >= 1 && g.scale < 2 ** 0.25, `scale ${g.scale} at zoom ${zoom}`);
      assert.ok(Math.abs(g.step * g.scale - 20 * zoom) < 1e-9);
      assert.ok(Math.abs(g.radius * g.scale - zoom / 2) < 1e-9);
    }
  });

  it("repaints only when the zoom crosses a step: within one, only the scale changes", () => {
    const steps = (zooms: number[]) => new Set(zooms.map((z) => dotGridLayout(0, 0, z)?.step));
    assert.equal(steps([1, 1.05, 1.1, 1.18]).size, 1);
    assert.equal(steps([1, 1.2, 1.45, 1.7, 2]).size, 5);
  });

  it("pans by less than one step on screen, which looks the same as the full pan", () => {
    for (const [x, zoom] of [
      [0, 1],
      [37, 1],
      [-523.5, 0.8],
      [12_345.6, 1.6],
    ] as const) {
      const g = dotGridLayout(x, -x, zoom);
      assert.ok(g);
      const onScreen = 20 * zoom;
      assert.ok(g.x > -onScreen - 1e-9 && g.x <= 1e-9, `shift ${g.x} for x ${x}`);
      const steps = (x - g.x) / onScreen;
      assert.ok(Math.abs(steps - Math.round(steps)) < 1e-6, `x ${x} isn't a whole number of steps from ${g.x}`);
      const ySteps = (-x - g.y) / onScreen;
      assert.ok(Math.abs(ySteps - Math.round(ySteps)) < 1e-6);
    }
  });
});
