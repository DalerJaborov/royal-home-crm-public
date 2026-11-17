import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DNS REBINDING (аудит безопасности 17.11.2026, часть 2, S2).
 *
 * Было: assertPublicUrl спрашивал DNS и проверял адрес, а fetch потом спрашивал
 * DNS ЗАНОВО сам. Имя с TTL 0 отвечает публичным адресом на первый вопрос и
 * 127.0.0.1 на второй — и сервер CRM шёл внутрь своей сети за клиента.
 *
 * Проверка: первый ответ резолвера — публичный адрес, все следующие — петля, где
 * слушает наш сервер-приманка. safeFetch обязан отказать, а приманка — не
 * получить ни одного запроса. Без привязки адреса к соединению запрос доходит
 * (fetch резолвит `localhost` сам и попадает в приманку) — тест красный.
 */

let lookupCalls = 0;
vi.mock("node:dns/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:dns/promises")>();
  const lookup = async () => {
    lookupCalls += 1;
    return lookupCalls === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }];
  };
  return { ...real, lookup, default: { ...real, lookup } };
});

const { safeFetch, assertPublicUrl, UnsafeUrlError } = await import("../src/lib/safeFetch.js");

let hits = 0;
let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>внутренний сервис</title>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  lookupCalls = 0;
  hits = 0;
});

describe("safeFetch: адрес проверяется в момент соединения", () => {
  it("имя, отдающее сначала внешний, потом внутренний адрес, не достигает внутреннего", async () => {
    let outcome: unknown;
    try {
      outcome = await safeFetch(`http://localhost:${port}/`, { timeoutMs: 5_000 });
    } catch (err) {
      outcome = err;
    }
    expect(hits).toBe(0);
    expect(outcome).toBeInstanceOf(UnsafeUrlError);
  });

  it("служебные диапазоны 198.18/15, 192.0.0/24 и NAT64 запрещены", async () => {
    for (const raw of ["http://198.18.0.1/", "http://198.19.255.1/", "http://192.0.0.8/", "http://[64:ff9b::7f00:1]/"]) {
      await expect(assertPublicUrl(raw)).rejects.toBeInstanceOf(UnsafeUrlError);
    }
  });
});
