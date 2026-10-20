import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  addChannelToBridge,
  answerChannel,
  createBridge,
  createExternalMediaChannel,
  deleteBridge,
} from "../src/lib/telephony/ariClient.js";

/**
 * Живой голос (пункт 5 очереди ИИ) — вызовы ARI для моста/externalMedia проверены
 * тем же приёмом, что и остальная телефония (ari-connection.test.ts): мокаем
 * fetch, проверяем, что запрос собран правильно, и что коды ошибок/сети не
 * бросают исключение наружу, а возвращают {ok:false, error}.
 */
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
afterEach(() => fetchMock.mockReset());
// Процесс общий на весь прогон (singleFork) — не снятый стаб глобального fetch
// доживал до следующих файлов и подменял им настоящую сеть (см. media-attachments.test.ts).
afterAll(() => vi.unstubAllGlobals());

const creds = { url: "http://217.11.178.238:8088", username: "royalhome", password: "secret" };

describe("createBridge", () => {
  it("POST /ari/bridges?type=mixing — возвращает id моста", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: "bridge-1" }) } as Response);
    const result = await createBridge(creds);
    expect(result).toEqual({ ok: true, bridgeId: "bridge-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://217.11.178.238:8088/ari/bridges?type=mixing",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("HTTP-отказ — {ok:false} с текстом причины, не исключение", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "boom" } as Response);
    const result = await createBridge(creds);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("500");
  });

  it("сетевой отказ — {ok:false}, не падает исключением", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await createBridge(creds);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });
});

describe("deleteBridge", () => {
  it("404 — успех (мост уже развален станцией), как у hangupCall", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 } as Response);
    expect(await deleteBridge(creds, "bridge-1")).toEqual({ ok: true });
  });

  it("успешный DELETE — ok:true", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204 } as Response);
    expect(await deleteBridge(creds, "bridge-1")).toEqual({ ok: true });
  });
});

describe("addChannelToBridge", () => {
  it("собирает channel в query", async () => {
    fetchMock.mockResolvedValue({ ok: true } as Response);
    await addChannelToBridge(creds, "bridge-1", "chan-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://217.11.178.238:8088/ari/bridges/bridge-1/addChannel?channel=chan-1",
      expect.objectContaining({ method: "POST" })
    );
  });
});

describe("createExternalMediaChannel", () => {
  it("собирает обязательные параметры slin16/rtp/udp/client/both", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: "media-1" }) } as Response);
    const result = await createExternalMediaChannel(creds, { app: "royalhome-live-voice", externalHost: "10.0.0.5:40000" });
    expect(result).toEqual({ ok: true, channelId: "media-1" });
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/ari/channels/externalMedia");
    expect(calledUrl.searchParams.get("app")).toBe("royalhome-live-voice");
    expect(calledUrl.searchParams.get("external_host")).toBe("10.0.0.5:40000");
    expect(calledUrl.searchParams.get("format")).toBe("slin16");
    expect(calledUrl.searchParams.get("encapsulation")).toBe("rtp");
    expect(calledUrl.searchParams.get("transport")).toBe("udp");
    expect(calledUrl.searchParams.get("connection_type")).toBe("client");
    expect(calledUrl.searchParams.get("direction")).toBe("both");
  });

  it("формат можно переопределить", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: "media-1" }) } as Response);
    await createExternalMediaChannel(creds, { app: "x", externalHost: "h:1", format: "ulaw" });
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get("format")).toBe("ulaw");
  });

  it("ответ без id — честная ошибка, не выдуманный channelId", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    const result = await createExternalMediaChannel(creds, { app: "x", externalHost: "h:1" });
    expect(result.ok).toBe(false);
  });
});

describe("answerChannel", () => {
  it("409 (уже отвечен) считается успехом — идемпотентно", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409 } as Response);
    expect(await answerChannel(creds, "chan-1")).toEqual({ ok: true });
  });

  it("другой отказ — {ok:false}", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "boom" } as Response);
    const result = await answerChannel(creds, "chan-1");
    expect(result.ok).toBe(false);
  });
});
