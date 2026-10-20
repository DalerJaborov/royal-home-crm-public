import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Карточка клиента: «Назначить агента», «Переназначить», «Забрать себе» и
 * «Перевести в кандидаты» — по ПРАВУ clients.assign, как пускает сервер
 * (routes/clients/lifecycle.ts), а не по роли (глубокая проверка 02.10.2026,
 * F8). Оператору, которому директор выдал право, кнопок не было; менеджеру,
 * у которого право сняли, кнопки были и отвечали 403.
 */
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../pages/ClientDetail.tsx");

describe("ClientDetail: назначение клиента по праву, а не по роли", () => {
  const text = fs.readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");
  it("разбор лида, переназначение и «в кандидаты» не завязаны на isSupervisor", () => {
    expect(text).not.toMatch(/pending && isSupervisor/);
    expect(text).not.toMatch(/!pending && isSupervisor && !isOther/);
    expect(text).not.toMatch(/if \(isSupervisor && !client\.deletedAt\)/);
  });
  it("право читается реестром", () => {
    expect(text).toMatch(/canDo\("clients\.assign"\)/);
  });
});
