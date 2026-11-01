import { useEffect, useState } from "react";

/** The clock, re-read every `everyMs` while `running`; `undefined` otherwise, so finished views stay still. */
export function useNow(running: boolean, everyMs: number): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [running, everyMs]);
  return running ? now : undefined;
}
