import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVENT_POINTS,
  EDITABLE_ROYAL_SCORE_EVENT_GROUPS,
  EDITABLE_SCORE_EVENT_KEYS,
  ROYAL_SCORE_EVENT_GROUPS,
} from "@royal-home/shared";

/**
 * КАТАЛОГ СОБЫТИЙ ROYAL SCORE — ОДИН НА ВСЕХ.
 *
 * Проверка появилась 10.09.2026 после реального расхождения: цены жили в
 * `apps/api/src/lib/scoreJournal.ts`, подписи и группы — в
 * `apps/web/src/pages/settings/TeamTab.tsx`, и два события, заведённые позже
 * (`lead_ignored` 12.08.2026 и `client_recovered_bonus` 01.09.2026), попали
 * только в первую копию. Последствие было хуже, чем «не видно»: экран
 * Настроек отправляет `royalScoreEventPoints` ЦЕЛИКОМ своим набором ключей, а
 * сервер записывает присланное поверх прежнего — то есть каждое сохранение
 * формы стирало этим двум событиям заданную владельцем цену.
 *
 * База тут не нужна: это проверка самого справочника, не поведения.
 */
describe("Каталог событий Royal Score", () => {
  it("ключи не повторяются", () => {
    const keys = ROYAL_SCORE_EVENT_GROUPS.flatMap((g) => g.events.map((e) => e.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("у каждого события есть подпись для владельца", () => {
    for (const group of ROYAL_SCORE_EVENT_GROUPS) {
      expect(group.title.trim().length).toBeGreaterThan(0);
      for (const e of group.events) {
        expect(e.label.trim().length, `подпись события ${e.key}`).toBeGreaterThan(0);
        expect(Number.isFinite(e.points), `цена события ${e.key}`).toBe(true);
      }
    }
  });

  it("цены по умолчанию собраны ровно из каталога, без второго списка", () => {
    const fromCatalog = Object.fromEntries(
      ROYAL_SCORE_EVENT_GROUPS.flatMap((g) => g.events.map((e) => [e.key, e.points] as const))
    );
    expect(DEFAULT_EVENT_POINTS).toEqual(fromCatalog);
  });

  it("каждое правимое событие есть на экране Настроек — иначе сохранение стирает его цену", () => {
    const onScreen = new Set(EDITABLE_ROYAL_SCORE_EVENT_GROUPS.flatMap((g) => g.events.map((e) => e.key)));
    for (const key of EDITABLE_SCORE_EVENT_KEYS) {
      expect(onScreen.has(key), `событие ${key} принимается сервером на правку, но не показано в Настройках`).toBe(
        true
      );
    }
    expect(onScreen.size).toBe(EDITABLE_SCORE_EVENT_KEYS.length);
  });

  it("два события, из-за которых и заведена проверка, на месте и правятся", () => {
    expect(EDITABLE_SCORE_EVENT_KEYS).toContain("lead_ignored");
    expect(EDITABLE_SCORE_EVENT_KEYS).toContain("client_recovered_bonus");
    expect(DEFAULT_EVENT_POINTS.lead_ignored).toBe(-2);
    expect(DEFAULT_EVENT_POINTS.client_recovered_bonus).toBe(3);
  });

  it("устаревшие виды остаются в каталоге, но правке не подлежат", () => {
    // Строки журнала с ними надо уметь прочитать, а кнопка правки была бы
    // кнопкой в никуда: kpi_override запрещён с 03.08.2026 (Fair Play),
    // lead_missed — старое имя call_15min_missed.
    expect(DEFAULT_EVENT_POINTS.kpi_override).toBe(0);
    expect(DEFAULT_EVENT_POINTS.lead_missed).toBe(-5);
    expect(EDITABLE_SCORE_EVENT_KEYS).not.toContain("kpi_override");
    expect(EDITABLE_SCORE_EVENT_KEYS).not.toContain("lead_missed");
  });
});
