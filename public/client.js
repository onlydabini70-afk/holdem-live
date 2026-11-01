"use strict";
/* API 호출 공통부. 파이썬 서버(server.py)가 있으면 그쪽, 없으면(GitHub Pages 등) 브라우저 로컬 API(localapi.js). */
const CB = (() => {
  let MODE = null, offset = 0;

  // 기본값은 APIS 실시간. ?mode=local(더미) / ?mode=server(파이썬 서버) 로 바꿀 수 있음.
  async function detect() {
    const p = new URLSearchParams(location.search);
    const m = p.get("mode");
    if (m === "apis" || m === "local" || m === "server") return m;
    return "apis";
  }

  // 관리자 페이지 전용: 쓰기 가능한 모드(서버 우선, 없으면 로컬 더미). apis 는 읽기전용이라 제외.
  async function detectWritable() {
    const p = new URLSearchParams(location.search);
    if (p.get("mode") === "local") return "local";
    if (p.get("mode") === "server") return "server";
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 2500);
      const r = await fetch("api/health", { cache: "no-store", signal: ctl.signal });
      clearTimeout(t);
      const j = await r.json();
      return j && j.ok && j.mode !== "apis" ? "server" : "local";
    } catch (e) { return "local"; }
  }

  async function request(method, path, body, key) {
    if (!MODE) MODE = await detect();
    const headers = { "Content-Type": "application/json" };
    if (key) headers["X-Admin-Key"] = key;
    let status, j;
    if (MODE === "apis") {
      const r = await ApisData.request(method, "/" + path.replace(/^\//, ""), body);
      status = r.status; j = r.body;
    } else if (MODE === "local") {
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
    setMode: m => { MODE = m; }, detectWritable,
  };
})();
