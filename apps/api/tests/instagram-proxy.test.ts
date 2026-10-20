import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { instagramApiUrl, instagramRequest } from "../src/messengers/meta.js";

/**
 * Instagram ходит через Cloudflare Worker: с нашего VPS `graph.instagram.com`
 * недоступен на сетевом уровне, из-за чего входящие приходили, а ответить бот
 * не мог («fetch failed»).
 *
 * Тонкость, которую легко потерять: Worker пробрасывает наверх только
 * `Content-Type`, поэтому через прокси маркер обязан уходить параметром запроса —
 * с `Authorization` Meta ответит 401, и снова будет «канал молчит без причины».
 */

const PROXY = "https://relay.example.workers.dev";
const TOKEN = "IGAAT-test-token";

const saved = {
  igUrl: process.env.IG_PROXY_URL,
  igKey: process.env.IG_PROXY_KEY,
  gemUrl: process.env.GEMINI_PROXY_URL,
  gemKey: process.env.GEMINI_PROXY_KEY,
};

beforeEach(() => {
  delete process.env.IG_PROXY_URL;
  delete process.env.IG_PROXY_KEY;
  delete process.env.GEMINI_PROXY_URL;
  delete process.env.GEMINI_PROXY_KEY;
});

afterEach(() => {
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("IG_PROXY_URL", saved.igUrl);
  restore("IG_PROXY_KEY", saved.igKey);
  restore("GEMINI_PROXY_URL", saved.gemUrl);
  restore("GEMINI_PROXY_KEY", saved.gemKey);
});

describe("instagramApiUrl — куда идёт запрос", () => {
  it("без прокси — прямо в Meta", () => {
    expect(instagramApiUrl("/me/media")).toBe("https://graph.instagram.com/me/media");
  });

  it("через прокси, когда он настроен для Instagram", () => {
    process.env.IG_PROXY_URL = PROXY;
    expect(instagramApiUrl("/me/media")).toBe(`${PROXY}/me/media`);
  });

  it("подхватывает прокси Gemini: Worker один и тот же, отдельная настройка не нужна", () => {
    process.env.GEMINI_PROXY_URL = PROXY;
    expect(instagramApiUrl("/v23.0/me/messages")).toBe(`${PROXY}/v23.0/me/messages`);
  });

  it("свой адрес важнее общего, если их развели", () => {
    process.env.GEMINI_PROXY_URL = "https://gemini-only.example";
    process.env.IG_PROXY_URL = PROXY;
    expect(instagramApiUrl("/me/media")).toBe(`${PROXY}/me/media`);
  });
});

describe("instagramRequest — как передаётся маркер", () => {
  it("напрямую в Meta маркер идёт заголовком", () => {
    const req = instagramRequest("https://graph.instagram.com/me/media", TOKEN);
    expect(req.url).toBe("https://graph.instagram.com/me/media");
    expect(req.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it("через прокси — параметром запроса, потому что Authorization Worker не пробрасывает", () => {
    process.env.IG_PROXY_URL = PROXY;
    process.env.IG_PROXY_KEY = "secret";
    const req = instagramRequest(`${PROXY}/me/media`, TOKEN);
    expect(req.url).toBe(`${PROXY}/me/media?access_token=${encodeURIComponent(TOKEN)}`);
    expect(req.headers).toEqual({ "x-proxy-key": "secret" });
    expect(req.headers.Authorization).toBeUndefined();
  });

  it("не ломает уже имеющиеся параметры", () => {
    process.env.IG_PROXY_URL = PROXY;
    const req = instagramRequest(`${PROXY}/me/media?fields=id&limit=25`, TOKEN);
    expect(req.url).toBe(`${PROXY}/me/media?fields=id&limit=25&access_token=${encodeURIComponent(TOKEN)}`);
  });

  it("адрес не нашего прокси получает обычный заголовок: ключ наружу не утекает", () => {
    process.env.IG_PROXY_URL = PROXY;
    process.env.IG_PROXY_KEY = "secret";
    const req = instagramRequest("https://graph.facebook.com/v23.0/123/messages", TOKEN);
    expect(req.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(req.url).not.toContain("access_token");
  });

  /**
   * Найдено 20.08.2026: `data.paging.next` из ответа Graph API приходит готовым
   * АБСОЛЮТНЫМ адресом на graph.instagram.com, а не на прокси, — старая проверка
   * `!url.startsWith(proxy)` считала, что раз префикса прокси нет, значит адрес
   * годится и так, и звала graph.instagram.com напрямую. С нашего VPS этот хост
   * недоступен: первая страница ленты (instagramApiUrl, уже с префиксом прокси)
   * читалась нормально, а вторая — с "aborted due to timeout"/"connect timeout"
   * на каждом вызове (getAllOwnMedia, instagramFeed.ts).
   */
  it("ссылка пагинации на graph.instagram.com тоже пересобирается через прокси", () => {
    process.env.IG_PROXY_URL = PROXY;
    process.env.IG_PROXY_KEY = "secret";
    const req = instagramRequest("https://graph.instagram.com/v23.0/17841/media?after=cursor123", TOKEN);
    expect(req.url).toBe(`${PROXY}/v23.0/17841/media?after=cursor123&access_token=${encodeURIComponent(TOKEN)}`);
    expect(req.headers).toEqual({ "x-proxy-key": "secret" });
  });
});
