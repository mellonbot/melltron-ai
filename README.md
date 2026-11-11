# AI — ai.melltron.build

LAB-003. Chat with the lab's own models from any browser: Ollama models (llama3.1:8b, deepseek-r1:8b, …) on the office desktop's RTX 4060, and small LLMs (qwen2.5, llama3.2:3b, …) on a Raspberry Pi 5's Hailo-10H AI HAT via hailo-ollama. Built from [melltron-lab-template](https://github.com/mellonbot/melltron-lab-template); see that README for the general lab lifecycle.

## How it fits together

```
browser ──▶ ai.melltron.build ──▶ Worker melltron-ai ─┬▶ ollama-tunnel.melltron.build ──▶ cloudflared (desktop) ──▶ Ollama 127.0.0.1:11434
            [public, no login]      [per-IP rate limit]   └▶ hailo-tunnel.melltron.build  ──▶ cloudflared (Pi)      ──▶ hailo-ollama 127.0.0.1:8000
                                                             [Access: service token only, both]
```

- **Two backends, one picker.** Desktop models keep their Ollama names; Pi models are listed as `hailo/<name>` and the Worker strips the prefix before forwarding. `/api/models` lists every configured backend and still answers when one is offline (`backends` says which). The Pi backend is off when `HAILO_URL` is empty.

- **Public, with a prompt quota.** With `PUBLIC="true"` (the default in `wrangler.jsonc`) anyone can open the app, with no login (`src/quota.js`):
  - **Tailnet devices are unlimited.** Opening the pass page (`http://<pass host's Tailscale IP>:8787/`, see *Tailnet pass* below) on a tailnet device redirects back here with a signed 30-day pass that the browser keeps.
  - **Everyone else gets `FREE_PROMPTS` (10) chats**, counted per browser (a random id kept in `localStorage`) and per IP, so clearing the browser doesn't reset them. Only chats the model started answering count.
  - **Then they ask the owner.** The page shows a name + note form; requests land on **`/admin`** (owner-only Access app), where the owner can approve (unlimited), deny, or reset (back to 10 free).
  - **The owner gets an email** for each new request (`src/alert.js`): `ALERT_EMAIL` send_email binding, from `ALERT_FROM` (`ai@melltron.build`, an Email Sending domain) to the `ALERT_TO` secret (a verified destination address on the account). At most `ALERT_MAX_PER_HOUR` (10) alerts an hour; editing a pending request doesn't re-send. Without the binding or secret, requests still work, just silently.
  - Counts and requests live in D1 (`DB`, database `melltron-ai`); tables are created on first use. Public mode fails closed (503) without `DB` or the rate-limit bindings.
  - `CHAT_LIMIT` / `MODELS_LIMIT` (10 and 30 a minute per IP) are an extra brake. Cloudflare's rate limiter is approximate and didn't block a test burst in practice; the quota is what holds.
- **The tunnels stay private.** `ollama-tunnel.melltron.build` and `hailo-tunnel.melltron.build` admit only the service token stored as Worker secrets, so no browser can reach Ollama or hailo-ollama directly, and pull/delete stay unreachable.
- **Private mode.** Set `PUBLIC` to `""`, put an Access app in front of `ai.melltron.build`, and the Worker re-verifies the Access JWT on every `/api/*` call (`src/access.js`). That check matters because Workers preview URLs bypass the custom-domain Access app. It fails closed (503) until `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set.
- **Narrow proxy.** Only `GET /api/tags`, `POST /api/show` and `POST /api/chat` are called upstream. Requests are rebuilt from validated fields (`model`, `messages[].role/content`, `think`), so pull/delete/create and request options like `keep_alive` can't be reached.
- **English by default.** Chats without a system message get one asking for English (deepseek-r1 otherwise answers short prompts in Chinese). Override with the `SYSTEM_PROMPT` var.
- **Conversations live in the browser** (`localStorage`); nothing is stored server-side.

## API

| Route | Auth | Purpose |
|---|---|---|
| `GET /_health`, `GET /api/ping` | public | version / liveness |
| `GET /api/me` | gate | `{email, public}` (email is null when public) |
| `GET /api/models` | gate + 30/min | `{models: [{name, backend, parameters, thinking, …}], backends: {desktop, hailo}}` |
| `GET /api/quota` | gate | `{tier, used, limit, remaining, requested, device, passInvalid}`; tier is `tailnet`, `approved`, `free`, `exhausted`, `pending`, `denied` or `private` |
| `POST /api/access-request` | gate | `{name, note?}` → asks the owner for more prompts |
| `GET /api/admin/visitors` | admin Access | visitors, pending first |
| `POST /api/admin/visitors` | admin Access | `{id, action: approve\|deny\|reset}` |
| `POST /api/chat` | gate + quota + 10/min | `{model, messages, think?}` → Ollama NDJSON stream |

Errors are JSON `{error, backend?}`: `offline` (that machine or its server is down), `tunnel_auth` (service token refused), `not_configured`, `access_not_configured`, `unauthenticated`, `quota_exhausted` / `denied` (403, with `quota`), `visitor_required`, `quota_not_configured`, `rate_limited` (429), `rate_limit_not_configured`, `upstream` (+`detail`). "gate" is nothing when public, the Access JWT otherwise. Public calls send `x-ai-visitor` (and `x-ai-pass` on tailnet browsers).

## Configuration

`wrangler.jsonc` → `vars`: `PUBLIC` (`"true"` = no login), `FREE_PROMPTS`, `ADMIN_ACCESS_AUD` (AUD of the owner-only Access app on `ai.melltron.build/admin` + `/api/admin`), `OLLAMA_URL`, `HAILO_URL` (empty disables the Pi), `ACCESS_TEAM_DOMAIN` (e.g. `mellon.cloudflareaccess.com`), `ACCESS_AUD` (the `ai.melltron.build` Access application's AUD tag).

Secrets: `wrangler secret put OLLAMA_CLIENT_ID` and `OLLAMA_CLIENT_SECRET` (the Access service token, admitted by both tunnels), `PASS_SECRET` (signs tailnet passes; without it nobody gets a pass and everyone is on the free tier), and `ALERT_TO` (where access-request emails go).

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
