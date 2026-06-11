import type { ViteDevServer } from "vite";
import type { SessionOutputOptions } from "./core/overlay-options";
import { handleVernierSessionRequest } from "./core/session-handler";

export function registerSessionMiddleware(server: ViteDevServer, options: SessionOutputOptions = {}): void {
  server.middlewares.use(async (request, response, next) => {
    const handled = await handleVernierSessionRequest(server.config.root, request, response, options);

    if (!handled) {
      next();
    }
  });
}
