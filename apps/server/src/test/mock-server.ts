import { serve } from "@hono/node-server";
import { mockUpstream } from "./mock-upstream.js";

/** Serves the mock providers on a local port, for demos and smoke tests. */
const port = Number(process.env.MOCK_PORT ?? 4999);
serve({ fetch: mockUpstream().app.fetch, hostname: "127.0.0.1", port }, () => {
  process.stdout.write(`Mock providers on http://127.0.0.1:${port}\n`);
});
