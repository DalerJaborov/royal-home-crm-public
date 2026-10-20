-- The original foundation enum CHECK predates PUBLIC namespaces. Keep every
-- old kind and admit the new discriminated shape constrained by migration507.
ALTER TABLE "CustomerEndpointScope" DROP CONSTRAINT "CustomerEndpointScope_kind_check";
ALTER TABLE "CustomerEndpointScope" ADD CONSTRAINT "CustomerEndpointScope_kind_check"
  CHECK ("kind" IN ('NORMAL','LEGACY_UNKNOWN','PUBLIC'));
