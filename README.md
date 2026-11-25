# AI — ai.melltron.build

LAB-003. Chat with the two Ollama models on the office desktop's RTX 4060: `huihui_ai/qwen3.5-abliterated:9b` (Qwen 3.5 9B) and `deepseek-9b-uncensored` (DeepSeek 9B). Context is 4608, set on the desktop. LocalAI and the Pi backend are off. Built from [melltron-lab-template](https://github.com/mellonbot/melltron-lab-template); see that README for the general lab lifecycle.

## How it fits together

```
browser ──▶ ai.melltron.build ──▶ Worker melltron-ai ──▶ localai-tunnel.melltron.build ──▶ cloudflared (desktop) ──▶ Ollama 127.0.0.1:11434
            [public, no login]      [per-IP rate limit]                                    [Access: service token only]
```

- **One backend on.** Each is off when its URL var (`OLLAMA_URL`, `LOCALAI_URL`, `PI_URL`) is empty; an off backend is left out of `/api/models`. Desktop Ollama models keep their names. `OLLAMA_MODELS` is the allowlist, so only the two RTX models are offered. LocalAI models would be `rtx/<id>` and Pi models `pi/<name>` if those URLs were set again.

- **Public, with a prompt quota.** With `PUBLIC="true"` (the default in `wrangler.jsonc`) anyone can open the app, with no login (`src/quota.js`):
  - **Tailnet devices are unlimited.** Opening the pass page (`http://<pass host's Tailscale IP>:8787/`, see *Tailnet pass* below) on a tailnet device redirects back here with a signed 30-day pass that the browser keeps.
  - **Everyone else gets `FREE_PROMPTS` (10) chats**, counted per browser (a random id kept in `localStorage`) and per IP, so clearing the browser doesn't reset them. Only chats the model started answering count.
  - **Then they ask the owner.** The page shows a name + note form; requests land on **`/admin`** (owner-only Access app), where the owner can approve (unlimited), deny, or reset (back to 10 free).
  - **The owner gets an email** for each new request (`src/alert.js`): `ALERT_EMAIL` send_email binding, from `ALERT_FROM` (`ai@melltron.build`, an Email Sending domain) to the `ALERT_TO` secret (a verified destination address on the account). At most `ALERT_MAX_PER_HOUR` (10) alerts an hour; editing a pending request doesn't re-send. Without the binding or secret, requests still work, just silently.
  - Counts and requests live in D1 (`DB`, database `melltron-ai`); tables are created on first use. Public mode fails closed (503) without `DB` or the rate-limit bindings.
  - `CHAT_LIMIT` / `MODELS_LIMIT` (10 and 30 a minute per IP) are an extra brake. Cloudflare's rate limiter is approximate and didn't block a test burst in practice; the quota is what holds.
- **The tunnels stay private.** `localai-tunnel` and `ollama-tunnel.melltron.build` admit only the service token stored as Worker secrets, so no browser can reach LocalAI or the Pi's Ollama directly, and pull/delete stay unreachable.
- **Private mode.** Set `PUBLIC` to `""`, put an Access app in front of `ai.melltron.build`, and the Worker re-verifies the Access JWT on every `/api/*` call (`src/access.js`). That check matters because Workers preview URLs bypass the custom-domain Access app. It fails closed (503) until `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set.
- **LocalAI speaks the OpenAI API; the browser never sees it.** The Worker calls only `GET /v1/models` and `POST /v1/chat/completions` (`stream: true`) and translates the SSE stream to Ollama's NDJSON (`sseToNdjson` in `src/api.js`): `delta.content` → `message.content`, `delta.reasoning_content`/`reasoning` → `message.thinking`, `[DONE]` → `{done: true}`. `LOCALAI_MODELS` (comma-separated ids) limits what's offered, since `/v1/models` also lists embedding/TTS/image models; chats to other ids are refused (400) before reaching the desktop. Optional `LOCALAI_API_KEY` secret is sent as `Authorization: Bearer` (matches LocalAI's `API_KEY`), a second lock behind the tunnel's service token.
- **Narrow proxy.** Only `GET /api/tags`, `POST /api/show` and `POST /api/chat` (Ollama) or the two `/v1` routes above (LocalAI) are called upstream. Requests are rebuilt from validated fields (`model`, `messages[].role/content`, `think`), so pull/delete/create and request options like `keep_alive` can't be reached.
- **English by default.** Chats without a system message get one asking for English (deepseek-r1 otherwise answers short prompts in Chinese). Override with the `SYSTEM_PROMPT` var.
- **Conversations live in the browser** (`localStorage`); nothing is stored server-side.

## API

| Route | Auth | Purpose |
|---|---|---|
| `GET /_health`, `GET /api/ping` | public | version / liveness |
| `GET /api/me` | gate | `{email, public}` (email is null when public) |
| `GET /api/models` | gate + 30/min | `{models: [{name, backend, parameters, thinking, …}], backends: {desktop?, localai?, pi?}}` (configured backends only) |
| `GET /api/quota` | gate | `{tier, used, limit, remaining, requested, device, passInvalid}`; tier is `tailnet`, `approved`, `free`, `exhausted`, `pending`, `denied` or `private` |
| `POST /api/access-request` | gate | `{name, note?}` → asks the owner for more prompts |
| `GET /api/admin/visitors` | admin Access | visitors, pending first |
| `POST /api/admin/visitors` | admin Access | `{id, action: approve\|deny\|reset}` |
| `POST /api/chat` | gate + quota + 10/min | `{model, messages, think?}` → Ollama NDJSON stream (LocalAI translated) |
| `POST /api/repo-qa` | separate trusted-user Access + 10/min | `{repository, question}` → `{answer, sources, coverage}`; read-only repository Q&A |

Errors are JSON `{error, backend?}`: `offline` (that machine or its server is down), `tunnel_auth` (service token refused), `not_configured`, `access_not_configured`, `unauthenticated`, `quota_exhausted` / `denied` (403, with `quota`), `visitor_required`, `quota_not_configured`, `rate_limited` (429), `rate_limit_not_configured`, `upstream` (+`detail`). "gate" is nothing when public, the Access JWT otherwise. Public calls send `x-ai-visitor` (and `x-ai-pass` on tailnet browsers).

## Configuration

`wrangler.jsonc` → `vars`: `PUBLIC` (`"true"` = no login), `FREE_PROMPTS`, `ADMIN_ACCESS_AUD` (AUD of the owner-only Access app on `ai.melltron.build/admin` + `/api/admin`), `OLLAMA_URL`, `OLLAMA_MODELS`, `LOCALAI_URL`, `LOCALAI_MODELS`, `PI_URL` (empty URL disables that backend), `ACCESS_TEAM_DOMAIN` (e.g. `mellon.cloudflareaccess.com`), `ACCESS_AUD` (the `ai.melltron.build` Access application's AUD tag).

Secrets: `wrangler secret put OLLAMA_CLIENT_ID` and `OLLAMA_CLIENT_SECRET` (the Access service token, admitted by every tunnel), `LOCALAI_API_KEY` (optional, LocalAI's `API_KEY`), `PASS_SECRET` (signs tailnet passes; without it nobody gets a pass and everyone is on the free tier), and `ALERT_TO` (where access-request emails go).

### Protected repository Q&A

This separate API remains closed even when public chat is enabled. Set `ACCESS_TEAM_DOMAIN` to the Access team and configure either or both exact trusted-user audiences: `REPO_QA_ACCESS_AUD` for the direct Q&A Access application and `MELLONPANEL_ACCESS_AUD` for the separate Mellonpanel Access application. They must be distinct from the existing public-chat and admin audiences; a conflict fails closed. Neither audience is preconfigured here. The Worker verifies each signed assertion's signature, issuer, expiration and exact audience itself, including on preview URLs, and requires a human login (nonempty `email` and `sub`, no service-token `common_name`). It also requires `CHAT_LIMIT`, keyed per verified email because all Mellonpanel calls share the panel host's IP. Visitor approvals and caller-supplied system messages do not authorize repository access. Restrict both Access applications to trusted human users; do not allow service tokens or untrusted users.

Set `REPO_QA_GITHUB_TOKEN` as a Worker secret using a fine-grained GitHub token with **Contents: read-only**, restricted to `mellonbot/mellonbot-status` and `mellonbot/melltron-ai`; give it no write permissions. Set `REPO_QA_MODEL` to one of the desktop models in the nonempty `OLLAMA_MODELS` allowlist. No configuration or secrets are provisioned by this change. Without these settings the API fails closed.

Send a same-origin `POST /api/repo-qa` with JSON such as `{"repository":"mellonbot/melltron-ai","question":"How is access verified?"}`. Only the two named repositories are accepted. GitHub code search searches up to three question keywords on the default branch; it reads at most eight matching text files and sends at most six short excerpts to the configured desktop Ollama tunnel. Questions must be at most 1,000 characters, and model output is bounded. GitHub indexing, search-result and excerpt limits mean this is **not exhaustive**; an empty result does not prove a fact is absent. `sources` includes paths, blob hashes, line numbers, excerpts and links; links follow the default branch and may change after the request. Answers and citation relevance are model-generated, so verify them against the sources. The API asks the model to distinguish evidence from inference and rejects missing or unknown source labels, but cannot guarantee factual accuracy.

GitHub receives the question's search keywords; selected excerpts and the question go to local Ollama through the existing Cloudflare tunnel. No repository content is stored by this feature. Public chat still accepts caller-supplied system messages as conversation input, not authorization policy.

Mellonpanel is not wired by this change. Its HTTPS entry point must be protected by the configured Mellonpanel Access application, and its server-side proxy must forward the caller's `CF-Access-Jwt-Assertion` to the gateway unchanged, not use a shared service identity or trust a client-supplied identity. The proxy must not forward the browser's cross-origin `Origin` header; browser cross-origin calls remain rejected and no CORS access is granted. Route the gateway request so that the Worker receives the original assertion: any gateway-side Access application in front of this path must not reject or replace the Mellonpanel assertion before Worker verification. The hostname, routing, and Access policies must be explicitly configured and tested in production; this change does not provision them.

### Tailnet pass

`tools/tailnet-pass.py` (standard-library Python, needs the `tailscale` CLI) runs on any always-on machine in the tailnet and listens only on that machine's Tailscale address (port 8787), so only tailnet devices can reach it. It checks the caller with `tailscale whois`, then redirects to `https://ai.melltron.build/#pass=<token>`. Set `PASS_USERS=login1,login2` to limit passes to some tailnet users (by default anyone on the tailnet gets one, including users who shared a device in).

```sh
install -Dm755 tools/tailnet-pass.py ~/.local/bin/tailnet-pass
umask 077; mkdir -p ~/.config/ai-pass
python3 -c 'import secrets; print(secrets.token_urlsafe(48))' > ~/.config/ai-pass/secret
tr -d '\n' < ~/.config/ai-pass/secret | npx wrangler secret put PASS_SECRET --name melltron-ai
cp tools/tailnet-pass.service ~/.config/systemd/user/
systemctl --user enable --now tailnet-pass
```

### Desktop tunnel (cloudflared)

`localai-tunnel.melltron.build` is the office tunnel (`mellonlab-office`). Its origin is Ollama at `http://localhost:11434` with HTTP Host Header `localhost:11434` (Ollama rejects any other Host). `OLLAMA_URL` points here. `OLLAMA_MODELS` must stay in step with the two model names from `ollama list`. Do not point `OLLAMA_URL` at `ollama-tunnel.melltron.build`: that name fronts the Pi.

Both tunnels are remotely managed (ingress lives in the dashboard / API, not a local config.yml). On the desktop, cloudflared runs as a user process (`~/.local/bin/cloudflared tunnel run --token-file ~/.config/cloudflared/tunnel-token`), not the `cloudflared` system service. Ollama is the user unit `ollama.service`, context 4608.

#### LocalAI on the RTX 4060

Not used by the site. The container can still be running on `127.0.0.1:8090`. The tunnel no longer reaches it.

LocalAI runs in Docker on the desktop, bound to loopback; the tunnel is the only way in. Needs the NVIDIA Container Toolkit (`nvidia-ctk runtime configure --runtime=docker`).

```
docker run -d --name localai --restart unless-stopped --gpus all -p 127.0.0.1:8090:8080 \
  -v ~/localai/models:/models -v localai-backends:/backends -e MODELS_PATH=/models \
  -e LOCALAI_SINGLE_ACTIVE_BACKEND=true -e API_KEY="$(cat ~/localai/api_key)" \
  localai/localai:latest-gpu-nvidia-cuda-12
```

1. v4 images ship without inference backends: install `llama-cpp` once (`POST /backends/apply`, resolves to `cuda12-llama-cpp`). Keep `/backends` on a named volume or it's lost when the container is recreated.
2. The old chat models were `llama-3.1-8b-instruct` and `deepseek-r1-distill-qwen-7b`. The site no longer offers them.
3. `~/localai/api_key` (mode 600) is LocalAI's `API_KEY`; the same value is the Worker secret `LOCALAI_API_KEY`. Without the header LocalAI answers 401.
3. The office tunnel hostname `localai-tunnel.melltron.build` goes to `HTTP` `localhost:11434`, Host header `localhost:11434`.
4. Add an Access application for `localai-tunnel.melltron.build` with the single **Service Auth** policy (same service token as the other tunnels).
5. Keep `LOCALAI_MODELS` in `wrangler.jsonc` in step with the chat model ids in `/v1/models`.

### Pi tunnel (cloudflared, Ollama on CPU)

Off (`PI_URL` empty). cloudflared still runs on the Pi as a system service, and Ollama still listens on `127.0.0.1:11434`. Setting `PI_URL` to `https://ollama-tunnel.melltron.build` lists those models as `pi/<name>` (the Worker strips the prefix before forwarding). It calls `/api/tags`, `/api/show`, and `/api/chat`. There is no Pi model allowlist: `/api/tags` is what gets offered, up to 25 names. A quant tag such as `llama3.2:1b-instruct-q4_K_M` is a valid id.

- `ollama-tunnel.melltron.build` → `HTTP` `localhost:11434`
- **HTTP Host Header: `localhost:11434`.** Ollama rejects non-local Host headers (empty 403). The origin is `localhost` because cloudflared runs on the Pi.

An Access application for `ollama-tunnel.melltron.build` uses the same single **Service Auth** policy as the other tunnels. Ollama loads one model at a time, so the first message after a switch waits while it loads. Reasoning from a `deepseek` / `r1` model on the Pi still arrives inline, ending in `</think>` (the opening tag is part of the prompt); the UI splits it into the Reasoning panel. `/api/show` capabilities turn the reasoning checkbox on when the model supports `think`.

## Public page

The chat page links back to [the lab index](https://melltron.build/lab/). `/favicon.ico` is the still frame of `public/favicon.svg` (browsers request the `.ico` even when the SVG icon is linked). `public/robots.txt` allows the public site, skips `/admin`, and points at `sitemap.xml`.

`https://ai.melltron.build/robots.txt` currently returns Cloudflare's free-plan Content Signals comment block, because the origin had no `robots.txt` and the Worker's HTML 404 is rewritten at the edge. That body is not in this repo, and it is not the managed-crawler file (no `User-agent` or bot `Disallow` rules). `https://melltron.build/robots.txt` on the same zone is served unchanged, so Bot Preference Sync is not prepending today. Shipping `public/robots.txt` is the origin fix. If Bot Preference Sync is later turned on in the dashboard with a Block or Disallow policy, Cloudflare can prepend managed lines; that setting is not in this repo.

## Develop

`npm run dev` · `npm test` · `npm run check` (CI runs the same). Tests fake Ollama and the Access certs endpoint and sign real RS256 tokens. Node ≥ 22.

After every push to `main`, `.github/workflows/verify.yml` waits until https://ai.melltron.build serves the committed `public/` files, then checks security headers against `src/edge.js`, the 404 page, `/_health`, http → https, TLS runway, and that the production workers.dev URL stays off. It loads the public pages in headless Chromium. `/admin` is behind Cloudflare Access, so a login redirect there counts as success. `/_health` reports `app`, `version`, and `deployed`; it does not include the git commit. PRs still stop at `npm run check`.
