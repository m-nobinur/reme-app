# ADR-044: Sandbox commands run as root, and the harness refuses none

Status: accepted, 2026-11-05, by the owner. Applies to `apps/orchestrator` (`RemeSandbox`) and
`packages/facade` (the Developer's tools). Amends ADR-031's 2026-10-19 amendment. Reverses #697's
confinement. Issue #699.

## Context

ADR-031's amendment noted that under the `durable_object` policy every process has root's
capabilities whatever its user. #697 answered that by running each command through `setpriv` as
`reme` with every capability dropped, and the facade refused commands and file paths by matching
their text. The 2026-11-05 local live test failed every build: commands started as the image's
user `reme`, which has no capabilities to drop, so `setpriv` failed with `setgroups failed`; once
commands started as root, privileged steps made `/workspace/site` root's and the confined user
could not write the site. The string guards had already refused grep and sed patterns (#611).

Hermes skips its command guards for container backends because nothing a command does there can
reach the host. Pi's bash tool has no guard.

## Decision

- Every command `RemeSandbox.exec` runs starts as root (`user: "0:0"`) with every capability. No
  `setpriv`.
- The facade refuses no bash command and no write or edit path. One ordering rule stays: a
  subagent never runs `astro build`, because the lead builds once after every task returns.
- The stray sweep after a build kills processes the Developer's commands left running. They are
  found by a `REME_STRAY=1` variable set on every command the code does not mark privileged, since
  a missing capability no longer marks them.
- The live probe asserts root and a writable workspace in place of #697's `confined` case.

The tenant boundary is the org's own container: one container per org, egress denied but for the
registry, no credential inside it. Those rules are enforced outside the container and are
unchanged.

## Consequences

- A Developer command, or site code a build runs, can change the toolchain and gate scripts inside
  that org's container and read any process there. This is a quality risk for that org's build,
  not a path to another tenant. The gates that decide a publish run again in platform code on
  the uploaded artifact.
- A command that clears its environment (`env -i ...`) can leave a process the sweep does not see.
  The sweep is cleanup of accidental strays, not a boundary. A process-group sweep is the planned
  improvement; an inverted sweep (everything but PID 1 and our steps) waits for one look at what
  Cloudflare runs inside a container.
- Re-adding confinement needs commands to start as root and drop to `reme` (as `setpriv` does),
  privileged steps to hand `/workspace/site` to `reme`, and a sweep marker the process cannot
  shed. Do not re-add it as a string guard in the harness.
