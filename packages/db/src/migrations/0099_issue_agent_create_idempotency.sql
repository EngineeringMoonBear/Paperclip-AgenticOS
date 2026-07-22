CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_agent_create_idempotency_uq"
  ON "issues" ("company_id", "origin_fingerprint")
  WHERE "origin_kind" = 'manual'
    AND "origin_fingerprint" <> 'default'
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');
