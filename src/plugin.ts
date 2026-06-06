import type { Plugin, ResolvedConfig } from "vite";
import { injectVernierOverlay } from "./core/html";
import { createVernierOverlayScript, vernierOverlayPath } from "./core/overlay-script";
import { registerSessionMiddleware } from "./middleware";

const virtualOverlayId = "virtual:vernier-overlay";
const resolvedVirtualOverlayId = `\0${virtualOverlayId}`;
const servedVirtualOverlayId = `/@id/${virtualOverlayId}`;

export interface VernierPluginOptions {
  enabled?: boolean;
}

export function vernier(options: VernierPluginOptions = {}): Plugin {
  let config: ResolvedConfig;

  return {
    name: "vernier",
    enforce: "pre",
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    configureServer(server) {
      registerSessionMiddleware(server);
    },
    resolveId(id) {
      if (id === virtualOverlayId) {
        return resolvedVirtualOverlayId;
      }

      return null;
    },
    load(id) {
      if (id !== resolvedVirtualOverlayId) {
        return null;
      }

      return createVernierOverlayScript({ html2canvasImportPath: "html2canvas" });
    },
    transformIndexHtml(html) {
      const isDevServer = config.command === "serve";
      const enabled = options.enabled ?? true;

      if (!isDevServer || !enabled) {
        return html;
      }

      return injectVernierOverlay(html, servedVirtualOverlayId);
    }
  };
}

export { vernierOverlayPath };
