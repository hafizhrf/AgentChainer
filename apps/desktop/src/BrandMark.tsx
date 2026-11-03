/**
 * AgentChainer's mark (UX-15, UX-16): three nodes linked into a check mark. Each node is an agent, each link a
 * hand-off, and the chain they make is a check: work passed along and verified. Drawn in `currentColor`, so it takes
 * the color of where it sits; the app icon is the same path on a tile (`src-tauri/icons/icon.svg`). Decorative: the
 * name is always written next to it or in its control's label.
 */
export function BrandMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4.5 12.5 10 18 19.5 6"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="4.5" cy="12.5" r="2.6" fill="currentColor" />
      <circle cx="10" cy="18" r="2.6" fill="currentColor" />
      <circle cx="19.5" cy="6" r="2.6" fill="currentColor" />
    </svg>
  );
}
