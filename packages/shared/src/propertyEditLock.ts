import type { PropertyStatus } from "./enums.js";

/**
 * КОГДА АГЕНТ МОЖЕТ ПРАВИТЬ СВОЙ ОБЪЕКТ (владелец 07.10.2026, отменяет замок
 * «на монтаже» от 23.09.2026).
 *
 * - До публикации (проверка, фото/видео, монтаж — любой статус конвейера) —
 *   можно. Если ролик уже у монтажёра, ему уходит уведомление «в карточке
 *   изменилось: было → стало» (lib/propertyEditNotify.ts), чтобы он не вклеил
 *   в кадр старые цифры; на проверке — уведомление модератору.
 * - После публикации (объект вышел из конвейера: в продаже, резерв, продан,
 *   снят) агент не меняет ничего, кроме статуса: цена, площадь и подпись уже
 *   живут в роликах, постах и на сайте. Путь изменений — заявка директору или
 *   админу («Запросить изменение»).
 *
 * Руководство (право properties.editForeign: директор, админ, менеджер,
 * маркетинг, монтажёр) правит всегда. Закрытый объект (offSite) конвейер не
 * проходит и публикации не имеет, поэтому не запирается никогда.
 *
 * Одно правило на сервер (PATCH, фото, видео, кнопки видео-исправлений) и на
 * сайт (кнопки правки): иначе сайт показывал бы кнопку, а сервер отвечал отказом.
 */
export const PROPERTY_EDIT_LOCKED_CODE = "PROPERTY_EDIT_LOCKED";

/** Причина замка в теле ответа 409 (`reason`): клиенты различают «опубликован» от возможных других. */
export const PROPERTY_EDIT_LOCKED_REASON_PUBLISHED = "PUBLISHED";

export const PROPERTY_EDIT_LOCKED_MESSAGE =
  "Объект уже опубликован. Чтобы изменить цену или данные, отправьте заявку директору или админу (кнопка «Запросить изменение»).";

/** 403 для кнопок видео-исправлений (вернуть монтажёру, убрать из соцсетей, обновить подписи, «Готово»). */
export const PROPERTY_PUBLISHED_ACTION_DENIED_MESSAGE =
  "Это делает директор или админ. Нажмите «Запросить изменение».";

/**
 * Статусы «после публикации» — объект вышел из конвейера подготовки
 * (PROPERTY_PIPELINE_STATUSES) и живёт в продаже или после неё. Старые объекты
 * без сетей (AVAILABLE без publishedChannels) тоже здесь: ролик и описание у них
 * уже на сайте и в карточках клиентов.
 */
export const PUBLISHED_PROPERTY_STATUSES = ["AVAILABLE", "RESERVED", "SOLD", "WITHDRAWN"] as const satisfies readonly PropertyStatus[];

export function isPropertyPublished(status: PropertyStatus | string): boolean {
  return (PUBLISHED_PROPERTY_STATUSES as readonly string[]).includes(status);
}

/** Поля, которые агент может менять и ПОСЛЕ публикации: это не параметры объекта,
 *  а шаг жизни объекта (зарезервирован / продан / снят) в рамках PROPERTY_AGENT_TRANSITIONS. */
export const PROPERTY_FIELDS_OPEN_AFTER_PUBLISH = ["status"] as const;

export function propertyEditLocked(
  property: { status: PropertyStatus | string; offSite?: boolean | null },
  canEditForeign: boolean
): boolean {
  if (canEditForeign) return false;
  if (property.offSite) return false;
  return isPropertyPublished(property.status);
}

/**
 * Этапы, на которых агент НЕ вставляет ссылку на ролик: объект ещё не одобрен,
 * ролика нет. Ссылка — пропуск в продажу, и агент уводил объект в продажу мимо
 * проверки и монтажа. С «Ждём видео» ссылку вставляет сам агент, как и было.
 */
export const PROPERTY_STATUSES_WITHOUT_AGENT_REEL_LINK = ["PENDING_REVIEW", "AWAITING_PHOTOS"] as const;

export function agentReelLinkClosed(status: PropertyStatus | string, canEditForeignOrModerate: boolean): boolean {
  if (canEditForeignOrModerate) return false;
  return (PROPERTY_STATUSES_WITHOUT_AGENT_REEL_LINK as readonly string[]).includes(status);
}
