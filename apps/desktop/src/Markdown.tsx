import { openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

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
};

/**
 * Assistant text as GitHub-flavored markdown (M1-10). react-markdown builds React elements and drops raw HTML
 * (`skipHtml`), so model output can't inject markup into the app. Code highlighting comes with the UX pass (UX-04).
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
