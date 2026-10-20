-- CreateIndex
CREATE INDEX "Client_assignedAgentId_idx" ON "Client"("assignedAgentId");

-- CreateIndex
CREATE INDEX "Client_status_idx" ON "Client"("status");

-- CreateIndex
CREATE INDEX "Client_desiredDistrictId_idx" ON "Client"("desiredDistrictId");

-- CreateIndex
CREATE INDEX "Client_aiScore_idx" ON "Client"("aiScore");

-- CreateIndex
CREATE INDEX "Client_createdAt_idx" ON "Client"("createdAt");

-- CreateIndex
CREATE INDEX "Deal_clientId_idx" ON "Deal"("clientId");

-- CreateIndex
CREATE INDEX "Deal_agentId_idx" ON "Deal"("agentId");

-- CreateIndex
CREATE INDEX "Deal_propertyId_idx" ON "Deal"("propertyId");

-- CreateIndex
CREATE INDEX "Deal_stage_idx" ON "Deal"("stage");

-- CreateIndex
CREATE INDEX "Deal_closedAt_idx" ON "Deal"("closedAt");

-- CreateIndex
CREATE INDEX "Interaction_clientId_idx" ON "Interaction"("clientId");

-- CreateIndex
CREATE INDEX "Interaction_agentId_idx" ON "Interaction"("agentId");

-- CreateIndex
CREATE INDEX "Interaction_propertyId_idx" ON "Interaction"("propertyId");

-- CreateIndex
CREATE INDEX "Interaction_type_createdAt_idx" ON "Interaction"("type", "createdAt");

-- CreateIndex
CREATE INDEX "Interaction_nextActionDate_idx" ON "Interaction"("nextActionDate");

-- CreateIndex
CREATE INDEX "PriceChange_propertyId_idx" ON "PriceChange"("propertyId");

-- CreateIndex
CREATE INDEX "Property_status_idx" ON "Property"("status");

-- CreateIndex
CREATE INDEX "Property_districtId_idx" ON "Property"("districtId");

-- CreateIndex
CREATE INDEX "Property_assignedAgentId_idx" ON "Property"("assignedAgentId");

-- CreateIndex
CREATE INDEX "Property_status_createdAt_idx" ON "Property"("status", "createdAt");
