import { pluralizeRu } from "@royal-home/shared";

/**
 * РЕШЕНИЕ НА «СОХРАНИТЬ»: создавать объект сейчас, ждать файлы или спросить
 * агента (07.10.2026, владелец: «чтобы ролики и фото всегда дозагружались и он
 * видел процесс»). Раньше `save()` создавал объект при любом раскладе, а
 * сервер потом молча стирал всё, что не успело стать READY: объект и фото
 * создались, ролика нет, агент об этом не узнал.
 *
 * Чистая функция от сводки очереди — тестируется без React.
 *
 *   wait    — что-то ещё едет или ждёт очереди; объект создавать рано.
 *   ask     — ничего не едет, но часть файлов не ушла или потеряна; молча
 *             создавать нельзя — агент выбирает: повторить, убрать или
 *             сохранить БЕЗ них (`acceptedLoss`, только явным нажатием).
 *   proceed — все файлы на сервере, либо агент явно согласился обойтись без упавших.
 */
export type SaveDecision = "proceed" | "wait" | "ask";

export function decideSave(
  summary: { pending: number; failed: number },
  opts: { acceptedLoss?: boolean } = {}
): SaveDecision {
  if (summary.pending > 0) return "wait";
  if (summary.failed > 0 && !opts.acceptedLoss) return "ask";
  return "proceed";
}

/** «Не загрузилось 2 файла» — заголовок окна выбора. */
export function uploadProblemTitle(failed: number, timedOut: boolean): string {
  if (failed <= 0) return timedOut ? "Файлы ещё не доехали" : "Файлы не загрузились";
  const files = pluralizeRu(failed, ["файл", "файла", "файлов"]);
  return `Не загрузилось ${failed} ${files}`;
}

/**
 * Сколько файлов сервер НЕ перенёс в созданный объект. Ответ POST /properties
 * несёт `media: { attached, skipped }`; пока сервер этого не отдаёт (или поле
 * иное), чтение необязательное и возвращает 0 — ничего не ломается.
 */
export function skippedMediaCount(response: unknown): number {
  if (typeof response !== "object" || response === null || !("media" in response)) return 0;
  const media = response.media;
  if (typeof media !== "object" || media === null || !("skipped" in media)) return 0;
  const n = media.skipped;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function skippedMediaMessage(skipped: number): string {
  const files = pluralizeRu(skipped, ["файл", "файла", "файлов"]);
  return `${skipped} ${files} не дошли до карточки — добавьте их в объекте ещё раз`;
}

/**
 * МОЖНО ЛИ ЗАКРЫТЬ МАСТЕР (владелец 07.10.2026): до «Сохранить» — всегда, даже
 * пока файлы едут: агент уходит за информацией (карточка клиента и т.п.) и
 * возвращается к черновику, загрузка продолжается в фоне (lib/workGuard.ts),
 * поля при закрытии досылаются на сервер сразу. Блокировка — только во время
 * самого сохранения (ожидание файлов после «Сохранить», создание объекта,
 * финальный экран): там закрытие и есть «ушёл, а ролик не доехал».
 */
export function canCloseWizard(state: { saving: boolean; finishing: boolean }): boolean {
  return !state.saving && !state.finishing;
}
