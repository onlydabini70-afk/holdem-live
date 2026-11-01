#!/usr/bin/env python3
"""CHIPBOARD — 홀덤 토너먼트 실시간 현황 서버 (파이썬 표준 라이브러리만 사용).

실행:  python server.py            → http://localhost:8080
옵션:  --port 8080  --host 0.0.0.0  --reset(데모 데이터 새로 생성)  --no-sim(자동 시뮬레이션 끔)
"""
import argparse
import json
import math
import mimetypes
import os
import re
import secrets
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

import engine
import seed

KST = timezone(timedelta(hours=9))
ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, "public")
DB_PATH = os.path.join(ROOT, "data", "db.json")
KEY_PATH = os.path.join(ROOT, "data", "admin_key.txt")

LOCK = threading.RLock()
DB = {}
SIM = True


# ---------- 저장소 ----------

def load_db(reset=False):
    global DB
    if not reset and os.path.exists(DB_PATH):
        with open(DB_PATH, encoding="utf-8") as f:
            DB = json.load(f)
        if DB.get("demo") and DB.get("seed_day") != today_str():
            DB = seed.make_db()
            save_db()
    else:
        DB = seed.make_db()
        save_db()


def save_db():
    tmp = DB_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(DB, f, ensure_ascii=False)
    os.replace(tmp, DB_PATH)


def admin_key():
    k = os.environ.get("CHIPBOARD_ADMIN_KEY")
    if k:
        return k
    if not os.path.exists(KEY_PATH):
        with open(KEY_PATH, "w", encoding="utf-8") as f:
            f.write(secrets.token_urlsafe(12))
    with open(KEY_PATH, encoding="utf-8") as f:
        return f.read().strip()


def now_ts():
    return time.time()


def today_str(days=0):
    return (datetime.now(KST) + timedelta(days=days)).strftime("%Y-%m-%d")


def day_of(ts):
    return datetime.fromtimestamp(ts, KST).strftime("%Y-%m-%d")


def iso(ts):
    return datetime.fromtimestamp(ts, KST).isoformat(timespec="seconds") if ts else None


def new_id(prefix, table):
    while True:
        i = prefix + secrets.token_hex(3)
        if i not in table:
            return i


# ---------- 직렬화 ----------

def dist_km(a_lat, a_lng, b_lat, b_lng):
    r = 6371.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lng - a_lng)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def venue_brief(v):
    return {k: v.get(k) for k in ("id", "name", "region", "address", "lat", "lng")}


def game_out(g, now, full=False):
    v = DB["venues"].get(g["venue_id"], {})
    st = DB["structures"][g["structure_id"]]
    clk = engine.compute_clock(g, st, now)
    bb = clk["level"]["bb"] if clk["level"] else None
    out = {
        "id": g["id"], "name": g["name"], "tags": g.get("tags", []),
        "venue": venue_brief(v) if v else None, "venue_id": g["venue_id"],
        "state": g["state"], "start_at": iso(g["start_at"]), "start_ts": int(g["start_at"] * 1000),
        "date": day_of(g["start_at"]), "starting_chips": g["starting_chips"],
        "guarantee": g.get("guarantee", 0), "reg_close_level": g.get("reg_close_level"),
        "max_players": g.get("max_players"), "structure_id": g["structure_id"],
        "structure_name": st["name"], "level_min": st["levels"][0]["min"],
        "buyin": g["buyin_types"][0]["price"] if g["buyin_types"] else 0,
        "clock": clk, "stats": engine.stats(g, bb),
    }
    if full:
        out.update({
            "buyin_types": g["buyin_types"], "payouts": g.get("payouts", []),
            "notes": g.get("notes", ""), "structure": st,
            "segments": engine.build_segments(st),
            "started_at": iso(g.get("started_at")), "finished_at": iso(g.get("finished_at")),
            "venue": v or None,
        })
    return out


def comp_out(c, full=False):
    t = today_str()
    status = "upcoming" if t < c["start_date"] else ("finished" if t > c["end_date"] else "ongoing")
    out = {k: c[k] for k in ("id", "scope", "name", "city", "country", "flag", "currency",
                             "start_date", "end_date", "venue", "organizer")}
    out["status"] = status
    out["event_count"] = len(c.get("events", []))
    out["max_guarantee"] = max([e.get("guarantee", 0) for e in c.get("events", [])] or [0])
    if full:
        out["events"] = c.get("events", [])
        out["notes"] = c.get("notes", "")
    return out


def active_promos():
    t = today_str()
    return [p for p in DB["promos"].values() if p["starts_at"] <= t <= p["ends_at"]]


STATUS_GROUPS = {
    "live": ("PLAYING", "PAUSED"), "playing": ("PLAYING",), "paused": ("PAUSED",),
    "upcoming": ("WAITING",), "waiting": ("WAITING",), "done": ("FINISHED",),
    "finished": ("FINISHED",),
}


def query_games(q, now):
    status = (q.get("status") or "all").lower()
    region = q.get("region")
    venue = q.get("venue")
    date = q.get("date")
    text = (q.get("q") or "").strip().lower()
    reg = q.get("reg")
    near = q.get("near")
    sort = q.get("sort") or "start"
    limit = min(int(q.get("limit") or 300), 1000)
    ids = set(filter(None, (q.get("ids") or "").split(","))) or None
    rows = []
    for g in DB["games"].values():
        v = DB["venues"].get(g["venue_id"], {})
        if ids is not None and g["id"] not in ids:
            continue
        if status != "all" and g["state"] not in STATUS_GROUPS.get(status, (status.upper(),)):
            continue
        if region and v.get("region") != region:
            continue
        if venue and g["venue_id"] != venue:
            continue
        if date and day_of(g["start_at"]) != date:
            continue
        if text and text not in (g["name"] + " " + v.get("name", "") + " " + " ".join(g.get("tags", []))).lower():
            continue
        o = game_out(g, now)
        if reg == "open" and not (o["clock"]["reg_open"] and (g["state"] != "WAITING" or g["start_at"] - now < 4 * 3600)):
            continue
        if near:
            try:
                lat, lng = (float(x) for x in near.split(","))
                o["distance_km"] = round(dist_km(lat, lng, v["lat"], v["lng"]), 1)
            except (ValueError, KeyError):
                raise ApiError(400, "near 는 '위도,경도' 형식이어야 합니다")
        rows.append(o)
    keys = {
        "start": lambda o: o["start_ts"],
        "entries": lambda o: -o["stats"]["entries"],
        "players": lambda o: -o["stats"]["players_left"],
        "guarantee": lambda o: -o["guarantee"],
        "distance": lambda o: o.get("distance_km", 9e9),
        "level": lambda o: -(o["clock"]["level"]["lv"] if o["clock"]["level"] else 0),
    }
    if sort not in keys:
        raise ApiError(400, f"sort 는 {', '.join(keys)} 중 하나")
    rows.sort(key=keys[sort])
    return rows[:limit]


# ---------- 라우팅 ----------

class ApiError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code
        self.msg = msg


ROUTES = []


def route(method, pattern, admin=False):
    def deco(fn):
        ROUTES.append((method, re.compile("^" + pattern + "$"), fn, admin))
        return fn
    return deco


def need(obj, key, table, label):
    if key not in DB[table]:
        raise ApiError(404, f"{label}을(를) 찾을 수 없습니다: {key}")
    return DB[table][key]


@route("GET", "/api")
def api_index(req, q):
    return {"name": "CHIPBOARD API", "docs": "/docs.html",
            "endpoints": [f"{m} {re.sub(r'[(][?]P<(\w+)>[^)]+[)]', r'{\1}', p.pattern[1:-1])}" + ("  (관리자)" if a else "")
                          for m, p, _, a in ROUTES]}


@route("GET", "/api/health")
def api_health(req, q):
    return {"ok": True, "games": len(DB["games"]), "venues": len(DB["venues"]),
            "demo": DB.get("demo"), "simulation": SIM}


@route("GET", "/api/meta")
def api_meta(req, q):
    regions = sorted({v["region"] for v in DB["venues"].values()},
                     key=lambda r: ["서울", "경기", "인천", "부산", "대구", "대전", "광주", "울산", "제주"].index(r)
                     if r in ["서울", "경기", "인천", "부산", "대구", "대전", "광주", "울산", "제주"] else 99)
    return {"regions": regions, "today": today_str(),
            "dates": [today_str(d) for d in range(0, 4)],
            "structures": [{"id": s["id"], "name": s["name"]} for s in DB["structures"].values()],
            "demo": DB.get("demo")}


@route("GET", "/api/home")
def api_home(req, q):
    now = now_ts()
    today = query_games({"date": today_str()}, now)
    live = [g for g in today if g["state"] in ("PLAYING", "PAUSED")]
    hot = sorted(live, key=lambda g: -g["stats"]["players_left"])[:8]
    open_reg = [g for g in query_games({"reg": "open", "sort": "start"}, now)
                if g["state"] != "WAITING" or g["start_ts"] / 1000 - now < 3 * 3600][:10]
    feat = []
    for f in sorted(DB["featured"], key=lambda f: f["priority"]):
        g = DB["games"].get(f["game_id"])
        if g:
            feat.append({**f, "game": game_out(g, now)})
    comps = sorted((comp_out(c) for c in DB["competitions"].values() if c["end_date"] >= today_str()),
                   key=lambda c: c["start_date"])[:4]
    return {"promos": active_promos(), "featured": feat, "hot": hot, "open_reg": open_reg,
            "competitions": comps,
            "counts": {"live": len(live), "today": len(today),
                       "players": sum(g["stats"]["players_left"] for g in live),
                       "venues": len({g["venue_id"] for g in live})}}


@route("GET", "/api/live")
def api_live(req, q):
    now = now_ts()
    return {"games": query_games({**q, "status": q.get("status") or "live",
                                  "sort": q.get("sort") or "players"}, now)}


@route("GET", "/api/games")
def api_games(req, q):
    return {"games": query_games(q, now_ts())}


@route("GET", r"/api/games/(?P<gid>[\w-]+)")
def api_game(req, q, gid):
    now = now_ts()
    g = need(None, gid, "games", "게임")
    out = game_out(g, now, full=True)
    out["same_venue"] = [game_out(x, now) for x in DB["games"].values()
                         if x["venue_id"] == g["venue_id"] and x["id"] != gid
                         and day_of(x["start_at"]) == day_of(g["start_at"])]
    return out


@route("GET", r"/api/games/(?P<gid>[\w-]+)/clock")
def api_clock(req, q, gid):
    now = now_ts()
    g = need(None, gid, "games", "게임")
    o = game_out(g, now)
    return {"id": gid, "name": g["name"], "venue": o["venue"]["name"] if o["venue"] else None,
            "state": g["state"], "clock": o["clock"], "stats": o["stats"]}


@route("GET", "/api/venues")
def api_venues(req, q):
    now = now_ts()
    region, text, near = q.get("region"), (q.get("q") or "").lower(), q.get("near")
    out = []
    for v in DB["venues"].values():
        if region and v["region"] != region:
            continue
        if text and text not in (v["name"] + v["address"]).lower():
            continue
        today = [g for g in DB["games"].values() if g["venue_id"] == v["id"] and day_of(g["start_at"]) == today_str()]
        o = {**v, "today_games": len(today),
             "live_games": sum(g["state"] in ("PLAYING", "PAUSED") for g in today),
             "live_players": sum(g["players_left"] for g in today if g["state"] in ("PLAYING", "PAUSED"))}
        if near:
            try:
                lat, lng = (float(x) for x in near.split(","))
            except ValueError:
                raise ApiError(400, "near 는 '위도,경도' 형식이어야 합니다")
            o["distance_km"] = round(dist_km(lat, lng, v["lat"], v["lng"]), 1)
        out.append(o)
    out.sort(key=lambda o: (o.get("distance_km", 0), -o["live_players"], o["name"]))
    return {"venues": out}


@route("GET", r"/api/venues/(?P<vid>[\w-]+)")
def api_venue(req, q, vid):
    now = now_ts()
    v = need(None, vid, "venues", "매장")
    games = sorted((game_out(g, now) for g in DB["games"].values() if g["venue_id"] == vid
                    and day_of(g["start_at"]) >= today_str()), key=lambda o: o["start_ts"])
    return {**v, "games": games}


@route("GET", "/api/competitions")
def api_comps(req, q):
    scope = q.get("scope")
    status = q.get("status")
    out = [comp_out(c) for c in DB["competitions"].values() if not scope or c["scope"] == scope]
    if status:
        out = [c for c in out if c["status"] == status]
    order = {"ongoing": 0, "upcoming": 1, "finished": 2}
    out.sort(key=lambda c: (order[c["status"]], c["start_date"] if c["status"] != "finished" else ""))
    return {"competitions": out}


@route("GET", r"/api/competitions/(?P<cid>[\w-]+)")
def api_comp(req, q, cid):
    return comp_out(need(None, cid, "competitions", "대회"), full=True)


@route("GET", "/api/featured")
def api_featured(req, q):
    return {"featured": api_home(req, q)["featured"]}


@route("GET", "/api/promos")
def api_promos(req, q):
    return {"promos": active_promos()}


@route("GET", "/api/structures")
def api_structures(req, q):
    return {"structures": list(DB["structures"].values())}


@route("GET", r"/api/structures/(?P<sid>[\w-]+)")
def api_structure(req, q, sid):
    return need(None, sid, "structures", "구조")


@route("GET", "/api/search")
def api_search(req, q):
    text = (q.get("q") or "").strip().lower()
    if not text:
        return {"venues": [], "games": [], "competitions": []}
    now = now_ts()
    venues = [venue_brief(v) for v in DB["venues"].values()
              if text in (v["name"] + " " + v["address"] + " " + v["region"]).lower()]
    games = query_games({"q": text}, now)
    games = [g for g in games if g["date"] >= today_str()][:30]
    comps = [comp_out(c) for c in DB["competitions"].values()
             if text in (c["name"] + " " + c["city"] + " " + c["country"]).lower()]
    return {"venues": venues[:20], "games": games, "competitions": comps}


# ----- 관리자 (헤더 X-Admin-Key) -----

GAME_FIELDS = {"name": str, "venue_id": str, "structure_id": str, "start_at": (int, float, str),
               "starting_chips": int, "guarantee": int, "reg_close_level": int, "max_players": int,
               "tags": list, "buyin_types": list, "payouts": list, "notes": str,
               "reentry_ok": bool, "addon_ok": bool, "auto_start": bool, "players_left": int,
               "counts": dict}


def parse_time(v):
    if isinstance(v, (int, float)):
        return v / 1000 if v > 1e11 else v
    try:
        dt = datetime.fromisoformat(v)
    except (TypeError, ValueError):
        raise ApiError(400, "start_at 은 ISO 시각(예: 2026-11-01T19:00) 또는 epoch 이어야 합니다")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=KST)
    return dt.timestamp()


def clean_game(body, partial):
    out = {}
    for k, t in GAME_FIELDS.items():
        if k not in body:
            continue
        if not isinstance(body[k], t) or (t is int and isinstance(body[k], bool)):
            raise ApiError(400, f"{k} 형식이 잘못되었습니다")
        out[k] = body[k]
    if "start_at" in out:
        out["start_at"] = parse_time(out["start_at"])
    if "venue_id" in out and out["venue_id"] not in DB["venues"]:
        raise ApiError(400, "venue_id 가 없는 매장입니다")
    if "structure_id" in out and out["structure_id"] not in DB["structures"]:
        raise ApiError(400, "structure_id 가 없는 구조입니다")
    for b in out.get("buyin_types", []):
        if not (isinstance(b, dict) and b.get("key") in ("buyin", "reentry", "addon")
                and isinstance(b.get("price"), int) and isinstance(b.get("chips"), int)):
            raise ApiError(400, "buyin_types 항목은 {key: buyin|reentry|addon, name, price, chips}")
    if not partial:
        for k in ("name", "venue_id", "structure_id", "start_at"):
            if k not in out:
                raise ApiError(400, f"{k} 는 필수입니다")
    return out


@route("POST", "/api/admin/login", admin=True)
def adm_login(req, q):
    return {"ok": True}


@route("POST", "/api/admin/games", admin=True)
def adm_game_create(req, q):
    body = clean_game(req.json(), partial=False)
    chips = body.get("starting_chips", 30000)
    g = {
        "id": new_id("g", DB["games"]), "template": "custom", "tags": [], "state": "WAITING",
        "auto_start": True, "starting_chips": chips,
        "buyin_types": [{"key": "buyin", "name": "바이인", "price": 0, "chips": chips}],
        "guarantee": 0, "reg_close_level": 8, "max_players": 60, "reentry_ok": True,
        "addon_ok": False, "popularity": 1.0, "counts": {"buyin": 0, "reentry": 0, "addon": 0},
        "players_left": 0, "payouts": [], "notes": "", "started_at": None, "paused_at": None,
        "finished_at": None, "paused_total": 0, "skip": 0,
    }
    g.update(body)
    DB["games"][g["id"]] = g
    save_db()
    return 201, game_out(g, now_ts(), full=True)


@route("PATCH", r"/api/admin/games/(?P<gid>[\w-]+)", admin=True)
def adm_game_patch(req, q, gid):
    g = need(None, gid, "games", "게임")
    g.update(clean_game(req.json(), partial=True))
    save_db()
    return game_out(g, now_ts(), full=True)


@route("DELETE", r"/api/admin/games/(?P<gid>[\w-]+)", admin=True)
def adm_game_delete(req, q, gid):
    need(None, gid, "games", "게임")
    del DB["games"][gid]
    DB["featured"] = [f for f in DB["featured"] if f["game_id"] != gid]
    save_db()
    return {"deleted": gid}


@route("POST", r"/api/admin/games/(?P<gid>[\w-]+)/action", admin=True)
def adm_game_action(req, q, gid):
    g = need(None, gid, "games", "게임")
    body = req.json()
    try:
        engine.apply_action(g, DB["structures"][g["structure_id"]], body.get("action"),
                            now_ts(), body.get("n", 1))
    except engine.ActionError as e:
        raise ApiError(409, str(e))
    save_db()
    return game_out(g, now_ts(), full=True)


VENUE_FIELDS = {"name": str, "region": str, "address": str, "lat": (int, float), "lng": (int, float),
                "tables": int, "phone": str, "hours": str, "intro": str, "amenities": list}


def clean_fields(body, fields, required=()):
    out = {}
    for k, t in fields.items():
        if k in body:
            if not isinstance(body[k], t) or isinstance(body[k], bool):
                raise ApiError(400, f"{k} 형식이 잘못되었습니다")
            out[k] = body[k]
    for k in required:
        if k not in out:
            raise ApiError(400, f"{k} 는 필수입니다")
    return out


@route("POST", "/api/admin/venues", admin=True)
def adm_venue_create(req, q):
    body = clean_fields(req.json(), VENUE_FIELDS, ("name", "region"))
    v = {"id": new_id("v", DB["venues"]), "address": "", "lat": 37.5665, "lng": 126.978,
         "tables": 4, "phone": "", "hours": "", "intro": "", "amenities": [], **body}
    DB["venues"][v["id"]] = v
    save_db()
    return 201, v


@route("PATCH", r"/api/admin/venues/(?P<vid>[\w-]+)", admin=True)
def adm_venue_patch(req, q, vid):
    v = need(None, vid, "venues", "매장")
    v.update(clean_fields(req.json(), VENUE_FIELDS))
    save_db()
    return v


@route("DELETE", r"/api/admin/venues/(?P<vid>[\w-]+)", admin=True)
def adm_venue_delete(req, q, vid):
    need(None, vid, "venues", "매장")
    if any(g["venue_id"] == vid for g in DB["games"].values()):
        raise ApiError(409, "이 매장에 게임이 남아 있어 삭제할 수 없습니다")
    del DB["venues"][vid]
    save_db()
    return {"deleted": vid}


COMP_FIELDS = {"scope": str, "name": str, "city": str, "country": str, "flag": str,
               "currency": str, "start_date": str, "end_date": str, "venue": str,
               "organizer": str, "events": list, "notes": str}


@route("POST", "/api/admin/competitions", admin=True)
def adm_comp_create(req, q):
    body = clean_fields(req.json(), COMP_FIELDS, ("scope", "name", "start_date", "end_date"))
    if body["scope"] not in ("kr", "intl"):
        raise ApiError(400, "scope 는 kr 또는 intl")
    c = {"id": new_id("c", DB["competitions"]), "city": "", "country": "", "flag": "",
         "currency": "KRW", "venue": "", "organizer": "", "events": [], "notes": "", **body}
    DB["competitions"][c["id"]] = c
    save_db()
    return 201, comp_out(c, full=True)


@route("PATCH", r"/api/admin/competitions/(?P<cid>[\w-]+)", admin=True)
def adm_comp_patch(req, q, cid):
    c = need(None, cid, "competitions", "대회")
    c.update(clean_fields(req.json(), COMP_FIELDS))
    save_db()
    return comp_out(c, full=True)


@route("DELETE", r"/api/admin/competitions/(?P<cid>[\w-]+)", admin=True)
def adm_comp_delete(req, q, cid):
    need(None, cid, "competitions", "대회")
    del DB["competitions"][cid]
    save_db()
    return {"deleted": cid}


@route("POST", "/api/admin/promos", admin=True)
def adm_promo_create(req, q):
    body = clean_fields(req.json(), {"title": str, "body": str, "color": str, "starts_at": str,
                                     "ends_at": str, "link": dict}, ("title", "starts_at", "ends_at"))
    if "color" in body and not re.fullmatch(r"#[0-9a-fA-F]{3,8}", body["color"]):
        raise ApiError(400, "color 는 #RRGGBB 형식")
    p = {"id": new_id("p", DB["promos"]), "body": "", "color": "#33D1FF", "link": None, **body}
    DB["promos"][p["id"]] = p
    save_db()
    return 201, p


@route("DELETE", r"/api/admin/promos/(?P<pid>[\w-]+)", admin=True)
def adm_promo_delete(req, q, pid):
    need(None, pid, "promos", "공지")
    del DB["promos"][pid]
    save_db()
    return {"deleted": pid}


@route("PUT", "/api/admin/featured", admin=True)
def adm_featured(req, q):
    body = req.json()
    items = body.get("featured")
    if not isinstance(items, list) or not all(isinstance(i, dict) and i.get("game_id") in DB["games"] for i in items):
        raise ApiError(400, "featured 는 [{game_id, priority, label}] 목록 (game_id 는 존재해야 함)")
    DB["featured"] = [{"game_id": i["game_id"], "priority": int(i.get("priority", n + 1)),
                       "label": str(i.get("label", "추천"))} for n, i in enumerate(items)]
    save_db()
    return {"featured": DB["featured"]}


@route("POST", "/api/admin/reset", admin=True)
def adm_reset(req, q):
    load_db(reset=True)
    return {"ok": True, "games": len(DB["games"])}


# ---------- HTTP ----------

class Handler(BaseHTTPRequestHandler):
    server_version = "CHIPBOARD/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("CHIPBOARD_LOG"):
            super().log_message(fmt, *args)

    def json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 1_000_000:
            raise ApiError(413, "요청이 너무 큽니다")
        raw = self.rfile.read(n) if n else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            raise ApiError(400, "JSON 형식이 아닙니다")
        if not isinstance(body, dict):
            raise ApiError(400, "JSON 객체가 필요합니다")
        return body

    def send_json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.cors()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def dispatch(self):
        url = urlparse(self.path)
        path = url.path.rstrip("/") or "/"
        if path == "/api/stream":
            return self.stream()
        if not path.startswith("/api"):
            return self.static(url.path)
        q = {k: v[-1] for k, v in parse_qs(url.query).items()}
        allowed = False
        for method, pat, fn, admin in ROUTES:
            m = pat.match(path)
            if not m:
                continue
            allowed = True
            if method != self.command and not (method == "GET" and self.command == "HEAD"):
                continue
            try:
                if admin:
                    key = self.headers.get("X-Admin-Key") or ""
                    if not secrets.compare_digest(key.encode(), ADMIN_KEY.encode()):
                        raise ApiError(401, "관리자 키가 틀렸습니다")
                with LOCK:
                    res = fn(self, q, **m.groupdict())
                code, body = res if isinstance(res, tuple) else (200, res)
                if isinstance(body, dict):
                    body["server_now"] = int(time.time() * 1000)
                return self.send_json(code, body)
            except ApiError as e:
                return self.send_json(e.code, {"error": e.msg})
            except (ValueError, TypeError) as e:
                return self.send_json(400, {"error": f"잘못된 요청: {e}"})
        if allowed:
            return self.send_json(405, {"error": "허용되지 않는 메서드"})
        return self.send_json(404, {"error": "없는 API 입니다", "see": "/api"})

    do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = do_HEAD = dispatch

    def static(self, path):
        rel = unquote(path).lstrip("/") or "index.html"
        full = os.path.realpath(os.path.join(PUBLIC, rel))
        if not full.startswith(os.path.realpath(PUBLIC) + os.sep) or not os.path.isfile(full):
            full = os.path.join(PUBLIC, "index.html")  # SPA 라우팅
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def stream(self):
        """SSE: 3초마다 진행 중 게임 시계/숫자. ?game=ID 로 한 게임만."""
        q = {k: v[-1] for k, v in parse_qs(urlparse(self.path).query).items()}
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.cors()
        self.end_headers()
        self.close_connection = True
        try:
            while True:
                now = now_ts()
                with LOCK:
                    if q.get("game"):
                        g = DB["games"].get(q["game"])
                        items = [g] if g else []
                    else:
                        items = [g for g in DB["games"].values() if g["state"] in ("PLAYING", "PAUSED")]
                    payload = [{"id": g["id"], "state": g["state"],
                                **{k: v for k, v in game_out(g, now).items() if k in ("clock", "stats")}}
                               for g in items]
                msg = json.dumps({"server_now": int(now * 1000), "games": payload}, ensure_ascii=False)
                self.wfile.write(f"event: tick\ndata: {msg}\n\n".encode("utf-8"))
                self.wfile.flush()
                time.sleep(3)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            return


def sim_loop():
    """시작 시간 된 게임 자동 시작 + (데모) 엔트리/탈락 시뮬레이션."""
    last_save = 0
    while True:
        time.sleep(15)
        now = now_ts()
        with LOCK:
            if DB.get("demo") and DB.get("seed_day") != today_str():
                load_db(reset=True)
                continue
            changed = False
            for g in DB["games"].values():
                changed |= engine.auto_start(g, now)
                if SIM:
                    changed |= engine.sim_step(g, DB["structures"][g["structure_id"]], now)
            if changed and now - last_save > 30:
                save_db()
                last_save = now


def main():
    global SIM, ADMIN_KEY
    ap = argparse.ArgumentParser(description="CHIPBOARD 서버")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8080)))
    ap.add_argument("--reset", action="store_true", help="데모 데이터 새로 생성")
    ap.add_argument("--no-sim", action="store_true", help="엔트리/탈락 자동 시뮬레이션 끄기")
    a = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    SIM = not a.no_sim
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    ADMIN_KEY = admin_key()
    load_db(reset=a.reset)
    threading.Thread(target=sim_loop, daemon=True).start()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    srv.daemon_threads = True
    print(f"CHIPBOARD 실행 중 → http://localhost:{a.port}")
    print(f"관리자 페이지 → http://localhost:{a.port}/admin.html  (키: {ADMIN_KEY})")
    print(f"API 문서     → http://localhost:{a.port}/docs.html")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        save_db()


ADMIN_KEY = ""

if __name__ == "__main__":
    main()
