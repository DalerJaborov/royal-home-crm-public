-- «Объект загорелся» (24.09.2026): когда агенту последний раз ушло уведомление.
ALTER TABLE "Property" ADD COLUMN "hotNotifiedAt" TIMESTAMP(3);
