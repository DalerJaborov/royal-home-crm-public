import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { FunctionStatusResponse } from "@royal-home/shared";

/**
 * «Состояние функций» (14.11.2026): экран директора показывает причину выключения простыми словами,
 * цветную плашку состояния, последний запуск фоновой задачи; рядовому сотруднику — только заглушка,
 * запрос данных не включается.
 */
const DATA: FunctionStatusResponse = {
  generatedAt: "2026-11-14T09:00:00.000Z",
  summary: { working: 0, preview: 0, off: 1, attention: 1 },
  items: [
    {
      key: "bot-photos",
      title: "Фото объектов в чате",
      what: "Бот присылает клиенту фотографии объекта.",
      group: "bot",
      state: "off",
      reason: "Тумблер включён, но сервер не разрешает: переменная X_MODE на сервере не задана.",
      detail: null,
      attention: true,
      envNames: ["X_MODE"],
      settingsTab: "bot",
      crons: [{ name: "bot-pause-watch", lastRunAt: "2026-11-14T08:00:00.000Z", lastOkAt: "2026-11-14T08:00:00.000Z", lastError: null, health: "ok" }],
      lastError: null,
    },
  ],
  crons: [],
};

let role = "DIRECTOR";
const enabledSeen: boolean[] = [];
// Признак «Нового вида» читает /ui-shell через react-query; здесь проверяется прежний вид
// (новый — components/look/admin/AdminScreens.test.tsx).
vi.mock("../../../hooks/useRoyalLook", () => ({ useRoyalLook: () => false }));
vi.mock("../../../store/auth", () => ({ useAuthStore: (sel: (s: { agent: { role: string } }) => unknown) => sel({ agent: { role } }) }));
vi.mock("../../../hooks/useFunctionStatus", () => ({
  useFunctionStatus: (enabled: boolean) => {
    enabledSeen.push(enabled);
    return { data: enabled ? DATA : undefined, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };
  },
}));

const { FunctionStatus } = await import("../FunctionStatus");

const html = () => renderToString(<MemoryRouter><FunctionStatus /></MemoryRouter>).replace(/<!-- -->/g, "");

describe("экран «Состояние функций»", () => {
  it("директор видит состояние, причину, имя переменной, ссылку на вкладку и последний запуск", () => {
    role = "DIRECTOR";
    const out = html();
    expect(out).toContain("Фото объектов в чате");
    expect(out).toContain("Выключено");
    expect(out).toContain("Обратите внимание");
    expect(out).toContain("сервер не разрешает");
    expect(out).toContain("X_MODE");
    expect(out).toContain("/settings?tab=bot");
    expect(out).toContain("в порядке");
  });

  it("сбой: по-человечески от сервера, сырой текст и имена — только в «Для разработчика» (К17)", () => {
    role = "DIRECTOR";
    const item = DATA.items[0]!;
    const saved = { lastError: item.lastError, crons: item.crons };
    item.lastError = { at: "2026-11-14T08:00:00.000Z", message: "Gemini 429 RESOURCE_EXHAUSTED: quota exceeded", humanMessage: "Кончился лимит Gemini — подождите или пополните счёт." };
    item.crons = [{ name: "bot-pause-watch", lastRunAt: null, lastOkAt: null, lastError: "fetch failed UND_ERR_CONNECT_TIMEOUT (api.telegram.org)", humanError: "Telegram не отвечает — проверьте позже.", health: "failing" }];
    try {
      const out = html();
      expect(out).toContain("Кончился лимит Gemini");
      expect(out).toContain("Telegram не отвечает — проверьте позже.");
      expect(out).toContain("Для разработчика");
      // сырой текст есть, но только внутри свёрнутого блока
      const outside = out.replace(/<details[\s\S]*?<\/details>/g, "");
      expect(outside).not.toContain("RESOURCE_EXHAUSTED");
      expect(outside).not.toContain("UND_ERR");
      expect(outside).not.toContain("bot-pause-watch");
    } finally {
      item.lastError = saved.lastError;
      item.crons = saved.crons;
    }
  });

  it("сотрудник без прав видит заглушку и не запрашивает данные", () => {
    role = "AGENT";
    enabledSeen.length = 0;
    const out = html();
    expect(out).toContain("только директору и администратору");
    expect(out).not.toContain("Фото объектов в чате");
    expect(enabledSeen).toEqual([false]);
  });
});
