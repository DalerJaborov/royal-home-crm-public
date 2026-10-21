-- SENT is provider acceptance, not handset delivery. Never turn a dry-run,
-- preparation, copied link, failed attempt or orphaned journal row into outreach.
-- Deterministic IDs are shared with the live SMS route, so this is safe to rerun.
INSERT INTO "PropertyExposure" (
  "id", "channel", "recipientId", "clientId", "propertyId", "shortId", "kind", "sentAt"
)
SELECT 'sms:' || s."id", 'SMS', c."id", c."id", p."id", p."shortId", 'LINK', s."createdAt"
FROM "SmsMessage" s
JOIN "Client" c ON c."id" = s."clientId"
JOIN "Property" p ON p."id" = s."propertyId"
WHERE s."status" = 'SENT'
  AND s."purpose" = 'PROPERTY_SHARE'
  AND NOT EXISTS (
    SELECT 1 FROM "PropertyExposure" e
    WHERE e."channel" = 'SMS' AND e."clientId" = c."id"
      AND e."propertyId" = p."id" AND e."sentAt" = s."createdAt"
  )
ON CONFLICT ("id") DO NOTHING;
