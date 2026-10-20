-- Тумблер §10.4: категория досье решает тип карточки только тогда, когда сам
-- ход неуверен (модель не поняла или не уверена). Выключено по умолчанию —
-- поведение decideLeadKind не меняется, пока владелец не включит сам.
ALTER TABLE "Settings" ADD COLUMN "contactCategoryDrivesLeadKind" BOOLEAN NOT NULL DEFAULT false;
