# Authentication

SaintBridge separates authentication sources, authentication input modes, and data-provider sessions.

This document describes the authentication execution boundary completed in `AUTH-01`, the independent SmartID/Library state lifecycle completed in `AUTH-02`, and the transactional provider callback/session-binding layer completed in `AUTH-03`. It does not mean that live SmartID or Library sign-in is available yet. Provider-specific success detection, cookie transfer, and real SAP, LearningX, and Library callback protocols remain later work.

## Model

Authentication sources:

- `smartid`: the school SmartID SSO source used to establish u-SAINT, LMS, and supported delegated Library sessions
- `library`: the Library-native authentication source used for personal Library capabilities

Input modes:

- `official-browser`: the user enters credentials on the official page in an isolated visible Chromium context
- `application-credentials`: a trusted Node.js runtime supplies one-shot `TransientCredentials` obtained from its own UI

Data providers remain separate from both concepts:

- `usaint`
- `lms`
- `library`

An authentication snapshot records the source, input mode, status, and expiry. It never records an identifier or password.

## Authentication source state machine

SmartID and Library authentication are tracked independently. Absence from `authSources` represents a source that has no authentication state.

| Current state    | Event    | Next state                           |
| ---------------- | -------- | ------------------------------------ |
| absent           | begin    | `authenticating`                     |
| `authenticating` | complete | `authenticated`                      |
| `authenticating` | rollback | the previous stable state, or absent |
| `authenticated`  | begin    | `authenticating`                     |
| `authenticated`  | expire   | `expired`                            |
| `expired`        | begin    | `authenticating`                     |
| any active state | remove   | absent                               |

`unsupported` remains part of the shared public status model, but AUTH-02 does not produce it. Support and capability detection belong to AUTH-07.

`InMemoryAuthSourceStateMachine` stores only schema-validated source metadata. `StatefulAuthenticationExecutor` composes that state machine with the AUTH-01 executor:

```text
validate AuthLoginRequest
  -> begin opaque source attempt
  -> expose authenticating snapshot
  -> execute AUTH-01 input-mode handler
       success -> complete -> authenticated
       failure, cancellation, or timeout -> rollback
```

An initial failed attempt rolls back to absent. Failed reauthentication restores the complete previous `authenticated` or `expired` session, including its input mode and expiry metadata.

SmartID and Library may authenticate concurrently, but only one attempt may own a given source. Attempt tokens are opaque and tracked by object identity. Completion or rollback from a removed, completed, or replaced attempt is rejected, so a late handler cannot overwrite a newer state. If rollback itself is stale, the original authentication error remains primary.

Snapshots are frozen, deterministically ordered as SmartID then Library, and never contain credentials, credential callbacks, cookies, browser objects, or internal attempt ownership data.

The mock orchestrator uses the production stateful provider authentication executor and callback transaction coordinator. Tests may inject non-sensitive authentication and provider-callback handlers to pause, succeed, or fail either phase deterministically without a school account. During reauthentication, provider sessions derived from that source are exposed as expired until the attempt succeeds or rolls back.

## Provider callback and session binding

`AUTH-03` defines the common orchestration layer used after an authentication handler recognizes source-level success. It supports these bindings:

| Authentication source | Provider callback                         |
| --------------------- | ----------------------------------------- |
| SmartID               | u-SAINT                                   |
| SmartID               | LMS                                       |
| SmartID               | Library delegated session, when supported |
| Library               | Library-native session                    |

Library authentication cannot create u-SAINT or LMS sessions. The validated adapter registry also requires its registration key to match the adapter descriptor and rejects duplicate, malformed, unsupported-source, and unsupported-scope registrations or requests.

The callback plan is deterministic regardless of requested-scope order:

```text
validate source, input mode, scopes, and adapters
  -> group requested scopes by owning provider
  -> order callbacks as u-SAINT, LMS, Library
  -> create one staged provider HTTP session per callback
  -> invoke each adapter with only that provider's scopes
  -> validate and stage every ProviderSession
  -> bind the prepared callbacks to the active auth-source attempt
  -> commit provider sessions and complete the source without an await gap
  -> asynchronously close transports replaced by the successful commit
```

Every callback result must match the registry provider and requested authentication source. Its granted scopes must belong to that provider, stay within the provider-specific request, contain no duplicate provider result, and pass the public `ProviderSession` schema. An opaque prepared-callback token records ownership internally without exposing callback results, transports, cookies, or source attempt tokens.

Provider transports are created lazily and remain staged until commit. A callback failure, validation failure, cancellation, binding mismatch, or stale provider revision rolls the transaction back and closes all newly staged transports. Previously committed sessions and unrelated providers or authentication sources remain unchanged. Cleanup failure cannot replace the original callback or stale-attempt error.

`StatefulProviderAuthenticationExecutor` links this transaction to the AUTH-02 source attempt. Before publication it verifies that the source attempt is still active and that the prepared callback source, input mode, and canonical scope set match the login request. The provider commit and source completion then run consecutively without an asynchronous observation point. Public snapshots contain only schema-validated source and provider metadata; provider transports and callback ownership stay private. If a source is authenticating or expired, its previously committed providers are projected as expired.

The mock orchestrator follows this production path rather than constructing provider sessions directly. Its tests cover deterministic routing, partial rollback, stale SmartID-delegated versus Library-native races, per-provider transport separation, and per-user transport separation.

## Execution flow

The stateful executor surrounds the lower-level AUTH-01 execution boundary described below.

```text
AuthLoginRequest
  -> validate source, mode, and scopes
  -> create cancellation and timeout lifecycle
  -> dispatch by input mode
       official-browser
         -> select source-specific navigation policy
         -> launch visible Chromium
         -> create fresh non-persistent BrowserContext
         -> run the source adapter
         -> close context and browser
       application-credentials
         -> acquire TransientCredentials at execution time
         -> expose values to one bounded adapter callback
         -> signal cancellation or timeout to the adapter
         -> release when the bounded adapter callback exits
  -> return non-sensitive adapter result
```

The default execution timeout is five minutes. Callers may select an integer timeout from 1 millisecond through 30 minutes.

## Official browser mode

```ts
await executor.execute({
  authSource: "smartid",
  mode: "official-browser",
  scopes: ["usaint:profile.read"],
});
```

The managed browser runner enforces the following properties:

- `headless: false`
- a new non-persistent `BrowserContext` for every execution
- no system-browser profile or `userDataDir`
- exact source-specific HTTPS host allowlists
- no embedded URL credentials, unexpected ports, or fragments
- no popups or downloads
- no TLS-error or CSP bypass
- blocked service workers
- context and browser cleanup after success, failure, timeout, cancellation, or runner shutdown

The current code does not contain final SmartID or Library entry URLs. Tests use `.example.invalid`, and manual smoke tests use `example.com`. Actual upstream hosts must be observed with the developer's own account and added explicitly; wildcard hosts are rejected.

## Application credential mode

```ts
await executor.execute({
  authSource: "smartid",
  mode: "application-credentials",
  scopes: ["usaint:profile.read"],
  acquireCredentials: () =>
    new TransientCredentials({
      identifier: formValues.identifier,
      password: formValues.password,
    }),
});
```

Direct `identifier` and `password` fields are rejected from `AuthLoginRequest`. The credential provider is called only after execution begins and must return `TransientCredentials`.

The container can be consumed once. Its inspection and JSON forms are redacted, and its internal string references are cleared after the adapter callback. If credential acquisition completes after cancellation or timeout, the late container is released without invoking the adapter. Once a credential adapter has started, it must honor the supplied `AbortSignal` so that its callback exits and releases the values promptly.

JavaScript cannot guarantee physical memory zeroization. Applications must avoid copying credential values and must honor the supplied `AbortSignal`. A custom frontend must send credentials only to a paired local companion, desktop runtime, or appropriately secured developer-controlled backend. A browser-only SPA must not contact school authentication endpoints directly.

## Cancellation and cleanup

Authentication failures expose redacted classifications:

- `CANCELLED`: the caller cancelled the execution
- `TIMED_OUT`: the configured execution timeout elapsed
- `EXECUTION_ABORTED`: a browser runner used directly received an untrusted abort reason
- `RUNNER_CLOSED`: shutdown stopped an active browser execution

The browser runner's `close()` method is idempotent. It stops all active executions, waits for their cleanup, and rejects new executions. When an adapter failure and cleanup failure happen together, the adapter failure remains the primary error. Both context and browser cleanup are still attempted.

## Local development

Unit and CI tests use injected browser doubles and never contact school domains. A browser binary is only required for a manual visible smoke test:

```bash
pnpm --filter @ssu-saintbridge/auth exec playwright install chromium
pnpm --filter @ssu-saintbridge/auth test
```

Do not use a real account in automated tests. Do not retain screenshots, raw HTML, HAR files, browser profiles, cookies, tokens, or credentials.

## Not implemented yet

- final SmartID and Library entry URLs and redirect allowlists
- live login completion detection
- MFA, CAPTCHA, invalid-credential, and account-lock classification
- provider-specific u-SAINT, LMS, and Library callback protocols
- browser-to-provider cookie transfer
- real provider-session creation
- local REST authentication endpoints
- live school-account smoke tests
