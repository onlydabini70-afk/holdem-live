/* OVERLAY HUNTER ← APIS 실시간 연동 (apislive.com 공개 주소 3개만 사용, 키 없음)
   - GET https://apislive.com/data.json          (60초, ETag/If-None-Match)
   - GET https://apislive.com/live                (10초)
   - GET https://apislive.com/live?clock=list     (10초)
   탭이 숨겨지면 폴링 중단. 응답은 기존 더미와 같은 모양으로 변환해서 화면 코드 변경 최소.
   실패해도 더미로 대체하지 않고, 마지막 성공값 + 갱신 시각을 유지한다. 없는 값은 null → 화면에서 '-'. */
(function (global) {
  "use strict";
  const BASE = "https://apislive.com";
  const KST = 9 * 3600 * 1000;
  const LEVEL_DEFAULT_MIN = 15, BREAK_DEFAULT_MIN = 10;
  const CLOCK_STALE_MS = 40 * 60 * 1000;

  const now = () => Date.now();
  const nowS = () => Date.now() / 1000;
  const dayOf = ts => new Date(ts * 1000 + KST).toISOString().slice(0, 10);
  const todayStr = (d = 0) => dayOf(nowS() + d * 86400);
  const parseMs = s => { if (!s) return NaN; const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + "+09:00"); return t; };
  const num = v => (typeof v === "number" && isFinite(v)) ? v : null;

  /* ---------- 네트워크 (공개 주소 3개 전용) ---------- */
  const cache = {
    data: null, dataEtag: null, live: null, clock: null,
    sync: { data: 0, live: 0, clock: 0 }, lastOk: 0, lastErr: 0, errMsg: "",
  };
  let polling = false, timers = [];

  async function pull(url, opts) {
    const r = await fetch(url, Object.assign({ cache: "no-store", mode: "cors" }, opts));
    return r;
  }
  async function pullData() {
    const r = await pull(BASE + "/data.json", cache.dataEtag ? { headers: { "If-None-Match": cache.dataEtag } } : {});
    if (r.status === 304) { cache.sync.data = now(); return; }
    if (!r.ok) throw new Error("data.json " + r.status);
    const j = await r.json();
    cache.data = j; cache.dataEtag = r.headers.get("ETag") || cache.dataEtag; cache.sync.data = now();
  }
  async function pullLive() {
    const r = await pull(BASE + "/live");
    if (!r.ok) throw new Error("live " + r.status);
    cache.live = await r.json(); cache.sync.live = now();
  }
  async function pullClock() {
    const r = await pull(BASE + "/live?clock=list");
    if (!r.ok) throw new Error("clock " + r.status);
    cache.clock = await r.json(); cache.sync.clock = now();
  }
  async function refreshAll(force) {
    const jobs = [];
    if (force || !cache.data || now() - cache.sync.data > 60000) jobs.push(pullData());
    if (force || !cache.live || now() - cache.sync.live > 10000) jobs.push(pullLive());
    if (force || !cache.clock || now() - cache.sync.clock > 10000) jobs.push(pullClock());
    if (!jobs.length) return;
    try {
      await Promise.all(jobs);
      cache.lastOk = now(); cache.errMsg = "";
    } catch (e) {
      cache.lastErr = now(); cache.errMsg = e.message || String(e);
      if (!cache.data && !cache.live) throw e;        // 아직 한 번도 못 받았으면 실패를 올린다
    }
  }
  function startPolling() {
    if (polling) return;
    polling = true;
    const tick = (fn, ms) => timers.push(setInterval(() => { if (!document.hidden) fn().catch(() => { cache.lastErr = now(); }); }, ms));
    tick(() => pullData(), 60000);
    tick(() => pullLive(), 10000);
    tick(() => pullClock(), 10000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshAll(false).catch(() => { }); });
  }

  /* ---------- 블라인드 시퀀스 / 현재 칸 계산 ---------- */
  function buildSeq(structure, breaks) {
    const levels = (structure || []).slice().sort((a, b) => (a.level || 0) - (b.level || 0));
    const bk = breaks || [];
    const seq = [];
    for (const lv of levels) {
      seq.push({ kind: "level", lv: lv.level, sb: num(lv.sb), bb: num(lv.bb), ante: num(lv.ante) || 0,
        min: num(lv.duration_min) || LEVEL_DEFAULT_MIN });
      for (const b of bk) if ((b.after_level) === lv.level)
        seq.push({ kind: "break", after: lv.level, min: num(b.duration_min) || BREAK_DEFAULT_MIN });
    }
    return seq;
  }
  const levelObj = cell => cell && cell.kind === "level"
    ? { lv: cell.lv, sb: cell.sb, bb: cell.bb, ante: cell.ante, min: cell.min } : null;
  function nextLevelFrom(seq, idx) {
    for (let i = idx + 1; i < seq.length; i++) if (seq[i].kind === "level") return levelObj(seq[i]);
    return null;
  }
  // idx 칸의 남은시간 remaining(초)에서 시작해, 조건 cell 까지의 초 합
  function timeUntil(seq, idx, remaining, pred) {
    let t = remaining;
    if (pred(seq[idx], idx)) return 0;
    for (let i = idx + 1; i < seq.length; i++) { if (pred(seq[i], i)) return Math.floor(t); t += seq[i].min * 60; }
    return null;
  }

  function clockFromSeq(seq, idx, remaining, running, onBreak, regClose) {
    const cell = seq[idx] || { kind: "level", min: 1 };
    const curLevel = cell.kind === "level" ? levelObj(cell)
      : levelObj(seq.slice(0, idx).reverse().find(c => c.kind === "level")) || null;
    const nxt = nextLevelFrom(seq, idx);
    const nextBreak = cell.kind === "level" ? timeUntil(seq, idx, remaining, (c, i) => i > idx && c.kind === "break") : null;
    let regCloseIn = null, regOpen = false;
    if (regClose && curLevel) {
      regOpen = running && curLevel.lv <= regClose;
      if (regOpen) regCloseIn = timeUntil(seq, idx, remaining, c => c.kind === "level" && c.lv > regClose);
    }
    return {
      phase: !running ? "paused" : onBreak ? "break" : "level", running, on_break: onBreak,
      level: curLevel, next: nxt, remaining: Math.max(0, Math.floor(remaining)),
      end_at: running ? now() + Math.max(0, remaining) * 1000 : null,
      starts_in: 0, next_break_in: nextBreak, reg_open: regOpen, reg_close_in: regCloseIn,
      elapsed: null, seg: idx,
    };
  }
  function waitingClock(seq, startTs) {
    const first = seq.find(c => c.kind === "level");
    return {
      phase: "waiting", running: false, on_break: false, level: levelObj(first),
      next: nextLevelFrom(seq, seq.indexOf(first)), remaining: first ? first.min * 60 : 0, end_at: null,
      starts_in: Math.max(0, Math.floor(startTs - nowS())), next_break_in: null,
      reg_open: true, reg_close_in: null, elapsed: null, seg: 0,
    };
  }

  /* ---------- 변환: APIS → 우리 DB ---------- */
  function mapVenue(v, hasGames) {
    return {
      id: v.db_id || v.id, name: v.name || "-", region: v.region || "-", area: v.area || "",
      address: v.address || "-", lat: num(v.lat), lng: num(v.lng),
      brand: v.brand || "", category: v.category || "", open_chat_url: v.open_chat_url || "",
      parking: v.parking || "", has_games: !!hasGames,
      // contact 는 의도적으로 제외 (화면 노출 금지)
      intro: [v.area, v.brand].filter(Boolean).join(" · ") || "홀덤 매장",
      amenities: v.parking ? ["주차 " + v.parking] : [],
      tables: null, phone: null, hours: null,
    };
  }
  function structName(structure) {
    const d = num((structure || [])[0] && structure[0].duration_min);
    return d ? d + "분 레벨" : "구조 정보";
  }
  function mapGame(t, venue) {
    const gid = t._gameid || (t._key ? t._key.replace(/[^\w-]/g, "_") : null);
    const startTs = parseMs(`${t.date}T${(t.start_time || "00:00")}:00`) / 1000;
    const chips = num(t.starting_chips);
    const bt = [{ key: "buyin", name: "바이인", price: num(t.buy_in) || 0, chips: chips || 0 }];
    if (num(t.reentry_chips)) bt.push({ key: "reentry", name: "리엔트리", price: num(t.buy_in) || 0, chips: t.reentry_chips });
    const tags = [t.type, t.league_tag].filter(Boolean);
    return {
      id: gid, _key: t._key || null, _gameid: t._gameid || null,
      name: t.name || "-", tags, venue_id: venue.id, venue_name: venue.name,
      start_ts: Math.round((isFinite(startTs) ? startTs : nowS()) * 1000), start_s: isFinite(startTs) ? startTs : nowS(),
      date: t.date || todayStr(), starting_chips: chips, guarantee: num(t.guarantee),
      reg_close_level: num(t.late_reg_level), max_players: null, buyin: num(t.buy_in),
      buyin_types: bt, structure: t.structure || [], breaks: t.breaks || [],
      structure_name: structName(t.structure), level_min: num((t.structure || [])[0] && t.structure[0].duration_min),
      prize_summary: t.prize_summary || "", notes: "",
      base_status: t.status || "", _clock: null, _live: null,
    };
  }

  function buildDB() {
    const d = cache.data || {};
    const venuesArr = d.venues || [];
    const venues = {}, games = {};
    const byKey = {}, byGid = {};
    for (const v of venuesArr) {
      const mv = mapVenue(v, (v.tournaments || []).length > 0);
      venues[mv.id] = mv;
      for (const t of v.tournaments || []) {
        const g = mapGame(t, mv);
        if (!g.id || games[g.id]) continue;
        games[g.id] = g;
        if (g._key) byKey[g._key] = g;
        if (g._gameid) byGid[g._gameid] = g;
      }
    }
    // directory: 게임 없는 매장 목록(검색/목록용)
    for (const dv of d.directory || []) {
      const id = dv.id;
      if (!venues[id]) venues[id] = mapVenue(dv, false);
    }
    // /live 붙이기 (id = _key)
    for (const x of cache.live || []) {
      const g = byKey[x.id]; if (!g) continue;
      g._live = { status: x.status, live: x.live || null };
    }
    // clock=list 붙이기 (game_id = _gameid), 40분 초과 제외
    for (const c of cache.clock || []) {
      const g = byGid[c.game_id]; if (!g) continue;
      const up = parseMs(c.updated_at);
      if (isFinite(up) && now() - up > CLOCK_STALE_MS) continue;
      g._clock = c;
    }
    // 각 게임의 상태/시계/통계 확정 (실시간 우선)
    for (const g of Object.values(games)) finalize(g);
    return { venues, games, generated_at: d._generated_at || null };
  }

  function finalize(g) {
    let state = null, clock = null, stats = emptyStats();
    const live = g._live && g._live.live;
    const c = g._clock;

    if (c && c.state) {                                   // 클락(가장 정확한 블라인드/타이밍)
      const seq = buildSeq(c.structure, c.breaks);
      const st = c.state, status = st.status;
      let idx = num(st.levelIdx) || 0, end = parseMs(st.endsAt);
      const running = status === "running" || status === "break";
      if (running && isFinite(end)) {
        while (end <= now() && idx < seq.length - 1) { idx++; end += (seq[idx].min || 1) * 60000; }
      }
      const remaining = isFinite(end) ? (end - now()) / 1000 : (seq[idx] ? seq[idx].min * 60 : 0);
      const onBreak = (seq[idx] && seq[idx].kind === "break") || status === "break";
      clock = clockFromSeq(seq, idx, remaining, running, onBreak, num(st.regCloseLevel) || g.reg_close_level);
      state = running ? "PLAYING" : "PAUSED";
      const cnt = c.counts || {};
      // counts 키는 buyin / early / rebuy 등 매장마다 다름 → 애드온 계열만 빼고 모두 엔트리로 합산
      let entries = 0, seen = false;
      for (const k in cnt) { const n = num(cnt[k]); if (n == null || /addon/i.test(k)) continue; entries += n; seen = true; }
      const reb = num(cnt.rebuy);
      stats = {
        entries: seen ? entries : null, unique: seen ? entries - (reb || 0) : null,
        reentries: reb, addons: num(cnt.addon),
        players_left: num(c.players_left), total_chips: null, avg_stack: null, avg_bb: null,
      };
    } else if (live && g._live.status === "PLAYING") {    // 실시간 라이브
      const seq = buildSeq(g.structure, g.breaks);
      let idx = seq.findIndex(s => s.kind === "level" && s.lv === live.level);
      if (idx < 0) idx = 0;
      const remaining = num(live.level_sec_left) != null ? live.level_sec_left : (seq[idx] ? seq[idx].min * 60 : 0);
      clock = clockFromSeq(seq, idx, remaining, true, false, g.reg_close_level);
      if (!clock.level) clock.level = { lv: live.level, sb: num(live.sb), bb: num(live.bb), ante: num(live.ante) || 0, min: null };
      state = "PLAYING";
      const avg = num(live.avg_stack), bb = num(live.bb);
      const uniq = num(live.entries), reb = num(live.rebuys);   // APIS: entries=순수 바이인, rebuys=리엔트리
      stats = {
        entries: uniq == null ? null : uniq + (reb || 0), unique: uniq,
        reentries: reb, addons: null, players_left: num(live.players_left),
        total_chips: num(live.total_chips), avg_stack: avg, avg_bb: (avg && bb) ? Math.round(avg / bb * 10) / 10 : null,
      };
    }

    if (!state) {                                         // 실시간 없음 → 일정 기준
      const waiting = (g._live && g._live.status === "WAITING") || g.base_status === "upcoming" || g.start_s > nowS();
      if (g.base_status === "finished" && !(g._live && g._live.status === "WAITING")) state = "FINISHED";
      else state = waiting ? "WAITING" : (g.base_status === "live" ? "PLAYING" : "WAITING");
    }
    const seq = buildSeq(g.structure, g.breaks);
    if (!clock) {
      if (state === "WAITING") clock = waitingClock(seq, g.start_s);
      else if (state === "PLAYING") clock = unknownClock();   // 진행 중이나 실시간 값 없음 → 지어내지 않고 '-'
      else if (state === "FINISHED") {
        const last = seq.slice().reverse().find(s => s.kind === "level");
        clock = { phase: "finished", running: false, on_break: false, level: levelObj(last) || levelObj(seq[0]),
          next: null, remaining: 0, end_at: null, starts_in: 0, next_break_in: null, reg_open: false, reg_close_in: null, elapsed: null, seg: Math.max(0, seq.length - 1) };
      } else clock = waitingClock(seq, g.start_s);
    }
    g.state = state; g.clock = clock; g.stats = stats; g.segments = seq.map((s, i) => ({ kind: s.kind, idx: i, sec: s.min * 60 }));
    g.structure_levels = seq.filter(s => s.kind === "level").map(s => ({ lv: s.lv, sb: s.sb, bb: s.bb, ante: s.ante, min: s.min }));
  }
  const unknownClock = () => ({
    phase: "unknown", running: false, on_break: false, level: null, next: null, remaining: null,
    end_at: null, starts_in: 0, next_break_in: null, reg_open: false, reg_close_in: null, elapsed: null, seg: 0,
  });
  const emptyStats = () => ({ entries: null, unique: null, reentries: null, addons: null, players_left: null, total_chips: null, avg_stack: null, avg_bb: null });

  /* ---------- 직렬화 (기존 API 응답 모양) ---------- */
  const venueBrief = v => ({ id: v.id, name: v.name, region: v.region, address: v.address, lat: v.lat, lng: v.lng });
  function gameOut(g, full) {
    const out = {
      id: g.id, name: g.name, tags: g.tags, venue: venueBrief2(g), venue_id: g.venue_id, state: g.state,
      start_at: new Date(g.start_ts + KST).toISOString().slice(0, 19) + "+09:00", start_ts: g.start_ts, date: g.date,
      starting_chips: g.starting_chips, guarantee: g.guarantee || 0, reg_close_level: g.reg_close_level,
      max_players: g.max_players, structure_id: "apis", structure_name: g.structure_name, level_min: g.level_min,
      buyin: g.buyin, clock: g.clock, stats: g.stats,
    };
    if (full) {
      out.buyin_types = g.buyin_types; out.payouts = []; out.notes = g.notes;
      out.prize_summary = g.prize_summary; out.segments = g.segments;
      out.structure = { id: "apis", name: g.structure_name, levels: g.structure_levels,
        breaks: Object.fromEntries((g.breaks || []).map(b => [String(b.after_level), b.duration_min || BREAK_DEFAULT_MIN])) };
      out.started_at = null; out.finished_at = null;
      out.venue = DBV()[g.venue_id] ? fullVenue(DBV()[g.venue_id]) : null;
    }
    return out;
  }
  let _db = null, _dbAt = 0;
  function DB() { if (!_db || now() - _dbAt > 2000) { _db = buildDB(); _dbAt = now(); } return _db; }
  const DBV = () => DB().venues;
  function venueBrief2(g) { const v = DBV()[g.venue_id]; return v ? venueBrief(v) : { id: g.venue_id, name: g.venue_name, region: "-", address: "-", lat: null, lng: null }; }
  function fullVenue(v) {
    return { id: v.id, name: v.name, region: v.region, address: v.address, lat: v.lat, lng: v.lng,
      tables: v.tables, phone: null, hours: v.hours, intro: v.intro, amenities: v.amenities,
      open_chat_url: v.open_chat_url || null };
  }
  function dist(aLat, aLng, bLat, bLng) {
    if ([aLat, aLng, bLat, bLng].some(x => x == null)) return null;
    const r = 6371, rad = x => x * Math.PI / 180, p1 = rad(aLat), p2 = rad(bLat), dp = rad(bLat - aLat), dl = rad(bLng - aLng);
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return Math.round(2 * r * Math.asin(Math.sqrt(h)) * 10) / 10;
  }
  const LIVE2 = ["PLAYING", "PAUSED"];
  const GROUPS = { live: LIVE2, playing: ["PLAYING"], paused: ["PAUSED"], upcoming: ["WAITING"], waiting: ["WAITING"], done: ["FINISHED"], finished: ["FINISHED"] };

  function queryGames(q) {
    const db = DB(), status = (q.status || "all").toLowerCase(), text = (q.q || "").trim().toLowerCase();
    const ids = q.ids ? new Set(q.ids.split(",").filter(Boolean)) : null;
    const near = q.near ? q.near.split(",").map(Number) : null;
    const rows = [];
    for (const g of Object.values(db.games)) {
      const v = db.venues[g.venue_id] || {};
      if (ids && !ids.has(g.id)) continue;
      if (status !== "all" && !(GROUPS[status] || [status.toUpperCase()]).includes(g.state)) continue;
      if (q.region && v.region !== q.region) continue;
      if (q.venue && g.venue_id !== q.venue) continue;
      if (q.date && g.date !== q.date) continue;
      if (text && !(g.name + " " + (v.name || "") + " " + g.tags.join(" ")).toLowerCase().includes(text)) continue;
      const o = gameOut(g);
      if (q.reg === "open" && !(o.clock.reg_open && (g.state !== "WAITING" || g.start_s - nowS() < 4 * 3600))) continue;
      if (near) o.distance_km = dist(near[0], near[1], v.lat, v.lng);
      rows.push(o);
    }
    const keys = {
      start: o => o.start_ts, entries: o => -(o.stats.entries || 0), players: o => -(o.stats.players_left || 0),
      guarantee: o => -(o.guarantee || 0), distance: o => o.distance_km == null ? 9e9 : o.distance_km,
      level: o => -((o.clock.level && o.clock.level.lv) || 0),
    };
    const sort = keys[q.sort] ? q.sort : "start";
    rows.sort((a, b) => keys[sort](a) - keys[sort](b));
    return rows.slice(0, Math.min(parseInt(q.limit || 400, 10), 1000));
  }
  const REGION_ORDER = ["서울", "경기", "인천", "강원", "대전", "충남", "충북", "세종", "부산", "대구", "울산", "경남", "경북", "광주", "전남", "전북", "제주"];
  function regionsWithGames() {
    const db = DB(), s = new Set();
    for (const g of Object.values(db.games)) { const v = db.venues[g.venue_id]; if (v && v.region && v.region !== "-") s.add(v.region); }
    return [...s].sort((a, b) => (REGION_ORDER.indexOf(a) + 1 || 99) - (REGION_ORDER.indexOf(b) + 1 || 99));
  }

  const ROUTES = [
    ["/api/health", () => ({ ok: true, mode: "apis", games: Object.keys(DB().games).length, venues: Object.keys(DB().venues).length, generated_at: DB().generated_at })],
    ["/api/meta", () => ({ regions: regionsWithGames(), today: todayStr(), dates: [0, 1, 2, 3].map(d => todayStr(d)),
      structures: [], demo: false, mode: "apis", source: "OVERLAY HUNTER", generated_at: DB().generated_at,
      last_sync: cache.lastOk || null, stale: staleFlag(), updated_label: updatedLabel() })],
    ["/api/home", () => {
      const today = queryGames({ date: todayStr() });
      const live = queryGames({ status: "live", sort: "players" });
      const openReg = queryGames({ reg: "open", sort: "start" }).filter(g => g.state !== "WAITING" || g.start_ts / 1000 - nowS() < 3 * 3600).slice(0, 10);
      const feat = live.slice(0, 3).map((g, i) => ({ game_id: g.id, priority: i + 1, label: "실시간 상위", game: g }));
      return {
        promos: homePromos(), featured: feat, hot: live.slice(0, 8), open_reg: openReg, competitions: [],
        counts: { live: live.length, today: today.length, players: live.reduce((s, g) => s + (g.stats.players_left || 0), 0), venues: new Set(live.map(g => g.venue_id)).size },
        updated_label: updatedLabel(), stale: staleFlag(),
      };
    }],
    ["/api/live", q => ({ games: queryGames(Object.assign({ status: "live", sort: "players" }, q)), updated_label: updatedLabel(), stale: staleFlag() })],
    ["/api/games", q => ({ games: queryGames(q), updated_label: updatedLabel(), stale: staleFlag() })],
    [/^\/api\/games\/([^/]+)\/clock$/, (q, m) => {
      const g = DB().games[decodeURIComponent(m[1])]; if (!g) return err(404, "게임을 찾을 수 없습니다");
      const o = gameOut(g); return { id: g.id, name: g.name, venue: o.venue && o.venue.name, state: g.state, clock: o.clock, stats: o.stats };
    }],
    [/^\/api\/games\/([^/]+)$/, (q, m) => {
      const db = DB(), g = db.games[decodeURIComponent(m[1])]; if (!g) return err(404, "게임을 찾을 수 없습니다");
      const o = gameOut(g, true);
      o.same_venue = Object.values(db.games).filter(x => x.venue_id === g.venue_id && x.id !== g.id && x.date === g.date).map(x => gameOut(x));
      return o;
    }],
    ["/api/venues", q => {
      const db = DB(), text = (q.q || "").toLowerCase(), near = q.near ? q.near.split(",").map(Number) : null, t = todayStr();
      const out = Object.values(db.venues).filter(v => (!q.region || v.region === q.region) && (!text || (v.name + v.address + v.region).toLowerCase().includes(text))).map(v => {
        const today = Object.values(db.games).filter(g => g.venue_id === v.id && g.date === t), live = today.filter(g => LIVE2.includes(g.state));
        const o = Object.assign(fullVenue(v), { today_games: today.length, live_games: live.length, live_players: live.reduce((s, g) => s + (g.stats.players_left || 0), 0) });
        if (near) o.distance_km = dist(near[0], near[1], v.lat, v.lng);
        return o;
      });
      out.sort((a, b) => (b.live_players - a.live_players) || (b.today_games - a.today_games) || a.name.localeCompare(b.name));
      return { venues: out };
    }],
    [/^\/api\/venues\/([^/]+)$/, (q, m) => {
      const db = DB(), v = db.venues[decodeURIComponent(m[1])]; if (!v) return err(404, "매장을 찾을 수 없습니다");
      const t = todayStr();
      return Object.assign(fullVenue(v), { games: Object.values(db.games).filter(g => g.venue_id === v.id && g.date >= t).map(g => gameOut(g)).sort((a, b) => a.start_ts - b.start_ts) });
    }],
    ["/api/competitions", () => ({ competitions: [] })],         // series 는 일정 데이터가 없어 비움
    [/^\/api\/competitions\/([^/]+)$/, () => err(404, "대회 정보가 없습니다")],
    ["/api/featured", () => ({ featured: byPath("/api/home").featured })],
    ["/api/promos", () => ({ promos: homePromos() })],
    ["/api/structures", () => ({ structures: [] })],
    [/^\/api\/structures\/([^/]+)$/, () => err(404, "구조 정보가 없습니다")],
    ["/api/search", q => {
      const text = (q.q || "").trim().toLowerCase(), db = DB(), t = todayStr();
      if (!text) return { venues: [], games: [], competitions: [] };
      return {
        venues: Object.values(db.venues).filter(v => (v.name + " " + v.address + " " + v.region + " " + v.area).toLowerCase().includes(text)).map(venueBrief).slice(0, 20),
        games: queryGames({ q: text }).filter(g => g.date >= t).slice(0, 30), competitions: [],
      };
    }],
  ];
  function staleFlag() { return cache.lastErr > cache.lastOk && cache.lastOk > 0; }
  function updatedLabel() {
    const g = DB().generated_at, t = cache.sync.live || cache.lastOk;
    if (!t) return null;
    const d = new Date(t), hh = String(d.getHours()).padStart(2, "0"), mm = String(d.getMinutes()).padStart(2, "0");
    return (staleFlag() ? "갱신 실패 · 마지막 " : "실시간 ") + hh + ":" + mm;
  }
  function homePromos() {
    return [{ id: "apis", title: "OVERLAY HUNTER 실시간", body: (updatedLabel() || "연결 중") + " · 전국 매장 토너먼트", color: "#33D1FF", link: { type: "tab", id: "live" } }];
  }
  function err(status, msg) { return { __err: status, error: msg }; }
  function byPath(path) { for (const [p, fn] of ROUTES) if (typeof p === "string" && p === path) return fn({}); return {}; }

  async function request(method, url) {
    if (method !== "GET") return { status: 405, body: { error: "OVERLAY HUNTER 실시간 데이터는 읽기 전용입니다" } };
    startPolling();
    try { await refreshAll(false); } catch (e) {
      if (!cache.data && !cache.live) return { status: 503, body: { error: "OVERLAY HUNTER 연결 실패: " + (e.message || e) } };
    }
    const u = new URL(url, "http://local/");
    const path = u.pathname.replace(/\/+$/, "") || "/";
    const q = Object.fromEntries(u.searchParams.entries());
    for (const [p, fn] of ROUTES) {
      let m = null;
      if (typeof p === "string") { if (p !== path) continue; }
      else { m = path.match(p); if (!m) continue; }
      const r = fn(q, m);
      if (r && r.__err) return { status: r.__err, body: { error: r.error, server_now: now() } };
      return { status: 200, body: Object.assign({ server_now: now() }, r) };
    }
    return { status: 404, body: { error: "OVERLAY HUNTER에 없는 경로입니다", server_now: now() } };
  }

  global.ApisData = { request, refresh: () => refreshAll(true), get lastSync() { return cache.lastOk; }, get stale() { return staleFlag(); }, updatedLabel };
})(window);
