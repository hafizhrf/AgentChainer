import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

/** Copies `text` to the clipboard; the icon turns into a check for a moment (UX-04). */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="ghost icon small copy-button"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}
