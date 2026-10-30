import { useEffect, useState } from "react";
import { CopyButton } from "./ui/CopyButton.tsx";

/**
 * A fenced code block in the transcript (UX-04): plain text first, then highlighted by Monaco's colorizer, which
 * loads on the first block. While a reply streams in, highlighting waits for the text to settle.
 */
export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (!lang) return;
    let live = true;
    const t = setTimeout(() => {
      import("./monaco.ts")
        .then(({ colorize }) => colorize(code, lang))
        .then((out) => {
          if (live) setHtml(out);
        })
        .catch(() => undefined);
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [code, lang]);

  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span>{lang || "text"}</span>
        <CopyButton text={code} label="Copy code" />
      </div>
      {html ? (
        // Monaco's colorizer escapes the code; its output is only its own spans (THREAT_MODEL T-01).
        // biome-ignore lint/security/noDangerouslySetInnerHtml: see above.
        <pre className="code" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="code">{code}</pre>
      )}
    </div>
  );
}
