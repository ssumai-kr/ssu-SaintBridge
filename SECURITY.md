# Security Policy

이 프로젝트는 비밀번호, u-SAINT 세션 쿠키, SSO 토큰과 API 세션 토큰을 모두 인증정보로 취급합니다.

## 취약점 제보

실제 자격증명, 쿠키, 원본 HAR 또는 학생 개인정보를 public issue에 첨부하지 마세요. 공개 저장소가 준비되기 전에는 maintainer에게 비공개로 전달하고, 저장소 공개 후에는 GitHub의 private vulnerability reporting을 사용합니다.

## 지원 범위

정식 릴리스 전까지는 보안 지원 버전이 없습니다. 현재 코드를 중앙 로그인 대행 서비스로 배포하지 마세요.

## 로컬 데이터 취급

- 실제 비밀번호, Cookie, Set-Cookie, Authorization, SSO token과 API token을 저장소에 저장하지 않습니다.
- 원본 HAR와 실제 학생 HTML/XML은 저장소 밖의 접근 제한된 위치에서만 다룹니다.
- 정제본은 `pnpm sanitize:har` 실행 후 사람이 diff를 검토하고 `pnpm security:check`를 통과해야 합니다.
- `.env`, session dump, cookie jar와 private key는 커밋 대상이 아닙니다.
