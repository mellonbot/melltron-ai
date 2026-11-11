// External script only — the CSP forbids inline JS.
fetch("/api/ping")
  .then((r) => r.json())
  .then((d) => (document.getElementById("ping").textContent = JSON.stringify(d)))
  .catch((e) => (document.getElementById("ping").textContent = `error: ${e}`));
