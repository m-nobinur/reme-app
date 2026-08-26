# ADR-025: shadcn on Base UI

Status: accepted, decided by the repo owner on 2026-08-26.

Applies to `packages/ui`, `packages/starter-site` and every component copied into either.

## Context

shadcn distributes component source rather than a package, so the primitive library
underneath it is a per-project choice made once at `init` and expensive to change later.
Two candidates: Radix, and Base UI.

Base UI is maintained by MUI, with several of the engineers who originally built Radix. It
ships monthly against Radix's slower cadence, and it covers combobox and multi-select
natively. A pipeline inbox and a service-area picker both want those, and building either
on top of a listbox is work we would rather not own.

Radix has one real advantage: almost every third-party copy-in component assumes it.

## Decision

Base UI. The scaffold runs as
`shadcn init --preset b5dwprpg0 --template start --monorepo --pointer -b base`.

Preset `b5dwprpg0` carries style `base-luma`, a neutral base with a teal theme, phosphor
icons, DM Sans, small radius and a subtle menu accent. It does not carry the base library,
so `-b base` is passed explicitly.

## Consequences

The third-party cost is real and we take it, because the component sources we actually
depend on are base-agnostic. shadcn ships both flavours, and so does assistant-ui.

Registry URLs have to be style-aware. `components.json` registers
`"@assistant-ui": "https://r.assistant-ui.com/styles/{style}/{name}.json"`. The flat
`/{name}.json` form is the Radix fallback, and pointing at it is the one mistake that puts
a second primitive library in the tree.

AI Elements is closed to us. Its components use Radix-specific APIs (`asChild`,
`openDelay`) and type-error against Base UI, and they read chat state from `useChat` rather
than from `AssistantRuntimeProvider`, so an element dropped into an assistant-ui thread
subscribes to nothing. Vercel's own tooling says to init with `--base radix` in any project
that may use them.

The escape hatch is narrower than a registry install and stays that way: a specific
component can be lifted as source, its Radix APIs ported to Base UI, and rewired to our
runtime. That is a story with an estimate, not a `shadcn add`.

## Not a reason to revisit

One element needing Radix. Reopening this per component is what produces two primitive
libraries in one tree.

## Change if

We start consuming outside component source regularly. The switch is then a
design-system-wide `shadcn init -b radix`, not a per-component call.
