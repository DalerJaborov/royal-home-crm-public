-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "transferConflictKeywords" TEXT[] DEFAULT ARRAY['конфликт', 'жалоб', 'недовол', 'оскорб', 'груб', 'агресс', 'скандал', 'хам']::TEXT[];
