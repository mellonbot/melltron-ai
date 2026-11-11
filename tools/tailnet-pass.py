#!/usr/bin/env python3
"""Tailnet pass issuer for ai.melltron.build.

Runs on a machine in the tailnet and listens ONLY on its Tailscale address, so
only tailnet devices can reach it. Opening it in a browser mints a signed pass
and redirects to https://ai.melltron.build/#pass=<token>; the page keeps the pass
and the Worker treats that browser as unlimited (src/quota.js) until it expires.

The token format matches signPass() in src/quota.js:
    base64url(JSON {dev, user, exp}) + "." + base64url(HMAC-SHA256(secret, payload))

Config (env):
    PASS_SECRET_FILE  default ~/.config/ai-pass/secret (same value as the Worker's PASS_SECRET)
    PASS_BIND         default: `tailscale ip -4`
    PASS_PORT         default 8787
    PASS_TARGET       default https://ai.melltron.build/
    PASS_DAYS         default 30
    PASS_USERS        optional comma-separated Tailscale logins allowed a pass
                      (default: anyone on the tailnet, including shared-in users)

Standard library only. Run as a user service (see README.md).
"""

import base64
import hashlib
import hmac
import html
import ipaddress
import json
import os
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TAILNET_V4 = ipaddress.ip_network("100.64.0.0/10")
TAILNET_V6 = ipaddress.ip_network("fd7a:115c:a1e0::/48")


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def sign(claims: dict, secret: str) -> str:
    payload = b64url(json.dumps(claims, separators=(",", ":")).encode())
    sig = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest()
    return f"{payload}.{b64url(sig)}"


def in_tailnet(ip: str) -> bool:
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if a.version == 6 and a.ipv4_mapped:
        a = a.ipv4_mapped
    return a in (TAILNET_V4 if a.version == 4 else TAILNET_V6)


def whois(ip: str):
    """-> (device, login) from `tailscale whois`, or None if Tailscale doesn't know the peer."""
    try:
        out = subprocess.run(["tailscale", "whois", "--json", ip], capture_output=True, text=True, timeout=5, check=True).stdout
        d = json.loads(out)
    except Exception:
        return None
    node = d.get("Node") or {}
    dev = node.get("ComputedName") or (node.get("Name") or "").split(".")[0] or ip
    login = (d.get("UserProfile") or {}).get("LoginName") or ""
    return dev, login


def page(status: int, title: str, body: str):
    doc = (
        "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
        f"<title>{html.escape(title)}</title>"
        "<body style='font:16px system-ui;max-width:32em;margin:3em auto;padding:0 16px'>"
        f"<h1 style='font-size:20px'>{html.escape(title)}</h1><p>{body}</p>"
    )
    return status, doc.encode()


class Handler(BaseHTTPRequestHandler):
    server_version = "tailnet-pass"

    def do_GET(self):
        if self.path.split("?")[0] not in ("/", "/pass"):
            return self.reply(*page(404, "Not found", "Open <code>/</code> to get a pass."))
        ip = self.client_address[0]
        if not in_tailnet(ip):
            return self.reply(*page(403, "Tailnet only", "This page only issues passes to Tailscale devices."))
        who = whois(ip)
        if not who:
            return self.reply(*page(403, "Unknown device", "Tailscale doesn't recognise this device."))
        dev, login = who
        allowed = [u.strip().lower() for u in os.environ.get("PASS_USERS", "").split(",") if u.strip()]
        if allowed and login.lower() not in allowed:
            log(f"refused {dev} ({login}) {ip}")
            return self.reply(*page(403, "Not allowed", "This tailnet user isn't on the pass list."))
        exp = int(time.time()) + int(float(os.environ.get("PASS_DAYS", "30")) * 86400)
        token = sign({"dev": dev, "user": login, "exp": exp}, SECRET)
        target = os.environ.get("PASS_TARGET", "https://ai.melltron.build/")
        log(f"issued {dev} ({login}) {ip} until {time.strftime('%Y-%m-%d', time.gmtime(exp))}")
        self.send_response(302)
        self.send_header("Location", f"{target}#pass={token}")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()

    def reply(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # quiet default access log; we log issues ourselves
        pass


def log(msg: str):
    print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), msg, flush=True)


def tailscale_ip() -> str:
    return subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=5, check=True).stdout.split()[0]


if __name__ == "__main__":
    secret_file = os.path.expanduser(os.environ.get("PASS_SECRET_FILE", "~/.config/ai-pass/secret"))
    try:
        SECRET = open(secret_file).read().strip()
    except OSError as e:
        sys.exit(f"tailnet-pass: can't read {secret_file}: {e}")
    if len(SECRET) < 32:
        sys.exit("tailnet-pass: secret is too short (need 32+ characters)")
    bind = os.environ.get("PASS_BIND") or tailscale_ip()
    if not in_tailnet(bind):
        sys.exit(f"tailnet-pass: refusing to listen on non-Tailscale address {bind}")
    port = int(os.environ.get("PASS_PORT", "8787"))
    log(f"listening on http://{bind}:{port}/")
    ThreadingHTTPServer((bind, port), Handler).serve_forever()
