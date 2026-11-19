import { useMemo } from "react";
import { royalLookOverride, useLookAttribute } from "../../../hooks/useRoyalLook";

/**
 * «НОВЫЙ ВИД» НА СТРАНИЦАХ БЕЗ ВХОДА — экран входа `/login`, ссылка на объект
 * `/l/:token`, отчёт владельцу `/o/:token` (пачка records, 20.11.2026).
 *
 * Здесь нет сотрудника и нет ответа `/ui-shell`, поэтому признак берётся не с
 * сервера, а только так:
 *   1) `?look=royal` в адресе — показать новый вид, `?look=legacy` — прежний;
 *   2) без параметра — запомненный на этом устройстве выбор сотрудника: ключ
 *      `rh-look:<id> = "royal"`, который `useRoyalLookChoice` пишет ТОЛЬКО тому,
 *      кому сервер дал новый вид (hooks/useRoyalLook.ts).
 * Ни того ни другого — прежний вид до пикселя. Клиент (покупатель, владелец
 * квартиры) открывает ссылку на своём телефоне: ключа там нет, и страница прежняя.
 *
 * Ни одного запроса: только адрес и localStorage. Сам выбор здесь НЕ запоминается —
 * `?look=royal` в присланной ссылке не должен «прилипать» к чужому телефону.
 *
 * Модуль подключён в LoginSessionGate (входной кусок сборки), поэтому ленивые
 * страницы берут его оттуда и отдельным файлом он не грузится.
 */
const KEY_PREFIX = "rh-look:";

/** Есть ли на устройстве сотрудник, выбравший новый вид (ключи пишет только useRoyalLookChoice). */
export function rememberedStaffLook(storage: Pick<Storage, "length" | "key" | "getItem"> | null | undefined): boolean {
  if (!storage) return false;
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(KEY_PREFIX) && storage.getItem(key) === "royal") return true;
    }
  } catch { /* Хранилище закрыто (приватный режим) — прежний вид. */ }
  return false;
}

/** Правило: параметр адреса важнее, иначе запомненный выбор сотрудника; по умолчанию — прежний вид. */
export function publicRoyalLook(search: string, remembered: boolean): boolean {
  return royalLookOverride(search) ?? remembered;
}

function deviceStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

/** Новый вид на странице без входа; ставит `data-ui-look="royal"` на <html>, пока страница открыта. */
export function usePublicRoyalLook(): boolean {
  // Адрес окна, а не роутера: экран входа живёт и вне роутера (LoginSessionGate в тестах
  // первого кадра), а страницы по ссылке открываются полной загрузкой. Перерисовка при
  // смене маршрута читает адрес заново.
  const search = typeof window === "undefined" ? "" : window.location.search;
  const remembered = useMemo(() => rememberedStaffLook(deviceStorage()), []);
  const royal = publicRoyalLook(search, remembered);
  useLookAttribute(royal);
  return royal;
}

/** Метка раздела пачки: «records» в новом виде, иначе атрибута нет. */
export const RECORDS_SECTION = "records";
