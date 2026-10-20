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
import { useAutoReadNotifications } from "../useNotifications";

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
