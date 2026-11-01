import type { ReactFlowInstance } from "@xyflow/react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { benchItems, type FrameStats, frameStats } from "./benchScene.ts";
import type { FlowNode } from "./SessionGraph.tsx";

const SessionGraph = lazy(() => import("./SessionGraph.tsx"));

export type BenchReport = {
  nodes: number;
  viewport: { width: number; height: number; dpr: number };
  pan: FrameStats;
  zoom: FrameStats;
  userAgent: string;
};

const PHASE_MS = 4000;
const NO_WAIT: ReadonlySet<string> = new Set();

/** Calls `step(t)` with t from 0 to 1 on every animation frame for `ms`, and returns the frames' timestamps. */
function animate(ms: number, step: (t: number) => void): Promise<number[]> {
  return new Promise((resolve) => {
    const times: number[] = [];
    const tick = (now: number) => {
      const start = times[0] ?? now;
      times.push(now);
      const t = (now - start) / ms;
      step(Math.min(1, t));
      if (t < 1) requestAnimationFrame(tick);
      else resolve(times);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * The M4-E2 bench (dev only, `AGENTCHAINER_SELFTEST` with `"bench": "graph"`): the session graph with the synthetic
 * 200-node scene, panned and then zoomed through React Flow's viewport on every frame, as a user dragging and
 * scrolling would, while the intervals between animation frames are recorded. Driven by scripts/graph-bench.mjs.
 */
export function GraphBench({ onDone }: { onDone: (report: BenchReport) => void }) {
  const items = useMemo(() => benchItems(), []);
  const [flow, setFlow] = useState<ReactFlowInstance<FlowNode> | null>(null);
  const [report, setReport] = useState<BenchReport | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (!flow || started.current) return;
    started.current = true;
    void (async () => {
      // Let the first layout and fitView settle.
      await new Promise((r) => setTimeout(r, 1000));
      const home = flow.getViewport();
      const pan = await animate(PHASE_MS, (t) => {
        const a = t * Math.PI * 4;
        flow.setViewport({ x: home.x + Math.sin(a) * 600, y: home.y + Math.cos(a) * 300, zoom: home.zoom });
      });
      const zoom = await animate(PHASE_MS, (t) => {
        flow.setViewport({ ...home, zoom: home.zoom * (1 + 1.5 * Math.sin(t * Math.PI * 4) ** 2) });
      });
      flow.setViewport(home);
      const r: BenchReport = {
        nodes: flow.getNodes().length,
        viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
        pan: frameStats(pan),
        zoom: frameStats(zoom),
        userAgent: navigator.userAgent,
      };
      setReport(r);
      onDone(r);
    })();
  }, [flow, onDone]);

  return (
    <div className="graph-bench">
      <Suspense fallback={<p className="muted">Loading the graph…</p>}>
        <SessionGraph
          items={items}
          running={false}
          waiting={NO_WAIT}
          selected={null}
          onSelect={() => undefined}
          onFlow={setFlow}
        />
      </Suspense>
      <p className="graph-bench-status muted">
        {report
          ? `${report.nodes} nodes · pan p95 ${report.pan.p95Ms} ms (${report.pan.fps} fps) · zoom p95 ${report.zoom.p95Ms} ms (${report.zoom.fps} fps)`
          : "Measuring pan and zoom with 200 nodes…"}
      </p>
    </div>
  );
}
