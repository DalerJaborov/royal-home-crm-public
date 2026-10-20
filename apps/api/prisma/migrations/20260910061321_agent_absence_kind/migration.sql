-- CreateEnum
CREATE TYPE "AbsenceKind" AS ENUM ('VACATION', 'SICK', 'OTHER');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "absenceKind" "AbsenceKind",
ADD COLUMN     "absenceUntil" TIMESTAMP(3);
