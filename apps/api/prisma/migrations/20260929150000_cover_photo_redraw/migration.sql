-- Фото под наш шаблон обложки перерисовывает ChatGPT «как для журнала» (по умолчанию включено).
ALTER TABLE "Settings" ADD COLUMN "coverPhotoRedraw" BOOLEAN NOT NULL DEFAULT true;
