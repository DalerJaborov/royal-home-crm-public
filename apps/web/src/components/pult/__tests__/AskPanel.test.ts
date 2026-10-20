import { describe, expect, it } from "vitest";
import type { PultArea } from "@royal-home/shared";
import { answerLines, mentionedAreas } from "../AskPanel";

const AREAS: PultArea[] = [
  { id: "clients", label: "Клиенты", href: "/clients", big: "10", line: "", tone: "ok" },
  { id: "money", label: "Деньги", href: "/finance", big: "0 %", line: "", tone: "crit" },
  { id: "calls", label: "Звонки", href: "/telephony", big: "0", line: "", tone: "ok" },
];

describe("AskPanel: answerLines (печать построчно 40 мс/строку)", () => {
  it("режет по явным переносам, если они есть", () => {
    expect(answerLines("Первая строка.\nВторая строка.")).toEqual(["Первая строка.", "Вторая строка."]);
  });

  it("без переносов режет по предложениям", () => {
    expect(answerLines("Заработаем 55000 сомони. Это 70% плана.")).toEqual([
      "Заработаем 55000 сомони.",
      "Это 70% плана.",
    ]);
  });

  it("короткий ответ без знаков препинания остаётся одной строкой", () => {
    expect(answerLines("готово")).toEqual(["готово"]);
  });
});

describe("AskPanel: mentionedAreas (чипы-ссылки по упомянутым разделам)", () => {
  it("находит раздел по названию плитки", () => {
    const found = mentionedAreas("Деньги идут по плану месяца.", AREAS);
    expect(found.map((a) => a.id)).toEqual(["money"]);
  });

  it("находит раздел по ключевому слову-синониму", () => {
    const found = mentionedAreas("Комиссия за октябрь выше обычного.", AREAS);
    expect(found.map((a) => a.id)).toEqual(["money"]);
  });

  it("не предлагает чип, если раздел не упомянут", () => {
    expect(mentionedAreas("Всё спокойно.", AREAS)).toEqual([]);
  });

  it("находит несколько разделов сразу", () => {
    const found = mentionedAreas("Пропущенных звонков нет, деньги в норме.", AREAS);
    expect(found.map((a) => a.id).sort()).toEqual(["calls", "money"]);
  });
});
