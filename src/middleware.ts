import type { ViteDevServer } from "vite";
import { handleVernierSessionRequest } from "./core/session-handler";

export function registerSessionMiddleware(server: ViteDevServer): void {
  server.middlewares.use(async (request, response, next) => {
    const handled = await handleVernierSessionRequest(server.config.root, request, response);

    if (!handled) {
      next();
    }
  });
}

