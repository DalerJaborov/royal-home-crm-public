import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * «Принят …» в карточке объекта (24.09.2026): чип брал дату заведения
 * карточки (createdAt), а в правке меняют «Дату принятия объекта»
 * (listingAcceptedAt) — поменял дату, а в шапке ничего не изменилось.
 *
 * С 06.10.2026 дата живёт строкой «Принят» во вкладке «Коротко» единой карточки
 * (раньше её рисовал `MobilePriceCard`, которого больше нет). Карточка тянет
 * десяток запросов и без сервера не отрисовывается, поэтому проверяем исходник:
 * дата берётся из listingAcceptedAt, а не из createdAt.
 */
const src = readFileSync(join(__dirname, "../../pages/PropertyDetail.tsx"), "utf8");

describe("Дата приёма объекта", () => {
  it("строка «Принят» показывает дату принятия, а не дату заведения карточки", () => {
    expect(src).toContain('title="Принят"');
    expect(src).toContain(
      'meta={dushanbeDate(property.listingAcceptedAt ?? property.createdAt, { day: "numeric", month: "long" })}',
    );
    expect(src).not.toContain("dushanbeDate(property.createdAt");
  });
});
