# AGENTS.md - Vernier

> **North star:** Point at broken UI. Watch it fix itself.
> **This MVP:** the precision layer only. A dev-time overlay that measures UI problems, maps them to source, and writes an agent-readable session to the repo. No agent integration yet.

Working name is **Vernier**. It is the npm package name and CLI/import name throughout. To rename, find-replace `vernier` -> `<newname>`; nothing else depends on it.

## Rules For The Agent

1. Build in milestone order: M0 -> M5. Do not start a milestone until the previous one passes its **Verify** step.
2. Each milestone ends with a runnable check. Run it. If it fails, fix before moving on.
3. TypeScript strict mode everywhere. No `any` without a `// reason:` comment.
4. The overlay runs **dev-only**. It must never ship in a production build. Guard all injection behind the Vite dev condition.
5. Keep dependencies minimal: only those listed in **Stack**. Do not add a UI framework for the overlay; it is vanilla TS + DOM.
6. Prefer small, composable modules matching the file tree below. One concern per file.
7. Touch only files needed for the request.
8. After each milestone, summarize files changed and what the Verify step proved.

## Stack

Locked for the MVP. Do not deviate without explicit approval.

- Language: **TypeScript** strict mode.
- Package manager: **npm**.
- Library build: **tsup** with ESM, CJS, and types.
- Form factor: **a Vite plugin shipped as an npm package**. Not a browser extension.
- First-class target: **Vite + React**. Other bundlers are post-MVP.
- Overlay UI: vanilla TS + DOM. No React inside the overlay.
- Screenshots: **html2canvas**.
- Browser-to-disk: the Vite plugin registers dev-server middleware at `POST /__vernier/session`; this writes files because the browser cannot write directly to disk.
- E2E test: **Playwright**.

## Repo Structure

```txt
vernier/
  package.json
  tsup.config.ts
  src/
    index.ts
    plugin.ts
    middleware.ts
    schema.ts
    overlay/
      index.ts
      picker.ts
      measure.ts
      selector.ts
      source.ts
      session.ts
      ui.ts
  examples/
    react-vite/
  tests/
    acceptance.spec.ts
  README.md
  AGENTS.md
```

## Session Output Contract

Written to `.ui-feedback/sessions/<YYYY-MM-DD-slug>/` with a `latest` symlink. Must contain `session.json`, `session.md`, and `screenshots/`.

`session.md` must be actionable with zero extra explanation:

```md
# UI Feedback Session - Vernier
Route: /dashboard
Viewport: 1440x900 @1x

## Issue 1 - alignment
Measured: .revenue-card left edge x=252; reference .usage-card x=240. Delta: 12px.
Selector: .revenue-card
Source: src/components/RevenueCard.tsx:42
Note: should share left edge with the card below
Screenshot: ./screenshots/issue-1.png

## Agent instruction
Fix the issues above. Prefer minimal changes. Use existing design tokens.
Map each change back to an issue number and state the file:line touched.
```

The non-negotiable: the human never types the number. **Vernier measures the 12px.** The human only points.

## Milestones

### M0 - Scaffold

- Build: npm package with tsup, strict TS. `src/index.ts` exports a Vite plugin that, in dev only, logs `[vernier] active` and injects an empty overlay module. Create `examples/react-vite` (Vite + React) that installs the plugin locally and renders two cards, where `.revenue-card` is intentionally offset 12px from `.usage-card`.
- **Verify:** `cd examples/react-vite && npm run dev` starts; browser console shows `[vernier] active`. A production build (`npm run build`) shows the overlay code is **not** present in output.

### M1 - Overlay + Hotkey

- Build: `Cmd+Shift+F` / `Ctrl+Shift+F` toggles a fixed overlay layer with high z-index and pointer-events managed so it does not block the picker. Include a visible toolbar with an active indicator.
- **Verify:** pressing the hotkey shows the toolbar; pressing again hides it.

### M2 - Element Picker

- Build: in active mode, hovering draws a highlight box on the element under the cursor with a `WxH` label. Click freezes selection. `Esc` clears it. Use `getBoundingClientRect()` and account for `devicePixelRatio`.
- **Verify:** hovering the cards in the example app draws boxes whose dimensions match DevTools to the pixel.

### M3 - Single Measurement

- Build: on select, capture and show in the panel: bbox (`x,y,w,h`), key computed styles (`font-size, color, background, padding, margin, width, height, border-radius`), a stable selector, and source `file:line`.
- `selector.ts`: prefer `[data-testid]` -> `#id` -> shortest unique CSS path.
- `source.ts`: find the React fiber via the `__reactFiber$*` / `__reactInternalInstance$*` key on the DOM node and read `_debugSource` (`fileName`, `lineNumber`). If absent, fall back to selector-only and mark source as `unresolved`. Optional post-MVP hardening: a dev-time transform that stamps `data-vernier-source="file:line"`.
- **Verify:** selecting `.revenue-card` shows values matching DevTools, and `source` resolves to `RevenueCard.tsx:<line>` or cleanly reports `unresolved`.

### M4 - Delta Measurement

- Build: select element A, then element B. Compute and display real deltas: per-edge pixel offset (`left edge off by 12px`), size deltas, color delta (hex vs hex), and font-size delta.
- **Verify:** selecting the two example cards reports a left-edge delta of exactly `12px`.

### M5 - Session + Screenshot + Export

- Build: accumulate multiple measurements into one session. Do not force one issue per send. Capture an element screenshot with html2canvas and a full-page screenshot. On "Export", POST the session to `/__vernier/session`; `middleware.ts` writes `session.json`, `session.md`, and `screenshots/` under `.ui-feedback/sessions/<slug>/` and updates the `latest` symlink.
- **Verify:** after exporting a 2-issue session in the example app, the files exist on disk and `session.md` contains the measured `12px` delta and the resolved `file:line`.

## MVP Acceptance Test

`tests/acceptance.spec.ts` must be runnable headless so Codex can self-verify:

1. Start the example app dev server.
2. Programmatically activate the overlay, select `.revenue-card` then `.usage-card`, add a note, and trigger export.
3. Assert `.ui-feedback/latest/session.md` exists and contains both `12px` and a `Source: src/...RevenueCard.tsx:` line, or an explicit `unresolved` marker if running on a React version without `_debugSource`.

If that test passes, the MVP is done. Wire it as `npm run test:e2e`.

## Non-Goals

Out of scope for this MVP:

- No browser extension.
- No MCP server, no Claude Code / Codex integration yet. The file format is the integration for now.
- No live-preview-before-code, no pixel-verification, no design-token gap detection. These are next milestones, not MVP.
- No team, sync, or hosted backend.
- No "open protocol" or "standard" framing anywhere in code or docs.
- No bundlers other than Vite. A framework-agnostic `<script>` fallback is post-MVP.

## After The MVP

Priority order for context only:

1. Live preview: inject the proposed fix as tentative inline styles into the running page before any file is written.
2. Pixel verification: re-measure after a fix; auto-resolve only if pixels moved where the user pointed.
3. Design-token gap detection: compare computed styles to available tokens, write the precise fix instruction.
4. MCP server over the existing session format.
5. Interaction-state capture for hover, focus, modal, and scroll states.
