# Vernier

Vernier is a dev-time UI measurement overlay. It lets you point at UI problems, records real measurements, and exports an agent-readable feedback session.

Current status: MVP plus adapter/proxy architecture.

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

Your target app must already be running. If the target app is down, Vernier keeps running and shows a 502 page explaining that the target refused the connection.

## Workflow

1. Press `Ctrl+Shift+F`.
2. Choose a mode:
   - **Measure**: hover elements, click one element for a single measurement, click a second element for a delta.
   - **Pen**: draw a freehand annotation.
   - **Box**: drag a rectangular annotation.
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
.ui-feedback/latest/screenshots/
```

Annotations store viewport data and normalized relative points so future adapters can re-anchor or replay them across browser sizes.

## Development

```bash
npm install
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
vernier show <issue-id>
vernier verify <issue-id>
vernier verify <issue-id> --target http://localhost:3000 --open
vernier verify <issue-id> --target http://localhost:3000 --compare
vernier replay latest
vernier doctor
vernier clean --keep 20 --dry-run
vernier mark <issue-id> fixed
vernier mark <issue-id> todo
vernier copy <issue-id>
vernier send --to codex
vernier send <issue-id> --to codex
vernier send all --to claude --all
vernier latest
vernier open
```

`vernier issues` prints short stable IDs like `i-8f3a12` plus a `todo` or `fixed` status, so you do not have to rely on fragile list positions when multiple issues are waiting.

`vernier send --to codex` sends todo issues in the latest session by default. Use `--all` when you want fixed issues included too. If the Codex or Claude CLI is not installed, Vernier copies the task to your clipboard so you can paste it into the desktop app.

`vernier verify <issue-id>` prints the captured viewport, original evidence, target URL, screenshot path, and the follow-up mark commands. Add `--open` to open the captured route in your browser.

`vernier verify <issue-id> --compare` reopens the captured route at the captured viewport, finds the selector, remeasures it, and writes local artifacts under `.ui-feedback/sessions/<session>/verification/<issue-id>/`.

`vernier replay latest` opens a local read-only viewer for the latest session, including screenshots, structured evidence, statuses, and verification reports.

`vernier doctor` checks local privacy hygiene, including whether `.ui-feedback/` is ignored. `vernier clean` removes old local session folders by count or age.
