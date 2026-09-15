-- Custom SQL, not generated: drizzle-kit models neither privileges nor
-- triggers (ADR-032).

-- `deployments` is append-only. The active revision is the newest row for a
-- site, so rewriting or erasing a row would rewrite which revision the site
-- served. `reme_app` keeps SELECT and INSERT; `tenancy/rls.test.ts` asserts it.
REVOKE UPDATE, DELETE ON "deployments" FROM reme_app;
--> statement-breakpoint
-- An approval is written once. A decided row never changes, and an undecided
-- request may gain its decision and nothing else, so a decision can only ever
-- be about the target that was shown.
CREATE FUNCTION approvals_write_once() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  -- A move across orgs is row security's to refuse, with its own error.
  IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    RETURN NEW;
  END IF;
  IF OLD.decision IS NOT NULL THEN
    RAISE EXCEPTION 'approval % is already decided', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.org_id, NEW.assignment_id, NEW.requested_by_staff_id,
      NEW.approver_staff_id, NEW.action_kind, NEW.target, NEW.revision_id,
      NEW.rationale, NEW.requested_at, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.org_id, OLD.assignment_id, OLD.requested_by_staff_id,
      OLD.approver_staff_id, OLD.action_kind, OLD.target, OLD.revision_id,
      OLD.rationale, OLD.requested_at, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'approval % may change only its decision', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER approvals_write_once
  BEFORE UPDATE ON "approvals"
  FOR EACH ROW EXECUTE FUNCTION approvals_write_once();
