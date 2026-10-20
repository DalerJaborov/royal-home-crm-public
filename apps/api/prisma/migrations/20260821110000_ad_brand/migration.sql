-- Реклама самого агентства: объекта не имеет и в список «без объекта» не входит.
ALTER TABLE "Ad" ADD COLUMN IF NOT EXISTS "brand" BOOLEAN NOT NULL DEFAULT false;
