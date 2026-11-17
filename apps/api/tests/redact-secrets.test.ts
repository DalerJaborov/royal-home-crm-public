import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/lib/redactSecrets.js";

/** Вычистка секретов из текстов ошибок, уходящих помощнику и в Telegram (17.11.2026). */
describe("redactSecrets", () => {
  const BOT = "123456789:AAH0abcdefghijklmnopqrstuvwxyz012345";

  it("токен бота в адресе запроса", () => {
    const out = redactSecrets(`Request failed: https://api.telegram.org/bot${BOT}/sendMessage 401`);
    expect(out).toBe("Request failed: https://api.telegram.org/bot•••/sendMessage 401");
    expect(out).not.toContain("AAH0");
  });

  it("токен бота без «bot» в начале", () => {
    expect(redactSecrets(`token ${BOT} rejected`)).toBe("token ••• rejected");
  });

  it("access_token=, key=, token=, secret=, password= в адресе и форме", () => {
    expect(redactSecrets("GET /me?access_token=EAAB123456789012345678901234567890&fields=id")).toBe("GET /me?access_token=•••&fields=id"); // secret-scan: allow — выдуманное значение для теста вычистки
    expect(redactSecrets("https://maps.example/geocode?key=abcDEF123456&q=x")).toBe("https://maps.example/geocode?key=•••&q=x");
    expect(redactSecrets("bad request token=zzz999 secret=qqq111")).toBe("bad request token=••• secret=•••");
    expect(redactSecrets("login failed: password=hunter2!")).toBe("login failed: password=•••");
    expect(redactSecrets("client_secret=abc123&refresh_token=def456")).toBe("client_secret=•••&refresh_token=•••");
  });

  it("значения вида «token: …» и «password: …»", () => {
    expect(redactSecrets("config {token: abc123def456}")).toBe("config {token: •••}");
    expect(redactSecrets('password: "my secret pass"')).toBe("password: •••");
  });

  it("Bearer-заголовок", () => {
    expect(redactSecrets("Authorization: Bearer abc.DEF-123_456xyz failed")).toBe("Authorization: Bearer ••• failed");
    expect(redactSecrets("sent header Bearer ya29.A0ARrdaM-xxxxxxxxxxxx")).toBe("sent header Bearer •••");
  });

  it("длинные ключи: sk-…, AIza…, EAA…, JWT", () => {
    expect(redactSecrets("OpenAI key sk-proj-abcdefghijklmnop1234567890 invalid")).toBe("OpenAI key ••• invalid");
    expect(redactSecrets(["Gemini AI", "zaSyA1234567890abcd", "efghijklmnopqrstuv quota"].join(""))).toBe("Gemini ••• quota"); // secret-scan: allow — выдуманное значение для теста вычистки
    expect(redactSecrets("Meta EAAGm0PX4ZCpsBAKabcdefghijklmnop12345 expired")).toBe("Meta ••• expired");
    expect(redactSecrets("jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4 bad")).toBe("jwt ••• bad");
  });

  it("обычный текст ошибки не портится", () => {
    for (const plain of [
      "Не удалось отправить сообщение: таймаут 10 с",
      "connect ECONNREFUSED 10.9.0.1:40800",
      "Unique constraint failed on the fields: (`shortId`)",
      "primary key: id не найден, ключ клиента отсутствует",
      "Ошибка 429 Too Many Requests, повтор через 30 с",
      "Сбой звонка 2026-11-17T10:00:00Z на номер +992 900 00 00 00",
    ]) {
      expect(redactSecrets(plain)).toBe(plain);
    }
  });

  it("пустое и отсутствующее значение — как есть", () => {
    expect(redactSecrets("")).toBe("");
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeUndefined();
  });
});
