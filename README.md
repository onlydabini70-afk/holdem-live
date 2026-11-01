# CHIPBOARD — 홀덤 토너먼트 실시간 현황

매장 토너먼트와 국내·해외 대회의 **레벨·남은 시간·엔트리·남은 인원·평균 스택**을 실시간으로 보여주는 모바일 웹앱입니다.
매장·대회·숫자는 전부 **가상 데모 데이터**입니다.

## 화면
- **홈**: 요약 숫자, 이벤트 배너, 오늘 핫한 게임, 지금 등록 가능, 즐겨찾는/최근 본 매장, 내 주변 게임(위치), 대회
- **라이브**: 진행 중 게임 (지역 필터, 인원/엔트리/레벨/시작순 정렬)
- **게임**: 날짜·지역·상태별 토너먼트 / 매장 목록
- **대회**: 국내·해외 대회와 이벤트 일정
- **MY**: 즐겨찾기 매장·게임, 최근 본 매장, 기본 지역 설정
- **게임 상세**: 실시간 시계, 블라인드 구조표, 프라이즈, 매장정보, 공유, 즐겨찾기, **TV 모드**(매장 모니터용 큰 시계)
- **관리자**(`admin.html`): 시계 시작/일시정지/재개/이전·다음 레벨/+1분, 엔트리·리엔트리·애드온·탈락, 게임 생성·삭제, 데모 초기화
- **API 문서**(`docs.html`): 모든 엔드포인트와 바로 실행

## 데이터 출처 (APIS 실시간)
기본 데이터는 **APIS (apislive.com)** 가 공개로 내주는 주소 3개에서 가져옵니다. 키·로그인 없음.

| 주소 | 주기 | 쓰는 값 |
|---|---|---|
| `GET /data.json` | 60초 (ETag/If-None-Match, 304면 유지) | 매장·토너먼트·블라인드 구조 |
| `GET /live` | 10초 | 진행 레벨·엔트리·남은 인원·평균 스택 |
| `GET /live?clock=list` | 10초 | 클락 기반 레벨/남은 시간 (levelIdx·endsAt) |

- 탭이 숨겨지면 폴링을 멈춥니다.
- 연결 규칙: `/live.id` = `tournament._key`, 클락 `game_id` = `tournament._gameid`.
- 진행 상태는 실시간 값 우선, 클락 `updated_at` 40분 초과는 제외.
- 실패해도 더미로 되돌리지 않고 **마지막 성공값 + 갱신 시각**을 유지합니다.
- 없는 값은 지어내지 않고 `-` 로 표시합니다.
- 매장 **연락처(contact)는 화면에 노출하지 않습니다.** 회원·지갑·주문 등 다른 데이터는 조회하지 않습니다.

데이터 호출은 전부 [public/apis.js](public/apis.js) 한 파일에 모여 있고, 화면 코드는 그 파일이 내주는 응답(기존 더미와 같은 모양)만 씁니다.

## 실행 방식
| 모드 | 데이터 | 비고 |
|---|---|---|
| 기본 (`?mode=apis`) | APIS 실시간 | 읽기 전용 |
| `?mode=local` | 브라우저 안 더미 (`public/localapi.js`) | 기기별 저장, 관리자 편집 가능 |
| `?mode=server` | 파이썬 서버 `data/db.json` | 관리자 편집 가능 |

관리자 페이지(`admin.html`)는 APIS 가 읽기 전용이라 항상 서버/로컬 데이터를 편집합니다.

## 로컬 실행
```bash
python server.py            # http://localhost:8080
python server.py --reset    # 데모 데이터 새로 생성
python server.py --no-sim   # 엔트리/탈락 자동 시뮬레이션 끄기
```
파이썬 3.10+ 표준 라이브러리만 씁니다 (설치할 패키지 없음).
관리자 키는 처음 실행할 때 `data/admin_key.txt` 에 만들어지고 콘솔에 표시됩니다 (환경변수 `CHIPBOARD_ADMIN_KEY` 로 지정 가능).
GitHub Pages(로컬 모드)의 관리자 키는 `demo` 입니다.

## API 요약
| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/home` | 홈 묶음 |
| GET | `/api/live` | 진행 중 게임 |
| GET | `/api/games` | 게임 검색 (`date, status, region, venue, q, reg=open, near=lat,lng, sort, ids`) |
| GET | `/api/games/{id}` | 게임 상세 |
| GET | `/api/games/{id}/clock` | 시계만 |
| GET | `/api/venues`, `/api/venues/{id}` | 매장 |
| GET | `/api/competitions`, `/api/competitions/{id}` | 대회 |
| GET | `/api/featured`, `/api/promos`, `/api/structures`, `/api/search`, `/api/meta`, `/api/health` | 기타 |
| GET | `/api/stream` | SSE 실시간 (서버 모드) |
| POST/PATCH/PUT/DELETE | `/api/admin/...` | 관리자 (헤더 `X-Admin-Key`) |

전체 목록은 `GET /api` 또는 `docs.html`.

## 구조
```
server.py      HTTP 서버 + 라우트
engine.py      시계·통계·운영 액션·시뮬레이션
seed.py        데모 데이터
public/        프론트엔드 (GitHub Pages 배포 대상)
  localapi.js  서버 없는 환경용 API (engine/seed/server 를 JS 로 옮긴 것)
  client.js    API 호출 + 모드 자동 판단
  app.js       화면
.github/workflows/pages.yml   main 에 푸시하면 public/ 를 GitHub Pages 로 배포
```
