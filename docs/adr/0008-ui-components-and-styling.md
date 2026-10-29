# ADR-0008: Radix primitives with our own CSS tokens for the desktop UI

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** hafizhrf (owner), with Claude as implementer
- **Related:** UX-02, UX-03, UX-06, UX-07, [ADR-0001](0001-desktop-stack.md), [ADR-0002](0002-auth-and-branding.md)

## Context

The M1/M2 screens were built as plain spikes: one `App.css` of about 1,100 lines, native `<select>` elements, a
hand-rolled overlay for dialogs, and no layout system. After using the M2 build, the owner found them unfinished:
- no desktop menu;
- a cramped start screen whose scrollbar sat in the middle of the window;
- a 260 px sidebar too narrow for the Setup report and the bootstrap plan.

UX-02 asks for a design system (tokens for light and dark) and a recorded component approach. The UI needs:
- accessible menus, selects, tabs, tooltips and modal dialogs (focus trapping, keyboard support, screen-reader roles);
- resizable, collapsible panels for a three-column layout;
- a light and a dark theme that follow the OS, with a manual override.

The existing CSS already uses custom properties, and the owner chose a dark pastel green accent with no orange
(UX-02, branding rules in ADR-0002).

## Decision

- **Behavior:** Radix Primitives (unstyled, accessible). The app uses `@radix-ui/react-dialog`, `-dropdown-menu`,
  `-select`, `-tabs` and `-tooltip`, wrapped in small components in `apps/desktop/src/ui/` (`Select`, `ActionMenu`,
  `IconButton`, `Field`) and in `Dialog.tsx` (`Modal`, `useConfirm`).
- **Styling:** plain CSS with design tokens, no utility framework.
  - Tokens live in `src/styles/tokens.css`: color, spacing (4 px scale), radius, type scale, shadows, motion.
  - `data-theme` on `<html>` selects light, dark or system.
  - Then `base.css` (elements, forms, buttons), `layout.css` (shell, sidebar, Home), `components.css` (Radix parts,
    dialogs), `session.css` (session view) and `features.css` (readiness, markdown, git, bootstrap).
- **Layout:** `react-resizable-panels` for the sidebar, the session's right panel and the terminal split. Panel sizes
  and open/closed state persist in `localStorage`, wrapped in try/catch: a convenience that may be lost.
- **Icons:** `lucide-react`.
- **Theme:** a `theme` setting (`light`, `dark`, or unset for the OS). Monaco and xterm repaint on theme changes.

Licenses: Radix and react-resizable-panels are MIT; lucide-react is ISC. All are pinned to exact versions at least
two weeks old.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| shadcn/ui + Tailwind | Large component set, common look | Rewrites all existing CSS into utility classes; adds a build step and copied component code to maintain | The existing token-based CSS only needed restructuring, not a rewrite; owner chose this option |
| Native elements only (current) | No dependencies | Native selects, menus and dialogs can't be styled consistently across macOS, Windows and Linux webviews, and accessible menus and focus trapping would be hand-written | The spike UI showed the limits |
| A full component library (MUI, Mantine, Chakra) | Everything included | Heavy, opinionated theming that fights our tokens; larger bundle | More than the app needs |

## Consequences

- **Positive:**
  - Accessible menus, dialogs and selects without writing focus management.
  - One set of tokens drives both themes.
  - Panels resize and remember their sizes.
- **Negative:**
  - Seven new runtime dependencies; the main bundle is 748 kB before gzip (231 kB gzipped) after this change.
  - Our wrappers in `src/ui/` must stay thin, so the Radix API stays visible.
- **Revisit when:** the component set grows beyond what thin wrappers cover (a command palette, data tables, a
  date picker), or Radix stops being maintained.

## References

- Radix Primitives: https://www.radix-ui.com/primitives
- react-resizable-panels: https://github.com/bvaughn/react-resizable-panels
- lucide: https://lucide.dev
