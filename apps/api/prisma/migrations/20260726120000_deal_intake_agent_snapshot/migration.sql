-- Кому причитается доля за приём объекта — снапшот на момент закрытия сделки.
-- До этого получатель определялся через property."intakeAgentId" в момент построения
-- отчёта: смена интейкера у уже проданного объекта переписывала выплату за закрытый
-- месяц с одного агента на другого, и в журнале это выглядело правкой карточки.
ALTER TABLE "Deal" ADD COLUMN "commissionIntakeAgentId" TEXT;

-- Существующим закрытым сделкам проставляем текущего интейкера объекта: это ровно то,
-- что отчёты показывали до сих пор, — фиксируем историю как есть, не меняя цифр.
UPDATE "Deal" d
SET "commissionIntakeAgentId" = p."intakeAgentId"
FROM "Property" p
WHERE p.id = d."propertyId"
  AND d.stage = 'COMPLETED'
  AND d."commissionIntakeAmount" IS NOT NULL;
