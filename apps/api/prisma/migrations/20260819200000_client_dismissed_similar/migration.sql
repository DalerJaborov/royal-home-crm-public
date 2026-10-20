-- "Это разные люди" — руководитель может отклонить подсказку о похожих
-- заметках, чтобы баннер не появлялся снова для той же пары карточек.

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "dismissedSimilarClientIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
