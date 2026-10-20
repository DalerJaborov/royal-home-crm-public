import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  LOOK_IDS,
  migrateLegacyTheme,
  type LookId,
  type ThemeId,
  type UiPreferences,
} from "@royal-home/shared";
import { api } from "../lib/api";
import { useAuthStore } from "./auth";
import { DEFAULT_THEME, THEMES, initialDeviceTheme } from "../lib/themes";
import { queryClient } from "../lib/queryClient";
import type { MyProfile } from "../lib/meProfile";
import { readCleanNavigationOrder } from "../lib/cleanNavigationPreference";

/** Идентификаторы виджетов дашборда, доступных к скрытию (Dashboard.tsx). */
export const DASHBOARD_WIDGETS = [
  { id: "kpis", label: "Показатели (KPI)" },
  { id: "myLeads", label: "Мои лиды" },
  { id: "commission", label: "График комиссии" },
  { id: "properties", label: "Объекты" },
  { id: "funnel", label: "Воронка" },
  { id: "map", label: "Карта объектов" },
  { id: "districts", label: "Объекты по районам" },
  { id: "propertiesTrend", label: "Динамика объектов" },
  { id: "today", label: "Задачи на сегодня" },
  { id: "sources", label: "Источники лидов" },
  { id: "heatmap", label: "Тепловая карта обращений" },
  { id: "pulse", label: "Пульс команды" },
  { id: "team", label: "Команда · сейчас" },
  { id: "unaccepted", label: "Непринятые заявки" },
  { id: "insights", label: "ИИ-инсайты" },
  { id: "activity", label: "Активность команды" },
] as const;

export type DashboardWidgetId = (typeof DASHBOARD_WIDGETS)[number]["id"];

interface UiPrefsValues {
  theme: ThemeId;
  /** Облик — компоновка экрана. Независим от темы: тема меняет цвета, облик — саму раскладку. */
  look: LookId;
  aurora: boolean;
  glass: boolean;
  dashboardHidden: string[];
  desktopNavigationOrder: string[];
  navigationOwnerId: string | null;
  /** Автовыход при неактивности, минуты; null — «никогда». Применяет useIdleLogout. */
  autoLogoutMinutes: number | null;
  /** Идентификаторы разово скрытых подсказок/баннеров (например, промо живой темы). */
  dismissedHints: string[];
  /** Звуки уведомлений (новый лид/сообщение/звонок/сохранение/ошибка) — только локальное
   *  устройство, не синкается в БД (как sidebarCollapsed): личная привычка конкретного
   *  компьютера/наушников. */
  aiSoundsEnabled: boolean;
  /** Момент (Date.now()) последнего локального изменения синкуемых полей.
   *  Персистится, чтобы пережить перезагрузку страницы. */
  updatedAt: number;
  /** Момент (Date.now()) последнего ПОДТВЕРЖДЁННОГО сервером сохранения (успешный PUT
   *  или гидратация из /me). Пока updatedAt > syncedAt — есть локальные изменения,
   *  которые ещё не долетели до БД (в очереди/ретрае/сети нет), и hydrateFromServer
   *  не имеет права их перетереть. */
  syncedAt: number;
}

interface UiPrefsState extends UiPrefsValues {
  /** true после применения серверных настроек в этой сессии — чтобы /me не перетирал свежий локальный выбор. */
  serverHydrated: boolean;
  saveDesktopNavigationOrder: (order: string[]) => Promise<void>;
  setTheme: (theme: ThemeId) => void;
  setLook: (look: LookId) => void;
  setAurora: (on: boolean) => void;
  setGlass: (on: boolean) => void;
  setAutoLogoutMinutes: (minutes: number | null) => void;
  setAiSoundsEnabled: (on: boolean) => void;
  toggleDashboardWidget: (id: string) => void;
  dismissHint: (id: string) => void;
  /** Применить настройки из БД. force — при логине (мог войти другой пользователь). */
  hydrateFromServer: (prefs: UiPreferences | null | undefined, force?: boolean) => void;
  /** Свернут ли сайдбар в узкую панель с иконками — только локальное устройство, в БД не синкается. */
  sidebarCollapsed: boolean;
  toggleSidebarCollapsed: () => void;
}

/** Стекло — красиво, но не бесплатно: на слабом железе (мало ядер) или когда
 * ОС просит меньше прозрачности (`prefers-reduced-transparency`), включать
 * его по умолчанию не стоит — владелец сам включит в Профиль → Оформление,
 * если понравится. Считается один раз при загрузке модуля: смена ядер/ОС
 * посреди сессии не бывает, а вычислять на каждый рендер незачем. */
function computeDefaultGlass(): boolean {
  if (typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number" && navigator.hardwareConcurrency <= 4) {
    return false;
  }
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    try {
      if (window.matchMedia("(prefers-reduced-transparency: reduce)").matches) return false;
    } catch {
      // Старые браузеры не знают этот медиа-запрос — считаем, что прозрачность не запрещена.
    }
  }
  return true;
}

const DEFAULT_PREFS: UiPrefsValues = {
  theme: initialDeviceTheme(),
  // Классический по умолчанию: смена облика — осознанный выбор сотрудника,
  // а не сюрприз после обновления.
  look: "classic",
  aurora: true,
  glass: computeDefaultGlass(),
  dashboardHidden: [],
  desktopNavigationOrder: [],
  navigationOwnerId: null,
  autoLogoutMinutes: null,
  dismissedHints: [],
  aiSoundsEnabled: true,
  updatedAt: 0,
  syncedAt: 0,
};

/** Тема и эффекты живут на <html>: data-theme + классы fx-no-* (см. index.css).
 * Тот же контракт продублирован в инлайн-скрипте index.html (анти-FOUC) — менять синхронно. */
function applyToDom(state: UiPrefsValues) {
  if (typeof document === "undefined") return; // юнит-тесты стора (environment: "node")
  const el = document.documentElement;
  el.dataset.theme = state.theme;
  el.dataset.look = state.look;
  el.classList.toggle("fx-no-aurora", !state.aurora);
  el.classList.toggle("fx-no-glass", !state.glass);
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const themeMeta = THEMES.find((t) => t.id === state.theme);
  if (meta && themeMeta) meta.content = themeMeta.metaColor;
}

/** Настройки сохраняются в БД целиком, с дебаунсом — быстрые переключения не бомбят API.
 * Запись привязана к сессии на момент планирования: если пользователь вышел или вошёл
 * другой, отложенный/повторный PUT молча отменяется — чужой аккаунт не получит наши
 * настройки. Сеть ненадёжна (429/500/обрыв): до 3 попыток с экспоненциальной задержкой
 * (1с/2с/4с). На каждый вызов берётся САМОЕ СВЕЖЕЕ состояние на момент отправки (а не
 * снимок на момент планирования) — «последнее значение побеждает», даже если пользователь
 * переключил тему ещё раз, пока предыдущая попытка ждала повтора. */
let syncTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let syncRequestSequence = 0;
let lastAcknowledgedRequest = 0;
// PUT replaces the whole document: serialize writes so an older request cannot land last.
let syncTail: Promise<void> = Promise.resolve();

function buildPrefsBody(state: UiPrefsValues): UiPreferences {
  return {
    theme: state.theme,
    look: state.look,
    effects: { aurora: state.aurora, glass: state.glass },
    dashboard: { hidden: [...state.dashboardHidden] },
    ...(state.navigationOwnerId === useAuthStore.getState().agent?.id
      ? { navigation: { desktopOrder: [...state.desktopNavigationOrder] } }
      : {}),
    security: { autoLogoutMinutes: state.autoLogoutMinutes },
    dismissedHints: [...state.dismissedHints],
  };
}

function ownsSession(agentId: string, sessionEpoch: number): boolean {
  const auth = useAuthStore.getState();
  return auth.agent?.id === agentId && auth.sessionEpoch === sessionEpoch;
}

function persistPreferences(agentId: string, sessionEpoch: number, snapshot: () => { preferences: UiPreferences; changedAt: number }, afterAck?: () => void): Promise<void> {
  const request = syncTail.then(async () => {
    if (!ownsSession(agentId, sessionEpoch)) throw new Error("Сессия сменилась. Войдите снова.");
    let { preferences, changedAt } = snapshot();
    if (!afterAck) {
      // A theme change before this actor's /me arrives must preserve their
      // server navigation, never upload another actor's order or an empty one.
      const profile = await api<MyProfile>("/me", { expectAgentId: agentId });
      if (!ownsSession(agentId, sessionEpoch)) throw new Error("Сессия сменилась. Войдите снова.");
      ({ preferences, changedAt } = snapshot());
      preferences = { ...preferences, navigation: profile.preferences?.navigation ?? { desktopOrder: [] } };
    }
    const requestSequence = ++syncRequestSequence;
    await api("/me/preferences", { method: "PUT", body: preferences, expectAgentId: agentId });
    if (!ownsSession(agentId, sessionEpoch)) throw new Error("Сессия сменилась. Войдите снова.");
    if (requestSequence < lastAcknowledgedRequest) throw new Error("Нарушен порядок сохранения настроек. Повторите изменение.");
    lastAcknowledgedRequest = requestSequence;
    afterAck?.();
    queryClient.setQueryData<MyProfile>(["me"], (profile) =>
      profile?.id === agentId ? { ...profile, preferences } : profile
    );
    if (useUiPrefs.getState().syncedAt < changedAt) {
      useUiPrefs.setState((state) => state.updatedAt <= changedAt ? { syncedAt: changedAt } : state);
    }
  });
  // A failed write must not poison later explicit retries or another account's queue.
  syncTail = request.then(() => undefined, () => undefined);
  return request;
}

function attemptSync(agentId: string, sessionEpoch: number, attempt: number) {
  if (!ownsSession(agentId, sessionEpoch)) return;
  void persistPreferences(agentId, sessionEpoch, () => {
    const state = useUiPrefs.getState();
    return { preferences: buildPrefsBody(state), changedAt: state.updatedAt };
  }).catch(async (error: unknown) => {
    if (!ownsSession(agentId, sessionEpoch)) return;
    const readOnly = error instanceof Error && "data" in error && (error.data as { code?: string } | undefined)?.code === "READ_ONLY_ROLE";
    if (readOnly || attempt >= 3) {
      const { useToastStore } = await import("./toast");
      if (ownsSession(agentId, sessionEpoch)) useToastStore.getState().show(readOnly
        ? "Режим просмотра: настройки изменены только на этом устройстве, серверная запись запрещена."
        : "Настройки не сохранены на сервере. Локальные изменения действуют до следующего входа; повторите при восстановлении связи.", "error");
      return;
    }
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => attemptSync(agentId, sessionEpoch, attempt + 1), 1000 * 2 ** attempt);
  });
}

function syncToServer() {
  clearTimeout(syncTimer);
  clearTimeout(retryTimer);
  const { agent, sessionEpoch } = useAuthStore.getState();
  const agentId = agent?.id;
  if (!agentId) return;
  syncTimer = setTimeout(() => {
    if (!ownsSession(agentId, sessionEpoch)) return;
    attemptSync(agentId, sessionEpoch, 0);
  }, 600);
}

export const useUiPrefs = create<UiPrefsState>()(
  persist(
    (set, get) => {
      /** Единый путь изменения: состояние → DOM → отложенная запись в БД. */
      const commit = (patch: Partial<UiPrefsValues>) => {
        set({ ...patch, updatedAt: Math.max(Date.now(), get().updatedAt + 1) });
        applyToDom(get());
        syncToServer();
      };

      return {
        ...DEFAULT_PREFS,
        serverHydrated: false,
        sidebarCollapsed: false,

        saveDesktopNavigationOrder: async (value) => {
          const { agent, sessionEpoch } = useAuthStore.getState();
          if (!agent) throw new Error("Войдите в CRM, чтобы сохранить порядок.");
          if (!get().serverHydrated) throw new Error("Личные настройки ещё загружаются. Попробуйте через несколько секунд.");
          const order = readCleanNavigationOrder(value);
          // Draft stays in the sheet. Apply only after the actual PUT succeeds.
          let changedAt = 0;
          await persistPreferences(agent.id, sessionEpoch, () => {
            const state = get();
            changedAt = state.updatedAt;
            return { preferences: { ...buildPrefsBody(state), navigation: { desktopOrder: order } }, changedAt };
          }, () => set((state) => {
            const acknowledgedAt = Math.max(Date.now(), changedAt + 1);
            return {
              desktopNavigationOrder: [...order], navigationOwnerId: agent.id,
              serverHydrated: true,
              ...(state.updatedAt === changedAt ? { updatedAt: acknowledgedAt, syncedAt: acknowledgedAt } : {}),
            };
          }));
        },
        setTheme: (theme) => commit({ theme }),
        setLook: (look) => commit({ look }),
        setAurora: (aurora) => commit({ aurora }),
        setGlass: (glass) => commit({ glass }),
        setAutoLogoutMinutes: (autoLogoutMinutes) => commit({ autoLogoutMinutes }),
        // Локальная привычка устройства, не БД — как sidebarCollapsed, обычный set().
        setAiSoundsEnabled: (aiSoundsEnabled) => set({ aiSoundsEnabled }),
        toggleSidebarCollapsed: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
        toggleDashboardWidget: (id) => {
          const hidden = get().dashboardHidden;
          commit({ dashboardHidden: hidden.includes(id) ? hidden.filter((w) => w !== id) : [...hidden, id] });
        },
        dismissHint: (id) => {
          const hints = get().dismissedHints;
          if (hints.includes(id)) return;
          commit({ dismissedHints: [...hints, id] });
        },

        hydrateFromServer: (prefs, force = false) => {
          const actorId = useAuthStore.getState().agent?.id ?? null;
          if (force || !get().serverHydrated || get().navigationOwnerId !== actorId) {
            set({ desktopNavigationOrder: readCleanNavigationOrder(prefs?.navigation?.desktopOrder), navigationOwnerId: actorId });
          }
          if (get().serverHydrated && !force) return;
          // A late initial /me may arrive inside the theme-change debounce.
          // Keep the unsynced choice and schedule its PUT for this account/epoch.
          // Rescheduling also restores the queue lost during a full page reload.
          const localWins = !force && get().updatedAt > get().syncedAt;
          if (localWins) {
            set({ serverHydrated: true });
            applyToDom(get());
            syncToServer();
            return;
          }
          // Хвост дебаунса/ретрая прошлой сессии не должен уехать под новым токеном.
          clearTimeout(syncTimer);
          clearTimeout(retryTimer);
          if (!prefs) {
            // В БД пусто. При логине (force) сбрасываем к дефолтам: локальный выбор мог
            // принадлежать предыдущему пользователю этого устройства. На сервер ничего
            // не пишем — настройки сохранятся при первом осознанном изменении.
            if (force) set({ ...DEFAULT_PREFS, navigationOwnerId: actorId, serverHydrated: true, syncedAt: Date.now() });
            else set({ serverHydrated: true });
            applyToDom(get());
            return;
          }
          set({
            serverHydrated: true,
            // Слой 4 (08.09.2026): GET /me отдаёт preferences сырыми из БД (без
            // Zod-схемы), запись может ещё хранить один из шести удалённых id темы,
            // если backfill (migrate-theme-2026.ts) на этом окружении ещё не
            // прогнан — разворачиваем через migrateLegacyTheme, а не оставляем
            // клиента с undefined-темой.
            theme: prefs.theme ? migrateLegacyTheme(prefs.theme) : get().theme,
            look: prefs.look && LOOK_IDS.includes(prefs.look) ? prefs.look : get().look,
            aurora: prefs.effects?.aurora ?? get().aurora,
            glass: prefs.effects?.glass ?? get().glass,
            dashboardHidden: prefs.dashboard?.hidden ?? get().dashboardHidden,
            /**
             * АВТОВЫХОД БЕРЁТСЯ ТОЛЬКО С СЕРВЕРА (19.09.2026).
             *
             * Здесь стояло `?? get().autoLogoutMinutes`, и это была утечка
             * настройки между сотрудниками. Хранилище `royal-home-ui` общее на
             * браузер и переживает выход, а «никогда» (значение по умолчанию)
             * приезжает с сервера как ОТСУТСТВУЮЩЕЕ поле — то есть сервер
             * физически не мог сказать «у этого человека автовыхода нет»,
             * `??` всегда откатывался на то, что лежит в браузере. На общем
             * офисном компьютере достаточно было один раз выставить себе
             * «выходить через 5 минут», чтобы КАЖДЫЙ следующий вошедший здесь
             * молча выкидывался из CRM посреди работы, не имея такой настройки
             * у себя в профиле (жалоба владельца 19.09.2026 — «сотрудника
             * само по себе выбрасывает»).
             *
             * Остальные поля рядом трогать незачем: они про оформление, их
             * наследование от прошлого входа безвредно и осознанно.
             */
            autoLogoutMinutes: prefs.security?.autoLogoutMinutes ?? DEFAULT_PREFS.autoLogoutMinutes,
            dismissedHints: prefs.dismissedHints ?? get().dismissedHints,
            syncedAt: Date.now(),
            updatedAt: Date.now(),
          });
          applyToDom(get());
        },
      };
    },
    {
      name: "royal-home-ui",
      version: 1,
      partialize: (s) => ({
        theme: s.theme,
        look: s.look,
        aurora: s.aurora,
        glass: s.glass,
        dashboardHidden: s.dashboardHidden,
        desktopNavigationOrder: s.desktopNavigationOrder,
        navigationOwnerId: s.navigationOwnerId,
        autoLogoutMinutes: s.autoLogoutMinutes,
        dismissedHints: s.dismissedHints,
        sidebarCollapsed: s.sidebarCollapsed,
        aiSoundsEnabled: s.aiSoundsEnabled,
        updatedAt: s.updatedAt,
        syncedAt: s.syncedAt,
      }),
      // После восстановления из localStorage сразу применяем к DOM — инлайн-скрипт в
      // index.html уже сделал это до первой отрисовки, здесь синхронизируем на случай миграций.
      onRehydrateStorage: () => (state) => {
        if (state) applyToDom(state);
      },
    }
  )
);

/** Текущая тема, одним хуком — вместо чтения `useUiPrefs((s) => s.theme)` по месту.
 * Заведён в слое 3 миграции темы «Royal Home 2026» для `navigation.ts`
 * (ветвление `isRH2026` внутри `useNavigation()`, docs/pult/theme-2026/layer-3-plan.md §1.1):
 * несколько мест кода (навигация, `MissionControl.tsx`) должны узнавать тему одним
 * и тем же способом, а не заново решать, как её прочитать. */
export function useThemeId(): ThemeId {
  return useUiPrefs((s) => s.theme);
}
