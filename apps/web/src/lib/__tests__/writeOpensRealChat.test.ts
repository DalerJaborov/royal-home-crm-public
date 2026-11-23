import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { planOutgoingMediaPick } from "../mediaUpload";

/**
 * «Написать» в карточке клиента ведёт в обычный раздел «Чаты» (владелец
 * 23.11.2026: шторка-пузырь «Переписка» поверх карточки не нужна). Класс ошибки —
 * любая кнопка карточки (ПК и телефон) открывает шторку вместо перехода.
 */
const here = dirname(fileURLToPath(import.meta.url));
const detail = readFileSync(resolve(here, "../../pages/ClientDetail.tsx"), "utf8");

describe("карточка клиента: «Написать» открывает настоящий чат", () => {
  it("шторка ClientChatPanel и её состояние из карточки убраны", () => {
    expect(detail).not.toMatch(/<ClientChatPanel/);
    expect(detail).not.toMatch(/setChat\(/);
    expect(detail).not.toMatch(/\bchat\.open\b/);
  });

  it("все пути (ПК, телефон, «Ждёт варианты», сигнал openChat, карточка «Переписка») идут через openClientChat", () => {
    const calls = detail.match(/openClientChat\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(6);
    expect(detail).toMatch(/navigate\(inboxClientConversationHref\(clientId\)\)/);
  });
});

describe("planOutgoingMediaPick", () => {
  const img = (name: string, size = 1000) => ({ name, size, type: "image/jpeg" }) as File;
  it("один файл — превью и подпись, как раньше", () => {
    const plan = planOutgoingMediaPick([img("a.jpg")], "WHATSAPP");
    expect(plan.error).toBeNull();
    expect(plan.single?.name).toBe("a.jpg");
  });
  it("несколько — пачка без промежуточных шагов", () => {
    const plan = planOutgoingMediaPick([img("a.jpg"), img("b.jpg")], "WHATSAPP");
    expect(plan.batch).toHaveLength(2);
    expect(plan.single).toBeNull();
  });
  it("плохой файл в пачке останавливает всё и называет файл", () => {
    const bad = { name: "x.pdf", size: 10, type: "application/pdf" } as File;
    const plan = planOutgoingMediaPick([img("a.jpg"), bad], "WHATSAPP");
    expect(plan.error).toContain("x.pdf");
    expect(plan.batch).toHaveLength(0);
  });
});
