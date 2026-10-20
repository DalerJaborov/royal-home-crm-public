-- Объекты со ссылкой на пост Instagram, вписанной руками (старые и «ручные», как
-- ОБ-000088), имели пустой publishedChannels: карточка, фото-посты, повторные показы,
-- «Где вышел ролик» и бот монтажёра считали их нигде не опубликованными.
-- Ссылка на Instagram — тот же факт, что отметка канала. Только добавляем, ничего не
-- удаляем; условие совпадает с isInstagramLink (@royal-home/shared: начало адреса).
UPDATE "Property"
SET "publishedChannels" = array_append("publishedChannels", 'INSTAGRAM')
WHERE "deletedAt" IS NULL
  AND "instagramUrl" ~* '^\s*https?://(www\.)?instagram\.com/'
  AND NOT ('INSTAGRAM' = ANY("publishedChannels"));
