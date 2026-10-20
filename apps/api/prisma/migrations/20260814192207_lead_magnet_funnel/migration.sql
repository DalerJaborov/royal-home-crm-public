-- CreateTable
CREATE TABLE "LeadMagnetCampaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "postUrl" TEXT,
    "mediaId" TEXT,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "anyComment" BOOLEAN NOT NULL DEFAULT false,
    "publicReplies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "inviteText" TEXT NOT NULL,
    "inviteButton" TEXT NOT NULL DEFAULT 'Хочу чек-лист',
    "requireFollow" BOOLEAN NOT NULL DEFAULT true,
    "followText" TEXT NOT NULL,
    "followButton" TEXT NOT NULL DEFAULT 'Я подписался',
    "notFollowingText" TEXT NOT NULL,
    "maxFollowChecks" INTEGER NOT NULL DEFAULT 3,
    "deliverIfUnsure" BOOLEAN NOT NULL DEFAULT true,
    "deliveredText" TEXT NOT NULL,
    "filePath" TEXT,
    "fileName" TEXT,
    "fileSize" INTEGER,
    "link" TEXT,
    "createLead" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "LeadMagnetCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadMagnetDelivery" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "igUserId" TEXT NOT NULL,
    "username" TEXT,
    "commentId" TEXT,
    "commentText" TEXT,
    "state" TEXT NOT NULL DEFAULT 'INVITED',
    "followChecks" INTEGER NOT NULL DEFAULT 0,
    "wasFollowing" BOOLEAN,
    "deliveredAsFile" BOOLEAN,
    "clientId" TEXT,
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "askedFollowAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadMagnetDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeadMagnetCampaign_enabled_idx" ON "LeadMagnetCampaign"("enabled");

-- CreateIndex
CREATE INDEX "LeadMagnetDelivery_igUserId_state_idx" ON "LeadMagnetDelivery"("igUserId", "state");

-- CreateIndex
CREATE INDEX "LeadMagnetDelivery_campaignId_state_idx" ON "LeadMagnetDelivery"("campaignId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "LeadMagnetDelivery_campaignId_igUserId_key" ON "LeadMagnetDelivery"("campaignId", "igUserId");

-- AddForeignKey
ALTER TABLE "LeadMagnetDelivery" ADD CONSTRAINT "LeadMagnetDelivery_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "LeadMagnetCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
