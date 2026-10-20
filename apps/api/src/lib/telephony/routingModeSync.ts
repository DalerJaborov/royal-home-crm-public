import { prisma } from "../../db.js";
import { logSystemError } from "../systemError.js";
import { amiDbGet, amiDbPut, loadAmiCredentials, type AmiCredentials } from "./amiClient.js";

/**
 * РЕЖИМ МАРШРУТИЗАЦИИ НЕЗНАКОМЫХ ЗВОНКОВ — заготовка на будущее (владелец 20.08.2026).
 *
 * Тот же приём, что у failoverSync.ts («если оператор не ответил»): CRM не
 * переписывает диалплан станции, а кладёт ЗНАЧЕНИЕ в её внутреннюю базу (AstDB),
 * которое диалплан МОЖЕТ прочитать. Разница с failoverSync — сейчас на станции
 * нет диалплана, который бы это значение читал вовсе: очередь по KPI, отдельный
 * оператор и голосовое меню требуют работы на самой FreePBX, которую делает
 * владелец (см. ROUTE_CONTEXT в inboundRouting.ts — правки /etc/asterisk не моя
 * дверь). «Веерный вызов всем агентам» сюда нарочно не входит: предложен и в
 * тот же день отменён владельцем 20.08.2026 — агенты путают такой звонок со
 * своим собственным клиентом, см. ChannelsTab.tsx (ROUTING_MODES).
 *
 * Синхронизация всё равно нужна уже сейчас: когда диалплан для одного из режимов
 * появится, он должен читать актуальное намерение CRM без ещё одного релиза.
 * Молчаливое бездействие («режим просто лежит в Settings, ничего никуда не
 * едет») означало бы, что переключатель в интерфейсе врёт о своей готовности.
 */

/** Семейство в AstDB. */
export const ROUTING_MODE_FAMILY = "ROYALHOME/routing";
const ROUTING_MODE_KEY = "mode";

/** Единственное значение, которое реально исполняет станция сегодня. */
export const DEFAULT_ROUTING_MODE = "assigned_then_forward";

export async function loadRoutingMode(): Promise<string> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { incomingRoutingMode: true },
  });
  return settings?.incomingRoutingMode || DEFAULT_ROUTING_MODE;
}

/** Переложить режим в станцию. Возвращает причину отказа, а не бросает — как у syncFailoverToStation. */
export async function syncRoutingModeToStation(
  creds?: AmiCredentials | null
): Promise<{ ok: true; mode: string } | { ok: false; error: string }> {
  const credentials = creds ?? (await loadAmiCredentials());
  if (!credentials) return { ok: false, error: "Управление станцией не настроено (Настройки → Каналы связи → AMI)" };

  const mode = await loadRoutingMode();
  const result = await amiDbPut(credentials, ROUTING_MODE_FAMILY, ROUTING_MODE_KEY, mode);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, mode };
}

/** Что станция считает действующим прямо сейчас — для сверки при переподключении. */
export async function readRoutingModeFromStation(
  creds?: AmiCredentials | null
): Promise<{ ok: true; mode: string } | { ok: false; error: string }> {
  const credentials = creds ?? (await loadAmiCredentials());
  if (!credentials) return { ok: false, error: "Управление станцией не настроено" };

  const result = await amiDbGet(credentials, ROUTING_MODE_FAMILY, ROUTING_MODE_KEY);
  if (!result.ok) return result;
  // Пусто в базе станции = ещё не синхронизировали. Честное умолчание, не ошибка.
  return { ok: true, mode: result.value || DEFAULT_ROUTING_MODE };
}

/**
 * Синхронизация «вдогонку» — из сохранения настроек. Молчит, когда режим и так
 * умолчальный (переводить нечего, а без AMI шум был бы про возможность, которую
 * ещё не настраивали) — тот же принцип, что у syncFailoverInBackground.
 */
export function syncRoutingModeInBackground(): void {
  void (async () => {
    const creds = await loadAmiCredentials();
    if (!creds) return;
    const result = await syncRoutingModeToStation(creds);
    if (result.ok) return;
    const mode = await loadRoutingMode();
    if (mode === DEFAULT_ROUTING_MODE) {
      console.warn(`[телефония] режим маршрутизации не записался (действует умолчание): ${result.error}`);
      return;
    }
    void logSystemError("telephony", `Режим маршрутизации незнакомых звонков не доехал до станции: ${result.error}`);
  })();
}

/** Сверка при восстановлении связи со станцией — тот же повод, что у reconcileFailoverOnReconnect. */
export async function reconcileRoutingModeOnReconnect(): Promise<void> {
  try {
    const credentials = await loadAmiCredentials();
    if (!credentials) return;

    const desired = await loadRoutingMode();
    const actual = await readRoutingModeFromStation(credentials);

    if (!actual.ok) {
      const written = await syncRoutingModeToStation(credentials);
      if (!written.ok && desired !== DEFAULT_ROUTING_MODE) {
        void logSystemError("telephony", `Режим маршрутизации не доехал до станции: ${written.error}`);
      }
      return;
    }

    if (actual.mode === desired) return;

    const written = await syncRoutingModeToStation(credentials);
    console.log(
      written.ok
        ? `[телефония] режим маршрутизации разошёлся со станцией и дописан: ${desired}`
        : `[телефония] режим маршрутизации разошёлся со станцией, записать не удалось: ${written.error}`
    );
    if (!written.ok && desired !== DEFAULT_ROUTING_MODE) {
      void logSystemError("telephony", `Режим маршрутизации разошёлся со станцией и не дописался: ${written.error}`);
    }
  } catch (err) {
    console.error("[телефония] сверка режима маршрутизации не удалась:", err instanceof Error ? err.message : err);
    void logSystemError(
      "telephony",
      `Сверка режима маршрутизации со станцией не удалась: ${err instanceof Error ? err.message : err}`
    );
  }
}
