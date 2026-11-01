"""토너먼트 시계·통계·시뮬레이션 계산 (서버와 시드가 같이 씀)."""
import random

LIVE_STATES = ("PLAYING", "PAUSED")


def build_segments(st):
    """레벨과 휴식을 시간 순서대로 펼친 목록."""
    breaks = {int(k): v for k, v in (st.get("breaks") or {}).items()}
    segs = []
    for i, lv in enumerate(st["levels"]):
        segs.append({"kind": "level", "idx": i, "sec": int(lv["min"] * 60)})
        if breaks.get(lv["lv"]):
            segs.append({"kind": "break", "idx": i, "sec": int(breaks[lv["lv"]] * 60)})
    return segs


def elapsed_of(g, now):
    if not g.get("started_at"):
        return 0
    if g["state"] == "PAUSED" and g.get("paused_at"):
        ref = g["paused_at"]
    elif g["state"] == "FINISHED" and g.get("finished_at"):
        ref = g["finished_at"]
    else:
        ref = now
    return max(0.0, ref - g["started_at"] - g.get("paused_total", 0) + g.get("skip", 0))


def _blind(lv):
    return None if lv is None else {k: lv[k] for k in ("lv", "sb", "bb", "ante", "min")}


def locate(g, st, now):
    """현재 구간 번호, 구간 안에서 지난 초, 남은 초."""
    segs = build_segments(st)
    e = elapsed_of(g, now)
    acc = 0
    for si, s in enumerate(segs):
        if e < acc + s["sec"]:
            return segs, si, e - acc, acc + s["sec"] - e
        acc += s["sec"]
    return segs, len(segs) - 1, segs[-1]["sec"], 0.0


def compute_clock(g, st, now):
    levels = st["levels"]
    reg_close = g.get("reg_close_level") or 0
    if g["state"] == "WAITING":
        first = levels[0]
        return {
            "phase": "waiting", "running": False,
            "level": _blind(first), "next": _blind(levels[1] if len(levels) > 1 else None),
            "remaining": first["min"] * 60, "end_at": None,
            "starts_in": max(0, int(g["start_at"] - now)),
            "next_break_in": None, "reg_open": True, "reg_close_in": None,
            "elapsed": 0, "seg": 0,
        }
    segs, si, in_seg, remaining = locate(g, st, now)
    seg = segs[si]
    level = levels[seg["idx"]]
    nxt = levels[seg["idx"] + 1] if seg["idx"] + 1 < len(levels) else None
    if seg["kind"] == "break":
        phase = "break"
    else:
        phase = "level"
    if g["state"] == "PAUSED":
        phase = "paused"
    if g["state"] == "FINISHED":
        phase = "finished"

    next_break_in = None
    if seg["kind"] == "level":
        t = remaining
        for s in segs[si + 1:]:
            if s["kind"] == "break":
                next_break_in = int(t)
                break
            t += s["sec"]

    reg_open = g["state"] in LIVE_STATES and level["lv"] <= reg_close
    reg_close_in = None
    if reg_open:
        t = remaining
        for s in segs[si + 1:]:
            if levels[s["idx"]]["lv"] > reg_close:
                break
            t += s["sec"]
        reg_close_in = int(t)

    running = g["state"] == "PLAYING"
    return {
        "phase": phase, "running": running, "on_break": seg["kind"] == "break",
        "level": _blind(level), "next": _blind(nxt),
        "remaining": int(remaining),
        "end_at": int((now + remaining) * 1000) if running else None,
        "starts_in": 0, "next_break_in": next_break_in,
        "reg_open": reg_open, "reg_close_in": reg_close_in,
        "elapsed": int(elapsed_of(g, now)), "seg": si,
    }


def stats(g, bb=None):
    c = g.get("counts", {})
    bt = {b["key"]: b for b in g["buyin_types"]}
    chips = sum(c.get(k, 0) * bt[k]["chips"] for k in bt)
    entries = c.get("buyin", 0) + c.get("reentry", 0)
    left = g.get("players_left", 0)
    avg = chips // left if left else 0
    return {
        "entries": entries, "unique": c.get("buyin", 0), "reentries": c.get("reentry", 0),
        "addons": c.get("addon", 0), "players_left": left, "total_chips": chips,
        "avg_stack": avg, "avg_bb": round(avg / bb, 1) if bb and avg else None,
    }


# ---------- 운영 액션 ----------

class ActionError(ValueError):
    pass


def apply_action(g, st, action, now, n=1):
    n = max(1, int(n or 1))
    s = g["state"]
    c = g.setdefault("counts", {})
    if action == "start":
        if s != "WAITING":
            raise ActionError("이미 시작된 게임입니다")
        g.update(state="PLAYING", started_at=now, paused_total=0, skip=0, paused_at=None)
    elif action == "pause":
        if s != "PLAYING":
            raise ActionError("진행 중일 때만 일시정지할 수 있습니다")
        g.update(state="PAUSED", paused_at=now)
    elif action == "resume":
        if s != "PAUSED":
            raise ActionError("일시정지 상태가 아닙니다")
        g["paused_total"] = g.get("paused_total", 0) + (now - g["paused_at"])
        g.update(state="PLAYING", paused_at=None)
    elif action in ("next", "prev", "add_time"):
        if s not in LIVE_STATES:
            raise ActionError("진행 중인 게임이 아닙니다")
        segs, si, in_seg, remaining = locate(g, st, now)
        if action == "next":
            if si >= len(segs) - 1:
                raise ActionError("마지막 레벨입니다")
            g["skip"] = g.get("skip", 0) + remaining
        elif action == "prev":
            back = in_seg + (segs[si - 1]["sec"] if si > 0 and in_seg < 10 else 0)
            g["skip"] = g.get("skip", 0) - back
        else:
            sec = min(n, in_seg)
            g["skip"] = g.get("skip", 0) - sec
        raw = _ref(g, now) - g["started_at"] - g.get("paused_total", 0) + g["skip"]
        if raw < 0:  # 레벨 1 시작보다 앞으로는 못 감
            g["skip"] -= raw
    elif action in ("entry", "reentry"):
        if s == "FINISHED":
            raise ActionError("종료된 게임입니다")
        if s in LIVE_STATES and not compute_clock(g, st, now)["reg_open"]:
            raise ActionError("등록이 마감되었습니다")
        key = "buyin" if action == "entry" else "reentry"
        c[key] = c.get(key, 0) + n
        g["players_left"] = g.get("players_left", 0) + n
    elif action == "addon":
        c["addon"] = c.get("addon", 0) + n
    elif action == "bust":
        g["players_left"] = max(1, g.get("players_left", 0) - n)
    elif action == "finish":
        if s == "PAUSED":
            apply_action(g, st, "resume", now)
        g.update(state="FINISHED", finished_at=now)
    elif action == "reset":
        g.update(state="WAITING", started_at=None, paused_at=None, finished_at=None,
                 paused_total=0, skip=0)
    else:
        raise ActionError(f"알 수 없는 액션: {action}")


def _ref(g, now):
    return g["paused_at"] if g["state"] == "PAUSED" and g.get("paused_at") else now


# ---------- 데모 시뮬레이션 ----------

def auto_start(g, now):
    if g["state"] == "WAITING" and g.get("auto_start", True) and now >= g["start_at"]:
        g.update(state="PLAYING", started_at=g["start_at"], paused_total=0, skip=0, paused_at=None)
        return True
    return False


def sim_step(g, st, now, rng=random):
    """15초 한 번 분량의 엔트리/탈락 변화. 바뀌면 True."""
    if g["state"] != "PLAYING":
        return False
    clk = compute_clock(g, st, now)
    c = g.setdefault("counts", {})
    left = g.get("players_left", 0)
    cap = g.get("max_players") or 999
    entries = c.get("buyin", 0) + c.get("reentry", 0)
    pop = g.get("popularity", 1.0)
    changed = False
    if clk["reg_open"]:
        if left < cap and c.get("buyin", 0) < cap and rng.random() < 0.09 * pop:
            c["buyin"] = c.get("buyin", 0) + 1
            left += 1
            changed = True
        busted = entries - left
        if busted > 0 and left < cap and g.get("reentry_ok", True) and rng.random() < 0.05 * pop:
            c["reentry"] = c.get("reentry", 0) + 1
            left += 1
            changed = True
        if left > 3 and clk["level"]["lv"] >= 3 and rng.random() < 0.06:
            left -= 1
            changed = True
        if g.get("addon_ok") and clk["on_break"] and rng.random() < 0.25:
            c["addon"] = c.get("addon", 0) + 1
            changed = True
    elif left > 1:
        if rng.random() < min(0.5, 0.025 + left / 700):
            left -= 1
            changed = True
    g["players_left"] = left
    if left <= 1 and entries > 1:
        g.update(state="FINISHED", finished_at=now)
        changed = True
    return changed
