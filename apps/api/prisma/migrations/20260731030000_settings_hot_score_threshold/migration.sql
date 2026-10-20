-- Порог ИИ-скоринга для автопередачи перспективного клиента сильному агенту
-- после отрицательного разговора (решение владельца 30.07, третий пакет п. 9).
ALTER TABLE "Settings" ADD COLUMN "hotScoreThreshold" INTEGER NOT NULL DEFAULT 70;
