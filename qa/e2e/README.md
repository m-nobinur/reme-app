# e2e

`pnpm e2e` is the blocking smoke. It runs against whatever `E2E_BASE_URL` names and skips every
`@live` spec.

## The golden path

`golden.spec.ts` walks a new owner from signup to v2 live on staging through the UI, then clears
the org it made:

```sh
pnpm e2e:golden          # E2E_BASE_URL defaults to https://staging.remeai.co.uk
```

Before you run it:

- Run it outside the nightly window. It holds one of staging's 5 sandbox containers for most of
  its run, and the nightly runs and hand runs share the same pool.
- It spends money. Two real builds and several Chief of Staff turns go on the OpenRouter keys.
  The run reads each key's usage before and after (`OPENROUTER_API_KEY`, and `OPENROUTER_KEY` when
  the api has its own) and prints the difference. Any other run on the same key in that window
  counts too.
- It needs `WORKOS_API_KEY` from `.env.local`, plus what `pnpm probe:clear` needs to clear the
  org. The teardown runs `pnpm probe:clear --probe <org id> --yes`. If that refuses, or signup
  failed before the org's id came back, it deletes the WorkOS org and user only, fails, and the
  org's rows stay for `pnpm probe:clear --org`.
- Set `E2E_DATABASE_URL` to staging's direct Neon URL to count the org's `staff.hired` events.
  The spec only reads it.

The run prints a `golden-run.json` record and attaches it to the report. It holds the seconds
per step and in total, the usage per key, which blank-state actions it clicked, and anything it
could not check.
