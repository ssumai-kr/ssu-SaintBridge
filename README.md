# ssu-saintbridge

숭실대학교 u-SAINT의 인증과 SAP Web Dynpro 통신을 안전한 TypeScript API로 추상화하기 위한 비공식 오픈소스 프로젝트입니다.

현재는 `v0.1.0` 구현 초기 단계입니다. 이 프로젝트는 숭실대학교 또는 SAP의 공식 프로젝트가 아닙니다.

## 개발 환경

- Node.js 24 이상
- pnpm 11.21.0

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

## 안전 원칙

- 본인 계정과 본인 데이터만 사용합니다.
- 실제 비밀번호, 쿠키, SSO 토큰, 원본 HAR를 저장소에 커밋하지 않습니다.
- 초기 버전은 읽기 전용이며 2차 인증, CAPTCHA, 접근 통제를 우회하지 않습니다.
- REST server는 local-first로 설계합니다.

> This project is not affiliated with or endorsed by Soongsil University or SAP.
