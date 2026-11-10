/**
 * A model's short name for small places, such as the graph's nodes (UX-18): "claude-haiku-5-5" → "Haiku 5.5",
 * "claude-3-5-sonnet-20241022" → "Sonnet 3.5", "opus" → "Opus". A name it doesn't recognize comes back as it is.
 * Model names are product names, so they aren't translated.
 */
export function modelName(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const base = id.replace(/\[1m\]$/i, "");
  if (/^(opus|sonnet|haiku|fable)$/i.test(base)) return cap(base.toLowerCase());
  const current = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(base);
  if (current?.[1] && current[2])
    return `${cap(current[1].toLowerCase())} ${current[2]}${current[3] ? `.${current[3]}` : ""}`;
  const older = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/i.exec(base);
  if (older?.[1] && older[3]) return `${cap(older[3].toLowerCase())} ${older[1]}${older[2] ? `.${older[2]}` : ""}`;
  return id;
}
