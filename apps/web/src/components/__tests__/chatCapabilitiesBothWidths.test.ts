import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ОДИН И ТОТ ЖЕ ЧАТ НА ПК И НА ТЕЛЕФОНЕ — ОДИНАКОВЫЕ ВОЗМОЖНОСТИ.
 *
 * `pages/Messages.tsx` и `components/mobile/MobileChatView.tsx` показывают ОДНУ
 * переписку, просто на разной ширине: экран выбирает ветку по `narrow`. Значит
 * всё, что оператор умеет сделать в чате, обязано быть в обеих ветках.
 *
 * Поймано 23.09.2026. Отправка клиенту фото и видео приехала 18.08.2026
 * (коммит 9cc39bc4, 19 файлов) и легла только в `pages/Messages.tsx`; мобильный
 * чат та правка не тронула вовсе. Больше месяца агент, работающий с телефона, не
 * мог отправить клиенту фото объекта — при том что это его ежедневная работа.
 * Ничего не падало и никто не предупреждал: на ПК всё работало. Дыру закрыла
 * ветка `fix/mobile-chat-media-22-09`, этот сторож не даёт ей открыться снова.
 *
 * Класс описан в CLAUDE.md («Desktop и mobile ship together, same task») и
 * ловился до сих пор только глазами владельца: сборка и типы его не видят,
 * потому что оба файла сами по себе исправны.
 *
 * Сторож смотрит на ИМЕНА, а не на разметку: разметка у двух ширин своя и
 * должна оставаться своей, а вот хук загрузки, стор прогресса и общая проверка
 * выбранного файла у них одни и те же. Новую возможность чата — вписывать сюда
 * строкой, тогда вторую ширину не забудут.
 *
 * Идиома теста-сканера исходников — как у `lib/__tests__/noApiHrefs.test.ts`.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

const DESKTOP_CHAT = path.join(SRC, "pages/Messages.tsx");
const MOBILE_CHAT = path.join(SRC, "components/mobile/MobileChatView.tsx");

const SHARED_CHAT_CAPABILITIES = [
  { marker: "Paperclip", what: "прикрепить фото или видео" },
  { marker: "useUploadConversationMediaWithProgress", what: "отправить файл с показом хода загрузки" },
  { marker: "usePendingMediaUploads", what: "видеть пузырь загрузки в ленте" },
  { marker: "planOutgoingMediaPick", what: "получить отказ по размеру до загрузки" },
  { marker: "ChatObjectPicker", what: "отправить объект прямо из чата" },
  { marker: "VoiceRecordButton", what: "записать голосовое" },
];

describe("чат на ПК и на телефоне", () => {
  it("оба файла на месте (иначе сторож проверяет пустоту)", () => {
    expect(fs.existsSync(DESKTOP_CHAT)).toBe(true);
    expect(fs.existsSync(MOBILE_CHAT)).toBe(true);
  });

  for (const { marker, what } of SHARED_CHAT_CAPABILITIES) {
    it(`«${what}» есть на обеих ширинах (${marker})`, () => {
      const desktop = fs.readFileSync(DESKTOP_CHAT, "utf8");
      const mobile = fs.readFileSync(MOBILE_CHAT, "utf8");
      const missing = [
        desktop.includes(marker) ? null : "ПК",
        mobile.includes(marker) ? null : "телефоне",
      ].filter(Boolean);
      expect(
        missing,
        missing.length === 2
          ? `${marker} не используется нигде — возможность убрали? Тогда убрать и строку из списка.`
          : `На ${missing[0]} нет ${marker}: возможности «${what}» там просто не существует, и об этом никто не сообщит. Чинить не копией разметки, а общим хуком или компонентом.`
      ).toEqual([]);
    });
  }
});

/**
 * ВИДИМЫЙ ТРИГГЕР, А НЕ ИМПОРТ (25.11.2026, владелец: «кнопки „Отправить объект“
 * нет»). Импорт ChatPropertySend (теперь ChatObjectPicker) стоял, сторож выше был зелёный, а пункт в
 * скрепке рисовался только у диалога с карточкой клиента — у «Продавца из
 * WhatsApp» без карточки он молча пропадал. Теперь в строке ввода нового вида
 * нет отдельной кнопки (26.11.2026 убрана как дубль), а пункт меню не завёрнут в условие
 * наличия карточки (без неё — серый с пояснением).
 */
describe("«Отправить объект» видно всегда", () => {
  const desktop = fs.readFileSync(DESKTOP_CHAT, "utf8");
  it("отдельной кнопки-здания в строке ввода нет: «Объект» только пунктом меню скрепки (владелец 26.11.2026)", () => {
    expect(desktop).not.toContain('data-testid="chat-send-property"');
    expect(desktop).toContain("Объект из базы");
  });
  it("пункта «Сначала примите заявку» больше нет: объект уходит и без карточки (владелец 26.11.2026)", () => {
    expect(desktop).not.toContain("PROPERTY_SEND_NEEDS_CARD");
    expect(desktop).not.toContain("Сначала примите заявку");
    expect(desktop).not.toContain("aria-disabled={!canSendProperty");
  });
  it("пункт «Объект из базы» не прячется условием карточки клиента", () => {
    const at = desktop.indexOf("Объект из базы");
    expect(at).toBeGreaterThan(0);
    const before = desktop.slice(Math.max(0, at - 900), at);
    expect(before).not.toMatch(/\{conversation\?\.clientId && conversation\.clientShortId && \(\s*<button[^>]*role="menuitem"/);
  });
});

/**
 * СРОК ПАУЗЫ БОТА ПРИ ОТВЕТЕ ВИДЕН НА ОБЕИХ ШИРИНАХ (владелец 26.11.2026: «вернуть выбор срока,
 * по умолчанию час»). Новый вид чата — один адаптивный экран (`royal` в Messages.tsx): строка выбора
 * срока не завёрнута в условие ширины, а один и тот же срок получают текст, голосовое и фото/видео.
 * (`MobileChatView.tsx` сейчас нигде не подключён — отдельной ветки для телефона нет.)
 */
describe("срок паузы бота при ответе: одна строка на ПК и телефоне", () => {
  const desktop = fs.readFileSync(DESKTOP_CHAT, "utf8");
  it("строка выбора срока есть в новом виде и не зависит от ширины экрана", () => {
    const at = desktop.indexOf('data-testid="chat-reply-pause"');
    expect(at).toBeGreaterThan(0);
    const condition = desktop.slice(Math.max(0, at - 260), at);
    expect(condition).toContain("royal &&");
    expect(condition).not.toMatch(/narrow/);
  });
  it("одно число срока уходит с текстом, голосовым и фото/видео", () => {
    expect(desktop).toContain("useSendVoiceMessage(replyTargetId, royal ? () => replyPauseMinutes() : undefined)");
    // Прежний вид: голос и фото/видео срок НЕ шлют (как до 26.11) — «Бессрочно» им тихо не раздаём.
    expect(desktop).toMatch(/function mediaPauseMinutes\(\)[^{]*\{\s*return royal \? replyPauseMinutes\(\) : undefined;/);
    const starts = desktop.split(/\r?\n/).filter((line) => line.includes("mediaUpload.start("));
    expect(starts.length).toBe(3);
    for (const line of starts) expect(line, line).toMatch(/[pP]auseMinutes/);
    expect(desktop).toContain("pausedUntil: pausedUntilIso(replyPauseMinutes())");
  });
});
