-- История «цена снижена»/«продано» готовым роликом (26.11.2026): рубильник, по умолчанию включён.
ALTER TABLE "Settings" ADD COLUMN "instagramStoryVideoEnabled" BOOLEAN NOT NULL DEFAULT true;
