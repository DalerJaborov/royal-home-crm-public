import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BARE_ATTACHMENT_MARKER, BARE_MESSAGE_MARKER, NO_TEXT_NOTE, describeForStaff, describeServiceMarker, serviceMarkerKind, whereToLook } from "@royal-home/shared";

/**
 * Служебные пометки бота человеку (20.11.2026): одна функция на чат, список чатов, карточку клиента и push
 * сотрудникам. Честно: файл в CRM не сохранился — смотреть в мессенджере; «без текста» — реакция или место.
 */
describe("describeServiceMarker", () => {
  it("вложение без текста — файл не сохранился, где смотреть — по каналу", () => {
    expect(describeServiceMarker(BARE_ATTACHMENT_MARKER, { channel: "WHATSAPP" })).toBe("Клиент прислал файл — в CRM он не сохранился, посмотрите в WhatsApp");
    expect(describeServiceMarker(BARE_ATTACHMENT_MARKER, { channel: "INSTAGRAM" })).toContain("в Instagram");
    expect(describeServiceMarker(BARE_ATTACHMENT_MARKER)).toContain("в самом мессенджере");
  });
  it("старые пометки бота «[📎 файл не открылся]» и «[📎]» — тот же файл без текста, в списке чатов без скобок (26.11.2026)", () => {
    expect(serviceMarkerKind("[📎 файл не открылся]")).toBe("attachment");
    expect(describeServiceMarker("[📎 файл не открылся]", { channel: "INSTAGRAM", attachmentsUnknown: true })).toBe("Клиент прислал файл");
    expect(describeServiceMarker("[📎]", { hasAttachments: true })).toBe("");
    expect(describeForStaff("[📎 файл не открылся]")).toBe(NO_TEXT_NOTE);
  });
  it("файл показан рядом — пометка лишняя (пустая строка)", () => {
    expect(describeServiceMarker(BARE_ATTACHMENT_MARKER, { hasAttachments: true })).toBe("");
  });
  it("сообщение без текста — отдельная подпись, не про файл", () => {
    expect(describeServiceMarker(BARE_MESSAGE_MARKER, { channel: "WHATSAPP" })).toBe("Сообщение без текста (реакция или место)");
    expect(describeServiceMarker(BARE_MESSAGE_MARKER, { hasAttachments: true })).toBe("Сообщение без текста (реакция или место)");
  });
  it("живой текст клиента не трогается, фраза внутри текста — тоже", () => {
    expect(describeServiceMarker("Салом")).toBeNull();
    expect(describeServiceMarker(`вот ${BARE_ATTACHMENT_MARKER} тут`)).toBeNull();
    expect(serviceMarkerKind(`  ${BARE_MESSAGE_MARKER} `)).toBe("message");
    expect(whereToLook("TELEGRAM_DIRECT")).toBe("в Telegram");
  });
});

describe("describeForStaff: push сотрудникам не утверждает лишнего", () => {
  it("пусто и «вложение без текста» — нейтрально, без «не сохранился»", () => {
    expect(describeForStaff("")).toBe(NO_TEXT_NOTE);
    expect(describeForStaff(null)).toBe(NO_TEXT_NOTE);
    expect(describeForStaff(BARE_ATTACHMENT_MARKER)).toBe(NO_TEXT_NOTE);
    expect(NO_TEXT_NOTE).not.toMatch(/не сохранил/);
    expect(NO_TEXT_NOTE).toBe("Клиент прислал сообщение без текста (файл, голосовое или реакцию) — откройте чат");
  });
  it("«реакция или место» — только для пометки там, где медиа точно нет", () => {
    expect(describeForStaff(BARE_MESSAGE_MARKER)).toBe("Сообщение без текста (реакция или место) — откройте чат");
  });
  it("сырой «[вложение: image]» — словами, типы по-русски", () => {
    expect(describeForStaff("[вложение: image]")).toBe("Клиент прислал фото — откройте чат");
    expect(describeForStaff("[вложение: image, audio]")).toBe("Клиент прислал фото, голосовое — откройте чат");
    expect(describeForStaff("[вложение: weird]")).toBe("Клиент прислал файл — откройте чат");
  });
  it("живой текст клиента не трогается", () => {
    expect(describeForStaff("  Салом, есть квартира? ")).toBe("Салом, есть квартира?");
  });
});

/** Литералы пометок живут ТОЛЬКО в packages/shared (константы), а не копиями по коду (комментарии не в счёт). */
describe("литералы служебных пометок — только в shared", () => {
  const roots = [join(__dirname, "../src"), join(__dirname, "../../web/src")];
  const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { if (name !== "node_modules") walk(full, out); }
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(full);
    }
    return out;
  };
  it("«[вложение без текста]» и «[сообщение без текста]» не набраны строкой вне shared", () => {
    const offenders = roots.flatMap((root) => walk(root)).filter((file) => {
      const code = stripComments(readFileSync(file, "utf8"));
      return code.includes("[вложение без текста]") || code.includes("[сообщение без текста]");
    });
    expect(offenders).toEqual([]);
  });
});
