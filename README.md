# SaintBridge

SaintBridge is a local-first, unofficial open-source platform that provides secure and consistent APIs for Soongsil University's u-SAINT, LMS, and Central Library services through a single interactive login experience.

It is designed for student developers who want to build unified class, assignment, announcement, timetable, and library tools without directly handling SAP Web Dynpro, LearningX, service-specific cookies, or SSO callbacks.

SaintBridge is more than an HTML parser. The project is designed around four components:

- **Protocol and Provider SDKs** for service-specific authentication, sessions, and parsing
- **Unified API** for stable models such as courses, assignments, loans, and calendar events
- **Local REST Server** for language-independent HTTP/JSON and OpenAPI access
- **Client and Mock SDKs** for type-safe application development without a real school account

## Release Scope

SaintBridge follows a read-only-first release plan:

| Release | Scope                                                                                   |
| ------- | --------------------------------------------------------------------------------------- |
| `v0.1`  | u-SAINT student profile, course enrollment, timetable, CLI, and local REST API          |
| `v0.2`  | LMS courses, announcements, assignments, and unified task APIs                          |
| `v0.3`  | Library search, seats, hours, loans, and unified today, notification, and calendar APIs |

Application, submission, modification, attendance manipulation, reservation, payment, and protected-content proxy features are explicitly out of scope for the initial releases.

## Authentication Model

SaintBridge does not accept a student ID or password through its API. Authentication is performed by the user directly on the official sign-in page inside an isolated, visible, managed browser context.

```text
SignedOut
  ↓ user signs in on the official page
IdentityAuthenticated
  ├─→ u-SAINT session: Ready / Expired / Unsupported
  ├─→ LMS session: Ready / Expired / Unsupported
  └─→ Library session: Ready / Expired / Limited / Unsupported
```

Each provider receives an independent cookie jar and lifecycle. A failure or expiration in one provider must not damage another provider's session.

## Current Status

SaintBridge is in pre-`v0.1` development. The repository already contains the foundation and secure HTTP transport developed for the original u-SAINT-only scope. The revised multi-provider roadmap begins by realigning those contracts and package boundaries before implementing **M2 Auth Orchestrator (`AUTH-01` through `AUTH-08`)**.

The project cannot yet be used to sign in to school services or retrieve academic information.

## Design Principles

- **One login, multiple providers:** Create and manage separate u-SAINT, LMS, and Library sessions from the SmartID identity flow.
- **Normalized contracts:** Return stable public models instead of provider-specific screen and control identifiers.
- **Local-first security:** Keep credentials and student data on the user's device by default.
- **Read-only first:** Prioritize safe information retrieval over actions that change school data.
- **Fail closed:** Reject unexpected hosts, redirects, capabilities, and response structures instead of guessing.
- **No shared state:** Isolate cookies and provider state across users, tests, requests, and services.
- **Evidence-aware:** Preserve source and freshness metadata for decisions involving important academic information.
- **Mock-first development:** Support most development and testing without real credentials or live school requests.

## Planned Package Architecture

```text
types
  ↑
auth ← provider adapters (usaint / lms / library)
  ↑                 ↑
facade ────────────┘
  ↑
server / cli / client / mock
```

| Package   | Responsibility                                                      |
| --------- | ------------------------------------------------------------------- |
| `types`   | Shared provider, session, scope, source, event, and error contracts |
| `auth`    | Managed browser login and provider session orchestration            |
| `usaint`  | SAP portal, Web Dynpro, and academic adapters                       |
| `lms`     | LearningX course, announcement, and assignment adapters             |
| `library` | Public catalog and delegated personal library adapters              |
| `facade`  | Unified Node.js developer API                                       |
| `server`  | Local REST API, session management, and OpenAPI                     |
| `client`  | Type-safe REST client and React integration                         |
| `mock`    | Credential-free providers, fixtures, and scenarios                  |

Package names and npm scopes remain provisional until availability and trademark-confusion checks are complete.

## Development

Requirements:

- Node.js 24 or later
- pnpm 11.21.0

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

## Safety and Privacy

- Use only your own account and your own data when performing live protocol research.
- Never commit real passwords, cookies, SSO tokens, student HTML/XML, screenshots, session dumps, or raw HAR files.
- Do not bypass multi-factor authentication, CAPTCHA, account locks, rate limits, or other access controls.
- Do not read cookies from the user's existing system browser profile.
- Keep provider cookie jars separate and treat every session token as a credential.
- Do not log request or response bodies containing credentials or personal information.
- Do not operate a project-controlled centralized login proxy or retain student academic data on a project-controlled server.
- Stop or disable affected integrations if school policy prohibits automated access or the school requests that access cease.

## Disclaimer

SaintBridge is not an official project of, affiliated with, or endorsed by Soongsil University, SAP, LearningX, or the Soongsil University Central Library. Some or all functionality may stop working when policies or upstream systems change.
