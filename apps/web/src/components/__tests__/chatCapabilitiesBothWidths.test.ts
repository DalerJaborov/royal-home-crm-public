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
  { marker: "ChatPropertySend", what: "отправить объект прямо из чата" },
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
 * нет»). Импорт ChatPropertySend стоял, сторож выше был зелёный, а пункт в
 * скрепке рисовался только у диалога с карточкой клиента — у «Продавца из
 * WhatsApp» без карточки он молча пропадал. Теперь в строке ввода нового вида
 * есть круглая кнопка `chat-send-property`, а пункт меню не завёрнут в условие
 * наличия карточки (без неё — серый с пояснением).
 */
describe("«Отправить объект» видно всегда", () => {
  const desktop = fs.readFileSync(DESKTOP_CHAT, "utf8");
  it("в строке ввода есть кнопка-здание, а не только скрытый триггер", () => {
    expect(desktop).toContain('data-testid="chat-send-property"');
  });
  it("пункт «Объект из базы» не прячется условием карточки клиента", () => {
    const at = desktop.indexOf("Объект из базы");
    expect(at).toBeGreaterThan(0);
    const before = desktop.slice(Math.max(0, at - 900), at);
    expect(before).not.toMatch(/\{conversation\?\.clientId && conversation\.clientShortId && \(\s*<button[^>]*role="menuitem"/);
  });
});
