-- Immutable, key-free server configuration archive. No rows/activation/budget grants.
CREATE TABLE "CustomerAgentRuntimeSnapshot" (
  "id" TEXT NOT NULL,
  "snapshotJson" JSONB NOT NULL,
  "providerProfileHash" TEXT NOT NULL,
  "providerPolicyHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerAgentRuntimeSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_agent_runtime_snapshot_shape" CHECK (
    "id" ~ '^[a-f0-9]{64}$' AND "providerProfileHash" ~ '^[a-f0-9]{64}$' AND "providerPolicyHash" ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof("snapshotJson")='object'
    AND NOT ("snapshotJson" ?| ARRAY['keys','apiKey','apiKeys','token','secret'])
  )
);
CREATE UNIQUE INDEX "customer_agent_runtime_profile_policy_key" ON "CustomerAgentRuntimeSnapshot"("providerProfileHash","providerPolicyHash");
CREATE FUNCTION customer_agent_runtime_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'customer runtime snapshot cannot be replaced or deleted'; END $$;
CREATE TRIGGER customer_agent_runtime_snapshot_immutable BEFORE UPDATE OR DELETE ON "CustomerAgentRuntimeSnapshot"
  FOR EACH ROW EXECUTE FUNCTION customer_agent_runtime_snapshot_immutable();
