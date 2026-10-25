ALTER TABLE "Client" ADD COLUMN "mutationRevision" INTEGER NOT NULL DEFAULT 0;
-- A millisecond change stamp alone can collide. Every writer, including raw SQL,
-- advances the revision; request payloads cannot forge or retain an older value.
CREATE FUNCTION client_advance_mutation_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."mutationRevision" := OLD."mutationRevision" + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER client_advance_mutation_revision BEFORE UPDATE ON "Client"
FOR EACH ROW EXECUTE FUNCTION client_advance_mutation_revision();
