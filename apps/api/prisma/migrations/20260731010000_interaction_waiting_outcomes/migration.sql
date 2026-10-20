-- Исходы «итога звонка»: состояния ожидания вместо оценки настроения (решение
-- владельца 30.07). POSITIVE/NEUTRAL сохраняются — ими записана прошлая история.
ALTER TYPE "InteractionOutcome" ADD VALUE IF NOT EXISTS 'WAITING_CALL';
ALTER TYPE "InteractionOutcome" ADD VALUE IF NOT EXISTS 'WAITING_OPTIONS';
ALTER TYPE "InteractionOutcome" ADD VALUE IF NOT EXISTS 'WAITING_SHOWING';
