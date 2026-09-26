# ADR-027: What the web worker bundle gate measures

Status: accepted, 2026-08-27. Amended 2026-09-26, see "Amendment: the chat surface leaves the
worker" at the end. Applies to `apps/web`, `pnpm size` and the phase exit gate.

Does not change DR-1. DR-1 already names the 128 MB isolate as the limit that breaks Workers apps
and already records that its own superseded bundle trigger measured the wrong thing. The 1 MiB
number this ADR moves lives in the engineering guide, not in a DR. ADR-002, which will carry DR-1,
is not written yet; when it is, it should carry the startup measurement below.

## Context

The worker is at 839.59 KiB gzip against a 1024 KiB line, 82% of budget, with six product pages
and three more stories still to come. The line was set on 2026-08-26 as an early warning at
roughly four times the then-current 193 to 245 KiB, against platform limits of 10 MB gzip and a
128 MB isolate. It was never a platform constraint.

The two obvious readings are that we squeeze under the line or that we raise it. Both accept that
uploaded gzip is the number worth gating. That assumption is what I checked, because DR-1 already
argues it is the wrong number and because Cloudflare now ships a command that measures the right
one.

## What was measured

On `a7f3143`, in a clean worktree, after `TURBO_FORCE=true pnpm build`.

*What the gate measures today.* `pnpm size` reports 839.59 KiB gzip over 3914.07 KiB raw, 82 modules.

*What the isolate evaluates at startup.* Walking the static import graph from the uploaded entry,
`index.js`, reaches 15 of those 82 modules: 825.17 KiB raw, 180.94 KiB gzip. That is 21.6% of the
number the gate reads. The other 67 modules sit behind dynamic imports. `wrangler`'s own manifest
marks the chat route `isDynamicEntry: true`, and the entry reaches the router, the route tree and
`start.ts` through `import()` rather than a static import.

So the three dependencies the budget conversation is about are all outside the startup path.
The chat chunk is 415.21 KiB gzip, `@workos-inc/node` is 54.17 plus 22.78, its `jose` chunk is
29.00, the AI SDK is 52.02. None is evaluated until a request needs it, and the chat chunk is
evaluated only in an isolate that has served `/app/chat`.

*Startup CPU, the limit that rejects a deploy.* `wrangler check startup` profiles the global scope
locally and prints active CPU. Five runs: 7.5, 7.4, 7.6, 6.3, 6.3 ms, against a 1 second limit.
0.75% of budget. It runs from the same build `pnpm size` needs and takes about 3 seconds. It needs
no Cloudflare credentials, verified by running it with `CLOUDFLARE_API_TOKEN` unset and a throwaway
`HOME`.

*Whether our own code can move that number.* Appending static imports of `@assistant-ui/react`,
`@workos-inc/node` and `ai` to `src/start.ts`, with a `globalThis` assignment so nothing is shaken
out, added 201.55 KiB gzip to the upload, 839.59 to 1041.14, and moved the startup closure by
0.24 KiB, 180.94 to 181.18. Startup CPU across four runs of that build was 12.6, 7.4, 8.6 and
7.5 ms, inside the spread of the unmodified build. `src/start.ts` is itself behind a dynamic
import from the framework's server entry, so nothing an application file imports reaches the
startup path. The startup closure is 15 framework modules and it is the framework that sets it.

*Platform limits, from the Workers limits page.* Worker size 10 MB gzip and 64 MB raw on the paid
plan. Startup time 1 second of parse and global-scope execution, rejected at deploy as error
10021, `Script startup exceeded CPU time limit`. Memory 128 MB per isolate.

*The one unused dependency.* `assistant-cloud` is 23.9 KiB of the chat chunk's 1954.9 KiB of raw
regions, 1.2%, roughly 5 KiB gzip.

## Decision

The gate keeps measuring uploaded bytes and adds the number DR-1 says matters.

**Startup CPU is gated.** `wrangler check startup` runs alongside the dry run in `pnpm size` and
fails over 150 ms of active CPU, a `startupMs` key in `apps/web/size-budget.json`. 150 ms is 20
times what this hardware measures and 15% of the platform limit. Cloudflare's docs say a local
profile will not match their hardware, so the ceiling is set where slower CI cannot flake it and
only a structural change can cross it. The command writes a CPU profile as it goes, so a failure
names the function that spent the time rather than only the total.

**The uploaded-bytes line moves from 1 MiB to 3 MiB gzip.** 3 MiB is 30% of the platform ceiling
and 3.7 times today's number. The single most expensive surface we have, a streaming chat thread
with a full markdown pipeline, cost 471 KiB. Six product pages built from primitives already in the
bundle will not spend the 2.2 MB that is left.

**The 2% drift check against `baseline` is unchanged.** This is the part of the gate that works.
It is what caught assistant-ui at 3.1x and it is what would catch the failure the engineering
guide records, a default install taking a worker from 187 KiB to 3,637 KiB in twenty minutes.
Growth past it still raises the baseline in the same diff and still says in the PR body what the
bytes bought.

**Isolate memory is not gated per PR.** It cannot be measured without load, and DR-1 already routes
it to the load suite with a reversal trigger of sustained memory above roughly 90 MB. That suite
does not exist yet. Until it does, this is a known unmeasured risk, not a gate.

**The chat surface stays server-rendered.** It is not in the startup path, so it costs no startup
CPU. Making it client-only would remove SSR from the surface where first paint matters most and
put the C4 streaming seam through a client-only shell, in exchange for bytes that stay uploaded
either way.

## What was rejected

*Squeeze under 1 MiB by making the chat surface client-only.* Buys nothing measurable. `ssr: false`
was already shown not to remove the bytes, because the route module is reachable from the generated
route tree and wrangler uploads it regardless. The startup closure would not move, because the chat
chunk is not in it. It costs first paint on the chat surface and puts the C4 streaming seam through
a client-only shell, and it returns a smaller number.

*`lazyRouteComponent` on the chat route.* It defers evaluation against the startup budget. The
route is already deferred, and the startup budget is at 0.75%.

*Remove `assistant-cloud`.* 1.2% of the chunk it sits in. Worth doing as dependency hygiene when
someone is next in that file, not worth a story, and not a size measure.

*Raise the line to the 10 MB platform ceiling.* A gate at the ceiling gives no warning. The point of
an absolute line is to fire before the platform does.

*Drop the byte gate and keep only startup CPU.* Bytes still bound isolate memory and the 10 MB
ceiling, and the drift check is the part with a track record.

*Gate on startup-closure bytes instead of startup CPU.* Adding 201.55 KiB of dependencies moved
startup CPU by nothing measurable, because V8 compiles function bodies lazily and startup cost is
top-level execution rather than parsing. Bytes are a poor proxy for startup CPU in both directions.
The CPU number is cheap enough to measure directly.

## What this costs

About 3 seconds per CI run and a `startupMs` key in the budget file. The gate implementation is
roughly fifteen lines in `apps/web/scripts/size.mjs` and one case in `size-check.mjs`, filed as an
issue against `apps/web`.

Raising the byte line to 3 MiB means a PR can add 2.2 MB of gzip before the absolute check fires.
The drift check is what stops that, one PR at a time, and it is unchanged.

The startup gate will not fire on anything we write today, because our code cannot reach the
startup path. That is the point. It fires when the framework's entry shape changes underneath us,
which is otherwise a case we would first meet as a rejected deploy.

## Change if

Startup CPU passes 150 ms, which means the framework's entry shape changed and the startup closure
is now ours to manage. Or the load suite lands and shows sustained isolate memory near DR-1's 90 MB
trigger, at which point bytes become a proxy for something real and the byte line is worth
re-deriving from that measurement rather than from the platform ceiling.

## Amendment, 2026-09-26: the chat surface leaves the worker

Two lines above no longer hold. "The chat surface stays server-rendered" is false on `main`: both
chat routes, `/app/` and `/app/c/$id`, are `ssr: false`, and no ADR recorded the change. The
rejection "`ssr: false` was already shown not to remove the bytes" is true of the flag alone. It is
not true of the pattern below.

*What was measured.* On `4ded99d`, in a clean clone, `pnpm size` after a fresh build of `web`:

- `main` as it stands: 949.14 KiB gzip.
- `component: import.meta.env.SSR ? () => null : ChatPage`: 754.77 KiB. Vite replaces
  `import.meta.env.SSR` at build time and Rollup drops what only the dead branch used. The server's
  split chunk still opens with a bare `import "./chat-page-*.js"`, because the chat modules run
  code at the top level. That chunk is 193 KiB gzip of assistant-ui, mdast and micromark, and it
  still uploads.
- The same ternary with the client branch written as
  `lazyRouteComponent(() => import("@/chat/chat-page"), "ChatPage")` and the static import
  deleted: 558.49 KiB, 390.65 KiB below `main`. The server output has no chat chunk at all.
- `wrangler check startup`, five runs each on a machine busy with other builds: 13.7 to 16.2 ms
  for `main`, 16.4 to 50.2 ms for the lazy form. Both sit far under the 150 ms gate, and the spread
  comes from the host, not the code.

TanStack has no route option that keeps a component out of the server build. `ssr: false` and
`ClientOnly` both leave the import in place. The Start compiler prunes only the bodies of
`createServerFn`, `createServerOnlyFn`, `createClientOnlyFn` and `createIsomorphicFn`. The ternary
relies on Vite's static replacement, not on TanStack.

*Decision.* The conversation routes render on the client only and take their component through
the lazy form above. The server still renders the layout, the rail and the panel, so the first
paint carries the panel state from its cookie. Only the thread waits for the client. The baseline
moves down in the PR that applies the pattern, to the number `pnpm size` prints there. The drift
check guards it: a static `ChatPage` import in a route file brings roughly 390 KiB back and fails
the gate.

The original rejection weighed first paint against a smaller number that bought nothing. The
number is now 41% of the upload. First paint was already spent when the routes went `ssr: false`,
and the thread is empty until the owner types or history loads, so the server had nothing to put
in it.

*Rejected.* The ternary without the lazy import: it keeps half the bytes and runs the chat
modules' top-level code on the server. `ClientOnly`: it keeps the import. `createIsomorphicFn`:
the docs say its client body is pruned from the server build, but I did not measure it, and a Vite
constant already does the job.

*Cost.* On a first visit the client loads the route's split chunk, then the chat chunk, one more
request than before. Not measured.

*Change if* the conversation needs server-rendered content on first paint, such as history
rendered on the server, which brings SSR and the bytes back together. Or a TanStack release adds a
route option that keeps a component out of the server build, which would replace the ternary.
