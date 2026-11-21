import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * АВТОПРОЧТЕНИЕ НЕ СНИМАЕТ «ЖДЁТ РЕШЕНИЯ» И «КРИТИЧНОЕ» (аудит WEB-PAGES16, решение
 * владельца 04.10.2026, вариант A).
 *
 * Раньше через 1,5 с после открытия ленты уходил read-all по ВСЕЙ ленте: нерешённый
 * APPROVAL (например «лид прошёл всех агентов, назначьте вручную») становился
 * прочитанным, а закреп на сервере берётся по read=false, поэтому сигнал исчезал,
 * хотя решения никто не принял. Теперь автопрочтение шлёт только id ПОКАЗАННЫХ
 * непрочитанных записей и пропускает APPROVAL/CRITICAL; ручное «Прочитано» по-прежнему
 * read-all (его хук useMarkAllNotificationsRead не менялся).
 */

const apiCalls: { path: string; body?: unknown }[] = [];
let cleanups: (() => void)[] = [];

vi.mock("react", () => ({
  useRef: <T,>(v: T) => ({ current: v }),
  // Эффект выполняется сразу, очистка запоминается: этого хватает, чтобы проверить
  // таймер автопрочтения без отрисовки.
  useEffect: (fn: () => void | (() => void)) => {
    const cleanup = fn();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  },
  useState: <T,>(v: T) => [v, () => {}],
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: () => Promise.resolve() }),
  useQuery: () => ({ data: undefined }),
  useMutation: (opts: { mutationFn: (v?: unknown) => unknown }) => ({
    isPending: false,
    mutate: (v?: unknown) => void opts.mutationFn(v),
  }),
}));
vi.mock("../../lib/api", () => ({
  api: (path: string, init?: { body?: unknown }) => {
    apiCalls.push({ path, body: init?.body });
    return Promise.resolve({ ok: true });
  },
}));
vi.mock("../../lib/aiSounds", () => ({ playNewLead: () => {}, playNewMessage: () => {}, playSoftTick: () => {} }));
vi.mock("../../lib/pultSound", () => ({ pultSoundEnvironmentAllows: () => false }));

import type { AppNotification } from "../../types";
import { badgeCountOf, pickUnseenIds, useAutoReadNotifications, useSeenOnShow } from "../useNotifications";

function n(id: string, level: AppNotification["level"], read = false): AppNotification {
  return {
    id,
    agentId: "a1",
    kind: "lead",
    level,
    title: id,
    body: "",
    url: null,
    count: 1,
    read,
    createdAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  apiCalls.length = 0;
  cleanups = [];
  vi.useFakeTimers();
});
afterEach(() => {
  cleanups.forEach((c) => c());
  vi.useRealTimers();
});

describe("useAutoReadNotifications", () => {
  it("через 1,5 с помечает только показанные обычные записи, APPROVAL и CRITICAL не трогает", () => {
    const shown = [n("info-1", "OTHER"), n("approval-1", "APPROVAL"), n("crit-1", "CRITICAL"), n("info-2", undefined)];

    useAutoReadNotifications(9, true, shown);
    vi.advanceTimersByTime(1500);

    expect(apiCalls.map((c) => c.path)).not.toContain("/me/notifications/read-all");
    expect(apiCalls).toEqual([{ path: "/me/notifications/read-many", body: { ids: ["info-1", "info-2"] } }]);
  });

  it("если показаны одни APPROVAL/CRITICAL или уже прочитанное — запроса нет вовсе", () => {
    useAutoReadNotifications(2, true, [n("approval-1", "APPROVAL"), n("crit-1", "CRITICAL"), n("done", "OTHER", true)]);
    vi.advanceTimersByTime(5000);

    expect(apiCalls).toEqual([]);
  });

  it("выключенный хук ничего не шлёт", () => {
    useAutoReadNotifications(3, false, [n("info-1", "OTHER")]);
    vi.advanceTimersByTime(5000);

    expect(apiCalls).toEqual([]);
  });
});

/**
 * ОТКРЫЛ СПИСОК — МЕТКА ГАСНЕТ СРАЗУ (владелец 21.11.2026): «просмотрено» уходит без
 * таймера и включает «Ждёт решения»/«Критичное» (они остаются в ленте, read не трогаем).
 */
describe("useSeenOnShow", () => {
  it("сразу, без ожидания, отмечает показанные непросмотренные, в том числе срочные", () => {
    useSeenOnShow([n("info-1", "OTHER"), n("approval-1", "APPROVAL"), n("crit-1", "CRITICAL")], true);

    expect(apiCalls).toEqual([
      { path: "/me/notifications/seen", body: { ids: ["info-1", "approval-1", "crit-1"] } },
    ]);
    // Прочитанность не трогаем: ни read-many, ни read-all.
    expect(apiCalls.map((c) => c.path)).not.toContain("/me/notifications/read-many");
  });

  it("уже просмотренное и прочитанное повторно не шлётся; закрытый список ничего не шлёт", () => {
    const seen = { ...n("approval-1", "APPROVAL"), seenAt: new Date().toISOString() };
    useSeenOnShow([seen, n("done", "OTHER", true)], true);
    useSeenOnShow([n("info-1", "OTHER")], false);

    expect(apiCalls).toEqual([]);
    expect(pickUnseenIds([seen])).toEqual([]);
  });
});

describe("badgeCountOf", () => {
  it("метка считает непросмотренное; ответ старого сервера без поля — прежний счёт", () => {
    expect(badgeCountOf({ unreadCount: 9, unseenCount: 0 })).toBe(0);
    expect(badgeCountOf({ unreadCount: 9 })).toBe(9);
    expect(badgeCountOf(undefined)).toBe(0);
  });
});
