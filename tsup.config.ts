import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/overlay/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "es2022",
    external: ["vite"]
  },
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: true,
    target: "es2022",
    external: ["vite", "playwright"]
  }
]);
