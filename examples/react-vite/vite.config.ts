import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { vernier } from "../../src/index";

export default defineConfig({
  plugins: [react(), vernier()],
});
