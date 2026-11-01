"""데모 데이터 생성. 매장·대회 이름은 전부 가상(샘플)."""
import random
from datetime import datetime, timedelta, timezone

import engine

KST = timezone(timedelta(hours=9))

BLINDS = [(100, 200), (200, 400), (300, 600), (400, 800), (500, 1000), (600, 1200),
          (800, 1600), (1000, 2000), (1200, 2400), (1500, 3000), (2000, 4000), (2500, 5000),
          (3000, 6000), (4000, 8000), (5000, 10000), (6000, 12000), (8000, 16000),
          (10000, 20000), (12000, 24000), (15000, 30000), (20000, 40000), (25000, 50000),
          (30000, 60000), (40000, 80000), (50000, 100000), (60000, 120000),
          (80000, 160000), (100000, 200000)]


def structure(sid, name, minutes, break_every, break_min, ante_from=3):
    levels = [{"lv": i + 1, "sb": sb, "bb": bb, "ante": bb if i + 1 >= ante_from else 0,
               "min": minutes} for i, (sb, bb) in enumerate(BLINDS)]
    breaks = {str(lv): break_min for lv in range(break_every, len(BLINDS), break_every)}
    return {"id": sid, "name": name, "levels": levels, "breaks": breaks}


STRUCTURES = [
    structure("hyper", "하이퍼 터보 8분", 8, 8, 5),
    structure("turbo", "터보 12분", 12, 6, 10),
    structure("standard", "스탠다드 20분", 20, 4, 10),
    structure("deep", "딥스택 30분", 30, 4, 15, ante_from=2),
]

# id, 이름, 지역, 동네, 위도, 경도, 테이블 수
VENUES = [
    ("v01", "블루펠트 라운지", "서울", "강남구 역삼동", 37.4995, 127.0300, 8),
    ("v02", "리버카드 홀덤", "서울", "마포구 서교동", 37.5560, 126.9230, 6),
    ("v03", "노스스타 포커룸", "서울", "송파구 잠실동", 37.5130, 127.1000, 7),
    ("v04", "플랍하우스", "서울", "광진구 화양동", 37.5405, 127.0700, 5),
    ("v05", "스페이드원", "서울", "영등포구 여의도동", 37.5215, 126.9245, 6),
    ("v06", "턴앤리버 분당", "경기", "성남시 분당구 서현동", 37.3850, 127.1230, 6),
    ("v07", "체크레이즈 수원", "경기", "수원시 팔달구 인계동", 37.2660, 127.0300, 5),
    ("v08", "올인클럽 일산", "경기", "고양시 일산동구 장항동", 37.6580, 126.7700, 4),
    ("v09", "칩리더 부평", "인천", "부평구 부평동", 37.4890, 126.7240, 5),
    ("v10", "오션하트 송도", "인천", "연수구 송도동", 37.3920, 126.6390, 6),
    ("v11", "하버나인 서면", "부산", "부산진구 부전동", 35.1580, 129.0600, 7),
    ("v12", "마린플랍 해운대", "부산", "해운대구 우동", 35.1630, 129.1630, 6),
    ("v13", "레드킹 동성로", "대구", "중구 동성로", 35.8690, 128.5960, 5),
    ("v14", "센터레인 둔산", "대전", "서구 둔산동", 36.3520, 127.3780, 4),
    ("v15", "상무 포켓페어", "광주", "서구 치평동", 35.1520, 126.8510, 4),
    ("v16", "아일랜드 칩스", "제주", "제주시 연동", 33.4890, 126.4930, 5),
    ("v17", "웨이브 홀덤 울산", "울산", "남구 삼산동", 35.5380, 129.3380, 4),
]

TEMPLATES = [
    dict(key="daily_turbo", name="데일리 터보", st="turbo", chips=20000, price=50000, reg=8,
         cap=60, gtd=0, tags=["터보", "리엔트리"], reentry=True, addon=False, pop=1.0,
         prize="seed"),
    dict(key="daily_std", name="데일리 스탠다드", st="standard", chips=30000, price=70000, reg=10,
         cap=80, gtd=0, tags=["스탠다드"], reentry=True, addon=False, pop=1.1, prize="seed"),
    dict(key="night_deep", name="나이트 딥스택", st="deep", chips=50000, price=100000, reg=9,
         cap=90, gtd=5000000, tags=["딥스택", "애드온"], reentry=True, addon=True, pop=1.2,
         prize="seed"),
    dict(key="satellite", name="시드권 새틀라이트", st="hyper", chips=15000, price=30000, reg=10,
         cap=50, gtd=0, tags=["새틀라이트", "하이퍼"], reentry=True, addon=False, pop=0.9,
         prize="satellite"),
    dict(key="bounty", name="바운티 헌터", st="standard", chips=30000, price=80000, reg=10,
         cap=70, gtd=3000000, tags=["바운티"], reentry=True, addon=False, pop=1.0,
         prize="seed"),
    dict(key="highroller", name="하이롤러", st="deep", chips=100000, price=300000, reg=8,
         cap=40, gtd=10000000, tags=["하이롤러", "프리즈아웃"], reentry=False, addon=False,
         pop=0.6, prize="seed"),
    dict(key="weekend_main", name="주말 메인 이벤트", st="deep", chips=60000, price=150000,
         reg=10, cap=200, gtd=30000000, tags=["메인", "딥스택", "애드온"], reentry=True,
         addon=True, pop=1.8, prize="seed"),
]

SEED_PRIZES = ["샘플 시리즈 메인 시드 2장 + 트로피", "샘플 시리즈 메인 시드 1장",
               "하이롤러 시드 1장", "데일리 프리 엔트리 3장", "데일리 프리 엔트리 2장",
               "데일리 프리 엔트리 1장", "매장 포인트 3만", "매장 포인트 2만", "매장 포인트 1만"]


def payouts(kind, cap):
    if kind == "satellite":
        n = max(2, cap // 10)
        return [{"place": f"1~{n}위", "prize": "데일리 스탠다드 시드 1장"},
                {"place": f"{n + 1}위", "prize": "매장 포인트 1만"}]
    n = 6 if cap <= 60 else 9
    return [{"place": f"{i + 1}위", "prize": p} for i, p in enumerate(SEED_PRIZES[:n])]


def make_game(rng, gid, venue_id, t, start_at):
    bt = [{"key": "buyin", "name": "바이인", "price": t["price"], "chips": t["chips"]}]
    if t["reentry"]:
        bt.append({"key": "reentry", "name": "리엔트리", "price": t["price"], "chips": t["chips"]})
    if t["addon"]:
        bt.append({"key": "addon", "name": "애드온", "price": t["price"] // 2,
                   "chips": t["chips"] // 2})
    return {
        "id": gid, "venue_id": venue_id, "template": t["key"], "name": t["name"],
        "tags": list(t["tags"]), "structure_id": t["st"], "start_at": int(start_at),
        "state": "WAITING", "auto_start": True, "starting_chips": t["chips"],
        "buyin_types": bt, "guarantee": t["gtd"], "reg_close_level": t["reg"],
        "max_players": t["cap"], "reentry_ok": t["reentry"], "addon_ok": t["addon"],
        "popularity": round(t["pop"] * rng.uniform(0.7, 1.3), 2),
        "counts": {"buyin": 0, "reentry": 0, "addon": 0}, "players_left": 0,
        "payouts": payouts(t["prize"], t["cap"]),
        "notes": "데모용 샘플 토너먼트입니다.",
        "started_at": None, "paused_at": None, "finished_at": None,
        "paused_total": 0, "skip": 0,
    }


def fast_forward(g, st, now, rng):
    """시작 시각부터 지금까지 시뮬레이션을 돌려 숫자를 채운다."""
    if g["start_at"] > now:
        pre = int(g["max_players"] * rng.uniform(0.0, 0.18))
        g["counts"]["buyin"] = pre
        g["players_left"] = pre
        return
    engine.auto_start(g, g["start_at"])
    # 시작 전 사전 등록
    pre = int(g["max_players"] * rng.uniform(0.08, 0.2))
    g["counts"]["buyin"] += pre
    g["players_left"] += pre
    t = g["start_at"]
    while t < now and g["state"] == "PLAYING":
        t += 15
        engine.sim_step(g, st, min(t, now), rng)


def make_db(now=None):
    now = now or datetime.now(KST).timestamp()
    today = datetime.fromtimestamp(now, KST)
    rng = random.Random(today.strftime("%Y%m%d"))
    structures = {s["id"]: s for s in STRUCTURES}

    venues = {}
    for vid, name, region, area, lat, lng, tables in VENUES:
        venues[vid] = {
            "id": vid, "name": name, "region": region, "address": f"{region} {area} (샘플 주소)",
            "lat": lat, "lng": lng, "tables": tables,
            "phone": f"0507-0000-{int(vid[1:]):04d}",
            "hours": "평일 14:00 ~ 05:00 / 주말 12:00 ~ 06:00",
            "intro": f"{area}의 {tables}테이블 홀덤 매장 (데모 데이터)",
            "amenities": rng.sample(["주차", "흡연실", "음료 무료", "식사 가능", "와이파이", "카드 결제"], 3),
        }

    games = {}
    gid = 0
    # 오늘: 지금 기준으로 앞뒤 시간에 배치해서 항상 진행 중인 게임이 있게
    offsets_h = [-7.5, -5.0, -3.4, -2.2, -1.3, -0.6, -0.15, 0.4, 1.2, 2.5, 4.0, 6.0]
    for vid in venues:
        picks = rng.sample(TEMPLATES[:-1], 3)
        if today.weekday() >= 5 and rng.random() < 0.4:
            picks[0] = TEMPLATES[-1]
        hours = sorted(rng.sample(offsets_h, len(picks)))
        for t, h in zip(picks, hours):
            gid += 1
            start = now + h * 3600
            start -= start % 600  # 10분 단위
            g = make_game(rng, f"g{gid:04d}", vid, t, start)
            fast_forward(g, structures[g["structure_id"]], now, rng)
            games[g["id"]] = g

    # 앞으로 3일: 정해진 시간대
    for d in range(1, 4):
        day = (today + timedelta(days=d)).replace(hour=0, minute=0, second=0, microsecond=0)
        weekend = day.weekday() >= 5
        for vid in venues:
            for hh in rng.sample([14, 17, 19, 20, 21, 22], 2 + (rng.random() < 0.5)):
                gid += 1
                pool = TEMPLATES if weekend else TEMPLATES[:-1]
                t = rng.choice(pool)
                g = make_game(rng, f"g{gid:04d}", vid, t, (day + timedelta(hours=hh)).timestamp())
                pre = int(g["max_players"] * rng.uniform(0.0, 0.15))
                g["counts"]["buyin"] = pre
                g["players_left"] = pre
                games[g["id"]] = g

    def dstr(days):
        return (today + timedelta(days=days)).strftime("%Y-%m-%d")

    def series(cid, scope, name, city, country, flag, cur, s, e, venue, events):
        evs = []
        for i, (ename, day, time_, buyin, gtd, chips) in enumerate(events):
            evs.append({"no": i + 1, "name": ename, "date": dstr(s + day), "time": time_,
                        "buyin": buyin, "guarantee": gtd, "chips": chips})
        return {"id": cid, "scope": scope, "name": name, "city": city, "country": country,
                "flag": flag, "currency": cur, "start_date": dstr(s), "end_date": dstr(e),
                "venue": venue, "organizer": "샘플 조직위원회", "events": evs,
                "notes": "데모용 가상 대회입니다. 실제 일정이 아닙니다."}

    comps = [
        series("c01", "kr", "서울 시티 챔피언십 (샘플)", "서울", "대한민국", "🇰🇷", "KRW", -2, 3,
               "샘플 컨벤션홀 A", [("오프닝 이벤트", 0, "13:00", 300000, 100000000, 30000),
                                   ("바운티 이벤트", 1, "15:00", 500000, 150000000, 40000),
                                   ("메인 이벤트 Day1", 2, "12:00", 1100000, 500000000, 50000),
                                   ("하이롤러", 3, "14:00", 3300000, 300000000, 100000),
                                   ("메인 이벤트 파이널", 5, "13:00", 0, 0, 0)]),
        series("c02", "kr", "코리아 오픈 홀덤 시리즈 (샘플)", "서울", "대한민국", "🇰🇷", "KRW", 6, 13,
               "샘플 호텔 그랜드볼룸", [("오프닝 터보", 0, "13:00", 220000, 50000000, 25000),
                                      ("레이디스 이벤트", 1, "14:00", 220000, 20000000, 25000),
                                      ("메인 이벤트 Day1A", 2, "12:00", 1100000, 1000000000, 60000),
                                      ("메인 이벤트 Day1B", 3, "12:00", 1100000, 0, 60000),
                                      ("슈퍼 하이롤러", 5, "15:00", 5500000, 500000000, 150000)]),
        series("c03", "kr", "부산 오션 포커 페스티벌 (샘플)", "부산", "대한민국", "🇰🇷", "KRW", 18, 24,
               "샘플 해변 호텔", [("웰컴 이벤트", 0, "14:00", 300000, 80000000, 30000),
                                ("딥스택 이벤트", 2, "13:00", 550000, 150000000, 50000),
                                ("메인 이벤트", 3, "12:00", 1100000, 500000000, 60000)]),
        series("c04", "kr", "제주 아일랜드 클래식 (샘플)", "제주", "대한민국", "🇰🇷", "KRW", 30, 37,
               "샘플 리조트 볼룸", [("오프닝", 0, "14:00", 330000, 100000000, 30000),
                                 ("메인 이벤트", 2, "12:00", 1650000, 1000000000, 75000),
                                 ("하이롤러", 4, "15:00", 5500000, 500000000, 150000)]),
        series("c05", "intl", "아시아 퍼시픽 포커 투어 마닐라 (샘플)", "마닐라", "필리핀", "🇵🇭", "USD", 9, 17,
               "Sample Resort Manila", [("Opening", 0, "13:00", 300, 100000, 30000),
                                        ("Main Event", 3, "12:00", 1500, 1000000, 50000),
                                        ("High Roller", 6, "14:00", 5000, 500000, 100000)]),
        series("c06", "intl", "마카오 하이롤러 위크 (샘플)", "마카오", "중국", "🇲🇴", "HKD", 21, 28,
               "Sample Casino Macau", [("Kick-off", 0, "14:00", 5000, 2000000, 30000),
                                       ("Main Event", 2, "12:00", 15000, 10000000, 60000),
                                       ("Super High Roller", 5, "15:00", 100000, 20000000, 200000)]),
        series("c07", "intl", "라스베이거스 서머 시리즈 (샘플)", "라스베이거스", "미국", "🇺🇸", "USD", 40, 60,
               "Sample Hotel Las Vegas", [("Mystery Bounty", 0, "11:00", 400, 1000000, 40000),
                                          ("Main Event Day1", 10, "11:00", 10000, 0, 60000),
                                          ("High Roller", 15, "13:00", 25000, 5000000, 100000)]),
        series("c08", "intl", "몰타 지중해 오픈 (샘플)", "몰타", "몰타", "🇲🇹", "EUR", -20, -14,
               "Sample Casino Malta", [("Opening", 0, "14:00", 300, 100000, 30000),
                                       ("Main Event", 2, "12:00", 1100, 1000000, 50000)]),
    ]

    live_ids = [g["id"] for g in games.values() if g["state"] == "PLAYING"]
    big = sorted(live_ids, key=lambda i: -games[i]["players_left"])[:3]
    featured = [{"game_id": i, "priority": n + 1, "label": "오늘의 추천"} for n, i in enumerate(big)]

    promos = [
        {"id": "p1", "title": "데모 사이트입니다", "body": "모든 매장·대회·숫자는 가상 데이터예요. 관리자 페이지에서 직접 바꿔보세요.",
         "color": "#33D1FF", "starts_at": dstr(-1), "ends_at": dstr(30), "link": {"type": "page", "id": "admin"}},
        {"id": "p2", "title": "코리아 오픈 홀덤 시리즈 (샘플)", "body": f"{dstr(6)} 개막 · 메인 GTD 10억",
         "color": "#FFC24B", "starts_at": dstr(-1), "ends_at": dstr(13), "link": {"type": "comp", "id": "c02"}},
        {"id": "p3", "title": "주말 메인 이벤트", "body": "토·일 전 매장 딥스택 메인 이벤트",
         "color": "#3EE0A1", "starts_at": dstr(-1), "ends_at": dstr(6), "link": {"type": "tab", "id": "games"}},
    ]

    return {
        "demo": True, "seed_day": today.strftime("%Y-%m-%d"), "version": 1,
        "structures": structures, "venues": venues, "games": games,
        "competitions": {c["id"]: c for c in comps}, "featured": featured,
        "promos": {p["id"]: p for p in promos},
    }
