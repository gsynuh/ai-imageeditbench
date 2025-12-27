# Agent Conventions for ImageEditBench

Welcome! Please follow these conventions when making changes:

- Keep changes minimal and aligned with SPECS.md.
- Prefer TypeScript types that reflect the IndexedDB schema and API shapes.
- Avoid large refactors unless requested; add small, well-scoped helpers instead.
- Keep UI structure readable; add comments only when logic is non-obvious.
- Split big react components into smaller components if react related .ts/.tsx files are too large
- Export buisness logic outside of components
- Use state management libraries such as nanostores
- Use scss and style modules; share them or create mixins whenever possible.

## Persisted UX/UI Requirements (project conventions)

- Maximize screen usage and info density; avoid wasted space and decorative-only UI.
- Avoid “status bubbles” or tags that don’t help a workflow (no fluff like “IndexedDB ready”).
- Keep the app dark-mode correct end-to-end:
  - Ensure dropdown/popover/panel surfaces, dialogs, and focus rings match the dark theme.
  - Prefer `color-scheme: dark` and avoid relying on browser default light-mode controls.
- Prefer consistent cross-platform primitives for controls:
  - Use Radix UI primitives (Dialog/Select/Checkbox/ScrollArea/Slider) for consistent behavior and theming.
  - Avoid unstyled native checkboxes/select popups where they clash with the dark theme.
- Main view input dock layout should stay visually aligned and not “lopsided” due to multiline textarea.
- Main view background and containers should scroll correctly and scale with content (no stuck/non-extending backgrounds).
- Image “Quick Edit” should be a modal cropper with pan + zoom (profile-image style), not an inline panel.

## Before declaring a task complete, please run (in order) and ensure PASS:

1. `read_lints()` - Check all files using the IDE linter (most thorough). If this tool is unavailable or fails, fall back to CLI checks:
   - `npm run lint`
   - `npx tsc --noEmit` (or `npx tsc --noEmit --project tsconfig.app.json`)
2. `npm run format`

Avoid Building or transpiling to .js

If any step fails, fix it or explain the remaining issue clearly.
