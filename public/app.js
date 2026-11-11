// AI lab — chat UI for the lab's Ollama models.
// External script only (strict CSP). Model output is untrusted: everything is built
// with DOM APIs and textContent, never innerHTML.

const $ = (id) => document.getElementById(id);
const els = {
  sidebar: $("sidebar"), toggle: $("toggle-side"), chats: $("chats"), newChat: $("new-chat"),
  status: $("status"), statusText: $("status-text"), who: $("who"),
  model: $("model"), thinkWrap: $("think-wrap"), think: $("think"),
  log: $("log"), empty: $("empty"), notice: $("notice"),
  form: $("composer"), input: $("input"), send: $("send"), stop: $("stop"),
};

// ---------- storage (per-browser convenience; survives failures) ----------
const KEY = { chats: "ai.chats.v1", current: "ai.current", model: "ai.model", think: "ai.think" };
const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let chats = store.get(KEY.chats, []);
let currentId = store.get(KEY.current, null);
let models = [];
let controller = null;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const current = () => chats.find((c) => c.id === currentId) || null;
const save = () => { store.set(KEY.chats, chats); store.set(KEY.current, currentId); };

// ---------- markdown (small, safe subset) ----------
function inline(text, parent) {
  // `code`, **bold**, *italic*, [label](https://url)
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const tok = m[0];
    let node;
    if (m[1]) { node = document.createElement("code"); node.textContent = tok.slice(1, -1); }
    else if (m[2]) { node = document.createElement("strong"); inline(tok.slice(2, -2), node); }
    else if (m[3]) { node = document.createElement("em"); inline(tok.slice(1, -1), node); }
    else {
      node = document.createElement("a");
      node.href = m[5]; node.rel = "noopener noreferrer nofollow"; node.target = "_blank";
      node.textContent = tok.slice(1, tok.indexOf("]("));
    }
    parent.append(node);
    last = re.lastIndex;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function markdown(src) {
  const frag = document.createDocumentFragment();
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let i = 0, para = [];
  const flush = () => {
    if (!para.length) return;
    const p = document.createElement("p");
    para.forEach((l, j) => { if (j) p.append(document.createElement("br")); inline(l, p); });
    frag.append(p); para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([\w+-]*)/);
    if (fence) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence (or end of a still-streaming block)
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = buf.join("\n");
      if (fence[1]) code.dataset.lang = fence[1];
      const copy = document.createElement("button");
      copy.type = "button"; copy.className = "btn copy"; copy.textContent = "copy";
      copy.addEventListener("click", () => {
        navigator.clipboard?.writeText(code.textContent).then(() => { copy.textContent = "copied"; setTimeout(() => (copy.textContent = "copy"), 1200); }, () => {});
      });
      pre.append(copy, code);
      frag.append(pre);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { flush(); const el = document.createElement(`h${Math.min(h[1].length + 1, 4)}`); inline(h[2], el); frag.append(el); i++; continue; }
    const li = line.match(/^\s*([-*]|\d+[.)])\s+(.*)/);
    if (li) {
      flush();
      const ordered = /\d/.test(li[1]);
      const list = document.createElement(ordered ? "ol" : "ul");
      while (i < lines.length) {
        const mm = lines[i].match(/^\s*([-*]|\d+[.)])\s+(.*)/);
        if (!mm || /\d/.test(mm[1]) !== ordered) break;
        const item = document.createElement("li"); inline(mm[2], item); list.append(item); i++;
      }
      frag.append(list);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line); i++;
  }
  flush();
  return frag;
}

// ---------- rendering ----------
function messageEl(m) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${m.role}`;
  const role = document.createElement("div");
  role.className = "role";
  role.textContent = m.role === "user" ? "you" : (m.model || "assistant");
  const body = document.createElement("div");
  body.className = "body";
  wrap.append(role);
  if (m.role === "assistant" && m.thinking) {
    const d = document.createElement("details");
    d.className = "thinking";
    if (m.streaming && !m.content) d.open = true;
    const s = document.createElement("summary");
    s.textContent = m.streaming && !m.content ? "Reasoning…" : "Reasoning";
    const t = document.createElement("div");
    t.className = "t"; t.textContent = m.thinking.trim();
    d.append(s, t);
    wrap.append(d);
  }
  if (m.role === "user") body.textContent = m.content;
  else body.append(markdown(m.content || ""));
  if (m.streaming) body.classList.add("cursor");
  wrap.append(body);
  if (m.error) { const e = document.createElement("div"); e.className = "error"; e.textContent = m.error; wrap.append(e); }
  if (m.meta) { const e = document.createElement("div"); e.className = "meta"; e.textContent = m.meta; wrap.append(e); }
  return wrap;
}

function renderLog() {
  const c = current();
  els.log.replaceChildren();
  if (!c || !c.messages.length) { els.log.append(els.empty); return; }
  for (const m of c.messages) els.log.append(messageEl(m));
  els.log.scrollTop = els.log.scrollHeight;
}

function renderChats() {
  els.chats.replaceChildren();
  const sorted = [...chats].sort((a, b) => b.updated - a.updated);
  for (const c of sorted) {
    const row = document.createElement("div");
    row.className = "chat-item" + (c.id === currentId ? " active" : "");
    const a = document.createElement("a");
    a.href = "#"; a.textContent = c.title || "New chat"; a.title = c.title || "";
    a.addEventListener("click", (e) => { e.preventDefault(); if (controller) return; currentId = c.id; save(); renderAll(); closeSide(); });
    const del = document.createElement("button");
    del.type = "button"; del.className = "del"; del.textContent = "×"; del.setAttribute("aria-label", `Delete ${c.title || "chat"}`);
    let armed = null;
    del.addEventListener("click", () => {
      if (!armed) { del.classList.add("armed"); del.textContent = "delete?"; armed = setTimeout(() => { armed = null; del.classList.remove("armed"); del.textContent = "×"; }, 2500); return; }
      clearTimeout(armed);
      if (controller && c.id === currentId) controller.abort();
      chats = chats.filter((x) => x.id !== c.id);
      if (currentId === c.id) currentId = null;
      save(); renderAll();
    });
    row.append(a, del);
    els.chats.append(row);
  }
}

const renderAll = () => { renderChats(); renderLog(); updateSend(); };

function setStatus(state, text) { els.status.dataset.state = state; els.statusText.textContent = text; }

function showNotice(text, withReload) {
  els.notice.replaceChildren(text);
  if (withReload) {
    const a = document.createElement("a"); a.href = location.pathname; a.textContent = " Reload to sign in again.";
    els.notice.append(a);
  }
  els.notice.hidden = false;
}

const BACKEND_LABEL = { desktop: "Desktop · RTX 4060", hailo: "Pi · Hailo-10H" };
const OFFLINE = {
  desktop: "The lab desktop is offline, or Ollama isn't running on it.",
  hailo: "The Pi is offline, or hailo-ollama isn't running on it.",
};
const ERRORS = {
  offline: OFFLINE.desktop,
  tunnel_auth: "The tunnel refused the Worker's service token. Check OLLAMA_CLIENT_ID / OLLAMA_CLIENT_SECRET.",
  not_configured: "The Worker isn't connected to Ollama yet (OLLAMA_URL or tunnel token missing).",
  access_not_configured: "Access verification isn't configured on the Worker yet (ACCESS_TEAM_DOMAIN / ACCESS_AUD).",
  unauthenticated: "Your sign-in has expired.",
  too_large: "This conversation is too long to send. Start a new chat.",
};
const explain = (e) => (e.error === "offline" && OFFLINE[e.backend]) || ERRORS[e.error] || (e.detail ? `Ollama: ${e.detail}` : `Request failed (${e.error || "unknown"}).`);

// ---------- API ----------
async function api(path, init) {
  let res;
  try { res = await fetch(path, { credentials: "same-origin", ...init }); }
  catch (err) {
    if (err.name === "AbortError") throw err;
    // An expired Access session redirects cross-origin, which fetch reports as a network error.
    const e = new Error(ERRORS.unauthenticated); e.reauth = true; throw e;
  }
  if (res.ok) return res;
  let body = {};
  try { body = await res.json(); } catch {}
  const e = new Error(explain(body)); e.code = body.error; e.backend = body.backend; e.reauth = body.error === "unauthenticated"; throw e;
}

async function loadModels() {
  setStatus("checking", "Checking…");
  try {
    const data = await (await api("/api/models")).json();
    models = data.models || [];
    els.model.replaceChildren();
    // One group per machine, desktop first.
    const groups = new Map();
    for (const m of models) {
      const k = m.backend || "desktop";
      if (!groups.has(k)) {
        const g = document.createElement("optgroup");
        g.label = BACKEND_LABEL[k] || k;
        groups.set(k, g);
      }
      const o = document.createElement("option");
      o.value = m.name;
      const label = m.name.replace(/^hailo\//, "");
      o.textContent = m.parameters ? `${label}  ·  ${m.parameters}` : label;
      groups.get(k).append(o);
    }
    for (const k of ["desktop", "hailo", ...groups.keys()]) if (groups.has(k)) { els.model.append(groups.get(k)); groups.delete(k); }
    if (!models.length) {
      els.model.append(new Option("No models installed"));
      setStatus("error", "No models");
      return;
    }
    const want = current()?.model || store.get(KEY.model, null);
    if (want && models.some((m) => m.name === want)) els.model.value = want;
    els.model.disabled = false;
    const down = Object.entries(data.backends || {}).filter(([, s]) => s !== "online").map(([k]) => k);
    setStatus(down.length ? "partial" : "online", `Online · ${models.length} model${models.length === 1 ? "" : "s"}`);
    if (down.length) showNotice(down.map((k) => OFFLINE[k] || `${k} is unavailable.`).join(" ") + " Its models are hidden for now.");
    else els.notice.hidden = true;
    updateThink();
  } catch (err) {
    els.model.replaceChildren(new Option("Unavailable"));
    els.model.disabled = true;
    setStatus(err.code === "offline" ? "offline" : "error", err.code === "offline" ? "Lab offline" : "Unavailable");
    showNotice(err.message, err.reauth);
  }
  updateSend();
}

async function loadMe() {
  try { const d = await (await api("/api/me")).json(); els.who.textContent = d.email || ""; } catch {}
}

// ---------- chat ----------
const modelInfo = () => models.find((m) => m.name === els.model.value);
function updateThink() { els.thinkWrap.hidden = !modelInfo()?.thinking; }
function updateSend() {
  const busy = !!controller;
  els.send.hidden = busy; els.stop.hidden = !busy;
  els.send.disabled = busy || els.model.disabled || !els.input.value.trim();
}

function autosize() { els.input.style.height = "auto"; els.input.style.height = Math.min(els.input.scrollHeight, innerHeight * 0.4) + "px"; }

// Some models (deepseek-r1 on hailo-ollama) put their reasoning inline as
// <think>…</think> instead of a separate field. Split it out while streaming.
function splitThink(reply, raw) {
  const t = raw.trimStart();
  if (!t.startsWith("<think>")) { reply.content = raw; return; }
  const end = t.indexOf("</think>");
  if (end < 0) { reply.thinking = t.slice(7); reply.content = ""; return; }
  reply.thinking = t.slice(7, end);
  reply.content = t.slice(end + 8).trimStart();
}

async function send() {
  const text = els.input.value.trim();
  if (!text || controller || els.model.disabled) return;
  let c = current();
  if (!c) { c = { id: uid(), title: "", model: els.model.value, messages: [], updated: Date.now() }; chats.push(c); currentId = c.id; }
  c.model = els.model.value;
  if (!c.title) c.title = text.replace(/\s+/g, " ").slice(0, 60);
  c.messages.push({ role: "user", content: text });
  const reply = { role: "assistant", model: c.model, content: "", thinking: "", streaming: true };
  c.messages.push(reply);
  c.updated = Date.now();
  els.input.value = ""; autosize();
  store.set(KEY.model, c.model);
  save(); renderChats(); renderLog();

  controller = new AbortController();
  updateSend();
  const think = !!modelInfo()?.thinking && els.think.checked;
  const history = c.messages.filter((m) => m !== reply && !m.error).map(({ role, content }) => ({ role, content }));

  let frame = 0;
  const paint = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const last = els.log.lastElementChild;
      const stick = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 80;
      const fresh = messageEl(reply);
      if (last && last.classList.contains("assistant")) last.replaceWith(fresh);
      else els.log.append(fresh);
      if (stick) els.log.scrollTop = els.log.scrollHeight;
    });
  };

  try {
    const res = await api("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: c.model, messages: history, think }),
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", raw = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let evt; try { evt = JSON.parse(line); } catch { continue; }
        if (evt.error) throw new Error(`Ollama: ${evt.error}`);
        if (evt.message?.thinking) reply.thinking += evt.message.thinking;
        if (evt.message?.content) { raw += evt.message.content; splitThink(reply, raw); }
        if (evt.done && evt.eval_count && evt.eval_duration) {
          const tps = evt.eval_count / (evt.eval_duration / 1e9);
          reply.meta = `${evt.eval_count} tokens · ${tps.toFixed(1)} tok/s`;
        }
        paint();
      }
    }
    if (!reply.content && !reply.thinking) reply.error = "The model returned an empty reply.";
  } catch (err) {
    if (err.name === "AbortError") reply.meta = (reply.meta ? reply.meta + " · " : "") + "stopped";
    else {
      reply.error = err.message;
      if (err.reauth) showNotice(err.message, true);
      if (err.code === "offline") { setStatus("offline", err.backend === "hailo" ? "Pi offline" : "Desktop offline"); }
    }
  } finally {
    reply.streaming = false; // failed turns stay visible but are filtered out of history
    controller = null;
    c.updated = Date.now();
    save();
    cancelAnimationFrame(frame); frame = 0;
    renderAll();
    els.input.focus();
  }
}

// ---------- side panel (narrow screens) ----------
function closeSide() { els.sidebar.classList.remove("open"); els.toggle.setAttribute("aria-expanded", "false"); }
els.toggle.addEventListener("click", () => {
  const open = els.sidebar.classList.toggle("open");
  els.toggle.setAttribute("aria-expanded", String(open));
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSide(); });

// ---------- wiring ----------
els.form.addEventListener("submit", (e) => { e.preventDefault(); send(); });
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
els.input.addEventListener("input", () => { autosize(); updateSend(); });
els.stop.addEventListener("click", () => controller?.abort());
els.newChat.addEventListener("click", () => {
  if (controller) return;
  currentId = null; save(); renderAll(); closeSide(); els.input.focus();
});
els.model.addEventListener("change", () => { store.set(KEY.model, els.model.value); updateThink(); });
els.think.checked = store.get(KEY.think, true);
els.think.addEventListener("change", () => store.set(KEY.think, els.think.checked));
addEventListener("focus", () => { if (els.status.dataset.state !== "online" && !controller) loadModels(); });

// A reply left mid-stream by a reload is finished as-is.
for (const c of chats) for (const m of c.messages) if (m.streaming) { m.streaming = false; m.meta = (m.meta ? m.meta + " · " : "") + "interrupted"; }
if (currentId && !current()) currentId = null;
save();
renderAll();
loadModels();
loadMe();
els.input.focus();
