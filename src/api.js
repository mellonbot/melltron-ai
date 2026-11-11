// App logic lives here. Each handler: (request, env, ctx, url) -> Response.
// Return JSON via json(); errors are caught and logged by src/index.js.

export const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...init.headers },
  });

export const routes = {
  "GET /api/ping": () => json({ ok: true, at: new Date().toISOString() }),
};
