-- Локальная копия фото профиля клиента (best-effort, для пуш-уведомлений).
-- См. комментарий у Client.avatarUrl в schema.prisma и apps/api/src/lib/clientAvatar.ts.
ALTER TABLE "Client" ADD COLUMN "avatarUrl" TEXT;
