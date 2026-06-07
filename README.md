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
vernier --target http://localhost:3000
vernier start --target http://localhost:3000 --port 3333
vernier proxy --target http://localhost:3000 --port 3333
vernier http://localhost:3000
```

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

The proxy injects Vernier into HTML responses and forwards everything else to your target app.

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
vernier show <issue-id>
vernier copy <issue-id>
vernier send <issue-id> --to codex
vernier send <issue-id> --to claude
vernier latest
vernier open
```

`vernier issues` prints short stable IDs like `i-8f3a12`, so you do not have to rely on fragile list positions when multiple issues are waiting.
