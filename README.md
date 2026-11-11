# melltron lab app template

Starting point for every `<name>.melltron.build` app. One repo, one Worker, one subdomain per app, so a broken experiment can't take down the root or another app.

## Lifecycle

```
 Use this template ─▶ init ─▶ build ─▶ connect to Cloudflare ─▶ register in root ─▶ … ─▶ retire
   (new repo)       (once)   (PRs)     (Workers Builds)        (content/lab.json)
```

### 1. Create
GitHub → this repo → **Use this template** → new repo under `mellonbot` (personal account, never a company org). Name it after the subdomain, e.g. `part-tracker`.

### 2. Initialise
```
git clone … && cd part-tracker
node tools/init.mjs part-tracker "Part Tracker"
npm ci && npm run check
git commit -am "init part-tracker" && git push
```
`init` rewrites the `template-app` / `Template App` placeholders, deletes `.template`, and prints the `lab.json` entry It also sets the favicon's pulse colour (see Favicon). It rejects bad or reserved subdomains (`www`, `api`, `lab`, …) and refuses to run twice. CI fails if an initialised repo still contains placeholders.

### 3. Deploy
Cloudflare dashboard → Workers & Pages → Create → **Import a repository** → pick the repo. Defaults are correct: no build command, deploy `npx wrangler deploy`. Production branch `main`; other branches get preview URLs. The custom domain in `wrangler.jsonc` is created on first deploy.

### 4. Register
In `melltron.build`, append to `content/lab.json` (append only; IDs are array position), then rebuild:
```json
{ "name": "Part Tracker", "subdomain": "part-tracker", "status": "building", "summary": "One line." }
```
Set `"status": "live"` when it's usable. Only `live` entries link out.

### 5. Retire
Set `"status": "retired"` in `lab.json` (never delete; that renumbers every later ID). Then either delete the Worker (its subdomain stops resolving) or replace `public/` with a tombstone page. Archive the repo.

## Layout

```
src/index.js        request flow: /_health → /api/* → static assets
src/api.js          app routes: "METHOD /path" → handler
src/edge.js         shared edge contract: security headers + cache policy
public/             static assets (no build step; served as-is)
test/               node --test, no Workers runtime needed
tools/init.mjs      one-time setup
tools/pulse.mjs     favicon pulse colour: derived from the subdomain
wrangler.jsonc      Worker config, custom domain, bindings
```

## Edge contract

Every response passes through `finalize()` in `src/edge.js`:

| Response | Cache-Control |
| --- | --- |
| Static HTML | `max-age=300, must-revalidate` |
| Static file named `*.<hash>.<ext>` (8+ hex chars) | `max-age=31536000, immutable` |
| Other static files | asset server default (revalidate) |
| `/api/*`, `/_health` | `no-store` (set by `json()`) |

The security headers match `melltron.build/src/worker.js` exactly, so the whole domain has one posture. The CSP is same-origin only, with no inline `<script>`/`<style>`. Adding a third-party origin (analytics, fonts, an external API from the browser) means editing the CSP on purpose.

The copy is the weak point: two repos holding the same headers will drift. When there are three or more apps, move `edge.js` into a shared package, or have the root's CI diff it.

`/_health` returns `{ app, version, deployed }` from the Worker version metadata. Use it for uptime checks and to confirm which build is live.

## Favicon

Every lab app uses the root site's circuit-board M (`public/favicon.svg`, an SVG animated with SMIL only, so it passes the CSP). The only thing that changes per app is the colour of the current pulse, so all lab tabs read as one family but are each distinct:

- `init` derives the colour from the subdomain: same name, same colour, and nothing to track. Hues are restricted so the pulse never lands on the root's cyan, never on greens (they disappear against the traces), and never on the gold of the pads. Pick a colour yourself with `--pulse '#rrggbb'`.
- CI fails if an initialised app still uses the root's pulse colour.
- `apple-touch-icon` points at the root's PNG, since there is no build step here to rasterise one.
- The geometry is a copy of `melltron.build/static/favicon.svg`. If the root icon is redrawn, copy it here, keeping the root colours (`#8ff9ff` / `#c8ffff`), because they are what `init` replaces.

## Extending

**Routes:** add to `routes` in `src/api.js`: `"POST /api/parts": async (req, env) => json(...)`.

**Storage / bindings:** declare in `wrangler.jsonc` (`d1_databases`, `kv_namespaces`, `r2_buckets`), access via `env.<BINDING>`. Bindings are per-app; never share a database between lab apps, because shared state removes the isolation.

**Secrets:** local in `.dev.vars` (gitignored); production via `npx wrangler secret put NAME`. Never in `wrangler.jsonc` `vars`, which is committed.

**Hashed assets:** for long-cached CSS/JS, name files `app.<hash>.css` (e.g. first 10 hex of SHA-256) and update the reference. Unhashed names stay safe by default.

## Commands
```
npm run dev      # wrangler dev at :8787, real Workers runtime
npm test         # unit tests on Node 22
npm run check    # placeholders gone + tests + wrangler config/bundle dry-run (what CI runs)
```

## License
Code MIT, content all rights reserved. See [LICENSE](LICENSE).
