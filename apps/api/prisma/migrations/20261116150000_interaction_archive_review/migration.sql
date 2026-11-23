-- Звонок-разбор удалённого клиента из Корзины: отметка, чтобы не считать его работой агента.
ALTER TABLE "Interaction" ADD COLUMN "archiveReview" BOOLEAN NOT NULL DEFAULT false;
