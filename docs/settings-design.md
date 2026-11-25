# Settings appearance and navigation

This specification covers theme-sensitive reasoning controls and navigation around the settings dialog. It complements the existing components rather than introducing a separate design system.

## Behavior and scope

- Appearance supports System, Light, and Dark. An explicit preference overrides the operating system; System follows it. Use the existing theme store and `light-dark()` colors.
- Max and Ultra retain distinct accents in light and dark themes. Their text must remain readable on normal and highlighted surfaces, with a minimum contrast ratio of 4.5:1. Reuse the dark warning tokens for Max; keep Ultra purple with a dark purple surface.
- Keep the existing typography, spacing, fixed control width, accessible descriptions, keyboard selection, and reduced-motion behavior. Theme changes must not introduce horizontal overflow at 320 px or shift controls when ignition animations finish.
- The settings dialog overlays the current navigation state. Closing it returns to the still-open mobile sidebar. Opening a sidebar that is already expanded must not require clicking its covered background trigger. Tests inspect the current state before opening it; no forced clicks or application navigation changes are required.

## Regression acceptance

`tests/e2e/reasoning-visuals.spec.ts` verifies both system themes and explicit overrides at 1280 px and 320 px. It checks normal and highlighted colors and contrast, selection and undo, geometry, accessible descriptions, and reduced motion. Screenshots use Playwright's per-test output directory.

`tests/e2e/workdir.spec.ts` verifies saving the server base directory, returning to the open mobile sidebar, opening project management, missing directories, absolute overrides, and clearing the setting.

Build the app before running these browser checks:

```sh
pnpm build
pnpm exec playwright test tests/e2e/reasoning-visuals.spec.ts tests/e2e/workdir.spec.ts
```

Use isolated fixtures and the pinned Playwright browser, as described in [contributing](contributing.md). Mock browser checks do not constitute live-model or production-account acceptance. PR UI changes require actual screenshots under [AGENTS.md](../AGENTS.md).
