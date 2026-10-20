import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONVERSATION_CHANNEL_LABELS, channelLabel } from "@royal-home/shared";

/**
 * СЛОВАРЬ КАНАЛА ДИАЛОГА — ОДНО МЕСТО (ночная проверка 24.09.2026, находка №11).
 *
 * Три серверных места собирали текст для человека (пуш, запись в «Здоровье
 * системы», карточку в «Зависшая работа») прямо из `BotConversation.channel` —
 * `диалог ${row.channel}` давало «диалог INSTAGRAM» вместо «диалог Instagram».
 * `CLIENT_SOURCE_LABELS` из `packages/shared` для этого не подходит: это
 * словарь ИСТОЧНИКА клиента (`ClientSource`), а не канала диалога (произвольная
 * строка), и не покрывает часть значений (`TELEGRAM_DM`, `PHONE`, `LIVE_VOICE`).
 *
 * Здесь — свой словарь, `CONVERSATION_CHANNEL_LABELS`/`channelLabel`, общий для
 * `lib/phoneLeadWatchdog.ts`, `lib/clientToCandidate.ts`, `lib/stuckWork.ts`.
 */
describe("русское название канала диалога", () => {
  it("покрывает все значения channel, встречающиеся в коде и тестах", () => {
    // Собрано `grep -ohE 'channel:\s*"[A-Z_]+"' apps/api/src apps/api/tests`
    // 24.09.2026 — реальные значения, которые база отдаёт в это поле.
    const known = [
      "INSTAGRAM",
      "FACEBOOK",
      "TELEGRAM",
      "TELEGRAM_DM",
      "WHATSAPP",
      "TIKTOK",
      "YOUTUBE",
      "WEBSITE",
      "PHONE",
      "LIVE_VOICE",
    ];
    for (const channel of known) {
      const label = channelLabel(channel);
      expect(label).toBeTruthy();
      // Русское слово — не тот же код кириллицей не станет: значит буквы латиницей
      // в результате допустимы только у названий продуктов (Instagram, WhatsApp…),
      // а не у самого константного идентификатора канала.
      expect(label).not.toBe(channel);
    }
  });

  it("незнакомый канал не падает — показывается как есть", () => {
    expect(channelLabel("SOME_NEW_CHANNEL")).toBe("SOME_NEW_CHANNEL");
    expect(() => channelLabel("")).not.toThrow();
  });

  it("словарь не путает канал диалога с источником клиента (разные домены)", () => {
    // TELEGRAM_DM/PHONE/LIVE_VOICE — как раз то, чего нет в CLIENT_SOURCE_LABELS
    // (см. комментарий в conversationChannel.ts) — если появятся тут, словарь
    // снова вырос молча мимо теста.
    expect(CONVERSATION_CHANNEL_LABELS.TELEGRAM_DM).toBe("личка Telegram");
    expect(CONVERSATION_CHANNEL_LABELS.PHONE).toBe("телефон");
    expect(CONVERSATION_CHANNEL_LABELS.LIVE_VOICE).toBe("голосовой звонок");
  });
});

/**
 * Три места, где раньше был сырой `${row.channel}`/`${conv.channel}`/
 * `${input.channel}` в тексте для человека, теперь зовут `channelLabel(...)`.
 * Проверка исходником (аналог `apps/web/src/lib/__tests__/noApiHrefs.test.ts`),
 * а не запуском: два файла из трёх работают с ботом и без БД не собрать
 * реалистичный сценарий на все веточки текста дешёво.
 */
describe("три файла зовут общий словарь, а не собирают текст сами", () => {
  const FILES = [
    "../src/lib/phoneLeadWatchdog.ts",
    "../src/lib/clientToCandidate.ts",
    "../src/lib/stuckWork.ts",
  ];

  it("каждый файл импортирует channelLabel из @royal-home/shared", () => {
    for (const rel of FILES) {
      const text = fs.readFileSync(path.join(__dirname, rel), "utf8");
      expect(text).toMatch(/import\s*\{[^}]*\bchannelLabel\b[^}]*\}\s*from\s*"@royal-home\/shared"/);
    }
  });

  it("нет сырого канала в тексте для человека (диалог/канал в скобках)", () => {
    const RAW_CHANNEL_IN_TEXT = /\((?:row|conv|input)\.channel\)|\$\{(?:row|conv|input)\.channel\}(?!\))/;
    for (const rel of FILES) {
      const text = fs.readFileSync(path.join(__dirname, rel), "utf8");
      // За вычетом `channelLabel(row.channel)` — сам вызов допустим, важно, что
      // канал больше не подставляется в текст напрямую.
      const withoutWrappedCalls = text.replace(/channelLabel\((?:row|conv|input)\.channel\)/g, "channelLabel(…)");
      expect(withoutWrappedCalls).not.toMatch(RAW_CHANNEL_IN_TEXT);
    }
  });
});
