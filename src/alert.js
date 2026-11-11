// Emails the owner when a visitor asks for access.
//
//   env.ALERT_EMAIL  send_email binding (Cloudflare Email Service)
//   env.ALERT_FROM   sender on an Email Sending domain, e.g. ai@melltron.build
//   env.ALERT_TO     the owner's address. A secret, because this repo is public; it
//                    must be a verified destination address on the account.
//
// Anyone can file requests, so alerts are capped at ALERT_MAX_PER_HOUR (default 10)
// across all visitors. Requests still land on /admin when the cap is hit.
// Alerts never block or fail the visitor's request.

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const maxPerHour = (env) => {
  const n = Number.parseInt(env.ALERT_MAX_PER_HOUR ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 10;
};

// -> "sent" | "not_configured" | "throttled" | "failed"
export async function notifyOwner(env, { name, note, ip, prompts, adminUrl }) {
  const to = (env.ALERT_TO || "").trim();
  const from = (env.ALERT_FROM || "").trim();
  if (!env.ALERT_EMAIL || !to || !from) return "not_configured";

  // Requests filed in the last hour, this one included.
  const since = new Date(Date.now() - 3600_000).toISOString();
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM visitors WHERE requested >= ?").bind(since).first();
  if ((row?.n ?? 0) > maxPerHour(env)) return "throttled";

  const subject = `AI access request: ${name}`.slice(0, 120);
  const lines = [
    `${name} asked for more prompts on ai.melltron.build.`,
    "",
    note ? `Note: ${note}` : "No note.",
    "",
    `Prompts used: ${prompts} · IP: ${ip}`,
    "",
    `Approve or deny: ${adminUrl}`,
  ];
  const html =
    `<p><strong>${escapeHtml(name)}</strong> asked for more prompts on ai.melltron.build.</p>` +
    (note ? `<blockquote style="white-space:pre-wrap">${escapeHtml(note)}</blockquote>` : "<p>No note.</p>") +
    `<p style="color:#666">Prompts used: ${escapeHtml(prompts)} · IP: ${escapeHtml(ip)}</p>` +
    `<p><a href="${escapeHtml(adminUrl)}">Approve or deny on /admin</a></p>`;
  try {
    await env.ALERT_EMAIL.send({ to, from: { email: from, name: "ai.melltron.build" }, subject, text: lines.join("\n"), html });
    return "sent";
  } catch (err) {
    console.error(JSON.stringify({ alert: "failed", code: err?.code ?? null, error: String(err?.message || err) }));
    return "failed";
  }
}
