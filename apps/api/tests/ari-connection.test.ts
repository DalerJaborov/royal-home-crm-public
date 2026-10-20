import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { testAriConnection } from "../src/lib/telephony/ariClient.js";
import { prisma } from "../src/db.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * Этап 4 (телефония): проверка связи с Asterisk ARI (GET /ari/asterisk/info).
 * Стережёт три исхода, которые интерфейс должен отличать друг от друга —
 * «верно», «неверный пароль» и «сервер недоступен» — а не одно общее «ошибка».
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => fetchMock.mockReset());
// Процесс общий на весь прогон (singleFork) — не снятый стаб глобального fetch
// доживал до следующих файлов и подменял им настоящую сеть (см. media-attachments.test.ts).
afterAll(() => vi.unstubAllGlobals());

const creds = { url: "http://217.11.178.238:8088", username: "royalhome", password: "secret" };

describe("testAriConnection", () => {
  it("верные креды — ok и версия Asterisk", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ system: { version: "20.6.0" } }),
    } as Response);
    const result = await testAriConnection(creds);
    expect(result).toEqual({ ok: true, version: "20.6.0" });
  });

  it("неверный пароль — понятная причина, не голый HTTP-код", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as Response);
    const result = await testAriConnection(creds);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Неверный логин или пароль");
  });

  it("сервер недоступен — сетевая ошибка не падает исключением наружу", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const result = await testAriConnection(creds);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  /**
   * 22.09.2026: раньше отказ станции возвращался только вызывающему ({ok:false}),
   * а сам модуль ariClient.ts не писал в журнал ошибок ни разу — связь со
   * станцией отваливалась молча для «Здоровья системы». Поведение (result.error
   * с текстом сетевой ошибки) не меняется — проверяем, что теперь рядом
   * появляется читаемая запись в журнале.
   */
  it("сервер недоступен — отказ попадает в журнал понятной причиной", async () => {
    // Маркер уникален на каждый прогон: десятиминутная дедупликация
    // logSystemError (см. lib/systemError.ts) иначе схлопывает повторный
    // локальный прогон этого теста с записью от прошлого прогона — тест
    // должен стеречь «пишет в журнал», а не гоняться с собственным дедупом
    // (поймано 22.09.2026).
    const marker = randomUUID();
    fetchMock.mockRejectedValue(new Error(`connect ECONNREFUSED 217.11.178.238:8088 (${marker})`));

    const result = await testAriConnection(creds);
    expect(result.ok).toBe(false);

    const row = await waitFor(
      () =>
        prisma.errorLog.findFirst({
          where: { source: "telephony", message: { contains: marker } },
          orderBy: { createdAt: "desc" },
        }),
      { label: "запись об отказе проверки связи ARI в журнале" }
    );
    expect(row?.message).toContain("проверка связи");
    expect(row?.message).toContain("ECONNREFUSED");
  });

  it("отправляет Basic-авторизацию на правильный URL", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ system: {} }) } as Response);
    await testAriConnection(creds);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://217.11.178.238:8088/ari/asterisk/info",
      expect.objectContaining({
        headers: { Authorization: `Basic ${Buffer.from("royalhome:secret").toString("base64")}` },
      })
    );
  });
});
