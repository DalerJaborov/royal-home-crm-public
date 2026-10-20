import { logSystemError } from "./systemError.js";

/**
 * «У КЛЮЧА YOUTUBE НЕТ ПРАВА» — ОДНО НАПОМИНАНИЕ В СУТКИ, А НЕ СТРОКА НА РОЛИК
 * (25.09.2026, разбор журнала владельца).
 *
 * Ключ (refresh token) выпущен только с правом `youtube.upload`: публиковать
 * можно, а читать статистику, править подпись и отвечать на комментарии — нет.
 * Google отвечает на это одинаково («Request had insufficient authentication
 * scopes», 403 `insufficientPermissions`), и до этой правки каждый путь писал
 * своё: «Статистика роликов (YOUTUBE)» на каждое открытие карточки, «Объект …:
 * обновление подписей — YOUTUBE: …» на каждый объект (30 строк за минуту при
 * обновлении концовок), комментарии — своим текстом. Причина одна и чинится
 * одним действием владельца, поэтому и строка в журнале одна: с рецептом, раз
 * в сутки, общим ключом дедупликации (переживает перезапуск сервера, в отличие
 * от счётчика в памяти).
 *
 * Список прав всех маркеров — lib/tokenScopes.ts; здесь только распознать отказ.
 */

export const YOUTUBE_SCOPE_MISSING_MESSAGE =
  "refresh token выпущен только со scope youtube.upload; для чтения и ответа на комментарии " +
  "перевыпустить его, добавив scope https://www.googleapis.com/auth/youtube.force-ssl — рецепт в " +
  "docs/archive/youtube-oauth-refresh-check-11-09-2026.md, шаг 2.";

/** Коротко для карточки объекта и итогов «Обновить подписи» — без англоязычного текста Google. */
export const YOUTUBE_SCOPE_MISSING_SHORT =
  "у ключа YouTube нет права править и читать ролики — нужно перевыпустить ключ (см. журнал ошибок)";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Отказ Google именно из-за нехватки права у ключа (а не сеть, квота, удалённый ролик). */
export function isYoutubeScopeError(error: string | null | undefined): boolean {
  if (!error) return false;
  return /insufficient authentication scopes|insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(error);
}

/** Отметка в памяти процесса — перед базой: пачка объектов подряд (обновление
 *  концовок, «Обзор» на двадцать роликов) зовёт это десятки раз за секунды, и
 *  без неё все вызовы успевали бы проверить базу раньше первой вставки. База —
 *  второй слой: переживает перезапуск сервера после выката. */
let reportedAt = 0;

export function reportYoutubeScopeMissing(): void {
  if (Date.now() - reportedAt < DAY_MS) return;
  reportedAt = Date.now();
  void logSystemError("youtube", YOUTUBE_SCOPE_MISSING_MESSAGE, { dedupKey: "youtube-scope-missing", dedupWindowMs: DAY_MS });
}

/** Только для тестов: забыть отметку процесса, чтобы проверить слой базы. */
export function resetYoutubeScopeReportForTests(): void {
  reportedAt = 0;
}
