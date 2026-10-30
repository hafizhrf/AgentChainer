import { openUrl } from "@tauri-apps/plugin-opener";
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock.tsx";

/** Only web links open, in the user's browser; anything else (file:, javascript:, app-relative) does nothing. */
const WEB = /^https?:\/\//i;

const components: Components = {
  // Navigating the app's own window would replace the UI, so links open in the browser instead.
  a: ({ href, children }) => (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        if (href && WEB.test(href)) void openUrl(href);
      }}
    >
      {children}
    </a>
  ),
  // No remote loads from model output (tracking pixels, local file probes): show images as text.
  img: ({ alt, src }) => <span className="muted">[image: {alt || String(src ?? "")}]</span>,
  // Fenced blocks become highlighted code blocks with a copy button (UX-04); inline code stays as it is.
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children ?? "");
    const fence = /language-(\S+)/.exec(className ?? "")?.[1];
    if (fence === undefined && !text.endsWith("\n")) return <code>{children}</code>;
    return <CodeBlock code={text.replace(/\n$/, "")} lang={fence ?? ""} />;
  },
};

/**
 * Assistant text as GitHub-flavored markdown (M1-10). react-markdown builds React elements and drops raw HTML
 * (`skipHtml`), so model output can't inject markup into the app. Fenced code is highlighted (UX-04). Memoized: a long
 * transcript re-parses only the message that changed.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
