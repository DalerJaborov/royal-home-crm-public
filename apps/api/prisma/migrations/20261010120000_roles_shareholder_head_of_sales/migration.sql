-- Роли «Акционер» (SHAREHOLDER) и «РОП» (HEAD_OF_SALES), 10.10.2026.
-- Только добавление значений enum: данные не трогаем. Новое значение нельзя
-- использовать в той же транзакции — сид и данные идут отдельными шагами.
ALTER TYPE "Role" ADD VALUE 'SHAREHOLDER';
ALTER TYPE "Role" ADD VALUE 'HEAD_OF_SALES';
