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
vernier proxy --target http://localhost:3000 --port 3333
```

Open:

```text
http://127.0.0.1:3333
```

The proxy injects Vernier into HTML responses and forwards everything else to your target app.

## Workflow

1. Press `Ctrl+Shift+F`.
2. Hover an element to see its measured box.
3. Click one element to capture a single measurement.
4. Click a second element to capture a delta measurement.
5. Add a note.
6. Click **Export**.

Vernier writes:

```text
.ui-feedback/latest/session.md
.ui-feedback/latest/session.json
.ui-feedback/latest/screenshots/
```

## Development

```bash
npm install
npm run verify:m0
npm run test:e2e
npm run test:proxy
```

