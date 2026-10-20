import type { PropertyDraftView } from "@royal-home/shared";
import { api } from "./api";
import { readAllDraftFiles } from "./draftUploadStore";
import { setDraftReminder } from "./draftReminder";
import { useAuthStore } from "../store/auth";

/**
 * ДОЗАГРУЗКА ФАЙЛОВ МАСТЕРА ПРИ СТАРТЕ ПРИЛОЖЕНИЯ (07.10.2026, владелец: «чтобы
 * ролики и фото всегда дозагружались»). Живой случай: агент заполнил карточку и
 * ушёл, видео ещё грузилось, вкладку выгрузили — файл лежал в IndexedDB
 * (lib/draftUploadStore.ts), но поднять его могло только открытие мастера
 * (hydrateDraftMedia из PropertyWizard). Теперь при входе агента приложение само
 * смотрит, нет ли его недогруженных файлов, и продолжает отдачу в фоне — без
 * открытия мастера. Сама очередь регистрируется в workGuard и видна в
 * WorkIndicator.
 *
 * `lib/draftUploads.ts` подгружается только когда файлы реально нашлись: в
 * стартовый бандл тянуть очередь со сжатием снимков ради пустой проверки
 * незачем.
 */
export function resumeDraftUploadsOnStart(): void {
  let checkedFor: { agentId: string; epoch: number } | null = null;

  const check = () => {
    const { hasSession, agent, accessToken, sessionEpoch } = useAuthStore.getState();
    if (!hasSession || !agent) {
      checkedFor = null; // вышел — при следующем входе проверим заново
      setDraftReminder(false);
      return;
    }
    // Persisted identity is available before ProtectedRoute restores the in-memory
    // access token. Wait for that store update instead of sending a certain 401.
    if (!accessToken) return;
    if (checkedFor?.agentId === agent.id && checkedFor.epoch === sessionEpoch) return;
    if (checkedFor) setDraftReminder(false);
    checkedFor = { agentId: agent.id, epoch: sessionEpoch };
    void resumeFor(agent.id, sessionEpoch);
  };

  check();
  useAuthStore.subscribe(check);
}

async function resumeFor(agentId: string, epoch: number): Promise<void> {
  const currentSession = () => {
    const state = useAuthStore.getState();
    return state.hasSession && !!state.accessToken && state.agent?.id === agentId && state.sessionEpoch === epoch;
  };
  // Серверный черновик: и для плашки-напоминания «Черновик объекта · Продолжить»
  // (lib/draftReminder.ts), и чтобы слить уже принятые файлы с недогруженными
  // (hydrateDraftMedia — слияние по uploadKey). Не ответил сервер — файлы всё
  // равно уходят: отдача идемпотентна по uploadKey, повтор дубля не даёт.
  let draft: PropertyDraftView | null = null;
  try {
    const res = await api<{ draft: PropertyDraftView | null }>("/properties/drafts/current", { expectAgentId: agentId });
    if (!currentSession()) return;
    draft = res.draft;
    // Только поднимаем: понижает флаг мастер (создание объекта, «Начать заново»).
    if (isWorthDraft(draft)) setDraftReminder(true);
  } catch {
    /* офлайн или сервер недоступен — продолжаем по локальным копиям */
    if (!currentSession()) return;
    console.warn("[draft-resume] Server draft unavailable; continuing from local files.");
  }

  try {
    const stored = await readAllDraftFiles(agentId);
    if (!currentSession()) return;
    if (stored.length === 0) return;
    setDraftReminder(true);

    // Пока читали, агент мог выйти — чужими файлами не занимаемся.
    const { hydrateDraftMedia } = await import("./draftUploads");
    if (!currentSession()) return;
    await hydrateDraftMedia(draft?.media ?? []);
  } catch {
    if (!currentSession()) return;
    // Do not log draft contents, filenames, credentials or server responses.
    console.warn("[draft-resume] Local draft recovery failed; reopen the property wizard to retry.");
  }
}

/** Черновик, о котором стоит напоминать: в нём есть файлы или хотя бы одно поле. */
export function isWorthDraft(draft: PropertyDraftView | null): boolean {
  return !!draft && (draft.media.length > 0 || Object.keys(draft.values ?? {}).length > 0);
}
