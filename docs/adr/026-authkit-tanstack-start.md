# ADR-026: Adopt the AuthKit TanStack Start kit in the web worker

Status: accepted, 2026-08-27. Supersedes one clause of ADR-024, "neither
`@workos/authkit-tanstack-react-start` nor `@workos/authkit-session` is installed". The rest of
ADR-024, which is about how a session is sealed and read, still holds.

## Context

ADR-024 ruled the framework SDK out on a credential boundary, not on capability. Its measurement
was correct and still reproduces: `validateConfig()` runs in the `authkitMiddleware` body and
throws `WORKOS_API_KEY is required` on the first request through it, whether or not that request
needs the key. The conclusion drawn from it was that any worker serving traffic through the
middleware needs the key, and that `apps/web` must not have one.

That reasoning treated `apps/web` as a browser-facing shell. It is not. It is a worker running
TanStack Start on workerd, where every route has a server half and server functions run in the
same isolate as the SSR pass. The rule "the browser-facing worker holds no credentials" was
written for a deployment shape we do not have.

Holding the old boundary means hand-writing the session middleware, the route guards, the token
refresh orchestration and the client-side auth context that this kit already ships, and then
maintaining them against a provider whose SDK moves several times a quarter.

## What was verified

Against the published packages on 2026-08-27, not against documentation.

`@workos/authkit-tanstack-react-start` 0.11.0 declares `@workos-inc/node ^10.7.0` as a peer
dependency. It is a wrapper over the SDK `apps/api` already needs, not an alternative to it.
Adopting it adds an integration layer, it does not swap a dependency out.

It runs on workerd without `nodejs_compat`. Its `dist` contains no `node:` builtin at all. Its
one runtime dependency, `@workos/authkit-session` 0.7.1, mentions `node:crypto` exactly twice and
both are comments stating that it avoids `node:crypto` and `Buffer` on purpose. That package's own
dependencies are `jose`, `valibot` and `iron-webcrypto`, all of which are Web Crypto.

The server and client halves are separated structurally rather than by convention. `./client` is a
distinct subpath export, the package sets `sideEffects: false`, and the only server symbol the
client entry re-exports, `getAuthAction`, is a `createServerFn` whose handler reaches the real
implementation through `await import('./action-bodies.js')`. Every code path that could touch the
key sits behind a dynamic import inside a server function, so it does not enter the client graph.

Nothing evaluates configuration at module load. `validateConfig()` is async and dynamically
imports from `@workos/authkit-session`. Importing the package and constructing its service both
succeed with no key present.

## Decision

`apps/web` runs `authkitMiddleware` and owns the owner session: the sealed cookie, route
protection in layout loaders, `getAuthKitContext()` on the server and `AuthKitProvider` with its
hooks on the client. `WORKOS_API_KEY` becomes a secret of the `apps/web` worker.

`apps/api` keeps `@workos-inc/node`. Anything that writes to the database or manages WorkOS
organizations and users stays there, because §9.2 layer 1 makes the server-created tenant context
the only route to a database handle and that does not change.

The consequence, stated plainly rather than argued away: **both workers hold `WORKOS_API_KEY`.**
The rule it replaces, "`WORKOS_API_KEY` lives in `apps/api` and nowhere else", was a proxy for the
property we actually want. That property is now the rule directly: the key is a server-side secret
and reaches no client bundle, asserted in CI. The assertion was already required by the phase exit
gate, so the check that enforces this is one we were building anyway.

## What this costs

The blast radius of a leaked key doubles from one worker to two. The mitigation is the bundle
assertion plus the fact that both workers are ours and neither serves untrusted code.

We take a dependency on a package at 0.11.0, which is pre-1.0 and will break. The exposure is
bounded by the peer relationship: the sealing behaviour ADR-024 measured lives in
`@workos-inc/node`, which is at 10.11.0 and stable, and a sealed cookie written by one of these
packages is readable by the other in both directions, measured in ADR-024. If the kit becomes a
liability, the retreat is back to ADR-024's shape and the cookies already issued stay valid.

## Change if

The kit requires a Node built-in, or its client entry starts pulling server code into the browser
graph. Both are mechanically detectable: the first fails the workerd build, and the second is what
the bundle assertion in CI is for.
