-- 537: preserve approved revision ancestry beyond the sixteenth release.
-- No assignments, sources, owners, edges or delivery receipts are rewritten.
BEGIN;
CREATE OR REPLACE FUNCTION customer_agent_revision_reachable(from_revision TEXT,from_cohort TEXT,to_revision TEXT,to_cohort TEXT DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  WITH RECURSIVE lineage(revision,cohort) AS (
    SELECT from_revision,from_cohort
    UNION
    SELECT e."toRevisionId",e."toCohortId"
    FROM lineage l JOIN "CustomerAgentRevisionAdvance" e
      ON e."fromRevisionId"=l.revision AND e."fromCohortId"=l.cohort
  ) SELECT EXISTS(SELECT 1 FROM lineage WHERE revision=to_revision AND (to_cohort IS NULL OR cohort=to_cohort))
$$;
-- UNION deduplicates exact pairs: recursion is finite even for a corrupt cycle.
-- Existing insert guards still reject cycles using this full structural path.
COMMIT;
