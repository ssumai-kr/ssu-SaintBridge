# ssu-saintbridge 구현 로드맵

> 기준 문서: [PROJECT_PLAN.md](./PROJECT_PLAN.md)  
> 작성일: 2026-08-10  
> 현재 단계: `M1 — HTTP Transport` 진행 중  
> 대상 릴리스: `v0.1.0`

## 1. 로드맵 운영 방식

이 문서는 프로젝트 기획을 **4주 집중 개발**로 실행하기 위한 작업 문서다. 구현 중 범위와 보안 원칙은 `PROJECT_PLAN.md`를 기준으로 하며, 이 문서는 작업 순서와 완료 판정에 집중한다.

- 일정이 아니라 **완료 게이트**를 통과해야 다음 마일스톤으로 이동한다.
- 실제 계정이 필요한 작업은 mock 흐름과 redaction 검증이 먼저 완료된 뒤 수행한다.
- 각 기능은 `타입/계약 → 실패 테스트 → 최소 구현 → 회귀 테스트 → 문서` 순서로 완성한다.
- upstream 응답을 추측해서 정상 데이터로 반환하지 않는다. 계약이 맞지 않으면 `PARSER_MISMATCH`로 실패한다.
- v0.1에서는 조회 기능만 구현하고, 신청·제출·변경·결제 기능은 backlog에도 넣지 않는다.

### 상태 표기

| 상태      | 의미                                          |
| --------- | --------------------------------------------- |
| `TODO`    | 아직 시작하지 않음                            |
| `DOING`   | 현재 진행 중이며 한 번에 가능한 한 1개만 유지 |
| `BLOCKED` | 외부 결정이나 upstream 관찰이 필요함          |
| `DONE`    | 코드, 테스트, 문서 및 완료 게이트를 모두 충족 |

## 2. 한 달 실행 일정

1인 전일제 개발, 주 5일, 총 20일을 기준으로 한다. 4주 안에 `0.1.0-rc.1`을 만들고, 보안 출시 게이트가 모두 통과되면 같은 주에 `0.1.0`을 배포한다. 일정이 밀리면 기능 범위를 줄이고 보안·세션 격리·민감정보 검사는 줄이지 않는다.

| 마일스톤 | 목표                          |          배정 | 선행 조건            | 상태      |
| -------- | ----------------------------- | ------------: | -------------------- | --------- |
| M0       | 안전한 모노레포와 개발 기반   |   1주차 D1~D2 | 없음                 | `BLOCKED` |
| M1       | cookie-aware HTTP transport   |   1주차 D3~D5 | M0                   | `DOING`   |
| M2       | SSO/포털 인증 상태 머신       |   2주차 D6~D7 | M1                   | `TODO`    |
| M3       | Web Dynpro 공통 프로토콜      |  2주차 D8~D10 | M2                   | `TODO`    |
| M4       | 학생 기본정보 application     | 3주차 D11~D12 | M3                   | `TODO`    |
| M5       | 수강내역·시간표 application   | 3주차 D13~D15 | M3, M4의 parser 패턴 | `TODO`    |
| M6       | CLI와 local-first REST Server | 4주차 D16~D18 | M4, M5               | `TODO`    |
| M7       | RC 검증과 v0.1.0 배포         | 4주차 D19~D20 | M0~M6                | `TODO`    |

현재 진행 상황:

- `DONE`: FND-01 런타임/workspace 고정
- `DONE`: FND-02 `types`, `protocol`, `server`, `cli` 패키지 골격
- `DONE`: FND-03 strict TypeScript, ESLint, Prettier, Vitest 및 전체 검증 명령
- `DONE`: FND-04 공통 오류·학기 모델과 안전한 오류 직렬화
- `DONE`: FND-05 fixture loader, loopback mock upstream, 테스트 네트워크 차단
- `DONE`: FND-06 민감 파일·fixture·canary repository 검사
- `DONE`: FND-07 header/query/form/JSON 기반 HAR sanitizer
- `BLOCKED`: FND-08 CI workflow의 최초 원격 실행 확인—첫 push 필요
- `DONE`: NET-01 HTTPS·host·port·credential·fragment URL 정책

### 주차별 결과물

| 주차  | 집중 영역              | 주말 기준 결과물                                                            |
| ----- | ---------------------- | --------------------------------------------------------------------------- |
| 1주차 | Foundation + Transport | 모노레포, 공통 타입, CI, 안전한 HTTP/쿠키/redirect 계층                     |
| 2주차 | SSO + Web Dynpro Core  | mock 로그인 전체 흐름, live smoke, bootstrap/event fixture replay           |
| 3주차 | Applications           | `student.getInfo()`, `getCourses()`, `getTimetable()` 및 최소 CLI JSON 출력 |
| 4주차 | REST + Release         | local REST API, Swagger, Docker/npm RC, 보안 게이트 검증                    |

### 한 달 완수를 위한 범위 규칙

- CLI는 `student info`, `courses`, `timetable`의 JSON 출력만 제공한다. 대화형 UI와 꾸미기는 이후로 미룬다.
- REST는 계획서에 명시된 v0.1 endpoint만 구현한다. 별도 웹 UI는 만들지 않는다.
- Docker는 단일 로컬 실행 이미지까지만 제공한다. multi-arch 최적화와 배포 플랫폼별 가이드는 이후로 미룬다.
- 문서는 quick start, 인증, 보안, fixture 기여 방법에 집중한다. 예제 앱과 다국어 문서는 이후로 미룬다.
- 지원 화면이 예상과 다르면 범용 추측 parser를 추가하지 않고 해당 fixture를 명시적으로 실패시킨다.
- 성적, 장학금, 채플, 졸업사정, REST client, MCP는 v0.1에 추가하지 않는다.

### 일정 보호 체크포인트

- **D5:** transport 완료. 미완료면 charset/retry 편의 기능을 RC 이후로 옮기되 allowlist, cookie, redirect, timeout은 유지한다.
- **D10:** 로그인과 Web Dynpro fixture replay 완료. 여기서 live 흐름이 재현되지 않으면 application을 억지로 구현하지 않고 원인부터 해결한다.
- **D15:** 세 가지 protocol 조회 API 완료. 추가 필드는 미루고 최소 안정 모델을 고정한다.
- **D18:** REST 격리 테스트 완료. Swagger 꾸미기보다 session/Origin/no-store 검증을 우선한다.
- **D20:** RC artifact 검사. 보안 게이트가 남아 있으면 `0.1.0` 대신 RC 상태를 유지한다.

핵심 의존 경로는 다음과 같다.

```text
M0 Foundation
  → M1 Transport
    → M2 SSO
      → M3 Web Dynpro Core
        → M4 Student Info
          → M5 Courses & Timetable
            → M6 CLI & REST
              → M7 Release
```

HAR 정제, fixture 개인정보 검사, 보안 문서, 로그 redaction은 별도 마지막 단계가 아니라 M0부터 M7까지 계속 강화한다.

## 3. 마일스톤별 실행 백로그

### M0 — Foundation

목표: 실제 자격증명 없이 전체 개발 루프가 도는 최소 모노레포를 만든다.

| ID     | 작업                    | 결과물                                                     | 검증                         |
| ------ | ----------------------- | ---------------------------------------------------------- | ---------------------------- |
| FND-01 | 런타임과 workspace 고정 | `package.json`, `pnpm-workspace.yaml`, Node/pnpm 버전 파일 | 깨끗한 환경에서 install 성공 |
| FND-02 | 패키지 뼈대 생성        | `types`, `protocol`, `server`, `cli`                       | 의존 방향 위반 없음          |
| FND-03 | TS/품질 도구 설정       | strict TS, lint, format, Vitest                            | build/lint/test 명령 성공    |
| FND-04 | 공통 모델 정의          | `SaintError`, error code, semester 타입                    | 타입 및 schema unit test     |
| FND-05 | 테스트 기반 생성        | fixture loader, mock upstream skeleton                     | 네트워크 없이 테스트 성공    |
| FND-06 | 보안 기본 파일 작성     | `.gitignore`, `SECURITY.md`, fixture 정책                  | 금지 파일과 canary 검사      |
| FND-07 | HAR sanitizer 골격      | header/body/query redaction 파이프라인                     | canary secret 0건            |
| FND-08 | CI 기본 workflow        | install, lint, typecheck, test, build                      | 실제 secret 없이 통과        |

완료 게이트:

- `pnpm install --frozen-lockfile`, lint, typecheck, test, build가 모두 성공한다.
- package graph가 `types ← protocol ← server/cli` 방향만 허용한다.
- mock 테스트가 외부 학교 서버에 접근하지 않는다.
- 비밀번호, 쿠키, 토큰 canary가 test output과 artifact에서 발견되지 않는다.

### M1 — HTTP Transport

목표: 인증 흐름이 의존할 안전한 HTTP/쿠키 계층을 독립적으로 완성한다.

| ID     | 작업                 | 결과물                                | 핵심 실패 케이스                      |
| ------ | -------------------- | ------------------------------------- | ------------------------------------- |
| NET-01 | URL 정책             | HTTPS 및 정확한 host/port allowlist   | HTTP, userinfo, 비허용 host/port 거부 |
| NET-02 | cookie wrapper       | 요청 전 cookie 조회, 응답 후 저장     | host/path/secure 경계 위반 방지       |
| NET-03 | `HttpSession`        | manual redirect 기반 request API      | redirect loop, 누락/잘못된 Location   |
| NET-04 | resource limit       | timeout, body size, redirect hop 제한 | slow response, oversized body 중단    |
| NET-05 | retry 정책           | 안전한 요청만 제한적으로 retry        | 로그인 실패/잠금은 retry 금지         |
| NET-06 | charset 처리         | HTML/XML text decoding                | 잘못된 charset 명시적 오류            |
| NET-07 | redacted diagnostics | 안전한 request ID와 오류 정보         | URL query/header/body 비밀 미노출     |

완료 게이트:

- domain/path가 다른 쿠키가 mock 서버 간 교차 전송되지 않는다.
- redirect의 모든 hop을 다시 검증하고 최대 횟수를 넘으면 실패한다.
- timeout과 body limit 이후 연결 및 임시 상태가 정리된다.
- 오류 객체와 로그에 Cookie, Set-Cookie, Authorization, form body가 없다.

### M2 — SSO and Portal Session

목표: anonymous 상태에서 portal authenticated 상태까지를 재현 가능한 상태 머신으로 만든다.

| ID     | 작업                 | 결과물                                | 검증                          |
| ------ | -------------------- | ------------------------------------- | ----------------------------- |
| SSO-01 | 로그인 페이지 parser | form action 및 필수 hidden field 모델 | 누락/복수 form fixture        |
| SSO-02 | 상태 머신            | anonymous → SSO → portal 전이         | mock 전체 흐름 contract test  |
| SSO-03 | 실패 분류            | invalid, locked, MFA, flow changed    | 각 오류 code와 retryable 검증 |
| SSO-04 | callback 검증        | portal 인증 완료 판별                 | 가짜 success page 거부        |
| SSO-05 | lifecycle            | logout, close, expired 상태           | 이후 요청 실패 및 jar 폐기    |
| SSO-06 | 최초 live smoke      | 정상/오류 로그인 수동 확인            | 로컬 전용, 공개 artifact 없음 |

완료 게이트:

- mock 흐름만으로 성공 및 주요 실패 상태가 100% 재현된다.
- 실제 로그인 관찰은 mock/redaction 게이트 통과 후 본인 계정으로만 수행한다.
- 2차 인증이나 CAPTCHA가 보이면 우회하지 않고 명시적 오류로 중단한다.
- sanitized fixture는 자동 검사 후 사람이 diff를 검토한다.

### M3 — Web Dynpro Core

목표: 개별 학사 화면과 분리된 bootstrap, event, state update 엔진을 만든다.

| ID     | 작업               | 결과물                             | 검증                        |
| ------ | ------------------ | ---------------------------------- | --------------------------- |
| WDP-01 | bootstrap parser   | action/context/security 상태 모델  | 필수 상태 누락 시 실패      |
| WDP-02 | event 모델/encoder | 내부 event queue 직렬화            | golden payload test         |
| WDP-03 | response parser    | patch/data/error 분리              | 정상·부분·malformed fixture |
| WDP-04 | state revision     | 응답 후 atomic state 갱신          | 이전 state 재사용 방지      |
| WDP-05 | context mutex      | application별 요청 직렬화          | 동시 호출 순서 보장         |
| WDP-06 | expiry 감지        | context/session expired 분류       | 재로그인 필요 여부 구분     |
| WDP-07 | fixture replay     | bootstrap → event → update harness | 외부 네트워크 없이 재현     |

완료 게이트:

- 같은 context의 동시 이벤트가 직렬화되고 다른 사용자 상태와 섞이지 않는다.
- malformed response에서 부분 데이터를 반환하지 않는다.
- SAP 내부 ID와 보안 상태는 public package API 밖에 남는다.
- 동일 fixture replay 결과가 실행 순서나 시간에 의존하지 않는다.

### M4 — Student Information

목표: 첫 application vertical slice로 학생 기본정보를 최소 데이터 모델로 반환한다.

| ID     | 작업             | 결과물                          | 검증                             |
| ------ | ---------------- | ------------------------------- | -------------------------------- |
| STU-01 | 공개 모델 확정   | student info schema/type        | null/optional 의미 문서화        |
| STU-02 | 화면 interaction | application adapter             | 필요한 event만 전송              |
| STU-03 | parser           | 내부 화면 값을 공개 모델로 변환 | 정상/누락/변경 fixture           |
| STU-04 | protocol API     | `student.getInfo()`             | state/lifecycle integration test |
| STU-05 | CLI slice        | `student info --json`           | stdout 데이터, stderr 진단 분리  |

완료 게이트:

- fixture 필드가 누락되거나 구조가 바뀌면 조용히 빈 값을 만들지 않는다.
- endpoint 목적에 필요하지 않은 연락처 등 개인정보는 기본 모델에 포함하지 않는다.
- CLI 출력에는 cookie, context ID, 원본 HTML이 없다.

### M5 — Courses and Timetable

목표: v0.1의 핵심 가치인 수강내역과 계산 가능한 시간표를 제공한다.

| ID     | 작업            | 결과물                             | 검증                      |
| ------ | --------------- | ---------------------------------- | ------------------------- |
| CRS-01 | 학기 모델       | 연도/일반·계절학기 입력 schema     | 범위/조합 validation      |
| CRS-02 | 수강내역 parser | normalized course model            | 빈 학기, 취소/상태 케이스 |
| CRS-03 | 시간표 정규화   | 요일, 시작/종료, 강의실 모델       | 복수 시간 및 강의실       |
| CRS-04 | protocol API    | `academic.getCourses/getTimetable` | context integration test  |
| CRS-05 | CLI             | `courses`, `timetable`             | 안정된 JSON snapshot      |

완료 게이트:

- 한 과목의 복수 요일·시간·강의실을 손실 없이 표현한다.
- 일반학기와 계절학기 입력이 명시적으로 구분된다.
- 화면 표시 문자열과 계산용 값의 단위가 문서화된다.
- JSON schema 변경은 changelog 대상임을 테스트와 문서에 반영한다.

### M6 — CLI and Local-first REST Server

목표: protocol API를 안전한 로컬 HTTP/JSON 인터페이스로 제공한다.

| ID     | 작업               | 결과물                      | 검증                              |
| ------ | ------------------ | --------------------------- | --------------------------------- |
| API-01 | Fastify 기반       | health, ready, docs         | startup/shutdown integration test |
| API-02 | local access token | 서버 프로세스 접근 인증     | token 누락/오류 거부              |
| API-03 | session store      | hash key, idle/absolute TTL | logout/만료/재시작 정리           |
| API-04 | session API        | login/status/logout         | body logging 0건                  |
| API-05 | data API           | me/courses/timetable        | schema 및 no-store header         |
| API-06 | browser boundary   | Origin/CORS/CSRF 방어       | 악성 Origin 거부                  |
| API-07 | bind policy        | 기본 `127.0.0.1`            | 외부 bind 기본 거부               |
| API-08 | OpenAPI            | 전체 v0.1 계약              | route와 schema 일치               |
| API-09 | 격리 테스트        | mock user A/B 전체 흐름     | 세션 및 데이터 교차 0건           |

완료 게이트:

- 두 mock 사용자의 cookie jar, Web Dynpro context, 응답 데이터가 완전히 격리된다.
- 모든 개인정보 응답에 `Cache-Control: no-store`가 붙는다.
- token 누락, 악성 Origin, 허용되지 않은 외부 bind가 기본 설정에서 거부된다.
- 서버 재시작 시 세션 손실과 재로그인 필요성이 문서화된다.

### M7 — Release Candidate and v0.1.0

목표: 설치 가능한 RC를 검증한 뒤 모든 보안 출시 게이트를 통과한 v0.1.0을 배포한다.

| ID     | 작업        | 결과물                            | 검증                            |
| ------ | ----------- | --------------------------------- | ------------------------------- |
| REL-01 | 사용자 문서 | README quick start, API 예제      | 새 환경에서 15분 mock demo      |
| REL-02 | 배포물      | npm tarball, Docker image         | contents 수동 검토              |
| REL-03 | 공급망      | Trusted Publishing, provenance    | 장기 publish token 없음         |
| REL-04 | 보안 검토   | threat checklist, secret/PII scan | PROJECT_PLAN 12.12 전 항목 통과 |
| REL-05 | RC          | `0.1.0-rc.1`                      | 설치/호환성 피드백 반영         |
| REL-06 | 정식 릴리스 | `0.1.0`, changelog, tag           | package/tag/source 일치         |

완료 게이트:

- npm, Docker, source map, fixture, CI artifact에 실제 학생 데이터가 없다.
- protocol package와 REST server가 문서만으로 재현 가능하다.
- `PROJECT_PLAN.md`의 v0.1 보안 출시 게이트가 하나라도 미충족이면 정식 배포하지 않는다.

## 4. 첫 2일: M0 실행 순서

첫 2일에는 실제 u-SAINT 로그인이나 HAR 캡처를 하지 않는다. 기반과 mock 안전망을 먼저 완성한다.

### Step 1 — 저장소 기준 고정

- root package 및 pnpm workspace 생성
- Node.js/pnpm 버전 고정
- ESM, strict TypeScript 공통 설정
- root 명령 `lint`, `typecheck`, `test`, `build` 정의

### Step 2 — workspace 생성

- `packages/types`
- `packages/protocol`
- `apps/server`
- `apps/cli`
- 각 package의 public entry와 빈 test 구성

### Step 3 — 첫 계약 작성

- `SaintErrorCode`, `SaintError`
- `Semester`, `AcademicTerm`
- public schema와 TypeScript type의 일치 테스트
- 민감한 `cause`를 기본 serialization에서 제외하는 오류 정책

### Step 4 — transport seam과 mock 기반

- 실제 구현 전 `HttpSession` 계약 정의
- fixture loader와 mock upstream server 생성
- 테스트 중 학교 domain으로 나가는 네트워크 요청 차단

### Step 5 — 보안 가드레일

- `.gitignore`에 `.env`, HAR, session, raw fixture 금지 규칙 추가
- canary credential을 이용한 log/artifact redaction test
- HAR sanitizer의 header/query/body 처리 골격 생성

### Step 6 — M0 검증

- clean install부터 전체 명령 실행
- package graph와 공개 export 검토
- M1 backlog를 실패 테스트 단위로 확정
- M0 완료 결과를 이 문서의 상태에 반영

## 5. 선결정과 지연 가능한 결정

구현을 막지 않도록 아래 값은 v0.1의 임시 기본값으로 사용하고, 변경 시 ADR에 기록한다.

| 항목             | v0.1 기본 방향                          | 결정 시점                               |
| ---------------- | --------------------------------------- | --------------------------------------- |
| 저장소/패키지명  | `ssu-saintbridge`, `@ssu-saintbridge/*` | M0; npm 사용 가능 여부는 M7 전 확인     |
| 라이선스         | MIT 제안 유지                           | M0 문서, 공개 전 최종 확정              |
| 런타임           | Node.js 24 LTS, ESM                     | M0                                      |
| schema 기준      | Zod schema와 TS type의 단일 계약 유지   | M0; OpenAPI adapter는 M6에서 선택       |
| MFA/CAPTCHA      | 지원하지 않고 명시적 오류               | M2                                      |
| server bind      | `127.0.0.1` only by default             | M6                                      |
| API session      | in-memory, hashed opaque token          | M6                                      |
| session TTL 수치 | 설정 가능하게 설계                      | M6 시작 전 확정                         |
| 중앙 SaaS        | v0.x에서 제공하지 않음                  | 변경하려면 별도 보안/정책 프로젝트 필요 |

## 6. 공통 Definition of Done

모든 작업은 다음 조건을 충족해야 `DONE`으로 바꾼다.

- 정상 경로와 주요 실패 경로 테스트가 있다.
- 테스트는 기본적으로 실제 학교 서버와 실제 계정 없이 실행된다.
- public API와 오류 의미가 문서화되어 있다.
- 비밀번호, cookie, token, 학번, 이름, 원본 HTML이 로그와 fixture에 없다.
- timeout, cleanup, parser mismatch 동작이 명확하다.
- 새 runtime dependency가 꼭 필요한지와 보안 영향을 검토했다.
- lint, typecheck, test, build가 모두 통과한다.
- 사용자가 관찰할 동작 변경이면 changelog 후보로 표시한다.

## 7. v0.1 이후 보류 목록

다음은 v0.1 완료 전에는 착수하지 않는다.

- 성적 상세/요약과 REST TypeScript client
- 장학금, 채플, 등록금, 졸업사정
- MCP adapter와 AI 연동
- session export/import
- 중앙 배포형 로그인 대행 서비스
- 모든 쓰기 작업
