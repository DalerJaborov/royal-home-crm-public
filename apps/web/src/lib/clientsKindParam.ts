/**
 * Параметр `?kind=` страницы «Клиенты». `BUYER` и `SELLER` сужают список до
 * одного раздела; `all` снимает срез по виду совсем: сервер тогда отдаёт и
 * покупателей, и продавцов. Нужен ссылкам из счётчиков, которые считают оба вида
 * вместе (воронка лидов: «Новые» = покупатели + продавцы), иначе по клику
 * открывался только покупательский срез и продавцы были недоступны
 * (аудит 04.10.2026, WEB-PAGES06).
 */
export interface KindParam {
  sectionKind: "SELLER" | "BUYER" | null;
  allKinds: boolean;
}

export function readKindParam(raw: string | null): KindParam {
  return {
    sectionKind: raw === "SELLER" ? "SELLER" : raw === "BUYER" ? "BUYER" : null,
    allKinds: raw === "all",
  };
}
