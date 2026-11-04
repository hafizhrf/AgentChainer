import spec from "./redact-patterns.json" with { type: "json" };

/**
 * One redaction for logs, displayed tool output and diagnostics (X-03). The patterns live in `redact-patterns.json`,
 * which the Rust core reads too (`diagnostics.rs`), and `test/redact-vectors.json` runs against both, so the UI, the
 * sidecar and the app log mask the same things.
 */
const PATTERNS: readonly [RegExp, string][] = spec.patterns.map((p) => [
  new RegExp(p.pattern, `${"flags" in p ? p.flags : ""}g`),
  p.replace,
]);

/** Keys, tokens, passwords, private keys, credentials in URLs and email addresses, masked. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  return out;
}

/**
 * For logs: secrets masked, and the home folder as `~`, also where it appears JSON-escaped (a Windows path in a log
 * line that's itself JSON has its backslashes doubled, or doubled twice).
 */
export function redactForLog(text: string, home: string): string {
  let out = text;
  if (home.length > 1) {
    const once = home.replace(/\\/g, "\\\\");
    const twice = once.replace(/\\/g, "\\\\");
    for (const form of new Set([twice, once, home])) out = out.split(form).join("~");
  }
  return redactSecrets(out);
}

/** Whether `text` holds anything `redactSecrets` would mask, other than an email address. */
export function hasSecret(text: string): boolean {
  return PATTERNS.some(([re, to]) => to !== "[email]" && new RegExp(re.source, re.flags.replace("g", "")).test(text));
}

const SECRET_NAME = /api[_-]?key|token|secret|password|passwd|credential|private[_-]?key/i;

/**
 * A tool's input for display: every string masked, and a string under a secret-sounding field name (`token`,
 * `api_key`, …) replaced whole, unless it's a plain number. The shape stays, so diffs and summaries still work.
 */
export function redactValue(value: unknown, name = ""): unknown {
  if (typeof value === "string") {
    return SECRET_NAME.test(name) && value && !/^\d+$/.test(value) && !value.startsWith("[")
      ? "[redacted]"
      : redactSecrets(value);
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, name));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, k)]));
  }
  return value;
}
