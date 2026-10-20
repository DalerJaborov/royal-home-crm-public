import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth";

export type SectionKey =
  | "clients"
  | "sellers"
  | "otherInquiries"
  | "messages"
  | "comments"
  | "deals"
  | "calls"
  | "vacancies"
  | "calendar";

export interface SidebarCounters {
  clients: number;
  sellers: number;
  otherInquiries: number;
  messages: number;
  /** Комментарии под постами, где бот спасовал и ждёт человека, — с последнего
   *  визита в раздел. Не вся лента: значок должен звать разобрать, а не считать. */
  comments: number;
  /** Новые сделки с последнего визита в раздел (агенту — свои, руководству — все). */
  deals: number;
  /** Отвеченные звонки с карточкой, которые оператор ещё не разобрал (то же
   *  правило, что «без разбора» на вкладке «Звонки»). */
  calls: number;
  /** Анкеты кандидатов от бота, ещё не разобранные («Вакансии»). */
  vacancies: number;
  /** Ключи, взятые позже последнего визита и уже просроченные по настройке
   *  «Ключи → часы до предупреждения». */
  /** Личные задачи агента, наступившие после последнего визита и не выполненные. */
  calendar: number;
}

/** Красные счётчики «нового» для вкладок сайдбара. Лёгкий запрос, поллинг раз в 30с —
 * как у useTeamLive: значок появляется без перезагрузки страницы. */
export function useCounters() {
  return useQuery<SidebarCounters>({
    queryKey: ["counters"],
    queryFn: () => api("/dashboard/counters"),
    // ЗАПАСНОЙ ПУТЬ, А НЕ ОСНОВНОЙ (12.09.2026). Свежесть держит поток
    // событий (lib/liveEvents.ts): сервер сам говорит, что обновилось.
    // Таймер оставлен на случай, когда поток не дошёл — прокси срезал
    // соединение, телефон спал, флаг LIVE_EVENTS=0, — поэтому он редкий,
    // а не выключенный.
    refetchInterval: 300_000,
    staleTime: 25_000,
  });
}

/** Отмечает раздел прочитанным при открытии страницы — значок гаснет у текущего
 * агента (метка хранится на сервере, у остальных сотрудников счётчик остаётся). */
export function useMarkSectionSeen(section: SectionKey) {
  const queryClient = useQueryClient();
  const readOnly = useAuthStore((s) => s.agent?.role === "SHAREHOLDER" || s.agent?.readOnly === true);
  useEffect(() => {
    if (readOnly) return;
    api("/dashboard/counters/seen", { method: "POST", body: { section } })
      .then(() => queryClient.invalidateQueries({ queryKey: ["counters"] }))
      .catch(() => {}); // не критично: значок погаснет при следующем успешном заходе
  }, [section, queryClient, readOnly]);
}
