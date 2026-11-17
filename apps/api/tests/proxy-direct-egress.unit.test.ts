/**
 * Прямой выход без прокси (сервер в Германии с 04.11.2026): ни один секрет прокси
 * не уходит наружу, а маркер Instagram попадает туда, где его читает Meta.
 */
import { afterEach, describe, expect, it } from "vitest";
import { geminiProxyHeaders, geminiUrl } from "../src/ai/geminiTransport.js";
import { instagramQueryTokenRequest } from "../src/messengers/metaGraph.js";

const KEYS = ["GEMINI_PROXY_URL", "GEMINI_PROXY_KEY", "IG_PROXY_URL", "IG_PROXY_KEY"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

describe("Gemini без прокси", () => {
  it("ключ прокси без адреса прокси НЕ уходит в Google", () => {
    process.env.GEMINI_PROXY_URL = "";
    process.env.GEMINI_PROXY_KEY = "worker-secret";
    expect(geminiProxyHeaders()).toEqual({});
    expect(geminiUrl("/v1beta/models/x:generateContent").startsWith("https://generativelanguage.googleapis.com/")).toBe(true);
  });

  it("с прокси ключ по-прежнему идёт заголовком к Worker", () => {
    process.env.GEMINI_PROXY_URL = "https://proxy.example";
    process.env.GEMINI_PROXY_KEY = "worker-secret";
    expect(geminiProxyHeaders()).toEqual({ "x-proxy-key": "worker-secret" });
  });
});

describe("instagramQueryTokenRequest", () => {
  it("без прокси: маркер в строке один раз, без Bearer и без ключа прокси", () => {
    delete process.env.IG_PROXY_URL;
    delete process.env.GEMINI_PROXY_URL;
    process.env.GEMINI_PROXY_KEY = "worker-secret";
    const req = instagramQueryTokenRequest("https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token", "a b");
    expect(new URL(req.url).searchParams.getAll("access_token")).toEqual(["a b"]);
    expect(req.headers).toEqual({});
  });

  it("уже подписанный адрес не получает второй access_token", () => {
    delete process.env.IG_PROXY_URL;
    delete process.env.GEMINI_PROXY_URL;
    const req = instagramQueryTokenRequest("https://graph.instagram.com/x?access_token=t", "t");
    expect(new URL(req.url).searchParams.getAll("access_token")).toEqual(["t"]);
  });
});
