# Lab app — agent notes

A `*.melltron.build` lab app built from melltron-lab-template. See README.md for the full lifecycle.

## Invariants
- **Isolation.** Own repo, own Worker, own bindings. Never call into or share storage with another lab app or the root site.
- **Edge contract.** All responses go through `finalize()` in `src/edge.js`. Don't bypass it, and don't change the security headers here without changing `melltron.build/src/headers.js` to match.
- **Strict CSP.** No inline scripts/styles, no third-party origins, unless the CSP is edited on purpose and the reason is in the commit message.
- **No secrets in git.** `.dev.vars` locally, `wrangler secret put` in production.
- **Personal, not company.** No company code, data, names, or credentials.
- If `.template` exists, this is the template itself: keep the placeholders `template-app` / `Template App` intact.

## Commands
`npm run dev` · `npm test` · `npm run check` (run before every push; CI runs the same)

## Done means
`npm run check` passes, new routes have a test in `test/`, and `README.md` is updated if behaviour or setup changed.
