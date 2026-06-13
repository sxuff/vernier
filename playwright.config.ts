import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:5173",
  },
  webServer: {
    command:
      "npm --prefix examples/react-vite run dev -- --port 5173 --strictPort",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
