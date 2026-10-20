import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Role, UiPreferences } from "@royal-home/shared";
import { queryClient } from "../lib/queryClient";
import { clearPersistedQueryCache } from "../lib/queryPersist";
import { clearPendingMapPin } from "../lib/pendingMapPin";
import { clearRecentSearches } from "../lib/recentSearches";
import { clearIdleActivity } from "../lib/idleActivity";
import { LAST_DIAL_KEY } from "../lib/lastDial";
import { CLEAN_CHAT_DRAFT_KEY, chatDraftStorage } from "../lib/cleanChatDraft";
import { clearDraftsBeforeUpdate, configureDraftBeforeUpdateSession } from "../lib/draftBeforeUpdate";

function clearSessionChatDrafts() {
  try { chatDraftStorage()?.removeItem(CLEAN_CHAT_DRAFT_KEY); }
  catch { console.warn("[auth] Session chat drafts could not be cleared"); }
}

export interface AuthAgent {
  id: string;
  fullName: string;
  phone: string;
  role: Role;
  avatarUrl?: string | null;
  readOnly?: boolean;
}

/**
 * Что РЕАЛЬНО отдаёт сервер в ответах входа (см. issueSession в routes/auth.ts):
 * сам сотрудник плюс его настройки интерфейса.
 *
 * Экраны входа типизировали этот ответ как `any`, и компилятор не проверял ни
 * setSession, ни hydrateFromServer: переименуй поле на сервере или поменяй тип
 * роли — фронт молча собирался и ломался уже в браузере. Тише всего ломалась бы
 * тема: после входа она намеренно перетирает локальную («мог войти другой
 * человек — его тема должна победить»), и пропажу такого поведения замечают
 * далеко не сразу.
 */
export type SessionAgent = AuthAgent & { preferences: UiPreferences | null };

interface AuthState {
  agent: AuthAgent | null;
  accessToken: string | null;
  /** true, если сессия когда-либо была установлена — refresh-токен живёт только в HttpOnly cookie,
   * недоступной JS, поэтому здесь мы храним лишь признак "стоит попробовать /auth/refresh при старте". */
  hasSession: boolean;
  /**
   * Эпоха сессии: растёт при КАЖДОМ входе (setSession) и выходе (logout), и ни
   * при чём больше (setAccessToken/updateAgent её не двигают — это продление той
   * же сессии). Долгий запрос запоминает эпоху до отправки и сверяет по возвращении:
   * ответ, пришедший уже в чужую сессию (А вышел, вошёл Б), нельзя писать в стор
   * (аудит 04.10.2026, №1). В localStorage не сохраняется: после перезагрузки все
   * прежние запросы всё равно мертвы.
   */
  sessionEpoch: number;
  setSession: (agent: AuthAgent, accessToken: string) => void;
  setAccessToken: (accessToken: string) => void;
  updateAgent: (patch: Partial<AuthAgent>) => void;
  logout: () => void;
}

/**
 * Кэш API-ответов service worker (sw.ts, NetworkFirst «api-cache») ключуется только
 * адресом — Authorization в ключ не входит, и NetworkFirst отдаёт кэш не только
 * офлайн, но и при ответе дольше 4 секунд. Без чистки следующий вошедший на этом
 * устройстве сотрудник на медленной связи получал бы закэшированные ответы
 * предыдущего (/dashboard с финансами, /clients) в обход системы прав (26.08.2026).
 * Best-effort: caches может отсутствовать (старый браузер, http) — тогда и SW с его
 * кэшем нет.
 */
function dropSwApiCache(): void {
  try {
    void caches?.delete("api-cache");
  } catch {
    /* кэша нет — чистить нечего */
  }
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      agent: null,
      accessToken: null,
      hasSession: false,
      sessionEpoch: 0,
      setSession: (agent, accessToken) => {
        clearRecentSearches(get().agent?.id);
        clearIdleActivity(get().agent?.id);
        clearIdleActivity(agent.id);
        clearDraftsBeforeUpdate();
        clearSessionChatDrafts();
        // Drops any cached queries (e.g. GET /me) left over from a previous
        // agent's session on this browser tab — otherwise a login right after
        // a logout can briefly show the old agent's cached profile/data.
        queryClient.clear();
        dropSwApiCache();
        // Персистер (queryPersist.ts, perf/web-instant-11-09): снимок на диске
        // переживает вкладку, поэтому и его надо стереть при смене пользователя,
        // иначе новый агент на этом устройстве может дождаться восстановления
        // чужого снимка, если queryClient.clear() не успеет обогнать первый рендер.
        void clearPersistedQueryCache();
        clearPendingMapPin();
        set((s) => ({ agent, accessToken, hasSession: true, sessionEpoch: s.sessionEpoch + 1 }));
      },
      setAccessToken: (accessToken) => set({ accessToken }),
      /**
       * Догрузка полей уже известного сотрудника. Если локально агента нет
       * вовсе (localStorage почистился сам — обычное дело в iOS-браузерах и в
       * установленном приложении), а с сервера пришла ПОЛНАЯ личность, берём
       * её: иначе шапка остаётся пустой до перезагрузки страницы. Полноту
       * определяем по id — частичный патч (`{ avatarUrl }`) агентом не станет.
       */
      updateAgent: (patch) =>
        set((s) => {
          if (s.agent) return { agent: { ...s.agent, ...patch } };
          return patch.id ? { agent: patch as AuthAgent } : { agent: s.agent };
        }),
      logout: () => {
        clearRecentSearches(get().agent?.id);
        clearIdleActivity(get().agent?.id);
        clearDraftsBeforeUpdate();
        clearSessionChatDrafts();
        queryClient.clear();
        dropSwApiCache();
        void clearPersistedQueryCache();
        // Точка с долгого тапа на карте живёт во вкладке: без чистки следующий
        // вошедший на этом же устройстве получил бы чужую координату в мастере.
        clearPendingMapPin();
        // Последний набранный номер (lib/lastDial.ts, пишет DialPad.tsx) — та же ловушка общего
        // телефона: без чистки трубка на пустом поле подставляла бы номер
        // предыдущего сотрудника (ночная проверка 24.09.2026, находка №14).
        try {
          localStorage.removeItem(LAST_DIAL_KEY);
        } catch {
          /* localStorage недоступен (приватная вкладка и т.п.) — чистить нечего */
        }
        set((s) => ({ agent: null, accessToken: null, hasSession: false, sessionEpoch: s.sessionEpoch + 1 }));
      },
    }),
    {
      name: "royal-home-auth",
      version: 1,
      partialize: (s) => ({ agent: s.agent, hasSession: s.hasSession }),
      // v0 хранил refreshToken в localStorage напрямую — переносим наличие сессии в hasSession
      // и больше не доверяем токенам из старой схемы (они не переживут переход на HttpOnly cookie).
      migrate: (persisted: any) => ({
        agent: persisted?.agent ?? null,
        hasSession: !!(persisted?.agent && (persisted?.refreshToken || persisted?.hasSession)),
      }),
    }
  )
);

configureDraftBeforeUpdateSession(() => {
  const state = useAuthStore.getState();
  return { actorId: state.agent?.id, epoch: state.sessionEpoch };
});
