# AI — ai.melltron.build

LAB-003. Chat with the lab's own Ollama models (llama3.1:8b, deepseek-r1:8b, …) running on the office desktop's RTX 4060, from any browser. Built from [melltron-lab-template](https://github.com/mellonbot/melltron-lab-template); see that README for the general lab lifecycle.

## How it fits together

```
browser ──▶ ai.melltron.build ──▶ Worker melltron-ai ──▶ ollama-tunnel.melltron.build ──▶ cloudflared (desktop) ──▶ Ollama 127.0.0.1:11434
            [Access: owner login]   [verifies Access JWT]  [Access: service token only]
```

- **Two Access gates.** `ai.melltron.build` requires the owner's login. `ollama-tunnel.melltron.build` admits only the service token stored as Worker secrets, so no browser can reach Ollama directly.
- **The Worker re-verifies the Access JWT** on every `/api/*` call (`src/access.js`). Workers preview URLs bypass the custom-domain Access app, so without this check a preview build would be an open proxy to the GPU. It fails closed (503) until `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set.
- **Narrow proxy.** Only `GET /api/tags`, `POST /api/show` and `POST /api/chat` are called upstream. Requests are rebuilt from validated fields (`model`, `messages[].role/content`, `think`), so pull/delete/create and request options like `keep_alive` can't be reached.
- **Conversations live in the browser** (`localStorage`); nothing is stored server-side.

## API

| Route | Auth | Purpose |
|---|---|---|
| `GET /_health`, `GET /api/ping` | public | version / liveness |
| `GET /api/me` | Access | signed-in email |
| `GET /api/models` | Access | installed models, with `thinking` capability |
| `POST /api/chat` | Access | `{model, messages, think?}` → Ollama NDJSON stream |

Errors are JSON `{error}`: `offline` (desktop/Ollama down), `tunnel_auth` (service token refused), `not_configured`, `access_not_configured`, `unauthenticated`, `upstream` (+`detail`).

## Configuration

`wrangler.jsonc` → `vars`: `OLLAMA_URL`, `ACCESS_TEAM_DOMAIN` (e.g. `mellon.cloudflareaccess.com`), `ACCESS_AUD` (the `ai.melltron.build` Access application's AUD tag).

Secrets: `wrangler secret put OLLAMA_CLIENT_ID` and `OLLAMA_CLIENT_SECRET` (the Access service token).

### Desktop tunnel (cloudflared)

Cloudflare Zero Trust → Networks → Tunnels → create `mellonlab-office`, install the connector on the desktop as a service, and add the public hostname:

- `ollama-tunnel.melltron.build` → `HTTP` `localhost:11434`
- **HTTP Host Header: `localhost:11434`.** Ollama rejects non-local Host headers (empty 403).

Then add an Access application for `ollama-tunnel.melltron.build` with a single **Service Auth** policy that allows only the service token above.

## Develop

`npm run dev` · `npm test` · `npm run check` (CI runs the same). Tests fake Ollama and the Access certs endpoint and sign real RS256 tokens. Node ≥ 22.
