// Request flow:  /_health -> version info
//                /api/*   -> src/api.js routes
//                else     -> static assets in public/
// Every response passes through finalize() for headers + cache policy.

import { finalize } from "./edge.js";
import { json, routes } from "./api.js";

const APP = "ai";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let res;
    let isAsset = false;
    try {
      if (url.pathname === "/_health") {
        const v = env.CF_VERSION_METADATA || {};
        res = json({ app: APP, version: v.id ?? "dev", tag: v.tag ?? null, deployed: v.timestamp ?? null });
      } else if (url.pathname.startsWith("/api/")) {
        const handler = routes[`${request.method} ${url.pathname}`];
        res = handler ? await handler(request, env, ctx, url) : json({ error: "not_found" }, { status: 404 });
      } else {
        res = await env.ASSETS.fetch(request);
        isAsset = true;
      }
    } catch (err) {
      console.error(JSON.stringify({ app: APP, path: url.pathname, error: String(err?.stack || err) }));
      res = json({ error: "internal" }, { status: 500 });
      isAsset = false;
    }
    return finalize(res, url.pathname, isAsset);
  },
};
