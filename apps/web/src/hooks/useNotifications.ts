import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { playNewLead, playNewMessage, playSoftTick } from "../lib/aiSounds";
import { pultSoundEnvironmentAllows } from "../lib/pultSound";
import type { AppNotification } from "../types";

interface NotificationsPage {
  items: AppNotification[];
  unreadCount: number;
  /** Непрочитанное двух верхних уровней по ВСЕЙ ленте, а не только со страницы:
   *  такая строка недельной давности иначе выпадает за первые двадцать записей
   *  (владелец 09.09.2026, переделано под его формулировку 12.09.2026). */
  pinned: AppNotification[];
  approvalCount: number;
  criticalCount: number;
  hasMore: boolean;
}

/**
 * Лента уведомлений в шапке (17-18.08.2026, макет design_handoff, экран «notif»).
 *
 * Первая страница — этого достаточно для дропдауна под колокольчиком, поэтому
 * useQuery, а не useInfiniteQuery: в проекте нет прецедента бесконечной ленты
 * в маленьком выпадающем меню, а «показать ещё» здесь не просят. Поллинг —
 * тем же интервалом, что у счётчиков сайдбара (useCounters), чтобы бейдж на
 * колокольчике гас/появлялся без перезагрузки страницы.
 */
/**
 * ЗВУК НА НОВОЕ УВЕДОМЛЕНИЕ (владелец 12.09.2026: «все звуки, которых нет,
 * добавь и доработай, и там, где можно добавить»).
 *
 * ПОЧЕМУ ЗДЕСЬ, А НЕ В КАЖДОМ ЭКРАНЕ. Через ленту уведомлений проходит КАЖДОЕ
 * событие, о котором CRM вообще сообщает человеку: sendPushToAgent(s) на
 * сервере пишет запись в Notification всегда, даже когда push не настроен или
 * подписок нет (apps/api/src/push.ts). Значит одна точка здесь озвучивает и
 * новый лид, и сообщение клиента, и напоминание о показе — и не забудет новый
 * повод, который заведут завтра.
 *
 * ОДИН ЗВУК НА СОБЫТИЕ, А НЕ НА КОМПОНЕНТ. Хук живёт в нескольких местах
 * (колокольчик в шапке, экран уведомлений, нижняя панель), react-query отдаёт
 * им общий кэш — но эффект выполняется в каждом. Поэтому «что уже звучало»
 * лежит в модуле, а не в ref компонента: иначе одно уведомление звенело бы
 * трижды.
 *
 * ПЕРВАЯ ЗАГРУЗКА МОЛЧИТ: открыть CRM утром не значит получить двадцать
 * сигналов подряд. Звучит только то, что появилось ПОСЛЕ первого ответа.
 */
const soundedNotificationIds = new Set<string>();
let notificationSoundPrimed = false;

/** Тише всего — то, что «к сведению»: Royal Score и салют команде не звучат. */
const SILENT_KINDS: ReadonlySet<string> = new Set(["score", "celebration"]);

function soundForNotification(kind: string): (() => void) | null {
  if (SILENT_KINDS.has(kind)) return null;
  if (kind === "lead") return playNewLead;
  if (kind === "message") return playNewMessage;
  // Показ, задача, контроль руководителя и служебные сигналы без вида — тот же
  // тихий сигнал, что и у новой строки на пульте: заметно, но не тревога.
  return playSoftTick;
}

/** Только для тестов: сбросить память о том, что уже звучало. */
export function resetNotificationSoundState(): void {
  soundedNotificationIds.clear();
  notificationSoundPrimed = false;
}

export function useNotifications() {
  const query = useQuery<NotificationsPage>({
    queryKey: ["notifications"],
    queryFn: () => api("/me/notifications"),
    // ЗАПАСНОЙ ПУТЬ, А НЕ ОСНОВНОЙ (12.09.2026). Свежесть держит поток
    // событий (lib/liveEvents.ts): сервер сам говорит, что обновилось.
    // Таймер оставлен на случай, когда поток не дошёл — прокси срезал
    // соединение, телефон спал, флаг LIVE_EVENTS=0, — поэтому он редкий,
    // а не выключенный.
    refetchInterval: 300_000,
    staleTime: 25_000,
  });

  const items = query.data?.items;
  useEffect(() => {
    if (!items) return;
    if (!notificationSoundPrimed) {
      // Первый ответ — только запоминаем состав, ничего не играем.
      for (const n of items) soundedNotificationIds.add(n.id);
      notificationSoundPrimed = true;
      return;
    }
    // Самое свежее непрочитанное, которого ещё не было: звучит ОДИН звук на
    // опрос, даже если пришло пять уведомлений сразу — пять сигналов подряд
    // это не информация, а шум.
    const fresh = items.filter((n) => !n.read && !soundedNotificationIds.has(n.id));
    for (const n of items) soundedNotificationIds.add(n.id);
    if (fresh.length === 0) return;
    // Гейты окружения те же, что у звука пульта: скрытая вкладка и
    // prefers-reduced-motion молчат (см. lib/pultSound.ts).
    if (!pultSoundEnvironmentAllows()) return;
    const play = soundForNotification(fresh[0].kind);
    play?.();
  }, [items]);

  return query;
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/me/notifications/${id}/read`, { method: "POST" }),
    // silent: отметка «прочитано» — не сохранение данных, а побочный эффект тапа
    // по уведомлению; общий тост «Сохранено» всплывал поверх целевого экрана
    // (аудит №4, 27.08 — этот случай прямо назван примером в queryClient.ts).
    meta: { silent: true },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api("/me/notifications/read-all", { method: "POST" }),
    meta: { silent: true },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

/** Отметить прочитанными только перечисленные записи (автопрочтение, см. ниже). */
export function useMarkNotificationsReadMany() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api("/me/notifications/read-many", { method: "POST", body: { ids } }),
    meta: { silent: true },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

/**
 * Какие из показанных записей автопрочтение вправе погасить: непрочитанные, кроме
 * «Ждёт решения» (APPROVAL) и «Критичное» (CRITICAL). Эти два уровня закреплены на
 * сервере по признаку read=false («прочитанное значит разобранное»), поэтому
 * автопрочтение, снявшее признак у нерешённого сигнала, прятало его с глаз, пока
 * решения нет (аудит WEB-PAGES16, решение владельца 04.10.2026). Их гасит только
 * человек: открыл запись или нажал «Прочитано».
 */
export function pickAutoReadIds(shown: readonly AppNotification[]): string[] {
  return shown.filter((n) => !n.read && n.level !== "APPROVAL" && n.level !== "CRITICAL").map((n) => n.id);
}

/**
 * УВИДЕЛ — ЗНАЧИТ ПРОЧИТАНО (владелец 27.08.2026).
 *
 * ЧТО БЫЛО. Счётчик на колокольчике гас только двумя способами: открыть каждое
 * уведомление по одному или найти неприметную кнопку «Прочитано» в углу шапки.
 * Никто этого не делал, и «9+» висел месяцами: на проде у людей накопилось
 * 191, 190, 152, 134, 105, 90 непрочитанных — при том что уведомления они
 * читали, просто не отмечали. Красный кружок, который горит всегда, перестаёт
 * что-либо значить: человек привыкает и не замечает уже настоящую новость.
 *
 * ЧТО СТАЛО. Экран уведомлений открыт — лента считается просмотренной, и счётчик
 * гаснет сам. Ровно так ведут себя мессенджеры, и другого поведения от красного
 * кружка человек не ждёт.
 *
 * ПОЧЕМУ С ЗАДЕРЖКОЙ. Мгновенная отметка съедала бы смысл самого захода: экран
 * открылся, счётчик мигнул и пропал — человек не успевает понять, сколько было
 * нового. Полторы секунды хватает, чтобы увидеть число, и мало, чтобы уйти с
 * экрана раньше отметки.
 *
 * ПОДСВЕТКА «НОВОЕ» ОТ ЭТОГО НЕ ГАСНЕТ: она рисуется по снимку, снятому при
 * входе на экран (см. useSeenSnapshot ниже), а не по актуальному признаку read.
 * Иначе список дёргался бы под руками через полторы секунды после открытия.
 *
 * ГАСИТСЯ ТОЛЬКО ПОКАЗАННОЕ И НЕ СРОЧНОЕ (04.10.2026, WEB-PAGES16). Раньше уходил
 * read-all по всей ленте: записи за пределами экрана помечались прочитанными
 * непоказанными, а нерешённый APPROVAL/CRITICAL пропадал из закрепа. Теперь на
 * сервер уходят id только показанных записей без этих двух уровней
 * (pickAutoReadIds). Ручная кнопка «Прочитано» по-прежнему read-all.
 */
export function useAutoReadNotifications(
  unreadCount: number,
  enabled = true,
  /** Записи, которые человек сейчас видит на экране. */
  shown: readonly AppNotification[] = []
): void {
  const markMany = useMarkNotificationsReadMany();
  // Через ref, а не в зависимостях: мутация — новый объект на каждом рендере,
  // и эффект перезапускался бы бесконечно, отправляя запрос за запросом.
  const markRef = useRef(markMany);
  markRef.current = markMany;
  const ids = pickAutoReadIds(shown);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  // Появились новые показанные записи — таймер заводится заново, как и при смене счётчика.
  const idsKey = ids.join(",");

  useEffect(() => {
    if (!enabled || unreadCount <= 0 || idsKey === "") return;
    const timer = setTimeout(() => {
      const toMark = idsRef.current;
      if (toMark.length > 0 && !markRef.current.isPending) markRef.current.mutate(toMark);
    }, 1500);
    return () => clearTimeout(timer);
  }, [enabled, unreadCount, idsKey]);
}

/**
 * Снимок «что было непрочитано, когда человек вошёл» — чтобы подсветка новых
 * записей пережила автоматическую отметку прочтения.
 *
 * Снимается один раз за заход на экран: список, который перекрашивается сам
 * через полторы секунды после открытия, читается как сбой.
 */
export function useSeenSnapshot(items: AppNotification[]): Set<string> {
  const [snapshot, setSnapshot] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (snapshot || items.length === 0) return;
    setSnapshot(new Set(items.filter((n) => !n.read).map((n) => n.id)));
  }, [items, snapshot]);
  return snapshot ?? new Set();
}
