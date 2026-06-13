# Vernier

Vernier is a dev-time UI measurement overlay. It lets you point at UI problems, records real measurements, and exports an agent-readable feedback session.

Current status: local-first dev tool, ready for private/package testing.

Requires Node.js 20 or newer.

## Use With Vite

Install and add the plugin to a Vite config:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { vernier } from "vernier";

export default defineConfig({
  plugins: [react(), vernier()]
});
```

Start your Vite dev server, open the app, then press:

```text
Ctrl+Shift+F
```

## Use With Any Localhost App

Run your app on any local port, then start the Vernier proxy:

```bash
vernier
```

By default, Vernier forwards to `http://localhost:5173` and opens its proxy on `http://127.0.0.1:3333`.

Use an explicit target when your app runs somewhere else:

```bash
vernier attach
vernier attach --target http://localhost:3000
vernier --target http://localhost:3000
vernier start --target http://localhost:3000 --port 3333
vernier proxy --target http://localhost:3000 --port 3333
vernier http://localhost:3000
```

`vernier attach` scans common local dev ports, starts the proxy for the best match, and opens it in your browser. Add `--no-open` for scripts. If the requested proxy port is busy, Vernier automatically picks the next available port and prints the URL.

Find likely local apps without starting or owning them:

```bash
vernier detect
vernier detect --ports 5173,3000,6006
vernier detect --json
```

From this repo during development, the default proxy command is:

```bash
npm run dev:proxy
```

Open:

```text
http://127.0.0.1:3333
```

The proxy injects Vernier into HTML responses and forwards everything else to your target app, including redirects, cookies, SSE streams, and WebSocket upgrades used by HMR.

Known proxy limitation: HTML responses are buffered before Vernier injects the overlay. Server-Sent Events are streamed through, but streaming HTML responses such as React `renderToPipeableStream` will not stream progressively through the Vernier proxy.

Your target app must already be running. If the target app is down, Vernier keeps running and shows a 502 page explaining that the target refused the connection.

Vernier mounts its browser chrome in a Shadow DOM host so app-level CSS resets and component styles do not distort the overlay, and Vernier styles do not leak back into your app.

## Use Without A Proxy

If you can edit the app HTML directly, run a standalone Vernier server and paste the snippet before `</body>`:

```bash
vernier serve --port 3333
vernier snippet --port 3333
```

This serves only Vernier's overlay assets and session export endpoint. Your app can be plain HTML, a backend-rendered page, Storybook preview HTML, or another framework that does not use Vite.

Optional defaults can live in `vernier.config.json`:

```json
{
  "target": "http://localhost:5173",
  "port": "auto",
  "detectPorts": [5173, 3000, 6006],
  "verification": {
    "bboxTolerancePx": 2
  },
  "overlay": {
    "captureFullPage": false,
    "captureStrategy": "modern-screenshot"
  },
  "agents": {
    "default": "codex"
  }
}
```

Flags win over environment variables, environment variables win over config, and config wins over built-in defaults. Supported environment defaults are `VERNIER_TARGET`, `VERNIER_PORT`, `VERNIER_PORTS`, `VERNIER_AGENT`, and `VERNIER_DEBUG=1`.

Supported overlay screenshot strategies are `html2canvas` and `modern-screenshot`. `html2canvas` remains the default; use `modern-screenshot` when you want the newer DOM-to-canvas renderer.

## Workflow

1. Press `Ctrl+Shift+F`.
2. Choose a mode:
   - **Measure**: hover elements, click one element for a single measurement, click a second element for a delta.
   - **Pen**: draw a freehand annotation.
   - **Box**: drag a rectangular annotation.
   - **Redact**: drag a mask over sensitive screenshot regions.
3. Add a note.
4. Click **Add issue** to queue the current measurement or annotation.
5. Repeat for as many UI issues as you want.
6. Click **Export**.

Use handoff buttons when you want to move the session into an agent:

- **Copy markdown** copies the current session markdown preview.

Vernier writes:

```text
.ui-feedback/latest/session.md
.ui-feedback/latest/session.json
.ui-feedback/latest/screenshots.json
.ui-feedback/latest/screenshots/
```

Vernier is local-only:

- Screenshots, session JSON, verification artifacts, and replay assets are written to local disk.
- Vernier does not upload screenshots or session data.
- `metadata.json` records `localOnly: true` and `networkUploads: false` for exported sessions.
- The session write endpoint validates payload shape, caps body/screenshot sizes, accepts only safe screenshot filenames, confines writes to the project output directory, and rejects non-local cross-site browser origins.

Annotations store viewport data and normalized relative points so future adapters can re-anchor or replay them across browser sizes.

Screenshots automatically mask password inputs and elements marked with `data-vernier-redact`. Vernier shows a one-time local screenshot warning before the first export. Set `overlay.captureFullPage` to `false` when you want the exported overview screenshot cropped to the current viewport instead of the whole page.

Element measurements include computed styles, authored CSS hints, layout context, text metrics, stacking context, utility-like class hints, and nearby CSS custom properties that match captured values. This helps agents reuse existing classes and design tokens instead of inventing one-off values.

For non-React apps or compiled frameworks, add `data-vernier-source="src/components/Button.tsx:37"` to give Vernier an exact source hint. You can also add `data-vernier-component="Button"` and `data-vernier-owner-chain="Page > Card > Button"` when a file/line is not available.

## Development

```bash
npm install
npm test
npm run lint
npm run verify:m0
npm run test:e2e
npm run test:proxy
npm run dev:example
npm run dev:proxy
npm run proxy:3000
```

After exporting, you can also use:

```bash
vernier issues
vernier issues --todo
vernier issues --fixed
vernier issues --json
vernier status
vernier show <issue-id>
vernier verify <issue-id>
vernier verify <issue-id> --target http://localhost:3000 --open
vernier verify <issue-id> --target http://localhost:3000 --compare
vernier verify <issue-id> --target http://localhost:3000 --compare --viewports mobile,tablet,desktop
vernier capture --target http://localhost:3000 --routes /,/pricing --viewports mobile,desktop
vernier diff .ui-feedback/captures/capture-a .ui-feedback/captures/capture-b
vernier replay latest
vernier storybook --url http://localhost:6006 --stories button--primary --viewports mobile,desktop
vernier serve --port 3333
vernier snippet --port 3333
vernier doctor
vernier clean --keep 20 --dry-run
vernier audit a11y
vernier audit layout
vernier mcp
vernier mark <issue-id> fixed
vernier mark <issue-id> todo
vernier copy <issue-id>
vernier copy <issue-id> --format packet
vernier note <issue-id> "Button should align with card title"
vernier rename-session "pricing mobile pass"
vernier plan <issue-id>
vernier export --format zip
vernier export --format json --out latest-session.json
vernier import .ui-feedback/exports/latest-session.zip
vernier import path/to/session-directory
vernier github body <issue-id>
vernier github create all --label ui-feedback --dry-run
vernier fix-loop <issue-id> --to codex --target http://localhost:3000
vernier send --to codex --template codex
vernier send <issue-id> --to codex --template strict
vernier send all --to claude --all
vernier latest
vernier open
```

`vernier issues` prints short stable IDs like `i-8f3a12` plus a `todo` or `fixed` status, so you do not have to rely on fragile list positions when multiple issues are waiting. `vernier status` gives a compact latest-session count and next todo item.

Add `--json` to `vernier issues`, `vernier status`, or `vernier detect` when you want scriptable output for agents, CI, or shell pipelines.

`vernier note <issue-id> "..."` updates the latest session JSON and regenerates `session.md`, which is useful when you want to refine a captured issue without recapturing the screenshot.

`vernier copy <issue-id> --format packet` outputs a compact reproduction packet with route, viewport, selector, source hint, screenshot path, note, and verification commands. Use `--print` to write it to stdout instead of the clipboard.

`vernier rename-session "..."` labels the latest session in `session.json`, `session.md`, `issues`, and `status` output without renaming artifact directories.

`vernier plan <issue-id>` prints a lightweight patch plan: likely source, likely change type, evidence confidence, suggested approach, and verification commands.

`vernier export --format md|json|zip` exports the latest session artifact for sharing or archiving. Markdown and JSON print to stdout unless `--out` is provided; zip writes a portable archive by default under `.ui-feedback/exports/`.

`vernier import <session-directory-or-zip>` copies a Vernier session into `.ui-feedback/sessions/` and makes it the latest session. This is useful when someone sends you a zip report or when you want to replay archived evidence locally.

`vernier github body <issue-id>` prints a GitHub-ready issue body without network access. `vernier github create all --label ui-feedback` uses the GitHub CLI to create issues for todo Vernier issues; add `--dry-run` to preview the exact issues without network or auth.

`vernier fix-loop <issue-id> --to codex --target http://localhost:3000` sends a Vernier repair task to the selected agent, waits for it to exit, runs `vernier verify --compare`, and marks the issue fixed only when the measured result is inside tolerance. Add `--print` to inspect the task without launching an agent.

`vernier send --to codex` sends todo issues in the latest session by default. Use `--template generic|codex|claude|cursor|aider|strict` to tune handoff framing. Use `--all` when you want fixed issues included too. If the Codex or Claude CLI is not installed, Vernier copies the task to your clipboard so you can paste it into the desktop app.

`vernier verify <issue-id>` prints the captured viewport, original evidence, target URL, screenshot path, and the follow-up mark commands. Add `--open` to open the captured route in your browser.

`vernier verify <issue-id> --compare` reopens the captured route at the captured viewport, finds the selector, remeasures it, and writes local artifacts under `.ui-feedback/sessions/<session>/verification/<issue-id>/`. Add `--viewports mobile,tablet,desktop` or explicit sizes like `390x844,768x1024,1440x900@2` to compare the same issue across responsive breakpoints.

`vernier capture --routes /,/pricing --viewports mobile,desktop` performs batch screenshot capture against an already-running target app and writes artifacts under `.ui-feedback/captures/<timestamp>/`.

`vernier diff <left> <right>` compares two Vernier feedback sessions or two batch capture directories and reports added, removed, or changed issues/screenshots.

`vernier storybook --url http://localhost:6006` reads Storybook's `index.json`, captures each selected story through `iframe.html`, and writes story IDs, import paths, tags, viewport metadata, and screenshots under `.ui-feedback/storybook/<timestamp>/`.

`vernier replay latest` opens a local read-only viewer for the latest session, including screenshots, structured evidence, statuses, and verification reports.

`vernier doctor` checks local privacy hygiene, including whether `.ui-feedback/` is ignored. `vernier clean` removes old local session folders by count or age.

`vernier audit a11y` checks the latest captured evidence for contrast, tap-target size, and missing accessible names. `vernier audit layout` checks alignment deltas, overflow, and captured layout context. Add `--json` for agent/CI output.

`vernier mcp` starts a local MCP server over stdio so agents can list/read Vernier issues and mark or verify them without clipboard handoff.
