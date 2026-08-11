# ssu-saintbridge

An unofficial open-source project that abstracts Soongsil University's complex u-SAINT SSO authentication and SAP Web Dynpro communication into consistent TypeScript APIs and JSON models.

It is designed to help student developers securely access their own academic information and build tools such as timetable applications, graduation requirement calculators, academic assistants, and CLIs. The project will provide two primary components:

- **Protocol Client**: A TypeScript library that handles authentication, per-user sessions, Web Dynpro events, and response parsing
- **Local-first REST Server**: A local HTTP/JSON API that makes the Protocol Client available to applications written in any language

The initial public release will be **read-only**. The scope of `v0.1.0` includes student profile information, semester course enrollment data, and normalized timetables. Application, submission, modification, and payment features are explicitly out of scope.

## Current Status

The project is currently in pre-`v0.1.0` development. The secure monorepo foundation and cookie-aware HTTP transport are complete, and the SSO and portal authentication state machine is next. The project cannot yet be used to sign in to u-SAINT or retrieve academic information.

## Design Principles

- Convert complex SAP screens and state into stable TypeScript types and JSON models.
- Fully isolate cookies and Web Dynpro state across users, tests, and requests.
- Fail closed on unexpected hosts, redirects, or response structures instead of guessing.
- Use passwords only during login requests; never persist them in files, databases, logs, or telemetry.
- Treat school cookies and SSO tokens as credentials and never expose them to callers.
- Run the Protocol Client in the user's environment and the REST Server on the user's device or a backend under their control.

## Project Structure

```text
@ssu-saintbridge/types
        ↑
@ssu-saintbridge/protocol
        ↑
   server / cli
```

| Path                | Responsibility                                          |
| ------------------- | ------------------------------------------------------- |
| `packages/types`    | Shared models, errors, and semester types               |
| `packages/protocol` | HTTP sessions, SSO, Web Dynpro, and application parsers |
| `apps/server`       | Local-first REST API and session management             |
| `apps/cli`          | Minimal JSON-based command-line interface               |
| `fixtures`          | Sanitized test fixtures and fixture policies            |

## Development

- Node.js 24 or later
- pnpm 11.21.0

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

## Safety

- Use only your own account and your own data.
- Never commit real passwords, cookies, SSO tokens, or raw HAR files.
- The initial release is read-only and does not bypass multi-factor authentication, CAPTCHA, or access controls.
- The project does not operate a centralized login proxy or retain student academic data on a project-controlled server.

## Disclaimer

This is not an official Soongsil University or SAP project and is not affiliated with or endorsed by either organization. Some or all functionality may stop working when school policies or systems change.
