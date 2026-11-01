"use strict";
/* OVERLAY HUNTER 프론트엔드 — 프레임워크 없이 해시 라우팅 + 폴링 */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const now = () => CB.now();
const api = path => CB.get(path);
const TABS = ["home", "live", "games", "comp", "my"];

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = n => n == null ? "-" : Number(n).toLocaleString("ko-KR");
const pad = n => String(n).padStart(2, "0");
function mmss(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function untilText(sec) {
  if (sec <= 0) return "곧 시작";
  const h = Math.floor(sec / 3600), m = Math.ceil(sec % 3600 / 60);
  return h ? `${h}시간 후` : `${m}분 후`;   // 좁은 칸에서 줄바꿈되지 않게 간결히
}
const blind = l => l ? `${fmt(l.sb)} / ${fmt(l.bb)}${l.ante ? ` <small>(${fmt(l.ante)})</small>` : ""}` : "-";
function money(n, cur = "KRW") {
  if (!n) return "-";
  if (cur === "KRW") {
    if (n >= 1e8) return `${+(n / 1e8).toFixed(1)}억`;
    if (n >= 1e4) return `${+(n / 1e4).toFixed(1)}만`;
    return fmt(n) + "원";
  }
  const sym = { USD: "$", HKD: "HK$", EUR: "€", PHP: "₱" }[cur] || cur + " ";
  return sym + fmt(n);
}
const hhmm = ts => new Date(ts).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Seoul" });
function dayLabel(d, today) {
  const dt = new Date(d + "T00:00:00+09:00"), t = new Date(today + "T00:00:00+09:00");
  const diff = Math.round((dt - t) / 864e5);
  const wd = "일월화수목금토"[dt.getUTCDay() === undefined ? 0 : new Date(d + "T12:00:00+09:00").getDay()];
  if (diff === 0) return "오늘";
  if (diff === 1) return "내일";
  return `${+d.slice(5, 7)}/${+d.slice(8)} (${wd})`;
}
const dateRange = (a, b) => `${a.slice(5).replace("-", ".")} ~ ${b.slice(5).replace("-", ".")}`;

/* ---------- 로컬 저장 (실패해도 앱은 동작) ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } },
};
const favV = () => store.get("cb_fav_v", {});
const favG = () => store.get("cb_fav_g", {});
function toggleFav(kind, id, info) {
  const key = kind === "v" ? "cb_fav_v" : "cb_fav_g", m = store.get(key, {});
  if (m[id]) delete m[id]; else m[id] = info;
  store.set(key, m);
  toast(m[id] ? "즐겨찾기에 추가했어요" : "즐겨찾기에서 뺐어요");
  return !!m[id];
}
function addRecent(v) {
  const r = store.get("cb_recent_v", []).filter(x => x.id !== v.id);
  r.unshift({ id: v.id, name: v.name, region: v.region });
  store.set("cb_recent_v", r.slice(0, 8));
}

let toastT;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("on");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), 1800);
}

async function share(title) {
  const url = location.href;
  try {
    if (navigator.share) { await navigator.share({ title, url }); return; }
    await navigator.clipboard.writeText(url); toast("링크를 복사했어요");
  } catch (e) { if (e.name !== "AbortError") toast(url); }
}

/* ---------- 공통 조각 ---------- */
const IC = {
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 3v13M7 8l5-5 5 5M5 14v6h14v-6"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
};

function stBadge(g) {
  const c = g.clock;
  if (g.state === "PLAYING") return c.on_break ? '<span class="badge b-break">휴식 중</span>' : '<span class="badge b-live">LIVE</span>';
  if (g.state === "PAUSED") return '<span class="badge b-pause">일시정지</span>';
  if (g.state === "WAITING") return '<span class="badge b-wait">시작 전</span>';
  return '<span class="badge b-done">종료</span>';
}
function regBadge(g) {
  if (!g.clock.reg_open || g.state === "FINISHED") return "";
  return `<span class="badge b-reg">등록 가능${g.state !== "WAITING" && g.reg_close_level != null ? ` ~LV${g.reg_close_level}` : ""}</span>`;
}
function timer(g, startFmt = "until") {
  const c = g.clock;
  if (g.state === "WAITING") return `<span class="num" data-start="${g.start_ts}" data-f="${startFmt}">${startFmt === "clock" ? mmss(c.starts_in) : untilText(c.starts_in)}</span>`;
  if (c.running) return `<span class="num" data-end="${c.end_at}">${mmss(c.remaining)}</span>`;
  if (c.remaining == null) return '<span class="num">-</span>';
  return `<span class="num">${g.state === "FINISHED" ? "종료" : mmss(c.remaining)}</span>`;
}
const vname = g => esc(g.venue ? g.venue.name : "");

function liveCard(g) {
  const c = g.clock, s = g.stats;
  return `<a class="lc" href="#/game/${g.id}">
    <div class="top">${stBadge(g)} ${regBadge(g)}</div>
    <div class="nm">${esc(g.name)}</div>
    <div class="t2" style="font-size:12px;color:var(--t1)">${vname(g)} · ${esc(g.venue?.region || "")}</div>
    <div class="clk"><div class="lv">${c.on_break ? "BREAK" : "LV"}<b class="num">${c.level ? c.level.lv : "-"}</b></div><div class="tm">${timer(g)}</div></div>
    <div class="bl num">${blind(c.level)}</div>
    <div class="st"><span>엔트리<b class="num">${fmt(s.entries)}</b></span><span>남음<b class="num">${fmt(s.players_left)}</b></span><span>평균<b class="num">${s.avg_bb ?? "-"}BB</b></span></div>
  </a>`;
}

function gameRow(g, opts = {}) {
  const c = g.clock, s = g.stats, live = g.state === "PLAYING" || g.state === "PAUSED";
  const left = live
    ? `<div class="tm0"><b class="num">${c.on_break ? "휴식" : c.level ? "LV" + c.level.lv : "-"}</b><span>${timer(g)}</span></div>`
    : `<div class="tm0"><b class="num">${hhmm(g.start_ts)}</b><span>${g.state === "WAITING" ? timer(g) : "종료"}</span></div>`;
  const right = live
    ? `<div class="rt"><b class="num">${fmt(s.players_left)}<small style="font-size:12px;color:var(--t2)">/${fmt(s.entries)}</small></b><span>${s.avg_bb ?? "-"}BB</span></div>`
    : g.state === "WAITING"
      ? `<div class="rt"><b class="num">${money(g.buyin)}</b><span>${s.entries ? `사전 ${s.entries}명` : "바이인"}</span></div>`
      : `<div class="rt"><b class="num">${fmt(s.entries)}</b><span>엔트리</span></div>`;
  const dist = g.distance_km != null ? ` · ${g.distance_km}km` : "";
  return `<a class="row${g.state === "FINISHED" ? " dim" : ""}" href="#/game/${g.id}">${left}
    <div class="bd"><div class="t1">${esc(g.name)}</div>
      <div class="t2">${opts.noVenue ? esc(g.structure_name) : `${vname(g)} · ${esc(g.venue?.region || "")}${dist}`}${live ? ` · <span class="num">${blind(c.level).replace(/<\/?small>/g, "")}</span>` : ""}</div>
      <div class="t3">${stBadge(g)}${regBadge(g)}${g.guarantee ? `<span class="badge b-tag">GTD ${money(g.guarantee)}</span>` : ""}${(g.tags || []).slice(0, 2).map(t => `<span class="badge b-tag">${esc(t)}</span>`).join("")}</div>
    </div>${right}</a>`;
}

function compCard(c) {
  const st = { ongoing: '<span class="badge b-live">진행 중</span>', upcoming: '<span class="badge b-wait">예정</span>', finished: '<span class="badge b-done">종료</span>' }[c.status];
  return `<a class="cc" href="#/comp/${c.id}"><span class="fl">${esc((c.country || "").slice(0, 2) || (c.scope === "intl" ? "INT" : "KR"))}</span>
    <b>${esc(c.name)}</b><div class="d">${dateRange(c.start_date, c.end_date)} · ${esc(c.city)} · 이벤트 ${c.event_count}개</div>
    <div class="g">${st} ${c.max_guarantee ? `최대 GTD <strong>${money(c.max_guarantee, c.currency)}</strong>` : ""}</div></a>`;
}

function venueRow(v) {
  return `<a class="row" href="#/venue/${v.id}"><div class="tm0"><b style="color:var(--t0)">${esc(v.region)}</b><span>${v.tables ? v.tables + "테이블" : ""}</span></div>
    <div class="bd"><div class="t1">${esc(v.name)}</div><div class="t2">${esc(v.address)}${v.distance_km != null ? ` · ${v.distance_km}km` : ""}</div>
    ${v.live_games != null ? `<div class="t3">${v.live_games ? `<span class="badge b-live">진행 ${v.live_games}</span>` : ""}<span class="badge b-tag">오늘 ${v.today_games}게임</span></div>` : ""}</div>
    ${v.live_players != null ? `<div class="rt"><b class="num">${fmt(v.live_players)}</b><span>플레이 중</span></div>` : ""}</a>`;
}

function header(title, extra = "") {
  return `<header class="hd"><h1>${title}</h1>${extra}<a class="ic" href="#/search" aria-label="검색">${IC.search}</a></header>`;
}
const loading = '<div class="empty">불러오는 중…</div>';
const errBox = e => `<div class="empty">불러오지 못했어요<br><small>${esc(e.message)}</small></div>`;

/* ---------- 탭 화면 ---------- */
const S = {
  meta: null, liveRegion: null, liveSort: "players", gamesMode: "t", gamesDate: null, gamesRegion: null,
  gamesStatus: "all", compScope: "kr", near: null,
};

async function meta() { if (!S.meta) S.meta = await api("/api/meta"); return S.meta; }
const defRegion = () => store.get("cb_region", null);

function regionChips(cur, target) {
  return `<div class="chips" data-keep="rc">${[null, ...S.meta.regions].map(r =>
    `<button class="chip${r === cur ? " on" : ""}" data-act="region" data-target="${target}" data-v="${esc(r || "")}">${esc(r || "전체")}</button>`).join("")}</div>`;
}

/* 데이터가 들어가는 버튼은 인라인 JS 대신 data-* + 위임 핸들러 (이름에 따옴표가 있어도 안전) */
document.addEventListener("click", e => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const d = b.dataset;
  if (d.act === "region") { S[d.target] = d.v || null; render(); }
  else if (d.act === "fav") b.classList.toggle("on", toggleFav(d.kind, d.id, d.kind === "v" ? { name: d.name, region: d.region } : { name: d.name }));
  else if (d.act === "q") doSearch(d.q);
});

const VIEWS = {
  async home() {
    const [d] = await Promise.all([api("/api/home"), meta()]);
    const fv = Object.entries(favV()), rec = store.get("cb_recent_v", []);
    const vs = fv.length ? fv.map(([id, v]) => ({ id, ...v })) : rec;
    let nearHtml = `<button class="btn" style="width:100%" onclick="findNear()">${IC.pin.replace("<svg", '<svg width="16" height="16" style="stroke:currentColor;fill:none;stroke-width:2"')} 내 위치로 가까운 게임 찾기</button>`;
    if (S.near) nearHtml = S.near.length ? `<div class="list">${S.near.map(g => gameRow(g)).join("")}</div>` : '<div class="empty">근처에 오늘 남은 게임이 없어요</div>';
    return `<header class="hd"><div class="brand">Overlay Hunter</div>
        <a class="ic" href="#/search" aria-label="검색">${IC.search}</a></header>
      <div class="hero"><img src="logo-black.png" alt="OVERLAY HUNTER"><p>전국 홀덤 토너먼트 실시간</p></div>
      <div class="kpis">
        <div class="kpi"><b class="num">${d.counts.live}</b><span>진행 중</span></div>
        <div class="kpi"><b class="num">${fmt(d.counts.players)}</b><span>플레이어</span></div>
        <div class="kpi"><b class="num">${d.counts.venues}</b><span>매장</span></div>
        <div class="kpi"><b class="num">${d.counts.today}</b><span>오늘 게임</span></div>
      </div>
      <div class="sec">
        ${d.promos.length ? `<div class="sec-h"><h2>이벤트</h2></div><div class="hs" data-keep="promo">${d.promos.map(p =>
          `<a class="promo" href="${promoHref(p)}"><b>${esc(p.title)}</b><p>${esc(p.body)}</p></a>`).join("")}</div>` : ""}
        <div class="sec-h"><h2>오늘 핫한 게임</h2><a href="#/live">전체 ›</a></div>
        ${d.hot.length ? `<div class="hs" data-keep="hot">${d.hot.map(liveCard).join("")}</div>` : '<div class="empty">지금 진행 중인 게임이 없어요</div>'}
        <div class="sec-h"><h2>지금 등록 가능</h2><a href="#/games">전체 ›</a></div>
        ${d.open_reg.length ? `<div class="list">${d.open_reg.slice(0, 6).map(g => gameRow(g)).join("")}</div>` : '<div class="empty">등록 가능한 게임이 없어요</div>'}
        ${vs.length ? `<div class="sec-h"><h2>${fv.length ? "즐겨가는 매장" : "최근 본 매장"}</h2><a href="#/my">MY ›</a></div>
          <div class="hs" data-keep="vs">${vs.map(v => `<a class="vchip" href="#/venue/${v.id}"><i>${esc((v.region || "").slice(0, 2))}</i><div><b>${esc(v.name)}</b><span>${esc(v.region || "")}</span></div></a>`).join("")}</div>` : ""}
        <div class="sec-h"><h2>내 주변 게임</h2>${S.near ? '<button onclick="S.near=null;render()">닫기</button>' : ""}</div>
        ${nearHtml}
        <div class="sec-h"><h2>대회</h2><a href="#/comp">전체 ›</a></div>
        <div class="list">${d.competitions.map(compCard).join("")}</div>
      </div>`;
  },

  async live() {
    await meta();
    if (S.liveRegion === null && S._liveInit !== true) { S.liveRegion = defRegion(); S._liveInit = true; }
    const qs = new URLSearchParams({ sort: S.liveSort });
    if (S.liveRegion) qs.set("region", S.liveRegion);
    const d = await api("/api/live?" + qs);
    const players = d.games.reduce((a, g) => a + g.stats.players_left, 0);
    return header(`라이브<small>${d.games.length}게임 · ${fmt(players)}명</small>`) +
      regionChips(S.liveRegion, "liveRegion") +
      `<div class="toolbar"><span>진행 중 · 일시정지 포함</span><select onchange="S.liveSort=this.value;render()">
        ${[["players", "남은 인원순"], ["entries", "엔트리순"], ["level", "레벨순"], ["start", "시작순"]].map(([v, t]) => `<option value="${v}"${v === S.liveSort ? " selected" : ""}>${t}</option>`).join("")}
      </select></div>
      <div class="sec" style="padding-top:0"><div class="list">${d.games.map(g => gameRow(g)).join("") || '<div class="empty">진행 중인 게임이 없어요</div>'}</div></div>`;
  },

  async games() {
    const m = await meta();
    if (!S.gamesDate) S.gamesDate = m.today;
    if (S.gamesRegion === null && S._gamesInit !== true) { S.gamesRegion = defRegion(); S._gamesInit = true; }
    const seg = `<div class="seg"><button class="${S.gamesMode === "t" ? "on" : ""}" onclick="S.gamesMode='t';render()">토너먼트</button><button class="${S.gamesMode === "v" ? "on" : ""}" onclick="S.gamesMode='v';render()">매장</button></div>`;
    if (S.gamesMode === "v") {
      const qs = new URLSearchParams(); if (S.gamesRegion) qs.set("region", S.gamesRegion);
      const d = await api("/api/venues?" + qs);
      return header(`게임<small>매장 ${d.venues.length}곳</small>`) + seg + regionChips(S.gamesRegion, "gamesRegion") +
        `<div class="sec" style="padding-top:0"><div class="list">${d.venues.map(venueRow).join("") || '<div class="empty">매장이 없어요</div>'}</div></div>`;
    }
    const qs = new URLSearchParams({ date: S.gamesDate, sort: "start" });
    if (S.gamesRegion) qs.set("region", S.gamesRegion);
    if (S.gamesStatus !== "all") qs.set("status", S.gamesStatus);
    const d = await api("/api/games?" + qs);
    return header(`게임<small>${d.games.length}개</small>`) + seg +
      `<div class="chips" data-keep="dc">${m.dates.map(x => `<button class="chip${x === S.gamesDate ? " on" : ""}" onclick="S.gamesDate='${x}';render()">${dayLabel(x, m.today)}</button>`).join("")}</div>` +
      regionChips(S.gamesRegion, "gamesRegion") +
      `<div class="toolbar"><span>시작 시간순</span><select onchange="S.gamesStatus=this.value;render()">
        ${[["all", "전체 상태"], ["live", "진행 중"], ["upcoming", "시작 전"], ["done", "종료"]].map(([v, t]) => `<option value="${v}"${v === S.gamesStatus ? " selected" : ""}>${t}</option>`).join("")}
      </select></div>
      <div class="sec" style="padding-top:0"><div class="list">${d.games.map(g => gameRow(g)).join("") || '<div class="empty">조건에 맞는 게임이 없어요</div>'}</div></div>`;
  },

  async comp() {
    const d = await api("/api/competitions?scope=" + S.compScope);
    return header("대회") +
      `<div class="seg"><button class="${S.compScope === "kr" ? "on" : ""}" onclick="S.compScope='kr';render()">국내 대회</button><button class="${S.compScope === "intl" ? "on" : ""}" onclick="S.compScope='intl';render()">해외 대회</button></div>
      <div class="sec" style="padding-top:0"><div class="list">${d.competitions.map(compCard).join("") || '<div class="empty">등록된 대회가 없어요</div>'}</div>
      <p class="note">${CB.mode() === "apis" ? "APIS 공개 데이터에는 대회(시리즈) 일정이 없어 비워 둡니다." : "대회 정보는 데모용 가상 데이터입니다."}</p></div>`;
  },

  async my() {
    const m = await meta();
    const fv = Object.entries(favV()), fg = Object.keys(favG()), rec = store.get("cb_recent_v", []);
    let favGames = [];
    if (fg.length) favGames = (await api("/api/games?ids=" + encodeURIComponent(fg.join(",")))).games;
    const vlist = arr => arr.map(v => `<a class="row" href="#/venue/${v.id}"><div class="tm0"><b style="color:var(--t0)">${esc(v.region || "")}</b></div><div class="bd"><div class="t1">${esc(v.name)}</div></div><div class="rt"><span>›</span></div></a>`).join("");
    return header("MY") + `<div class="sec">
      <div class="sec-h"><h2>즐겨찾기 매장</h2></div>
      ${fv.length ? `<div class="list">${vlist(fv.map(([id, v]) => ({ id, ...v })))}</div>` : '<div class="empty">매장 화면의 ☆ 를 눌러 추가하세요</div>'}
      <div class="sec-h"><h2>즐겨찾기 게임</h2></div>
      ${favGames.length ? `<div class="list">${favGames.map(g => gameRow(g)).join("")}</div>` : '<div class="empty">게임 화면의 ☆ 를 눌러 추가하세요</div>'}
      ${rec.length ? `<div class="sec-h"><h2>최근 본 매장</h2></div><div class="list">${vlist(rec)}</div>` : ""}
      <div class="sec-h"><h2>설정</h2></div>
      <div class="kv"><span>기본 지역</span><b><select style="background:var(--s1);border:1px solid var(--line);border-radius:8px;padding:5px" onchange="store.set('cb_region',this.value||null);S._liveInit=S._gamesInit=false;S.liveRegion=S.gamesRegion=null;toast('저장했어요')">
        ${[null, ...m.regions].map(r => `<option value="${r || ""}"${r === defRegion() ? " selected" : ""}>${r || "전체"}</option>`).join("")}</select></b></div>
      <div class="kv"><span>내 기록 지우기</span><b><button class="btn" style="padding:6px 12px" onclick="if(confirm('즐겨찾기·최근 기록을 지울까요?')){['cb_fav_v','cb_fav_g','cb_recent_v','cb_region','cb_q'].forEach(k=>{try{localStorage.removeItem(k)}catch(e){}});render()}">지우기</button></b></div>
      <div class="kv"><span>매장 운영자</span><b><a href="admin.html" style="color:var(--t0)">관리자 페이지 ›</a></b></div>
      <div class="kv"><span>개발자</span><b><a href="docs.html" style="color:var(--t0)">API 문서 ›</a></b></div>
      <div class="kv"><span>데이터 모드</span><b>${CB.mode() === "apis" ? "APIS 실시간" : CB.mode() === "local" ? "브라우저 로컬 더미" : "서버"}</b></div>
      ${CB.mode() === "apis" ? `<div class="kv"><span>갱신</span><b>${esc(m.updated_label || "연결 중")}</b></div>
      <div class="kv"><span>데이터 생성</span><b>${esc(m.generated_at ? m.generated_at.slice(5, 16).replace("-", "/").replace("T", " ") : "-")}</b></div>` : ""}
      <p class="note">${CB.mode() === "apis" ? "매장·토너먼트 정보 출처: APIS (apislive.com) 공개 데이터" : "데모 데이터 · 모든 매장·대회·숫자는 가상입니다."}</p></div>`;
  },
};

function promoHref(p) {
  const l = p.link || {};
  if (l.type === "game") return `#/game/${esc(l.id)}`;
  if (l.type === "comp") return `#/comp/${esc(l.id)}`;
  if (l.type === "venue") return `#/venue/${esc(l.id)}`;
  if (l.type === "tab") return `#/${esc(l.id)}`;
  if (l.type === "page") return `${esc(l.id)}.html`;
  return "#/home";
}
function findNear() {
  if (!navigator.geolocation) return toast("이 브라우저는 위치를 지원하지 않아요");
  toast("위치 확인 중…");
  navigator.geolocation.getCurrentPosition(async p => {
    try {
      const qs = new URLSearchParams({ date: S.meta.today, near: `${p.coords.latitude},${p.coords.longitude}`, sort: "distance" });
      const d = await api("/api/games?" + qs);
      S.near = d.games.filter(g => g.state !== "FINISHED").slice(0, 8);
      render();
    } catch (e) { toast(e.message); }
  }, () => toast("위치 권한을 허용해 주세요"), { timeout: 8000, maximumAge: 600000 });
}

/* ---------- 푸시 화면 (상세) ---------- */
const P = { dtab: "main" };

const PUSH = {
  async game(id) {
    const g = await api("/api/games/" + encodeURIComponent(id));
    const c = g.clock, s = g.stats, fav = !!favG()[g.id];
    if (g.venue) addRecent(g.venue);
    P.title = `${g.name} · ${g.venue?.name || ""}`;
    const live = g.state === "PLAYING" || g.state === "PAUSED";
    const seg = g.segments[c.seg] || { sec: 1 };
    const pct = live ? Math.min(100, (1 - c.remaining / seg.sec) * 100) : 0;
    const bigLabel = g.state === "WAITING" ? `시작까지 · ${hhmm(g.start_ts)}` : c.on_break ? `BREAK · LV ${c.level ? c.level.lv : "-"} 이후` : c.level ? `LEVEL ${c.level.lv}` : "레벨 정보 없음";
    const head = `<header class="hd"><button class="ic back" onclick="goBack()" aria-label="뒤로">${IC.back}</button><h1 style="font-size:16px">${vname(g)}</h1>
      <button class="ic" onclick="share(P.title)" aria-label="공유">${IC.share}</button>
      <button class="ic${fav ? " on" : ""}" data-act="fav" data-kind="g" data-id="${esc(g.id)}" data-name="${esc(g.name)}" aria-label="즐겨찾기">${IC.star}</button></header>`;
    const clock = `<div class="dclk"><a class="full" href="#/clock/${g.id}">TV 모드 ⤢</a>
      <div class="ph">${stBadge(g)}${regBadge(g)}</div>
      <div class="lvl">${bigLabel}</div>
      <div class="big">${g.state === "FINISHED" ? "종료" : timer(g, "clock")}</div>
      <div class="bl num">${blind(c.on_break ? c.next : c.level)}</div>
      <div class="nx">${c.next && !c.on_break ? `다음 LV${c.next.lv} · <span class="num">${blind(c.next).replace(/<\/?small>/g, "")}</span>` : c.on_break ? "휴식 후 블라인드" : ""}</div>
      ${live ? `<div class="bar"><i data-bar-end="${c.end_at || ""}" data-bar-len="${seg.sec}" style="width:${pct}%"></i></div>` : ""}</div>`;
    const grid = `<div class="grid">
      <div><b class="num">${fmt(s.entries)}</b><span>엔트리${s.reentries ? ` (리엔 ${s.reentries})` : ""}</span></div>
      <div><b class="num">${fmt(s.players_left)}</b><span>남은 인원</span></div>
      <div><b class="num">${s.avg_bb ?? "-"}<small style="font-size:12px">BB</small></b><span>평균 ${fmt(s.avg_stack)}</span></div>
      <div><b class="num">${fmt(s.total_chips)}</b><span>총 칩</span></div>
      <div><b class="num">${c.reg_open ? (c.reg_close_in != null ? `<span data-cd="${now() + c.reg_close_in * 1000}" data-run="${c.running ? 1 : 0}">${mmss(c.reg_close_in)}</span>` : (g.reg_close_level != null ? "LV" + g.reg_close_level : "-")) : (g.state === "FINISHED" ? "마감" : "-")}</b><span>등록 마감${g.reg_close_level != null ? ` (LV${g.reg_close_level})` : ""}</span></div>
      <div><b class="num">${c.next_break_in != null ? `<span data-cd="${now() + c.next_break_in * 1000}" data-run="${c.running ? 1 : 0}">${mmss(c.next_break_in)}</span>` : c.on_break ? "휴식 중" : "-"}</b><span>다음 휴식</span></div></div>`;
    const tabs = [["main", "메인"], ["str", "블라인드"], ["pay", "프라이즈"], ["venue", "매장정보"]];
    return head + `<div class="dhd"><a class="v" href="#/venue/${g.venue_id}">${vname(g)} ›</a><h2>${esc(g.name)}</h2>
        <div class="t3" style="display:flex;gap:6px;flex-wrap:wrap">${(g.tags || []).map(t => `<span class="badge b-tag">${esc(t)}</span>`).join("")}</div></div>` +
      clock + grid +
      `<div class="tabs2">${tabs.map(([k, t]) => `<button class="${P.dtab === k ? "on" : ""}" onclick="P.dtab='${k}';renderPush()">${t}</button>`).join("")}</div>
      <div class="pane">${this["g_" + P.dtab](g)}</div>`;
  },
  g_main(g) {
    const bt = g.buyin_types.map(b => `${esc(b.name)} ${money(b.price)} · ${fmt(b.chips)}칩`).join("<br>");
    return `<div class="kv"><span>시작</span><b>${g.date.slice(5).replace("-", "/")} ${hhmm(g.start_ts)}</b></div>
      <div class="kv"><span>참가비</span><b>${bt || "-"}</b></div>
      <div class="kv"><span>시작 칩</span><b class="num">${fmt(g.starting_chips)}</b></div>
      <div class="kv"><span>개런티</span><b>${g.guarantee ? money(g.guarantee) : "없음"}</b></div>
      <div class="kv"><span>등록 마감</span><b>${g.reg_close_level != null ? `LV ${g.reg_close_level} 종료 시` : "-"}</b></div>
      <div class="kv"><span>최대 인원</span><b>${g.max_players != null ? fmt(g.max_players) + "명" : "-"}</b></div>
      <div class="kv"><span>구조</span><b>${esc(g.structure_name)}</b></div>
      ${g.notes ? `<div class="kv"><span>안내</span><b>${esc(g.notes)}</b></div>` : ""}
      ${g.same_venue.length ? `<div class="sec-h"><h2>이 매장 다른 게임</h2></div><div class="list">${g.same_venue.map(x => gameRow(x, { noVenue: true })).join("")}</div>` : ""}`;
  },
  g_str(g) {
    const cur = g.state === "WAITING" ? -1 : g.clock.seg;
    const rows = g.segments.map((s, i) => {
      const lv = g.structure.levels[s.idx];
      const cls = i === cur ? "cur" : i < cur ? "past" : "";
      if (s.kind === "break") return `<tr class="brk ${cls}" ${i === cur ? 'id="curRow"' : ""}><td colspan="4">— 휴식 ${s.sec / 60}분 —</td></tr>`;
      return `<tr class="${cls}" ${i === cur ? 'id="curRow"' : ""}><td>${lv.lv}</td><td class="num">${fmt(lv.sb)} / ${fmt(lv.bb)}</td><td class="num">${lv.ante ? fmt(lv.ante) : "-"}</td><td>${lv.min}분</td></tr>`;
    }).join("");
    return `<table class="tb"><thead><tr><th>LV</th><th>SB / BB</th><th>앤티</th><th>시간</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="note">앤티는 빅블라인드 앤티(BBA) 기준${g.reg_close_level != null ? ` · 등록 마감 LV ${g.reg_close_level}` : ""}</p>`;
  },
  g_pay(g) {
    if (!g.payouts.length) {
      return g.prize_summary
        ? `<div class="prize">${esc(g.prize_summary)}</div><p class="note">매장 공지 기준 · 참가 인원에 따라 달라질 수 있습니다.</p>`
        : '<div class="empty">프라이즈 정보가 아직 없어요</div>';
    }
    return `<table class="tb"><thead><tr><th>순위</th><th>프라이즈</th></tr></thead><tbody>
      ${g.payouts.map(p => `<tr><td>${esc(p.place)}</td><td>${esc(p.prize)}</td></tr>`).join("")}</tbody></table>
      <p class="note">ITM ${g.payouts.length}구간 · 매장 사정에 따라 바뀔 수 있습니다.</p>`;
  },
  g_venue(g) { return venueInfo(g.venue); },

  async venue(id) {
    const v = await api("/api/venues/" + encodeURIComponent(id));
    addRecent(v);
    P.title = v.name;
    const fav = !!favV()[v.id];
    const byDay = {};
    v.games.forEach(g => (byDay[g.date] = byDay[g.date] || []).push(g));
    const m = await meta();
    return `<header class="hd"><button class="ic back" onclick="goBack()" aria-label="뒤로">${IC.back}</button><h1 style="font-size:16px">매장</h1>
      <button class="ic" onclick="share(P.title)" aria-label="공유">${IC.share}</button>
      <button class="ic${fav ? " on" : ""}" data-act="fav" data-kind="v" data-id="${esc(v.id)}" data-name="${esc(v.name)}" data-region="${esc(v.region)}" aria-label="즐겨찾기">${IC.star}</button></header>
      <div class="dhd"><span class="v">${esc(v.region)}</span><h2>${esc(v.name)}</h2><div style="font-size:13px;color:var(--t1)">${esc(v.intro)}</div></div>
      <div class="pane">${venueInfo(v, true)}
      ${Object.entries(byDay).map(([d, gs]) => `<div class="sec-h"><h2>${dayLabel(d, m.today)}</h2><span style="font-size:13px;color:var(--t2)">${gs.length}게임</span></div>
        <div class="list">${gs.map(g => gameRow(g, { noVenue: true })).join("")}</div>`).join("") || '<div class="empty">예정된 게임이 없어요</div>'}</div>`;
  },

  async comp(id) {
    const c = await api("/api/competitions/" + encodeURIComponent(id));
    P.title = c.name;
    return `<header class="hd"><button class="ic back" onclick="goBack()" aria-label="뒤로">${IC.back}</button><h1 style="font-size:16px">대회</h1>
      <button class="ic" onclick="share(P.title)" aria-label="공유">${IC.share}</button></header>
      <div class="dhd"><span class="v">${esc(c.country)} · ${esc(c.city)}</span><h2>${esc(c.name)}</h2>
      <div style="font-size:14px;color:var(--t1)">${c.start_date} ~ ${c.end_date}</div></div>
      <div class="pane">
        <div class="kv"><span>장소</span><b>${esc(c.venue)}</b></div>
        <div class="kv"><span>주최</span><b>${esc(c.organizer)}</b></div>
        <div class="kv"><span>통화</span><b>${esc(c.currency)}</b></div>
        <div class="sec-h"><h2>이벤트 일정</h2></div>
        <table class="tb"><thead><tr><th>#</th><th>날짜</th><th>바이인</th><th>GTD</th></tr></thead><tbody>
        ${c.events.map(e => `<tr><td><b>${e.no}. ${esc(e.name)}</b>${e.chips ? `<br><small style="color:var(--t2)">시작 ${fmt(e.chips)}칩</small>` : ""}</td><td>${e.date.slice(5).replace("-", "/")}<br><small style="color:var(--t2)">${esc(e.time)}</small></td><td class="num">${e.buyin ? money(e.buyin, c.currency) : "-"}</td><td class="num">${e.guarantee ? money(e.guarantee, c.currency) : "-"}</td></tr>`).join("")}
        </tbody></table>
        ${c.notes ? `<p class="note">${esc(c.notes)}</p>` : ""}</div>`;
  },

  async search() {
    const recent = store.get("cb_q", []);
    return `<header class="hd"><button class="ic back" onclick="goBack()" aria-label="뒤로">${IC.back}</button>
      <label class="sbox">${IC.search.replace("<svg", '<svg width="18" height="18" style="stroke:var(--t2);fill:none;stroke-width:2"')}<input id="q" placeholder="매장, 게임, 지역, 대회 검색" autocomplete="off" value="${esc(P.q || "")}"></label></header>
      <div id="sres">${recent.length && !P.q ? `<div class="sec"><div class="sec-h"><h2>최근 검색</h2><button onclick="store.set('cb_q',[]);renderPush()">지우기</button></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${recent.map(t => `<button class="chip" data-act="q" data-q="${esc(t)}">${esc(t)}</button>`).join("")}</div></div>` : ""}</div>`;
  },
};

function venueInfo(v, short = false) {
  if (!v) return '<div class="empty">매장 정보가 없어요</div>';
  return `<div class="kv"><span>주소</span><b>${esc(v.address || "-")}</b></div>
    ${v.phone ? `<div class="kv"><span>전화</span><b><a href="tel:${esc(v.phone)}" style="color:var(--t0)">${esc(v.phone)}</a></b></div>` : ""}
    ${v.open_chat_url ? `<div class="kv"><span>오픈채팅</span><b><a target="_blank" rel="noopener" style="color:var(--t0)" href="${esc(v.open_chat_url)}">문의하기 ›</a></b></div>` : ""}
    <div class="kv"><span>영업시간</span><b>${esc(v.hours || "-")}</b></div>
    <div class="kv"><span>테이블</span><b>${v.tables != null ? v.tables + "개" : "-"}</b></div>
    ${v.amenities?.length ? `<div class="kv"><span>편의시설</span><b>${v.amenities.map(esc).join(" · ")}</b></div>` : ""}
    <div class="kv"><span>지도</span><b><a target="_blank" rel="noopener" style="color:var(--t0)" href="https://www.openstreetmap.org/?mlat=${v.lat}&mlon=${v.lng}#map=17/${v.lat}/${v.lng}">지도에서 보기 ›</a></b></div>
    ${short ? "" : `<div style="margin-top:14px"><a class="btn" style="width:100%" href="#/venue/${v.id}">매장 전체 일정 보기</a></div>`}`;
}

let searchT;
function bindSearch() {
  const q = $("#q"); if (!q) return;
  if (!P.q) q.focus();
  q.oninput = () => { clearTimeout(searchT); searchT = setTimeout(() => doSearch(q.value, false), 250); };
  q.onkeydown = e => { if (e.key === "Enter") doSearch(q.value); };
}
async function doSearch(text, save = true) {
  P.q = text.trim();
  const q = $("#q"); if (q && q.value !== text) q.value = text;
  const box = $("#sres"); if (!box) return;
  if (!P.q) { box.innerHTML = ""; return; }
  if (save) store.set("cb_q", [P.q, ...store.get("cb_q", []).filter(x => x !== P.q)].slice(0, 10));
  try {
    const d = await api("/api/search?q=" + encodeURIComponent(P.q));
    const none = !d.venues.length && !d.games.length && !d.competitions.length;
    box.innerHTML = none ? `<div class="empty">'${esc(P.q)}' 결과가 없어요</div>` : `<div class="sec">
      ${d.venues.length ? `<div class="sec-h"><h2>매장 ${d.venues.length}</h2></div><div class="list">${d.venues.map(venueRow).join("")}</div>` : ""}
      ${d.games.length ? `<div class="sec-h"><h2>게임 ${d.games.length}</h2></div><div class="list">${d.games.map(g => gameRow(g)).join("")}</div>` : ""}
      ${d.competitions.length ? `<div class="sec-h"><h2>대회 ${d.competitions.length}</h2></div><div class="list">${d.competitions.map(compCard).join("")}</div>` : ""}</div>`;
  } catch (e) { box.innerHTML = errBox(e); }
}

/* ---------- TV 시계 ---------- */
let tvTimer = null;
async function openTV(id) {
  closeTV();
  const el = document.createElement("div");
  el.className = "tv"; el.id = "tv"; el.innerHTML = loading;
  document.body.appendChild(el);
  const draw = async () => {
    try {
      const d = await api(`/api/games/${encodeURIComponent(id)}/clock`);
      const c = d.clock, s = d.stats;
      el.className = "tv " + (c.phase === "break" ? "break" : c.phase === "paused" ? "paused" : "");
      const g = { state: d.state, clock: c, start_ts: now() + c.starts_in * 1000 };
      el.innerHTML = `<img class="mark" src="logo-white.png" alt=""><button class="ic x" onclick="goBack()" aria-label="닫기">${IC.x}</button>
        <div class="vn">${esc(d.venue)}</div><div class="gn">${esc(d.name)}</div>
        <div class="lvl">${d.state === "WAITING" ? "STARTS IN" : c.on_break ? "BREAK" : c.level ? "LEVEL " + c.level.lv : "-"}${c.phase === "paused" ? " · 일시정지" : ""}</div>
        <div class="big">${d.state === "FINISHED" ? "FINISHED" : timer(g, "clock")}</div>
        <div class="bl num">${blind(c.on_break ? c.next : c.level).replace(/<\/?small>/g, "")}</div>
        <div class="nx">${c.next && !c.on_break ? `NEXT ${blind(c.next).replace(/<\/?small>/g, "")}` : ""}</div>
        <div class="sts"><div><b class="num">${fmt(s.players_left)}/${fmt(s.entries)}</b>PLAYERS</div><div><b class="num">${fmt(s.avg_stack)}</b>AVG STACK</div>
        <div><b class="num">${c.next_break_in != null ? mmss(c.next_break_in) : "-"}</b>NEXT BREAK</div></div>
        <button class="btn" style="margin-top:3vh" onclick="document.documentElement.requestFullscreen?.()">전체화면</button>`;
      tick();
    } catch (e) { el.innerHTML = `<button class="ic x" onclick="goBack()">${IC.x}</button>` + errBox(e); }
  };
  await draw();
  tvTimer = setInterval(() => { if (!document.hidden) draw(); }, 5000);
}
function closeTV() { clearInterval(tvTimer); tvTimer = null; $("#tv")?.remove(); }

/* ---------- 라우터 ---------- */
let curTab = "home", pushKey = null, navs = 0;

function keepScroll(root, fn) {
  const saved = $$("[data-keep]", root).map(e => [e.dataset.keep, e.scrollLeft]);
  fn();
  saved.forEach(([k, x]) => { const e = $(`[data-keep="${k}"]`, root); if (e) e.scrollLeft = x; });
}

let rendering = 0;
async function render() {
  const my = ++rendering, view = $("#view");
  $$("#tabs a").forEach(a => a.classList.toggle("on", a.dataset.t === curTab));
  if (!view.dataset.tab || view.dataset.tab !== curTab) { view.innerHTML = loading; window.scrollTo(0, 0); }
  try {
    const html = await VIEWS[curTab]();
    if (my !== rendering) return;
    keepScroll(view, () => { view.innerHTML = html; });
    view.dataset.tab = curTab;
  } catch (e) { if (my === rendering) view.innerHTML = errBox(e); }
  tick();
}

async function renderPush(first) {
  const stack = $("#stack");
  if (!pushKey) { stack.innerHTML = ""; return; }
  const [kind, id] = pushKey;
  let pg = $(".pg", stack);
  if (!pg || first) { stack.innerHTML = `<div class="push"><div class="pg">${loading}</div></div>`; pg = $(".pg", stack); }
  try {
    const key = pushKey.join("/");
    const html = await PUSH[kind](id);
    if (pushKey.join("/") !== key) return;
    const top = pg.scrollTop;
    keepScroll(pg, () => { pg.innerHTML = html; });
    pg.scrollTop = top;
    if (kind === "search") { bindSearch(); if (P.q) doSearch(P.q, false); }
    if (first && kind === "game" && P.dtab === "str") $("#curRow", pg)?.scrollIntoView({ block: "center" });
  } catch (e) { pg.innerHTML = `<header class="hd"><button class="ic back" onclick="goBack()">${IC.back}</button><h1></h1></header>` + errBox(e); }
  tick();
}

function goBack() { if (navs > 0) history.back(); else location.hash = "#/home"; }

function route() {
  const [a = "home", b] = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  closeTV();
  if ((TABS.includes(a) && !b) || !a) {
    pushKey = null; renderPush();
    if (a !== curTab || !$("#view").dataset.tab) { curTab = a || "home"; render(); }
    else { $$("#tabs a").forEach(x => x.classList.toggle("on", x.dataset.t === curTab)); }
    return;
  }
  if (!$("#view").dataset.tab) render();
  if (a === "clock" && b) { pushKey = null; renderPush(); openTV(b); return; }
  if (PUSH[a] && (b || a === "search")) {
    const changed = !pushKey || pushKey.join("/") !== `${a}/${b}`;
    if (changed && a === "game") P.dtab = "main";
    if (changed && a === "search") P.q = "";
    pushKey = [a, b];
    renderPush(true);
    return;
  }
  location.hash = "#/home";
}
window.addEventListener("hashchange", () => { navs++; route(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && ($("#tv") || pushKey)) goBack(); });
$$("#tabs a").forEach(a => a.addEventListener("click", e => {
  if (a.dataset.t === curTab && !pushKey) { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }
}));

/* ---------- 1초 틱 + 주기 갱신 ---------- */
let refreshT = null;
function softRefresh(delay = 1200) {
  if (refreshT) return;
  refreshT = setTimeout(() => {
    refreshT = null;
    if (document.hidden || $("#tv")) return;
    if (pushKey && pushKey[0] !== "search") renderPush(); else if (!pushKey) render();
  }, delay);
}
function tick() {
  const t = now();
  $$("[data-end]").forEach(e => {
    const rem = (+e.dataset.end - t) / 1000;
    e.textContent = mmss(rem);
    if (rem <= 0) softRefresh();
  });
  $$("[data-start]").forEach(e => {
    const rem = (+e.dataset.start - t) / 1000;
    e.textContent = e.dataset.f === "clock" ? mmss(rem) : untilText(rem);
    if (rem <= 0) softRefresh(16000); // 서버 자동 시작은 최대 15초 주기
  });
  $$("[data-cd]").forEach(e => { if (e.dataset.run === "1") e.textContent = mmss((+e.dataset.cd - t) / 1000); });
  $$("[data-bar-end]").forEach(e => {
    if (!e.dataset.barEnd) return;
    const rem = (+e.dataset.barEnd - t) / 1000;
    e.style.width = Math.max(0, Math.min(100, (1 - rem / +e.dataset.barLen) * 100)) + "%";
  });
}
setInterval(tick, 1000);
setInterval(() => { if (!document.hidden) softRefresh(0); }, 15000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) softRefresh(0); });

CB.detect().then(route);
