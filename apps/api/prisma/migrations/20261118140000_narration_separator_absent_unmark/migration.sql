-- 17.11.2026: сразу после выката #219 сервис voice-separator ещё не был поднят (ENOTFOUND), и объект
-- получил постоянную отметку «голос убрать не получилось». Это не приговор ролику — снимаем такие
-- отметки, чтобы после подъёма сервиса CRM повторила сама. Идемпотентно.
UPDATE "Property"
SET "videoMasterAutoError" = NULL, "videoMasterAutoErrorFinalPath" = NULL, "videoMasterAutoRetryAt" = NULL
WHERE "videoMasterAutoError" LIKE '%ENOTFOUND%';
