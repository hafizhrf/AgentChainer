import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "../i18n/index.ts";

/** Copies `text` to the clipboard; the icon turns into a check for a moment (UX-04). */
export function CopyButton({ text, label = t("shell.copyButton.copy") }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="ghost icon small copy-button"
      aria-label={copied ? t("shell.copyButton.copied") : label}
      title={copied ? t("shell.copyButton.copied") : label}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}
