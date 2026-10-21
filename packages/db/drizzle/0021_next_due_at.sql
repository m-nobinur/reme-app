-- Custom SQL, not generated (same as 0020): drizzle-kit models neither
-- privileges nor definer functions.

-- The third read that crosses tenants: the earliest time `claim_due_jobs`
-- could return a row, so the Cron Trigger can keep it in KV and leave
-- Postgres asleep until then. One timestamp, no ids: it says when, never
-- whose. A claimed row counts from when its claim lapses, which is
-- `claim_due_jobs`'s 20 minutes. Same defence as `claim_due_jobs`:
-- `SET search_path = ''`, schema-qualified relations, only `reme_app` may
-- execute it. Null when nothing is scheduled.
--
-- shortcut: reads every unpaused row, a few milliseconds at tens of
-- thousands; split it over the partial index when jobs pass about 100,000.
CREATE FUNCTION public.next_due_at()
RETURNS timestamp with time zone
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select min(
    case
      when j.claimed_at is null then j.next_run_at
      else greatest(j.next_run_at, j.claimed_at + interval '20 minutes')
    end)
  from public.scheduled_jobs j
  where j.paused_at is null
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.next_due_at() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.next_due_at() TO reme_app;
