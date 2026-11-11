// AI admin: approve, deny or reset visitors. Behind the owner-only Access app on
// /admin and /api/admin. Visitor names and notes are untrusted: textContent only.

const $ = (id) => document.getElementById(id);
const ago = (iso) => {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

let freePrompts = 10;

async function act(id, action, btns) {
  btns.forEach((b) => (b.disabled = true));
  try {
    const res = await fetch("/api/admin/visitors", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, action }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    await load();
  } catch (err) {
    showError(`Couldn't ${action}: ${err.message}`);
    btns.forEach((b) => (b.disabled = false));
  }
}

function buttons(v) {
  const box = el("div", "actions");
  const list = [];
  const add = (label, action, primary) => {
    const b = el("button", primary ? "btn primary" : "btn", label);
    b.type = "button";
    b.addEventListener("click", () => act(v.id, action, list));
    list.push(b); box.append(b);
  };
  if (v.status !== "approved") add("Approve", "approve", v.status === "pending");
  if (v.status !== "denied") add("Deny", "deny");
  if (v.prompts > 0 || v.status !== "free") add("Reset", "reset");
  return box;
}

function card(v) {
  const c = el("div", "card");
  c.append(el("div", "name", v.name || "(no name)"));
  if (v.note) c.append(el("div", "note", v.note));
  c.append(el("div", "meta", `asked ${ago(v.requested)} · ${v.prompts} prompt${v.prompts === 1 ? "" : "s"} used · ${v.ip || "?"} · ${v.id.slice(0, 8)}`));
  c.append(buttons(v));
  return c;
}

function row(v) {
  const tr = document.createElement("tr");
  const who = el("td");
  who.append(el("div", null, v.name || v.id.slice(0, 8)));
  if (v.note) who.append(el("div", "dim", v.note.length > 80 ? v.note.slice(0, 80) + "…" : v.note));
  const used = v.status === "approved" ? `${v.prompts}` : `${v.prompts} / ${freePrompts}`;
  const act = el("td"); act.append(buttons(v));
  tr.append(who, el("td", `st-${v.status}`, v.status), el("td", null, used), el("td", null, v.ip || ""), el("td", null, ago(v.updated)), act);
  return tr;
}

function showError(msg) { const e = $("error"); e.textContent = msg; e.hidden = false; }

async function load() {
  $("error").hidden = true;
  let data;
  try {
    const res = await fetch("/api/admin/visitors", { credentials: "same-origin" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    // An expired Access session redirects cross-origin, which fetch reports as a network error.
    showError(`Couldn't load visitors (${err.message}). Reload the page to sign in again.`);
    return;
  }
  freePrompts = data.freePrompts ?? 10;
  const pending = data.visitors.filter((v) => v.status === "pending");
  const others = data.visitors.filter((v) => v.status !== "pending");
  $("summary").textContent = `${pending.length} waiting · ${others.length} other visitor${others.length === 1 ? "" : "s"} · ${freePrompts} free prompts each · signed in as ${data.admin || "owner"}`;
  $("pending").replaceChildren(...(pending.length ? pending.map(card) : [el("p", "empty", "Nobody is waiting.")]));
  $("others").replaceChildren(...others.map(row));
  document.title = pending.length ? `(${pending.length}) AI admin` : "AI admin · melltron.build lab";
}

load();
setInterval(() => { if (!document.hidden) load(); }, 30000);
