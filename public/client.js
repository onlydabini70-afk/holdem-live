"use strict";
/* API 호출 공통부. 파이썬 서버(server.py)가 있으면 그쪽, 없으면(GitHub Pages 등) 브라우저 로컬 API(localapi.js). */
const CB = (() => {
  let MODE = null, offset = 0;

  async function detect() {
    const p = new URLSearchParams(location.search);
    if (p.get("mode") === "local" || location.hostname.endsWith(".github.io") || location.protocol === "file:") return "local";
    if (p.get("mode") === "server") return "server";
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 2500);
      const r = await fetch("api/health", { cache: "no-store", signal: ctl.signal });
      clearTimeout(t);
      const j = await r.json();
      return j && j.ok ? "server" : "local";
    } catch (e) {
      return "local";
    }
  }

  async function request(method, path, body, key) {
    if (!MODE) MODE = await detect();
    const headers = { "Content-Type": "application/json" };
    if (key) headers["X-Admin-Key"] = key;
    let status, j;
    if (MODE === "local") {
      const r = await LocalAPI.request(method, "/" + path.replace(/^\//, ""), body, headers);
      status = r.status; j = r.body;
    } else {
      const r = await fetch(path.replace(/^\//, ""), { method, headers, cache: "no-store", body: body ? JSON.stringify(body) : undefined });
      status = r.status; j = await r.json().catch(() => ({}));
    }
    if (j.server_now) offset = j.server_now - Date.now();
    if (status >= 400) { const e = new Error(j.error || "HTTP " + status); e.status = status; throw e; }
    return j;
  }

  return {
    request, get: p => request("GET", p), now: () => Date.now() + offset,
    mode: () => MODE, detect: async () => (MODE = MODE || await detect()),
  };
})();
