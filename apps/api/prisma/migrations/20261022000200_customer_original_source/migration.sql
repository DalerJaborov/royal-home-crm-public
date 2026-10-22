-- Additive only: historical sources retain NULL provenance and their old pins.
ALTER TABLE "CustomerPropertyIngressTicket"
  ADD COLUMN "routingSourceVersion" INTEGER,
  ADD COLUMN "routingSourceHash" TEXT,
  ADD COLUMN "routingScopeRevision" BIGINT,
  ADD COLUMN "routingProvenance" TEXT,
  ADD CONSTRAINT "CustomerIngress_routing_source_check" CHECK (
    ("routingSourceVersion" IS NULL AND "routingSourceHash" IS NULL AND
     "routingScopeRevision" IS NULL AND "routingProvenance" IS NULL) OR
    ("routingSourceVersion" IS NOT NULL AND "routingSourceVersion"=1 AND
     "routingSourceHash" IS NOT NULL AND "routingSourceHash" ~ '^[a-f0-9]{64}$' AND
     "routingScopeRevision" IS NOT NULL AND "routingScopeRevision">=0 AND
     "routingProvenance" IS NOT NULL AND "routingProvenance" IN ('META_ENVELOPE','NATIVE_HISTORY') AND
     "endpointScopeId" IS NOT NULL));

CREATE FUNCTION customer_ingress_routing_source_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- NULL historical metadata is not retroactively upgraded from a redelivery.
  IF ROW(NEW."routingSourceVersion",NEW."routingSourceHash",NEW."routingScopeRevision",NEW."routingProvenance") IS DISTINCT FROM
     ROW(OLD."routingSourceVersion",OLD."routingSourceHash",OLD."routingScopeRevision",OLD."routingProvenance") THEN
    RAISE EXCEPTION 'customer original routing source is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_ingress_routing_source_immutable BEFORE UPDATE ON "CustomerPropertyIngressTicket"
  FOR EACH ROW EXECUTE FUNCTION customer_ingress_routing_source_immutable();
