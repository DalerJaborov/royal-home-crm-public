import { describe, expect, it } from "vitest";
import { parseHtml } from "../src/lib/linkPreview.js";

/**
 * Аудит 23.09.2026, круг 3, №72: разбор чужой страницы по ссылке клиента шёл
 * регулярками `<meta[^>]+…` по всему документу. На странице из тысяч `<meta`
 * без закрывающей `>` они откатывались квадратично — десятки секунд на одно
 * сообщение, и всё это время процесс API (вся CRM, звонки) стоял.
 */
describe("разбор страницы по ссылке не вешает сервер", () => {
  it("страница-ловушка из незакрытых тегов разбирается быстро", () => {
    const trap = "<meta property=og:title ".repeat(8000) + "<title".repeat(8000) + "<meta ".repeat(8000);
    const started = performance.now();
    expect(parseHtml("https://trap.example/", trap)).toBeNull();
    expect(performance.now() - started).toBeLessThan(300);
  });

  it("обычная разметка читается как раньше, включая заглавные теги и апостроф", () => {
    const html = `<html><head>
      <TITLE>Запасной заголовок</TITLE>
      <meta name="viewport" content="width=device-width">
      <META Property="og:title" Content="Квартира на Сомони, 3 комнаты">
      <meta content="It's a deal — 75 000 $" name="description">
      <meta property='og:site_name' content='Somon.tj'>
    </head></html>`;
    const preview = parseHtml("https://somon.tj/y", html);
    expect(preview?.title).toBe("Квартира на Сомони, 3 комнаты");
    expect(preview?.description).toBe("It's a deal — 75 000 $");
    expect(preview?.siteName).toBe("Somon.tj");
  });

  it("без og:title берётся <title>, буквы вне латиницы позиции не сбивают", () => {
    const html = `İİİ ǅ<head><title>Дом в Вахдате</title><meta name="description" content="Сад, гараж"></head>`;
    const preview = parseHtml("https://x.tj/", html);
    expect(preview?.title).toBe("Дом в Вахдате");
    expect(preview?.description).toBe("Сад, гараж");
  });
});
