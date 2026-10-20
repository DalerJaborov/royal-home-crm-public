-- Маркер удаления Instagram (Facebook Login, graph.facebook.com) — отдельный от
-- metaIgToken (переписка, graph.instagram.com через прокси). См. комментарий
-- у поля Settings.metaIgManageToken в schema.prisma.
ALTER TABLE "Settings" ADD COLUMN "metaIgManageToken" TEXT;
