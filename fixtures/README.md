# Fixtures

이 폴더에는 실제 자격증명과 학생 개인정보가 없는 최소 fixture만 저장합니다.

- 원본 HAR, Cookie, Set-Cookie, SSO token과 실제 학생 응답을 추가하지 않습니다.
- HAR fixture는 `*.sanitized.har` 이름만 Git에 포함할 수 있습니다.
- 자동 정제 후에도 커밋 전에 사람이 diff를 검토해야 합니다.

정제 명령:

```bash
pnpm sanitize:har /secure/local/capture.har fixtures/example/login.sanitized.har
pnpm security:check
```

정제기는 민감 header와 cookie를 제거하고, 알려진 credential·token·학번·이메일·전화번호·주소 필드를 placeholder로 바꿉니다. 이름이나 비정형 HTML처럼 자동 판별이 불완전할 수 있으므로 원본과 정제본을 사람이 다시 비교해야 합니다.
