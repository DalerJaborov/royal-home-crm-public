-- В4 владельца (15.11.2026): сверка переписок с Meta для Messenger и Instagram — свой рубильник
-- у каждой площадки (lib/metaInboxReconcile.ts). По умолчанию включены.
ALTER TABLE "Settings" ADD COLUMN "messengerInboxReconcileEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "instagramInboxReconcileEnabled" BOOLEAN NOT NULL DEFAULT true;
