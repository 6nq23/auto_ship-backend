import type { IncomingMessage, ServerResponse } from "node:http";
import { waitUntil } from "@vercel/functions";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

let appPromise: ReturnType<typeof createApp> | undefined;

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  if (!appPromise) {
    appPromise = createApp(loadConfig(), undefined, (task) => waitUntil(task)).catch((error) => {
      appPromise = undefined;
      throw error;
    });
  }

  const app = await appPromise;
  return app(request, response);
}
