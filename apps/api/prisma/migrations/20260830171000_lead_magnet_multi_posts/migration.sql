-- Несколько публикаций на одну кампанию: списки работают наравне с одиночными
-- postUrl/mediaId. Два списка, а не один: permalink от Graph API приходит не всегда,
-- и кампания, привязанная только ссылкой, однажды неделю не выдала ни одного файла.
-- AlterTable
ALTER TABLE "LeadMagnetCampaign" ADD COLUMN "postUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "LeadMagnetCampaign" ADD COLUMN "mediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
