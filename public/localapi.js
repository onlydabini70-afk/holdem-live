/* OVERLAY HUNTER 로컬 API — 서버 없이(GitHub Pages 등) 브라우저 안에서 server.py 와 같은 API 를 돌린다.
   engine.py / seed.py / server.py 의 라우트를 그대로 옮긴 것. 데이터는 이 브라우저 localStorage 에만 저장. */
(function (global) {
  "use strict";
  const KST = 9 * 3600 * 1000;
  const DB_KEY = "cb_local_db_v1";
  const LOCAL_ADMIN_KEY = "demo";
  const nowTs = () => Date.now() / 1000;
  const dayOf = ts => new Date(ts * 1000 + KST).toISOString().slice(0, 10);
  const todayStr = (d = 0) => dayOf(nowTs() + d * 86400);
  const isoOf = ts => ts ? new Date(ts * 1000 + KST).toISOString().slice(0, 19) + "+09:00" : null;

  function mulberry(seedStr) {
    let h = 2166136261;
    for (const ch of seedStr) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    let a = h >>> 0;
    const r = () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      random: r,
      uniform: (lo, hi) => lo + (hi - lo) * r(),
      choice: arr => arr[Math.floor(r() * arr.length)],
      sample(arr, k) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, k); },
    };
  }
  const MATH_RNG = { random: Math.random };

  /* ================= engine ================= */
  const LIVE = ["PLAYING", "PAUSED"];
  const segCache = new Map();
  function buildSegments(st) {
    const key = st.id + ":" + st.levels.length + ":" + JSON.stringify(st.breaks || {});
    if (segCache.has(key)) return segCache.get(key);
    const br = st.breaks || {}, segs = [];
    st.levels.forEach((lv, i) => {
      segs.push({ kind: "level", idx: i, sec: Math.round(lv.min * 60) });
      if (br[String(lv.lv)]) segs.push({ kind: "break", idx: i, sec: Math.round(br[String(lv.lv)] * 60) });
    });
    segCache.set(key, segs);
    return segs;
  }
  function elapsedOf(g, now) {
    if (!g.started_at) return 0;
    let ref = now;
    if (g.state === "PAUSED" && g.paused_at) ref = g.paused_at;
    else if (g.state === "FINISHED" && g.finished_at) ref = g.finished_at;
    return Math.max(0, ref - g.started_at - (g.paused_total || 0) + (g.skip || 0));
  }
  const blind = lv => lv ? { lv: lv.lv, sb: lv.sb, bb: lv.bb, ante: lv.ante, min: lv.min } : null;
  function locate(g, st, now) {
    const segs = buildSegments(st), e = elapsedOf(g, now);
    let acc = 0;
    for (let i = 0; i < segs.length; i++) {
      if (e < acc + segs[i].sec) return [segs, i, e - acc, acc + segs[i].sec - e];
      acc += segs[i].sec;
    }
    return [segs, segs.length - 1, segs[segs.length - 1].sec, 0];
  }
  function computeClock(g, st, now) {
    const levels = st.levels, regClose = g.reg_close_level || 0;
    if (g.state === "WAITING") {
      return {
        phase: "waiting", running: false, level: blind(levels[0]), next: blind(levels[1]),
        remaining: levels[0].min * 60, end_at: null, starts_in: Math.max(0, Math.floor(g.start_at - now)),
        next_break_in: null, reg_open: true, reg_close_in: null, elapsed: 0, seg: 0,
      };
    }
    const [segs, si, , remaining] = locate(g, st, now);
    const seg = segs[si], level = levels[seg.idx], nxt = levels[seg.idx + 1] || null;
    let phase = seg.kind === "break" ? "break" : "level";
    if (g.state === "PAUSED") phase = "paused";
    if (g.state === "FINISHED") phase = "finished";
    let nextBreak = null;
    if (seg.kind === "level") {
      let t = remaining;
      for (const s of segs.slice(si + 1)) { if (s.kind === "break") { nextBreak = Math.floor(t); break; } t += s.sec; }
    }
    const regOpen = LIVE.includes(g.state) && level.lv <= regClose;
    let regCloseIn = null;
    if (regOpen) {
      let t = remaining;
      for (const s of segs.slice(si + 1)) { if (levels[s.idx].lv > regClose) break; t += s.sec; }
      regCloseIn = Math.floor(t);
    }
    const running = g.state === "PLAYING";
    return {
      phase, running, on_break: seg.kind === "break", level: blind(level), next: blind(nxt),
      remaining: Math.floor(remaining), end_at: running ? Math.floor((now + remaining) * 1000) : null,
      starts_in: 0, next_break_in: nextBreak, reg_open: regOpen, reg_close_in: regCloseIn,
      elapsed: Math.floor(elapsedOf(g, now)), seg: si,
    };
  }
  function stats(g, bb) {
    const c = g.counts || {}, bt = {};
    g.buyin_types.forEach(b => bt[b.key] = b);
    let chips = 0;
    for (const k in bt) chips += (c[k] || 0) * bt[k].chips;
    const entries = (c.buyin || 0) + (c.reentry || 0), left = g.players_left || 0;
    const avg = left ? Math.floor(chips / left) : 0;
    return {
      entries, unique: c.buyin || 0, reentries: c.reentry || 0, addons: c.addon || 0,
      players_left: left, total_chips: chips, avg_stack: avg,
      avg_bb: bb && avg ? Math.round(avg / bb * 10) / 10 : null,
    };
  }
  class ActionError extends Error { }
  function applyAction(g, st, action, now, n) {
    n = Math.max(1, parseInt(n || 1, 10) || 1);
    const s = g.state, c = g.counts = g.counts || {};
    const ref = () => (g.state === "PAUSED" && g.paused_at) ? g.paused_at : now;
    switch (action) {
      case "start":
        if (s !== "WAITING") throw new ActionError("이미 시작된 게임입니다");
        Object.assign(g, { state: "PLAYING", started_at: now, paused_total: 0, skip: 0, paused_at: null }); break;
      case "pause":
        if (s !== "PLAYING") throw new ActionError("진행 중일 때만 일시정지할 수 있습니다");
        Object.assign(g, { state: "PAUSED", paused_at: now }); break;
      case "resume":
        if (s !== "PAUSED") throw new ActionError("일시정지 상태가 아닙니다");
        g.paused_total = (g.paused_total || 0) + (now - g.paused_at);
        Object.assign(g, { state: "PLAYING", paused_at: null }); break;
      case "next": case "prev": case "add_time": {
        if (!LIVE.includes(s)) throw new ActionError("진행 중인 게임이 아닙니다");
        const [segs, si, inSeg, remaining] = locate(g, st, now);
        if (action === "next") {
          if (si >= segs.length - 1) throw new ActionError("마지막 레벨입니다");
          g.skip = (g.skip || 0) + remaining;
        } else if (action === "prev") {
          g.skip = (g.skip || 0) - (inSeg + (si > 0 && inSeg < 10 ? segs[si - 1].sec : 0));
        } else {
          g.skip = (g.skip || 0) - Math.min(n, inSeg);
        }
        const raw = ref() - g.started_at - (g.paused_total || 0) + g.skip;
        if (raw < 0) g.skip -= raw;
        break;
      }
      case "entry": case "reentry": {
        if (s === "FINISHED") throw new ActionError("종료된 게임입니다");
        if (LIVE.includes(s) && !computeClock(g, st, now).reg_open) throw new ActionError("등록이 마감되었습니다");
        const k = action === "entry" ? "buyin" : "reentry";
        c[k] = (c[k] || 0) + n; g.players_left = (g.players_left || 0) + n; break;
      }
      case "addon": c.addon = (c.addon || 0) + n; break;
      case "bust": g.players_left = Math.max(1, (g.players_left || 0) - n); break;
      case "finish":
        if (s === "PAUSED") applyAction(g, st, "resume", now);
        Object.assign(g, { state: "FINISHED", finished_at: now }); break;
      case "reset":
        Object.assign(g, { state: "WAITING", started_at: null, paused_at: null, finished_at: null, paused_total: 0, skip: 0 }); break;
      default: throw new ActionError("알 수 없는 액션: " + action);
    }
  }
  function autoStart(g, now) {
    if (g.state === "WAITING" && g.auto_start !== false && now >= g.start_at) {
      Object.assign(g, { state: "PLAYING", started_at: g.start_at, paused_total: 0, skip: 0, paused_at: null });
      return true;
    }
    return false;
  }
  function simStep(g, st, now, rng = MATH_RNG) {
    if (g.state !== "PLAYING") return false;
    const clk = computeClock(g, st, now), c = g.counts = g.counts || {};
    let left = g.players_left || 0, changed = false;
    const cap = g.max_players || 999, entries = (c.buyin || 0) + (c.reentry || 0), pop = g.popularity || 1;
    if (clk.reg_open) {
      if (left < cap && (c.buyin || 0) < cap && rng.random() < 0.09 * pop) { c.buyin = (c.buyin || 0) + 1; left++; changed = true; }
      if (entries - left > 0 && left < cap && g.reentry_ok !== false && rng.random() < 0.05 * pop) { c.reentry = (c.reentry || 0) + 1; left++; changed = true; }
      if (left > 3 && clk.level.lv >= 3 && rng.random() < 0.06) { left--; changed = true; }
      if (g.addon_ok && clk.on_break && rng.random() < 0.25) { c.addon = (c.addon || 0) + 1; changed = true; }
    } else if (left > 1 && rng.random() < Math.min(0.5, 0.025 + left / 700)) { left--; changed = true; }
    g.players_left = left;
    if (left <= 1 && entries > 1) { Object.assign(g, { state: "FINISHED", finished_at: now }); changed = true; }
    return changed;
  }

  /* ================= seed ================= */
  const BLINDS = [[100, 200], [200, 400], [300, 600], [400, 800], [500, 1000], [600, 1200], [800, 1600], [1000, 2000], [1200, 2400], [1500, 3000], [2000, 4000], [2500, 5000], [3000, 6000], [4000, 8000], [5000, 10000], [6000, 12000], [8000, 16000], [10000, 20000], [12000, 24000], [15000, 30000], [20000, 40000], [25000, 50000], [30000, 60000], [40000, 80000], [50000, 100000], [60000, 120000], [80000, 160000], [100000, 200000]];
  function structure(id, name, minutes, every, bmin, anteFrom = 3) {
    const levels = BLINDS.map(([sb, bb], i) => ({ lv: i + 1, sb, bb, ante: i + 1 >= anteFrom ? bb : 0, min: minutes }));
    const breaks = {};
    for (let lv = every; lv < BLINDS.length; lv += every) breaks[String(lv)] = bmin;
    return { id, name, levels, breaks };
  }
  const STRUCTURES = [structure("hyper", "하이퍼 터보 8분", 8, 8, 5), structure("turbo", "터보 12분", 12, 6, 10),
    structure("standard", "스탠다드 20분", 20, 4, 10), structure("deep", "딥스택 30분", 30, 4, 15, 2)];
  const VENUES = [
    ["v01", "블루펠트 라운지", "서울", "강남구 역삼동", 37.4995, 127.03, 8], ["v02", "리버카드 홀덤", "서울", "마포구 서교동", 37.556, 126.923, 6],
    ["v03", "노스스타 포커룸", "서울", "송파구 잠실동", 37.513, 127.1, 7], ["v04", "플랍하우스", "서울", "광진구 화양동", 37.5405, 127.07, 5],
    ["v05", "스페이드원", "서울", "영등포구 여의도동", 37.5215, 126.9245, 6], ["v06", "턴앤리버 분당", "경기", "성남시 분당구 서현동", 37.385, 127.123, 6],
    ["v07", "체크레이즈 수원", "경기", "수원시 팔달구 인계동", 37.266, 127.03, 5], ["v08", "올인클럽 일산", "경기", "고양시 일산동구 장항동", 37.658, 126.77, 4],
    ["v09", "칩리더 부평", "인천", "부평구 부평동", 37.489, 126.724, 5], ["v10", "오션하트 송도", "인천", "연수구 송도동", 37.392, 126.639, 6],
    ["v11", "하버나인 서면", "부산", "부산진구 부전동", 35.158, 129.06, 7], ["v12", "마린플랍 해운대", "부산", "해운대구 우동", 35.163, 129.163, 6],
    ["v13", "레드킹 동성로", "대구", "중구 동성로", 35.869, 128.596, 5], ["v14", "센터레인 둔산", "대전", "서구 둔산동", 36.352, 127.378, 4],
    ["v15", "상무 포켓페어", "광주", "서구 치평동", 35.152, 126.851, 4], ["v16", "아일랜드 칩스", "제주", "제주시 연동", 33.489, 126.493, 5],
    ["v17", "웨이브 홀덤 울산", "울산", "남구 삼산동", 35.538, 129.338, 4],
  ];
  const T = (key, name, st, chips, price, reg, cap, gtd, tags, reentry, addon, pop, prize) => ({ key, name, st, chips, price, reg, cap, gtd, tags, reentry, addon, pop, prize });
  const TEMPLATES = [
    T("daily_turbo", "데일리 터보", "turbo", 20000, 50000, 8, 60, 0, ["터보", "리엔트리"], true, false, 1.0, "seed"),
    T("daily_std", "데일리 스탠다드", "standard", 30000, 70000, 10, 80, 0, ["스탠다드"], true, false, 1.1, "seed"),
    T("night_deep", "나이트 딥스택", "deep", 50000, 100000, 9, 90, 5000000, ["딥스택", "애드온"], true, true, 1.2, "seed"),
    T("satellite", "시드권 새틀라이트", "hyper", 15000, 30000, 10, 50, 0, ["새틀라이트", "하이퍼"], true, false, 0.9, "satellite"),
    T("bounty", "바운티 헌터", "standard", 30000, 80000, 10, 70, 3000000, ["바운티"], true, false, 1.0, "seed"),
    T("highroller", "하이롤러", "deep", 100000, 300000, 8, 40, 10000000, ["하이롤러", "프리즈아웃"], false, false, 0.6, "seed"),
    T("weekend_main", "주말 메인 이벤트", "deep", 60000, 150000, 10, 200, 30000000, ["메인", "딥스택", "애드온"], true, true, 1.8, "seed"),
  ];
  const SEED_PRIZES = ["샘플 시리즈 메인 시드 2장 + 트로피", "샘플 시리즈 메인 시드 1장", "하이롤러 시드 1장", "데일리 프리 엔트리 3장",
    "데일리 프리 엔트리 2장", "데일리 프리 엔트리 1장", "매장 포인트 3만", "매장 포인트 2만", "매장 포인트 1만"];
  function payouts(kind, cap) {
    if (kind === "satellite") {
      const n = Math.max(2, Math.floor(cap / 10));
      return [{ place: `1~${n}위`, prize: "데일리 스탠다드 시드 1장" }, { place: `${n + 1}위`, prize: "매장 포인트 1만" }];
    }
    return SEED_PRIZES.slice(0, cap <= 60 ? 6 : 9).map((p, i) => ({ place: `${i + 1}위`, prize: p }));
  }
  function makeGame(rng, id, venueId, t, startAt) {
    const bt = [{ key: "buyin", name: "바이인", price: t.price, chips: t.chips }];
    if (t.reentry) bt.push({ key: "reentry", name: "리엔트리", price: t.price, chips: t.chips });
    if (t.addon) bt.push({ key: "addon", name: "애드온", price: Math.floor(t.price / 2), chips: Math.floor(t.chips / 2) });
    return {
      id, venue_id: venueId, template: t.key, name: t.name, tags: t.tags.slice(), structure_id: t.st,
      start_at: Math.floor(startAt), state: "WAITING", auto_start: true, starting_chips: t.chips, buyin_types: bt,
      guarantee: t.gtd, reg_close_level: t.reg, max_players: t.cap, reentry_ok: t.reentry, addon_ok: t.addon,
      popularity: Math.round(t.pop * rng.uniform(0.7, 1.3) * 100) / 100,
      counts: { buyin: 0, reentry: 0, addon: 0 }, players_left: 0, payouts: payouts(t.prize, t.cap),
      notes: "데모용 샘플 토너먼트입니다.", started_at: null, paused_at: null, finished_at: null, paused_total: 0, skip: 0,
    };
  }
  function fastForward(g, st, now, rng) {
    if (g.start_at > now) {
      const pre = Math.floor(g.max_players * rng.uniform(0, 0.18));
      g.counts.buyin = pre; g.players_left = pre; return;
    }
    autoStart(g, g.start_at);
    const pre = Math.floor(g.max_players * rng.uniform(0.08, 0.2));
    g.counts.buyin += pre; g.players_left += pre;
    let t = g.start_at;
    while (t < now && g.state === "PLAYING") { t += 15; simStep(g, st, Math.min(t, now), rng); }
  }
  function makeDb(now = nowTs()) {
    const today = dayOf(now), rng = mulberry(today.replace(/-/g, ""));
    const wdOf = ts => new Date(ts * 1000 + KST).getUTCDay();
    const weekend = ts => [0, 6].includes(wdOf(ts));
    const structures = {};
    STRUCTURES.forEach(s => structures[s.id] = s);
    const venues = {};
    for (const [id, name, region, area, lat, lng, tables] of VENUES) {
      venues[id] = {
        id, name, region, address: `${region} ${area} (샘플 주소)`, lat, lng, tables,
        phone: `0507-0000-${String(+id.slice(1)).padStart(4, "0")}`, hours: "평일 14:00 ~ 05:00 / 주말 12:00 ~ 06:00",
        intro: `${area}의 ${tables}테이블 홀덤 매장 (데모 데이터)`,
        amenities: rng.sample(["주차", "흡연실", "음료 무료", "식사 가능", "와이파이", "카드 결제"], 3),
      };
    }
    const games = {};
    let gid = 0;
    const offsets = [-7.5, -5.0, -3.4, -2.2, -1.3, -0.6, -0.15, 0.4, 1.2, 2.5, 4.0, 6.0];
    for (const vid in venues) {
      const picks = rng.sample(TEMPLATES.slice(0, -1), 3);
      if (weekend(now) && rng.random() < 0.4) picks[0] = TEMPLATES[TEMPLATES.length - 1];
      const hours = rng.sample(offsets, picks.length).sort((a, b) => a - b);
      picks.forEach((t, i) => {
        let start = now + hours[i] * 3600; start -= start % 600;
        const g = makeGame(rng, `g${String(++gid).padStart(4, "0")}`, vid, t, start);
        fastForward(g, structures[g.structure_id], now, rng);
        games[g.id] = g;
      });
    }
    const [y, m, d] = today.split("-").map(Number);
    for (let dd = 1; dd <= 3; dd++) {
      const midnight = (Date.UTC(y, m - 1, d + dd) - KST) / 1000;
      for (const vid in venues) {
        const hrs = rng.sample([14, 17, 19, 20, 21, 22], 2 + (rng.random() < 0.5 ? 1 : 0));
        for (const hh of hrs) {
          const t = rng.choice(weekend(midnight + 43200) ? TEMPLATES : TEMPLATES.slice(0, -1));
          const g = makeGame(rng, `g${String(++gid).padStart(4, "0")}`, vid, t, midnight + hh * 3600);
          const pre = Math.floor(g.max_players * rng.uniform(0, 0.15));
          g.counts.buyin = pre; g.players_left = pre;
          games[g.id] = g;
        }
      }
    }
    const ds = n => dayOf(now + n * 86400);
    const series = (id, scope, name, city, country, flag, currency, s, e, venue, events) => ({
      id, scope, name, city, country, flag, currency, start_date: ds(s), end_date: ds(e), venue, organizer: "샘플 조직위원회",
      events: events.map(([en, day, time, buyin, guarantee, chips], i) => ({ no: i + 1, name: en, date: ds(s + day), time, buyin, guarantee, chips })),
      notes: "데모용 가상 대회입니다. 실제 일정이 아닙니다.",
    });
    const comps = [
      series("c01", "kr", "서울 시티 챔피언십 (샘플)", "서울", "대한민국", "🇰🇷", "KRW", -2, 3, "샘플 컨벤션홀 A", [["오프닝 이벤트", 0, "13:00", 300000, 100000000, 30000], ["바운티 이벤트", 1, "15:00", 500000, 150000000, 40000], ["메인 이벤트 Day1", 2, "12:00", 1100000, 500000000, 50000], ["하이롤러", 3, "14:00", 3300000, 300000000, 100000], ["메인 이벤트 파이널", 5, "13:00", 0, 0, 0]]),
      series("c02", "kr", "코리아 오픈 홀덤 시리즈 (샘플)", "서울", "대한민국", "🇰🇷", "KRW", 6, 13, "샘플 호텔 그랜드볼룸", [["오프닝 터보", 0, "13:00", 220000, 50000000, 25000], ["레이디스 이벤트", 1, "14:00", 220000, 20000000, 25000], ["메인 이벤트 Day1A", 2, "12:00", 1100000, 1000000000, 60000], ["메인 이벤트 Day1B", 3, "12:00", 1100000, 0, 60000], ["슈퍼 하이롤러", 5, "15:00", 5500000, 500000000, 150000]]),
      series("c03", "kr", "부산 오션 포커 페스티벌 (샘플)", "부산", "대한민국", "🇰🇷", "KRW", 18, 24, "샘플 해변 호텔", [["웰컴 이벤트", 0, "14:00", 300000, 80000000, 30000], ["딥스택 이벤트", 2, "13:00", 550000, 150000000, 50000], ["메인 이벤트", 3, "12:00", 1100000, 500000000, 60000]]),
      series("c04", "kr", "제주 아일랜드 클래식 (샘플)", "제주", "대한민국", "🇰🇷", "KRW", 30, 37, "샘플 리조트 볼룸", [["오프닝", 0, "14:00", 330000, 100000000, 30000], ["메인 이벤트", 2, "12:00", 1650000, 1000000000, 75000], ["하이롤러", 4, "15:00", 5500000, 500000000, 150000]]),
      series("c05", "intl", "아시아 퍼시픽 포커 투어 마닐라 (샘플)", "마닐라", "필리핀", "🇵🇭", "USD", 9, 17, "Sample Resort Manila", [["Opening", 0, "13:00", 300, 100000, 30000], ["Main Event", 3, "12:00", 1500, 1000000, 50000], ["High Roller", 6, "14:00", 5000, 500000, 100000]]),
      series("c06", "intl", "마카오 하이롤러 위크 (샘플)", "마카오", "중국", "🇲🇴", "HKD", 21, 28, "Sample Casino Macau", [["Kick-off", 0, "14:00", 5000, 2000000, 30000], ["Main Event", 2, "12:00", 15000, 10000000, 60000], ["Super High Roller", 5, "15:00", 100000, 20000000, 200000]]),
      series("c07", "intl", "라스베이거스 서머 시리즈 (샘플)", "라스베이거스", "미국", "🇺🇸", "USD", 40, 60, "Sample Hotel Las Vegas", [["Mystery Bounty", 0, "11:00", 400, 1000000, 40000], ["Main Event Day1", 10, "11:00", 10000, 0, 60000], ["High Roller", 15, "13:00", 25000, 5000000, 100000]]),
      series("c08", "intl", "몰타 지중해 오픈 (샘플)", "몰타", "몰타", "🇲🇹", "EUR", -20, -14, "Sample Casino Malta", [["Opening", 0, "14:00", 300, 100000, 30000], ["Main Event", 2, "12:00", 1100, 1000000, 50000]]),
    ];
    const big = Object.values(games).filter(g => g.state === "PLAYING").sort((a, b) => b.players_left - a.players_left).slice(0, 3);
    const promos = [
      { id: "p1", title: "데모 사이트입니다", body: "모든 매장·대회·숫자는 가상 데이터예요. 관리자 페이지에서 직접 바꿔보세요.", color: "#33D1FF", starts_at: ds(-1), ends_at: ds(30), link: { type: "page", id: "admin" } },
      { id: "p2", title: "코리아 오픈 홀덤 시리즈 (샘플)", body: `${ds(6)} 개막 · 메인 GTD 10억`, color: "#FFC24B", starts_at: ds(-1), ends_at: ds(13), link: { type: "comp", id: "c02" } },
      { id: "p3", title: "주말 메인 이벤트", body: "토·일 전 매장 딥스택 메인 이벤트", color: "#3EE0A1", starts_at: ds(-1), ends_at: ds(6), link: { type: "tab", id: "games" } },
    ];
    const byId = arr => Object.fromEntries(arr.map(x => [x.id, x]));
    return {
      demo: true, seed_day: today, version: 1, last_sim: now, structures, venues, games,
      competitions: byId(comps), featured: big.map((g, i) => ({ game_id: g.id, priority: i + 1, label: "오늘의 추천" })),
      promos: byId(promos),
    };
  }

  /* ================= 저장 + 시뮬레이션 따라잡기 ================= */
  let DB = null, lastSave = 0;
  function save(force) {
    const t = Date.now();
    if (!force && t - lastSave < 5000) return;
    lastSave = t;
    try { localStorage.setItem(DB_KEY, JSON.stringify(DB)); } catch (e) { }
  }
  function load(reset) {
    if (!reset && !DB) { try { DB = JSON.parse(localStorage.getItem(DB_KEY) || "null"); } catch (e) { DB = null; } }
    if (reset || !DB || (DB.demo && DB.seed_day !== todayStr())) { DB = makeDb(); save(true); }
  }
  function catchUp() {
    load(false);
    const now = nowTs();
    let steps = Math.floor((now - (DB.last_sim || now)) / 15);
    if (steps <= 0) return;
    const skipped = Math.max(0, steps - 1440); // 6시간 넘게 비웠으면 앞부분은 건너뜀
    steps = Math.min(steps, 1440);
    let t = DB.last_sim + skipped * 15, changed = false;
    for (let i = 0; i < steps; i++) {
      t += 15;
      for (const g of Object.values(DB.games)) {
        changed = autoStart(g, t) || changed;
        changed = simStep(g, DB.structures[g.structure_id], t) || changed;
      }
    }
    DB.last_sim = t;
    if (changed) save(false);
  }

  /* ================= API (server.py 와 같은 라우트) ================= */
  class ApiError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
  const need = (id, table, label) => { if (!DB[table][id]) throw new ApiError(404, `${label}을(를) 찾을 수 없습니다: ${id}`); return DB[table][id]; };
  const venueBrief = v => ({ id: v.id, name: v.name, region: v.region, address: v.address, lat: v.lat, lng: v.lng });
  function distKm(aLat, aLng, bLat, bLng) {
    const r = 6371, rad = x => x * Math.PI / 180, p1 = rad(aLat), p2 = rad(bLat), dp = p2 - p1, dl = rad(bLng - aLng);
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * r * Math.asin(Math.sqrt(h));
  }
  function gameOut(g, now, full) {
    const v = DB.venues[g.venue_id], st = DB.structures[g.structure_id], clk = computeClock(g, st, now);
    const out = {
      id: g.id, name: g.name, tags: g.tags || [], venue: v ? venueBrief(v) : null, venue_id: g.venue_id, state: g.state,
      start_at: isoOf(g.start_at), start_ts: Math.floor(g.start_at * 1000), date: dayOf(g.start_at), starting_chips: g.starting_chips,
      guarantee: g.guarantee || 0, reg_close_level: g.reg_close_level, max_players: g.max_players, structure_id: g.structure_id,
      structure_name: st.name, level_min: st.levels[0].min, buyin: g.buyin_types[0] ? g.buyin_types[0].price : 0,
      clock: clk, stats: stats(g, clk.level ? clk.level.bb : null),
    };
    if (full) Object.assign(out, {
      buyin_types: g.buyin_types, payouts: g.payouts || [], notes: g.notes || "", structure: st, segments: buildSegments(st),
      started_at: isoOf(g.started_at), finished_at: isoOf(g.finished_at), venue: v || null,
    });
    return out;
  }
  function compOut(c, full) {
    const t = todayStr(), status = t < c.start_date ? "upcoming" : t > c.end_date ? "finished" : "ongoing";
    const out = {
      id: c.id, scope: c.scope, name: c.name, city: c.city, country: c.country, flag: c.flag, currency: c.currency,
      start_date: c.start_date, end_date: c.end_date, venue: c.venue, organizer: c.organizer, status,
      event_count: (c.events || []).length, max_guarantee: Math.max(0, ...(c.events || []).map(e => e.guarantee || 0)),
    };
    if (full) { out.events = c.events || []; out.notes = c.notes || ""; }
    return out;
  }
  const activePromos = () => { const t = todayStr(); return Object.values(DB.promos).filter(p => p.starts_at <= t && t <= p.ends_at); };
  const GROUPS = { live: ["PLAYING", "PAUSED"], playing: ["PLAYING"], paused: ["PAUSED"], upcoming: ["WAITING"], waiting: ["WAITING"], done: ["FINISHED"], finished: ["FINISHED"] };
  const parseNear = s => { const p = s.split(",").map(Number); if (p.length !== 2 || p.some(isNaN)) throw new ApiError(400, "near 는 '위도,경도' 형식이어야 합니다"); return p; };
  function queryGames(q, now) {
    const status = (q.status || "all").toLowerCase(), text = (q.q || "").trim().toLowerCase(), sort = q.sort || "start";
    const limit = Math.min(parseInt(q.limit || 300, 10), 1000);
    const ids = q.ids ? new Set(q.ids.split(",").filter(Boolean)) : null;
    const near = q.near ? parseNear(q.near) : null;
    const rows = [];
    for (const g of Object.values(DB.games)) {
      const v = DB.venues[g.venue_id] || {};
      if (ids && !ids.has(g.id)) continue;
      if (status !== "all" && !(GROUPS[status] || [status.toUpperCase()]).includes(g.state)) continue;
      if (q.region && v.region !== q.region) continue;
      if (q.venue && g.venue_id !== q.venue) continue;
      if (q.date && dayOf(g.start_at) !== q.date) continue;
      if (text && !(g.name + " " + (v.name || "") + " " + (g.tags || []).join(" ")).toLowerCase().includes(text)) continue;
      const o = gameOut(g, now);
      if (q.reg === "open" && !(o.clock.reg_open && (g.state !== "WAITING" || g.start_at - now < 4 * 3600))) continue;
      if (near) o.distance_km = Math.round(distKm(near[0], near[1], v.lat, v.lng) * 10) / 10;
      rows.push(o);
    }
    const keys = {
      start: o => o.start_ts, entries: o => -o.stats.entries, players: o => -o.stats.players_left, guarantee: o => -o.guarantee,
      distance: o => o.distance_km ?? 9e9, level: o => -(o.clock.level ? o.clock.level.lv : 0),
    };
    if (!keys[sort]) throw new ApiError(400, "sort 는 " + Object.keys(keys).join(", ") + " 중 하나");
    rows.sort((a, b) => keys[sort](a) - keys[sort](b));
    return rows.slice(0, limit);
  }
  const ORDER = ["서울", "경기", "인천", "부산", "대구", "대전", "광주", "울산", "제주"];
  const newId = (p, table) => { let i; do { i = p + Math.random().toString(16).slice(2, 8); } while (table[i]); return i; };

  function check(body, fields, required = []) {
    const out = {};
    for (const [k, t] of Object.entries(fields)) {
      if (!(k in body)) continue;
      const v = body[k], ok = t === "list" ? Array.isArray(v) : t === "dict" ? v && typeof v === "object" && !Array.isArray(v)
        : t === "int" ? Number.isInteger(v) : t === "num" ? typeof v === "number" : t === "time" ? ["number", "string"].includes(typeof v) : typeof v === t;
      if (!ok) throw new ApiError(400, `${k} 형식이 잘못되었습니다`);
      out[k] = v;
    }
    for (const k of required) if (!(k in out)) throw new ApiError(400, `${k} 는 필수입니다`);
    return out;
  }
  const GAME_F = { name: "string", venue_id: "string", structure_id: "string", start_at: "time", starting_chips: "int", guarantee: "int", reg_close_level: "int", max_players: "int", tags: "list", buyin_types: "list", payouts: "list", notes: "string", reentry_ok: "boolean", addon_ok: "boolean", auto_start: "boolean", players_left: "int", counts: "dict" };
  const VENUE_F = { name: "string", region: "string", address: "string", lat: "num", lng: "num", tables: "int", phone: "string", hours: "string", intro: "string", amenities: "list" };
  const COMP_F = { scope: "string", name: "string", city: "string", country: "string", flag: "string", currency: "string", start_date: "string", end_date: "string", venue: "string", organizer: "string", events: "list", notes: "string" };
  function parseTime(v) {
    if (typeof v === "number") return v > 1e11 ? v / 1000 : v;
    const s = /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : v + "+09:00", t = Date.parse(s);
    if (isNaN(t)) throw new ApiError(400, "start_at 은 ISO 시각(예: 2026-11-01T19:00) 또는 epoch 이어야 합니다");
    return t / 1000;
  }
  function cleanGame(body, partial) {
    const out = check(body, GAME_F, partial ? [] : ["name", "venue_id", "structure_id", "start_at"]);
    if ("start_at" in out) out.start_at = parseTime(out.start_at);
    if ("venue_id" in out && !DB.venues[out.venue_id]) throw new ApiError(400, "venue_id 가 없는 매장입니다");
    if ("structure_id" in out && !DB.structures[out.structure_id]) throw new ApiError(400, "structure_id 가 없는 구조입니다");
    for (const b of out.buyin_types || []) if (!(b && ["buyin", "reentry", "addon"].includes(b.key) && Number.isInteger(b.price) && Number.isInteger(b.chips)))
      throw new ApiError(400, "buyin_types 항목은 {key: buyin|reentry|addon, name, price, chips}");
    return out;
  }
  const HEX = /^#[0-9a-fA-F]{3,8}$/;

  const ROUTES = [];
  const R = (method, pattern, fn, admin = false) => ROUTES.push([method, new RegExp("^" + pattern + "$"), fn, admin]);

  R("GET", "/api", () => ({ name: "OVERLAY HUNTER API (브라우저 로컬 모드)", docs: "docs.html", endpoints: ROUTES.map(([m, p, , a]) => `${m} ${p.source.slice(1, -1)}${a ? "  (관리자)" : ""}`) }));
  R("GET", "/api/health", () => ({ ok: true, games: Object.keys(DB.games).length, venues: Object.keys(DB.venues).length, demo: DB.demo, simulation: true, mode: "local" }));
  R("GET", "/api/meta", () => ({
    regions: [...new Set(Object.values(DB.venues).map(v => v.region))].sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99)),
    today: todayStr(), dates: [0, 1, 2, 3].map(d => todayStr(d)),
    structures: Object.values(DB.structures).map(s => ({ id: s.id, name: s.name })), demo: DB.demo, mode: "local",
  }));
  R("GET", "/api/home", () => {
    const now = nowTs(), today = queryGames({ date: todayStr() }, now), live = today.filter(g => LIVE.includes(g.state));
    const openReg = queryGames({ reg: "open", sort: "start" }, now).filter(g => g.state !== "WAITING" || g.start_ts / 1000 - now < 3 * 3600).slice(0, 10);
    const featured = DB.featured.slice().sort((a, b) => a.priority - b.priority).filter(f => DB.games[f.game_id]).map(f => ({ ...f, game: gameOut(DB.games[f.game_id], now) }));
    const comps = Object.values(DB.competitions).filter(c => c.end_date >= todayStr()).map(c => compOut(c)).sort((a, b) => a.start_date < b.start_date ? -1 : 1).slice(0, 4);
    return {
      promos: activePromos(), featured, hot: live.slice().sort((a, b) => b.stats.players_left - a.stats.players_left).slice(0, 8), open_reg: openReg, competitions: comps,
      counts: { live: live.length, today: today.length, players: live.reduce((s, g) => s + g.stats.players_left, 0), venues: new Set(live.map(g => g.venue_id)).size },
    };
  });
  R("GET", "/api/live", q => ({ games: queryGames({ ...q, status: q.status || "live", sort: q.sort || "players" }, nowTs()) }));
  R("GET", "/api/games", q => ({ games: queryGames(q, nowTs()) }));
  R("GET", "/api/games/([\\w-]+)", (q, b, gid) => {
    const now = nowTs(), g = need(gid, "games", "게임"), out = gameOut(g, now, true);
    out.same_venue = Object.values(DB.games).filter(x => x.venue_id === g.venue_id && x.id !== gid && dayOf(x.start_at) === dayOf(g.start_at)).map(x => gameOut(x, now));
    return out;
  });
  R("GET", "/api/games/([\\w-]+)/clock", (q, b, gid) => {
    const g = need(gid, "games", "게임"), o = gameOut(g, nowTs());
    return { id: gid, name: g.name, venue: o.venue ? o.venue.name : null, state: g.state, clock: o.clock, stats: o.stats };
  });
  R("GET", "/api/venues", q => {
    const text = (q.q || "").toLowerCase(), near = q.near ? parseNear(q.near) : null, t = todayStr();
    const out = Object.values(DB.venues).filter(v => (!q.region || v.region === q.region) && (!text || (v.name + v.address).toLowerCase().includes(text))).map(v => {
      const today = Object.values(DB.games).filter(g => g.venue_id === v.id && dayOf(g.start_at) === t), live = today.filter(g => LIVE.includes(g.state));
      const o = { ...v, today_games: today.length, live_games: live.length, live_players: live.reduce((s, g) => s + g.players_left, 0) };
      if (near) o.distance_km = Math.round(distKm(near[0], near[1], v.lat, v.lng) * 10) / 10;
      return o;
    });
    out.sort((a, b) => (a.distance_km || 0) - (b.distance_km || 0) || b.live_players - a.live_players || a.name.localeCompare(b.name));
    return { venues: out };
  });
  R("GET", "/api/venues/([\\w-]+)", (q, b, vid) => {
    const now = nowTs(), v = need(vid, "venues", "매장"), t = todayStr();
    return { ...v, games: Object.values(DB.games).filter(g => g.venue_id === vid && dayOf(g.start_at) >= t).map(g => gameOut(g, now)).sort((a, b) => a.start_ts - b.start_ts) };
  });
  R("GET", "/api/competitions", q => {
    const order = { ongoing: 0, upcoming: 1, finished: 2 };
    let out = Object.values(DB.competitions).filter(c => !q.scope || c.scope === q.scope).map(c => compOut(c));
    if (q.status) out = out.filter(c => c.status === q.status);
    out.sort((a, b) => order[a.status] - order[b.status] || (a.status === "finished" ? 0 : a.start_date < b.start_date ? -1 : 1));
    return { competitions: out };
  });
  R("GET", "/api/competitions/([\\w-]+)", (q, b, cid) => compOut(need(cid, "competitions", "대회"), true));
  R("GET", "/api/featured", () => ({ featured: handle("GET", "/api/home").body.featured }));
  R("GET", "/api/promos", () => ({ promos: activePromos() }));
  R("GET", "/api/structures", () => ({ structures: Object.values(DB.structures) }));
  R("GET", "/api/structures/([\\w-]+)", (q, b, sid) => need(sid, "structures", "구조"));
  R("GET", "/api/search", q => {
    const text = (q.q || "").trim().toLowerCase();
    if (!text) return { venues: [], games: [], competitions: [] };
    const t = todayStr();
    return {
      venues: Object.values(DB.venues).filter(v => (v.name + " " + v.address + " " + v.region).toLowerCase().includes(text)).map(venueBrief).slice(0, 20),
      games: queryGames({ q: text }, nowTs()).filter(g => g.date >= t).slice(0, 30),
      competitions: Object.values(DB.competitions).filter(c => (c.name + " " + c.city + " " + c.country).toLowerCase().includes(text)).map(c => compOut(c)),
    };
  });

  R("POST", "/api/admin/login", () => ({ ok: true }), true);
  R("POST", "/api/admin/games", (q, body) => {
    const b = cleanGame(body, false), chips = b.starting_chips || 30000;
    const g = Object.assign({
      id: newId("g", DB.games), template: "custom", tags: [], state: "WAITING", auto_start: true, starting_chips: chips,
      buyin_types: [{ key: "buyin", name: "바이인", price: 0, chips }], guarantee: 0, reg_close_level: 8, max_players: 60,
      reentry_ok: true, addon_ok: false, popularity: 1, counts: { buyin: 0, reentry: 0, addon: 0 }, players_left: 0, payouts: [],
      notes: "", started_at: null, paused_at: null, finished_at: null, paused_total: 0, skip: 0,
    }, b);
    DB.games[g.id] = g;
    return [201, gameOut(g, nowTs(), true)];
  }, true);
  R("PATCH", "/api/admin/games/([\\w-]+)", (q, body, gid) => { const g = need(gid, "games", "게임"); Object.assign(g, cleanGame(body, true)); return gameOut(g, nowTs(), true); }, true);
  R("DELETE", "/api/admin/games/([\\w-]+)", (q, body, gid) => {
    need(gid, "games", "게임"); delete DB.games[gid]; DB.featured = DB.featured.filter(f => f.game_id !== gid); return { deleted: gid };
  }, true);
  R("POST", "/api/admin/games/([\\w-]+)/action", (q, body, gid) => {
    const g = need(gid, "games", "게임");
    try { applyAction(g, DB.structures[g.structure_id], body.action, nowTs(), body.n); }
    catch (e) { if (e instanceof ActionError) throw new ApiError(409, e.message); throw e; }
    return gameOut(g, nowTs(), true);
  }, true);
  R("POST", "/api/admin/venues", (q, body) => {
    const v = Object.assign({ id: newId("v", DB.venues), address: "", lat: 37.5665, lng: 126.978, tables: 4, phone: "", hours: "", intro: "", amenities: [] }, check(body, VENUE_F, ["name", "region"]));
    DB.venues[v.id] = v; return [201, v];
  }, true);
  R("PATCH", "/api/admin/venues/([\\w-]+)", (q, body, vid) => Object.assign(need(vid, "venues", "매장"), check(body, VENUE_F)), true);
  R("DELETE", "/api/admin/venues/([\\w-]+)", (q, body, vid) => {
    need(vid, "venues", "매장");
    if (Object.values(DB.games).some(g => g.venue_id === vid)) throw new ApiError(409, "이 매장에 게임이 남아 있어 삭제할 수 없습니다");
    delete DB.venues[vid]; return { deleted: vid };
  }, true);
  R("POST", "/api/admin/competitions", (q, body) => {
    const b = check(body, COMP_F, ["scope", "name", "start_date", "end_date"]);
    if (!["kr", "intl"].includes(b.scope)) throw new ApiError(400, "scope 는 kr 또는 intl");
    const c = Object.assign({ id: newId("c", DB.competitions), city: "", country: "", flag: "", currency: "KRW", venue: "", organizer: "", events: [], notes: "" }, b);
    DB.competitions[c.id] = c; return [201, compOut(c, true)];
  }, true);
  R("PATCH", "/api/admin/competitions/([\\w-]+)", (q, body, cid) => compOut(Object.assign(need(cid, "competitions", "대회"), check(body, COMP_F)), true), true);
  R("DELETE", "/api/admin/competitions/([\\w-]+)", (q, body, cid) => { need(cid, "competitions", "대회"); delete DB.competitions[cid]; return { deleted: cid }; }, true);
  R("POST", "/api/admin/promos", (q, body) => {
    const b = check(body, { title: "string", body: "string", color: "string", starts_at: "string", ends_at: "string", link: "dict" }, ["title", "starts_at", "ends_at"]);
    if (b.color && !HEX.test(b.color)) throw new ApiError(400, "color 는 #RRGGBB 형식");
    const p = Object.assign({ id: newId("p", DB.promos), body: "", color: "#33D1FF", link: null }, b);
    DB.promos[p.id] = p; return [201, p];
  }, true);
  R("DELETE", "/api/admin/promos/([\\w-]+)", (q, body, pid) => { need(pid, "promos", "공지"); delete DB.promos[pid]; return { deleted: pid }; }, true);
  R("PUT", "/api/admin/featured", (q, body) => {
    const items = body.featured;
    if (!Array.isArray(items) || !items.every(i => i && DB.games[i.game_id])) throw new ApiError(400, "featured 는 [{game_id, priority, label}] 목록 (game_id 는 존재해야 함)");
    DB.featured = items.map((i, n) => ({ game_id: i.game_id, priority: parseInt(i.priority || n + 1, 10), label: String(i.label || "추천") }));
    return { featured: DB.featured };
  }, true);
  R("POST", "/api/admin/reset", () => { load(true); return { ok: true, games: Object.keys(DB.games).length }; }, true);

  function handle(method, url, body, headers = {}) {
    const u = new URL(url, "http://local/");
    const path = u.pathname.replace(/\/+$/, "") || "/";
    const q = Object.fromEntries(u.searchParams.entries());
    let allowed = false;
    for (const [m, re, fn, admin] of ROUTES) {
      const hit = path.match(re);
      if (!hit) continue;
      allowed = true;
      if (m !== method) continue;
      try {
        if (admin && (headers["X-Admin-Key"] || "") !== LOCAL_ADMIN_KEY) throw new ApiError(401, "관리자 키가 틀렸습니다 (로컬 모드 키: demo)");
        const res = fn(q, body || {}, ...hit.slice(1));
        const [code, out] = Array.isArray(res) ? res : [200, res];
        if (method !== "GET") save(true);
        return { status: code, body: JSON.parse(JSON.stringify({ ...out, server_now: Date.now() })) };
      } catch (e) {
        if (e instanceof ApiError) return { status: e.code, body: { error: e.message } };
        return { status: 400, body: { error: "잘못된 요청: " + e.message } };
      }
    }
    return allowed ? { status: 405, body: { error: "허용되지 않는 메서드" } } : { status: 404, body: { error: "없는 API 입니다", see: "/api" } };
  }

  global.LocalAPI = {
    ADMIN_KEY: LOCAL_ADMIN_KEY,
    request(method, url, body, headers) {
      catchUp();
      return Promise.resolve(handle(method.toUpperCase(), url, body, headers));
    },
    reset() { load(true); },
  };
})(window);
