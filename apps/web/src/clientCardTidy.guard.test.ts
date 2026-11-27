import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Сторож уборки карточки клиента (владелец 22.11.2026): в файлах, из которых собрана карточка, не возвращаются
 * «Запрос покупателя», «Уточнить пожелания», «Следующий шаг», «Показано N из», «Выберите до 5 объектов».
 * «Записать результат» остаётся только за рубильником `clientRecordResultEnabled`.
 */
const FILES = ["pages/ClientDetail.tsx", "components/ClientCardContext.tsx", "components/match/MatchPanel.tsx", "components/MarketBuyerListings.tsx", "components/mobile/MobileClientCard.tsx", "components/ClientInsight.tsx"];
const FORBIDDEN = ["Запрос покупателя", "Уточнить пожелания", "Следующий шаг", "Показано {", "Выберите до 5 объектов", "Взять из разговора"];

describe("карточка клиента: убранные тексты не возвращаются", () => {
  const src = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const f of FILES) {
    it(f, () => { for (const bad of FORBIDDEN) expect(src(f), bad).not.toContain(bad); });
  }
  it("«Записать результат» в карточке только за рубильником", () => {
    expect(src("pages/ClientDetail.tsx")).toContain("recordResultOn");
    expect(src("pages/ClientDetail.tsx")).toMatch(/if \(recordResultOn\) mainItems\.push/);
    expect(src("components/ClientCardContext.tsx")).toMatch(/onRecord &&/);
  });
  // Владелец 27.11.2026: «удали это, я вроде бы просил, он висит все еще» — «Звонок роботом» и «Не звонить роботом».
  it("строки робота в карточке только за рубильником clientCardRobotRowsEnabled", () => {
    const card = src("pages/ClientDetail.tsx");
    expect(card).toMatch(/robotRowsOn = settings\?\.clientCardRobotRowsEnabled === true/);
    expect(card).toMatch(/if \(isSupervisor && !locked && robotRowsOn\) \{\s*extraItems\.push\(\{\s*key: "live-voice"/);
    expect(card).toMatch(/if \(!locked && robotRowsOn && robotStop\.data\)/);
    expect(card).toContain("useRobotCallStop(client?.id, robotRowsOn)");
  });
});
