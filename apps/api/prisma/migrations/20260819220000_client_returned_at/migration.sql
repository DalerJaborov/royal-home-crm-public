-- «Клиент вернулся» — заметно в списке без проверки хронологии.

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "returnedAt" TIMESTAMP(3);
