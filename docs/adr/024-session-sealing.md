# ADR-024: Session sealing

Status: accepted, 2026-08-27. Settles the question DR-4a left open.

Applies to `apps/api`, `apps/web`, and anything that reads the owner session cookie.

## Context

DR-4a puts owner sign-in on our own pages rather than the hosted AuthKit pages, and §9.1
recorded the consequence as a two-way choice: reproduce the TanStack SDK's undocumented
cookie format, or own sealing outright and use the SDK for nothing. Both options were read
off what `@workos/authkit-tanstack-react-start` exports. That package does mint every
session inside `handleCallbackRoute()`, and it exports no helper that seals one from an
`authenticateWith*` response taken elsewhere. Read one layer further down and the choice is
not two-way.

Three things came out of the installed sources.

*The backend SDK seals sessions itself.* `@workos-inc/node` 10.11.0 takes
`session: { sealSession: true, cookiePassword }` on `AuthenticateWithOptionsBase` and returns
`sealedSession` on the response. That base interface is shared, and at source level all ten
`authenticateWith*` methods route through the same `prepareAuthenticationResponse`, so
password, magic auth, email verification, TOTP, organization selection and code exchange all
seal identically. `loadSealedSession({ sessionData, cookiePassword })` returns a session with
`authenticate()`, `refresh()` and `getLogoutUrl()`. WorkOS documents both.

*The two seal implementations produce the same envelope.* `@workos/authkit-session` 0.7.1,
which the TanStack SDK depends on, seals through `AuthKitCore.encryptSession`, which is
`sealData(session, { password, ttl: 0 })` over iron-webcrypto: AES-256-CBC, SHA-256
integrity, 256-bit salts, one PBKDF2 iteration, then a literal `~2` appended. `@workos-inc/node`
vendors iron-webcrypto and does the same thing with the same parameters. Measured under
workerd, a value sealed by one unseals in the other and back. The difference is the payload,
not the envelope: the framework SDK stores `{accessToken, refreshToken, user, impersonator}`,
the backend SDK stores that plus `organizationId` and `authenticationMethod`. Everything else
that reaches a request handler, including `org_id`, `role`, `roles`, `permissions`,
`entitlements` and `feature_flags`, is decoded from the access token's claims at read time and
is not in the cookie.

*The framework SDK cannot run where we would need it.* `ConfigurationProvider` lists `apiKey`
among its required keys, and the default client factory calls `getConfig('apiKey')` eagerly.
Any worker that constructs the AuthKit service needs `WORKOS_API_KEY` in its own environment.
`apps/web` is the browser-facing worker and holds no credentials (§9.2), and the phase exit
gate asserts in CI that `WORKOS_API_KEY` reaches no client bundle. So the framework SDK is
ruled out by the credential boundary before the cookie format is even a question.

The envelope claims were measured, not read. A throwaway worker run under `wrangler dev`
sealed a session with `@workos/authkit-session`, unsealed it with `@workos-inc/node`'s
`getSessionFromCookie`, sealed the backend SDK's payload shape and read it back through the
framework SDK's `AuthService`, and confirmed that a tampered cookie raises
`SessionEncryptionError` while `withAuth` degrades to `{ user: null }`. `navigator.userAgent`
read `Cloudflare-Workers` on every run, so this is the target runtime and not Node. The probe
is not in the repo; the assertions it made belong in the auth story, against real tokens.

No WorkOS resource was created for this. The staging environment has no users, so no live
`authenticateWithPassword` response was observed. It did not need to be: at type level every
`authenticateWith*` method returns the same `AuthenticationResponse`, and the fields the seal
uses are on that one interface.

## Decision

`apps/api` owns the session end to end and seals with `@workos-inc/node`, the SDK it already
needs to call `authenticateWith*` at all. Neither
`@workos/authkit-tanstack-react-start` nor `@workos/authkit-session` is installed.

Sign-in calls `authenticateWithPassword` (or the magic auth, verification or code variant)
with `session: { sealSession: true, cookiePassword }`, and writes `sealedSession` as
`wos-session` with `Path=/; HttpOnly; Secure; SameSite=Lax`. Reads go through
`loadSealedSession(...).authenticate()`, which unseals, verifies the access token against the
environment JWKS, and returns the claims. Refresh and sign-out use `refresh()` and
`getLogoutUrl()` on the same object.

`apps/web` does not read the cookie. Route guards call `apps/api` over a service binding with
the cookie forwarded, the same route anything needing a credential already takes.

## Consequences

We own no cryptography and no cookie format. What we call is the vendor's documented sealing
API, so "reproduce the undocumented format" is not a risk we carry, and "own sealing outright"
is not a cost we pay. What we do own is the cookie write, the storage of the PKCE verifier
between the social sign-in redirect and its callback, and the sign-in rate limiting the hosted
page would have given us. `getAuthorizationUrlWithPKCE()` returns `{ url, state, codeVerifier }`,
so the verifier is a short-lived row keyed by `state`, not a crypto problem.

The session cookie has less headroom than it looks. Measured under workerd with a 983-byte
access token and a full user object, the backend SDK's payload is 1463 bytes of JSON and 2172
bytes sealed, an overhead of about 1.49x. Against the roughly 4096-byte per-cookie browser
limit that leaves about 1.3 KB of plaintext, and a real access token carrying `roles`,
`permissions`, `entitlements` and `feature_flags` arrays eats into it. Nothing of ours goes in
this cookie.

Our `org_id` is not in the session and must not be. The `organizationId` the backend SDK seals
is the WorkOS organization decoded from the access token, not the Reme tenant. Reme's `org_id`
is resolved server-side per request from the authenticated user, which is what R3 requires and
what keeps a membership change from surviving in a cookie until the next refresh.

Read the session through `authenticate()` and nothing else. `getSessionFromCookie` returns
`{}` for a tampered or wrong-password seal instead of throwing, which is fail-open if a caller
treats the result as a session. `loadSealedSession(...).authenticate()` checks for an access
token and then verifies the JWT, so a bad cookie comes back as `authenticated: false` with a
reason. A test that a tampered cookie is rejected, and a test that a forged `org_id` in a
request body is ignored, both belong to the auth story.

`WORKOS_COOKIE_PASSWORD` is a second secret alongside `WORKOS_API_KEY`, and key derivation runs
a single PBKDF2 iteration, so the password carries the entropy on its own. Generate it with
`openssl rand -base64 32`, keep it in wrangler secrets, and rotating it signs everyone out.

`@workos-inc/node` publishes a `workerd` export condition and the whole path was exercised
under workerd, so nothing here depends on a Node runtime.

## What was rejected

Reproducing the framework SDK's cookie format. This one is reproducible, and it is not even
reproduction: `@workos/authkit-session` exports `sessionEncryption`, `AuthKitCore` and
`CookieSessionStorage`, and the TanStack SDK re-exports `getAuthkit()`, so the same functions
are callable directly. The reason to reject it is the version. That package is 0.7.1 and its
README opens with "This is prerelease software. APIs may change without notice", so taking it
adds a second and less stable dependency that seals the same bytes as the one we must have
anyway. Of everything here, that is what decides it: the fewest packages, and the one with a
stable major version.

Owning sealing outright. Nothing is left to own once the backend SDK seals. The obvious
shortcut for a hand-rolled version is also worse than it looks. `iron-session`'s `unsealData`
returns `{}` for a wrong password instead of throwing, a fail-open default one import away.

Putting the AuthKit framework SDK in `apps/web`. It needs `WORKOS_API_KEY` in that worker.

## Not a reason to revisit

A future WorkOS framework SDK for TanStack Start that adds a seal-from-response helper. The
credential boundary, not the missing helper, is what puts the session in `apps/api`.

## Change if

WorkOS deprecates `sealSession` or `loadSealedSession` on the backend SDK, or the session
cookie needs to carry data the backend SDK's fixed payload cannot hold. The first is a version
pin and a migration; the second means a second cookie, and it should be argued before it is
built.
