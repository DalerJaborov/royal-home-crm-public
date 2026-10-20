import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AbsenceKind, Role } from "@royal-home/shared";
import { api } from "../lib/api";
import { SAFETY_REFETCH_MS } from "../lib/refetchIntervals";

export interface AgentListItem {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  role: Role;
  isActive: boolean;
  avatarUrl: string | null;
  createdAt: string;
  /** KPI 0-100, считается ночным кроном (apps/api/src/kpi.ts); null — ещё нет истории. */
  kpi: number | null;
  /** Внутренний номер на АТС (docs/telephony-sip-numbering.md); null — звонок из
   *  карточки клиента для этого агента недоступен, пока номер не назначен.
   *  Новым сотрудникам номер выдаётся автоматически из пула, заведённого на АТС. */
  sipExtension?: string | null;
  /** На каком языке сотруднику звучит подсказка о звонящем перед соединением:
   *  "tg" | "ru" | "off" (не играть ему вовсе); null — как выбрано в агентстве. */
  whisperLanguage?: string | null;
  /** Трубка зарегистрирована на АТС прямо сейчас. null — номера нет или АТС не
   *  ответила. «Номер выдан» и «телефон работает» — разные вещи: софтфон может быть
   *  не настроен, и узнать об этом до первого неудачного звонка было негде. */
  phoneOnline?: boolean | null;
  /** Номер числится в очереди входящих на АТС. null — АТС не ответила,
   *  судить нельзя (см. lib/telephony/agentIncomingReadiness.ts на сервере).
   *  Смысл с 20.09.2026 сузился: очередь — только для операторов первой линии,
   *  поэтому отметка касается тех, у кого стоит takesUnknownCalls. */
  incomingQueueReady?: boolean | null;
  /** Принимает незнакомые звонки, хотя оператором не назначен. Такого сверка
   *  убирает из очереди в ближайшие 15 минут; отметка нужна, чтобы до обхода
   *  директор видел правду, а не «всё в порядке». */
  takesUnknownCallsUnexpected?: boolean | null;
  /** Оператор первой линии: принимает звонки незнакомых номеров (решение
   *  владельца 20.09.2026). Агент отвечает только своим клиентам. */
  takesUnknownCalls?: boolean;
  /** Ник в Instagram без `@` (26.09.2026) — добавляется первым в соавторы Reels
   *  при публикации объектов этого агента (lib/instagramCollaborators.ts). */
  instagramUsername?: string | null;
  /** «Присылать мои посты в Telegram» (28.09.2026) — после публикации объекта
   *  ответственный агент получает в Telegram готовый пост со ссылками и кнопками
   *  «Поделиться» (lib/agentSharePost.ts на сервере); тумблер только выключает это
   *  конкретному человеку, общий рубильник — Settings.agentSharePostTelegram. */
  sharePostTelegram?: boolean;
  /** Личные выходные (11.10.2026), 0 — воскресенье. Пусто — работает каждый день. */
  weeklyDaysOff?: number[];
  /** Заморожен: лиды не выдаются (Команда → «Отпуск / больничный»). Только для agents.manage.
   *  Такого сотрудника не предлагают в списках «кому передать»: отдавать карточку
   *  тому, кого нет на работе, — ровно та ошибка, от которой уводят тревоги. */
  frozenAt?: string | null;
  /** Вид и срок отсутствия (владелец 09.09.2026). Пусто у прежней экстренной
   *  заморозки «для разбирательства» — она виду не соответствует. */
  absenceKind?: AbsenceKind | null;
  absenceUntil?: string | null;
  /** Поля `webrtc` (браузерная трубка) здесь больше нет: софтфон удалён 18.08.2026
   *  вместе с рабочим местом оператора входящих. Сервер поле пока отдаёт — лишнее
   *  поле в ответе ничего не ломает, уберут вместе с серверной частью. */
}

export function useAgents(options?: { enabled?: boolean }) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["agents"],
    queryFn: () => api<AgentListItem[]>("/agents"),
    enabled: options?.enabled ?? true,
  });
}

export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api<AgentSaveResult>("/agents", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });
}

/** Ответ на сохранение сотрудника. `extensionNote` — не ошибка: номер сохранён, но
 *  проверить его на АТС не удалось (станция выключена или телефония не настроена). */
export interface AgentSaveResult {
  id: string;
  sipExtension: string | null;
  extensionNote?: string;
}

export function useUpdateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api<AgentSaveResult>(`/agents/${id}`, { method: "PATCH", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });
}

/**
 * Свободные внутренние номера с АТС — подсказка для поля «Внутр. номер (SIP)».
 * Запрашиваются только когда карточка открыта на правку: это живой запрос к станции,
 * дёргать его на каждую отрисовку списка сотрудников незачем.
 */
export function useFreeExtensions(enabled: boolean) {
  return useQuery({
    queryKey: ["agents", "free-extensions"],
    queryFn: () => api<{ free: string[]; problem: string | null }>("/agents/extensions/free"),
    enabled,
    // Номера занимают друг за другом редко — минуты кэша достаточно, а лишние
    // запросы к АТС на каждое открытие формы не нужны.
    staleTime: 60_000,
  });
}

/**
 * Позвонить коллеге через АТС: сначала звонит своя трубка, потом станция соединяет
 * с сотрудником. Отдельно от звонка клиенту (useCallClient) — другой маршрут и
 * другой смысл: внутренний вызов не попадает ни в хронологию клиента, ни в Royal Score.
 */
export function useCallAgent(id: string) {
  return useMutation({
    mutationFn: () => api<{ ok: boolean; extension: string }>(`/agents/${id}/call`, { method: "POST" }),
    meta: { successText: "Звоним — снимите трубку" },
  });
}

/** Сброс 2FA сотрудника, потерявшего телефон: вход снова только по паролю.
 *  Ночной аудит 24.09.2026 (№13): раньше был голым `api(...)` в onClick —
 *  ни тоста, ни гашения списка, «ничего не произошло» было буквальным. */
export function useReset2fa() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/agents/${id}/2fa/reset`, { method: "POST" }),
    meta: { successText: "2FA сброшена" },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });
}

export function useDeleteAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/agents/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });
}

export function useUploadAgentAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) => {
      const form = new FormData();
      form.append("avatar", file);
      return api(`/agents/${id}/avatar`, { method: "POST", body: form, isForm: true });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });
}

/** Итог возврата раздачи (`POST /agents/handovers/:batchId/revert`) — то же
 *  `HandoverRevertResult` с сервера (apps/api/src/lib/agentHandoverRevert.ts). */
export interface HandoverRevertResult {
  clients: number;
  tasks: number;
  properties: number;
  /** Уже переданы другому — их не тронули. */
  skippedClients: number;
  skippedProperties: number;
  /** Учётка была отключена этой же раздачей и теперь снова включена. */
  reactivated: boolean;
}

/** Одна прошлая раздача дел сотрудника — строка `GET /agents/:id/handovers`. */
export interface AgentHandoverBatch {
  id: string;
  createdAt: string;
  clients: number;
  tasks: number;
  properties: number;
  deactivated: boolean;
  toAgentId: string | null;
  /** null — ещё не возвращена, кнопка «Вернуть всё как было» имеет смысл. */
  revertedAt: string | null;
  revertSummary: HandoverRevertResult | null;
}

/** Последние 5 раздач дел сотрудника, новые первыми — питает кнопку «Вернуть
 *  всё как было» и в карточке сотрудника, и в отчёте после самой передачи. */
export function useAgentHandovers(agentId: string, enabled = true) {
  return useQuery({
    queryKey: ["agents", agentId, "handovers"],
    queryFn: () => api<AgentHandoverBatch[]>(`/agents/${agentId}/handovers`),
    enabled: enabled && !!agentId,
    staleTime: 15_000,
  });
}

/** «Вернуть всё как было» — идёт по снимку раздачи, возвращает прежнему агенту
 *  всё, что получатели не передали дальше, и включает учётку, если её отключила
 *  та же раздача. Требует подтверждения личности — `api()` сам открывает окно
 *  пароля на 428, дополнительно делать ничего не нужно. */
export function useRevertHandover() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (batchId: string) => api<HandoverRevertResult>(`/agents/handovers/${batchId}/revert`, { method: "POST" }),
    meta: { silent: true },
    onSuccess: () => {
      // «agent-overview» — шапка карточки сотрудника (статус «деактивирован»): без
      // него подзаголовок жил бы старым, пока страницу не перезагрузят.
      for (const key of ["agents", "team", "clients", "properties", "dashboard-summary", "agent-overview", "agent-live"]) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}
