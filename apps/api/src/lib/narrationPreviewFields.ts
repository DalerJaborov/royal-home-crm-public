/**
 * Поля кандидата «прослушать перед выпуском» (17.11.2026, lib/narrationPreview.ts) в одном месте:
 * их обнуляют и выпуск/отказ, и приём нового ролика от монтажёра, и удаление ролика
 * (lib/videoHandoff.ts). Отдельный модуль без зависимостей — иначе videoHandoff ↔ narrationPreview цикл.
 */
export const NARRATION_PREVIEW_CLEARED = {
  narrationPreviewPath: null, narrationPreviewVersionId: null, narrationPreviewMasterKey: null, narrationPreviewAt: null,
  narrationPreviewDueAt: null, narrationPreviewVoiceSec: null, narrationPreviewClipSec: null, narrationPreviewNotifiedAt: null,
} as const;
