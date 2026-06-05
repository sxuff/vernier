import type { Plugin, ResolvedConfig } from "vite";
import { registerSessionMiddleware } from "./middleware";
import { startVernierOverlay } from "./overlay/index";
import { measureDelta, measureElement } from "./overlay/measure";
import { createPicker } from "./overlay/picker";
import { getStableSelector } from "./overlay/selector";
import { createSessionController } from "./overlay/session";
import { getSourceLocation } from "./overlay/source";
import { createOverlayRoot, renderMeasurementPanel } from "./overlay/ui";

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

      return [
        'import html2canvas from "html2canvas";',
        getStableSelector.toString(),
        getSourceLocation.toString(),
        measureElement.toString(),
        measureDelta.toString(),
        createSessionController.toString(),
        createOverlayRoot.toString(),
        renderMeasurementPanel.toString(),
        createPicker.toString(),
        `(${startVernierOverlay.toString()})();`
      ].join("\n");
    },
    transformIndexHtml(html) {
      const isDevServer = config.command === "serve";
      const enabled = options.enabled ?? true;

      if (!isDevServer || !enabled) {
        return html;
      }

      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: { type: "module", src: servedVirtualOverlayId },
            injectTo: "body"
          }
        ]
      };
    }
  };
}
