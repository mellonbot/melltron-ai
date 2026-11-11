# AI — ai.melltron.build

LAB-003. Chat with the lab's own models from any browser: Ollama models (llama3.1:8b, deepseek-r1:8b, …) on the office desktop's RTX 4060, and small LLMs (qwen2.5, llama3.2:3b, …) on a Raspberry Pi 5's Hailo-10H AI HAT via hailo-ollama. Built from [melltron-lab-template](https://github.com/mellonbot/melltron-lab-template); see that README for the general lab lifecycle.

## How it fits together

```
browser ──▶ ai.melltron.build ──▶ Worker melltron-ai ─┬▶ ollama-tunnel.melltron.build ──▶ cloudflared (desktop) ──▶ Ollama 127.0.0.1:11434
            [Access: owner login]   [verifies Access JWT] └▶ hailo-tunnel.melltron.build  ──▶ cloudflared (Pi)      ──▶ hailo-ollama 127.0.0.1:8000
                                                             [Access: service token only, both]
```

- **Two backends, one picker.** Desktop models keep their Ollama names; Pi models are listed as `hailo/<name>` and the Worker strips the prefix before forwarding. `/api/models` lists every configured backend and still answers when one is offline (`backends` says which). The Pi backend is off when `HAILO_URL` is empty.

- **Two Access gates.** `ai.melltron.build` requires the owner's login. `ollama-tunnel.melltron.build` and `hailo-tunnel.melltron.build` admit only the service token stored as Worker secrets, so no browser can reach Ollama directly.
- **The Worker re-verifies the Access JWT** on every `/api/*` call (`src/access.js`). Workers preview URLs bypass the custom-domain Access app, so without this check a preview build would be an open proxy to the GPU. It fails closed (503) until `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set.
- **Narrow proxy.** Only `GET /api/tags`, `POST /api/show` and `POST /api/chat` are called upstream. Requests are rebuilt from validated fields (`model`, `messages[].role/content`, `think`), so pull/delete/create and request options like `keep_alive` can't be reached.
- **English by default.** Chats without a system message get one asking for English (deepseek-r1 otherwise answers short prompts in Chinese). Override with the `SYSTEM_PROMPT` var.
- **Conversations live in the browser** (`localStorage`); nothing is stored server-side.

## API

| Route | Auth | Purpose |
|---|---|---|
| `GET /_health`, `GET /api/ping` | public | version / liveness |
| `GET /api/me` | Access | signed-in email |
| `GET /api/models` | Access | `{models: [{name, backend, parameters, thinking, …}], backends: {desktop, hailo}}` |
| `POST /api/chat` | Access | `{model, messages, think?}` → Ollama NDJSON stream |

Errors are JSON `{error, backend?}`: `offline` (that machine or its server is down), `tunnel_auth` (service token refused), `not_configured`, `access_not_configured`, `unauthenticated`, `upstream` (+`detail`).

## Configuration

`wrangler.jsonc` → `vars`: `OLLAMA_URL`, `HAILO_URL` (empty disables the Pi), `ACCESS_TEAM_DOMAIN` (e.g. `mellon.cloudflareaccess.com`), `ACCESS_AUD` (the `ai.melltron.build` Access application's AUD tag).

Secrets: `wrangler secret put OLLAMA_CLIENT_ID` and `OLLAMA_CLIENT_SECRET` (the Access service token, admitted by both tunnels).

### Desktop tunnel (cloudflared)

Cloudflare Zero Trust → Networks → Tunnels → create `mellonlab-office`, install the connector on the desktop as a service, and add the public hostname:

- `ollama-tunnel.melltron.build` → `HTTP` `localhost:11434`
- **HTTP Host Header: `localhost:11434`.** Ollama rejects non-local Host headers (empty 403).

Then add an Access application for `ollama-tunnel.melltron.build` with a single **Service Auth** policy that allows only the service token above.

### Pi tunnel (cloudflared, Hailo-10H)

Tunnel `hailo-pi`, connector installed on the Pi as a system service, public hostname:

- `hailo-tunnel.melltron.build` → `HTTP` `localhost:8000` (hailo-ollama, built from [hailo_model_zoo_genai](https://github.com/hailo-ai/hailo_model_zoo_genai))

plus an Access application for `hailo-tunnel.melltron.build` with the same single **Service Auth** policy. hailo-ollama runs one model at a time on the HAT, so the first message after switching models takes ~30 s while it loads. Reasoning from `deepseek_r1_distill_qwen` arrives inline, ending in `</think>` (the opening tag is part of the prompt); the UI splits it into the Reasoning panel.

## Develop

`npm run dev` · `npm test` · `npm run check` (CI runs the same). Tests fake Ollama and the Access certs endpoint and sign real RS256 tokens. Node ≥ 22.
