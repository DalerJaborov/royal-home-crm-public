import { useMemo } from "react";
import { deviceLookRemembered, royalLookOverride, useLookAttribute } from "../../../hooks/useRoyalLook";

/**
 * «НОВЫЙ ВИД» НА СТРАНИЦАХ БЕЗ ВХОДА — экран входа `/login`, ссылка на объект
 * `/l/:token`, отчёт владельцу `/o/:token` (пачка records, 20.11.2026).
 *
 * Здесь нет сотрудника и нет ответа `/ui-shell`, поэтому признак берётся не с
 * сервера, а только так:
 *   1) `?look=royal` в адресе — показать новый вид, `?look=legacy` — прежний;
 *   2) без параметра — флаг устройства `rh-look-device`, который ставит и снимает
 *      только AppLayout по признаку сотрудника с сервера (useDeviceLookMemory в
 *      hooks/useRoyalLook.ts): вид выключили — флаг снят при следующем заходе,
 *      вышел из учётки — снят сразу.
 * Ни того ни другого — прежний вид до пикселя. Клиент (покупатель, владелец
 * квартиры) открывает ссылку на своём телефоне: флага там нет, и страница прежняя.
 *
 * Ни одного запроса: только адрес и localStorage. Сам выбор здесь НЕ запоминается —
 * `?look=royal` в присланной ссылке не должен «прилипать» к чужому телефону.
 *
 * Модуль подключён в LoginSessionGate (входной кусок сборки), поэтому ленивые
 * страницы берут его оттуда и отдельным файлом он не грузится.
 */

/** Правило: параметр адреса важнее, иначе флаг устройства; по умолчанию — прежний вид. */
export function publicRoyalLook(search: string, remembered: boolean): boolean {
  return royalLookOverride(search) ?? remembered;
}

/**
 * Новый вид на странице без входа (только решение, без атрибута). Адрес окна, а не
 * роутера: экран входа живёт и вне роутера (LoginSessionGate в тестах первого кадра),
 * а страницы по ссылке открываются полной загрузкой.
 */
export function usePublicRoyalLook(): boolean {
  const search = typeof window === "undefined" ? "" : window.location.search;
  const remembered = useMemo(() => deviceLookRemembered(), []);
  return publicRoyalLook(search, remembered);
}

/**
 * Решение и атрибут `data-ui-look="royal"` на <html>, пока страница открыта. Ставит его
 * корень страницы: на входе — LoginSessionGate (один на маршрут), на ссылках — сама
 * страница. Экран Login атрибут не ставит, только читает решение.
 */
export function usePublicLookRoot(): boolean {
  const royal = usePublicRoyalLook();
  useLookAttribute(royal);
  return royal;
}

/** Метка раздела пачки: «records» в новом виде, иначе атрибута нет. */
export const RECORDS_SECTION = "records";
