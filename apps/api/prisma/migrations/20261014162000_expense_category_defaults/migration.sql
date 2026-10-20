CREATE INDEX "Expense_status_month_idx" ON "Expense"("status","month");
CREATE INDEX "Expense_paymentDate_idx" ON "Expense"("paymentDate");
CREATE INDEX "Expense_categoryId_idx" ON "Expense"("categoryId");
CREATE UNIQUE INDEX "Expense_recurringId_occurrenceDate_key" ON "Expense"("recurringId","occurrenceDate");
CREATE INDEX "ExpenseCategoryDefinition_parentId_idx" ON "ExpenseCategoryDefinition"("parentId");
UPDATE "ExpenseCategoryDefinition" SET "color"='#E07A3F' WHERE "id"='00000000-0000-4000-8000-000000000001';
UPDATE "ExpenseCategoryDefinition" SET "color"='#26836D',"icon"='User' WHERE "id"='00000000-0000-4000-8000-000000000002';
UPDATE "ExpenseCategoryDefinition" SET "color"='#5B7CFA',"icon"='Coffee' WHERE "id"='00000000-0000-4000-8000-000000000003';
UPDATE "ExpenseCategoryDefinition" SET "color"='#9A8FD6' WHERE "id"='00000000-0000-4000-8000-000000000004';
INSERT INTO "ExpenseCategoryDefinition" ("id","title","rootCategory","parentId","icon","color","updatedAt") VALUES
('00000000-0000-4000-8000-000000000005','Аренда','OFFICE','00000000-0000-4000-8000-000000000003','Building2','#5B7CFA',CURRENT_TIMESTAMP),
('00000000-0000-4000-8000-000000000006','Интернет','OFFICE','00000000-0000-4000-8000-000000000003','Wifi','#E6A23C',CURRENT_TIMESTAMP),
('00000000-0000-4000-8000-000000000007','Телефония','OFFICE','00000000-0000-4000-8000-000000000003','Phone','#2BA5C9',CURRENT_TIMESTAMP),
('00000000-0000-4000-8000-000000000008','Сервер','OTHER','00000000-0000-4000-8000-000000000004','Server','#9A8FD6',CURRENT_TIMESTAMP);
-- Link known templates only; do not manufacture unknown historical payment dates.
UPDATE "Expense" AS e SET "recurringId"=split_part(e."autoKey",':',2) WHERE e."recurringId" IS NULL AND e."autoKey" LIKE 'rec:%' AND EXISTS(SELECT 1 FROM "RecurringExpense" r WHERE r."id"=split_part(e."autoKey",':',2));
