import { describe, expect, it } from "vitest";
import { PERMISSIONS, PERMISSION_GROUPS, ROLE_PRESET_SUMMARY } from "@royal-home/shared";

/**
 * Подписи прав на экране «Права по ролям» (аудит 20.11.2026, К02.3/2.6): под правом без пояснения стоял его КОД
 * (`reports.view`, `agents.reset2fa`), а в пояснении было слово капсом. Реестр в `packages/shared/src/permissions.ts` —
 * единственное место подписей; этот тест не даёт добавить право без человеческого описания.
 */
const CODE_LIKE = /(?<![\p{L}\d])[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*(?![\p{L}\d])/u;
const SHOUTING = /(?<![\p{L}])[А-ЯЁA-Z]{5,}(?![\p{L}])/u;

describe("подписи прав доступа", () => {
  it("у каждого права есть название и пояснение человеческими словами", () => {
    const bad: string[] = [];
    for (const p of PERMISSIONS) {
      const hint = "hint" in p ? (p.hint as string | undefined) : undefined;
      if (!p.label.trim()) bad.push(`${p.id}: нет названия`);
      if (!hint || hint.trim().length < 8) bad.push(`${p.id}: нет пояснения`);
      for (const [what, text] of [["название", p.label], ["пояснение", hint ?? ""]] as const) {
        if (CODE_LIKE.test(text)) bad.push(`${p.id}: в ${what} код вместо слов «${text}»`);
        if (SHOUTING.test(text)) bad.push(`${p.id}: в ${what} слово капсом «${text}»`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("описания групп и ролей без капса и без кодов", () => {
    const texts = [
      ...PERMISSION_GROUPS.flatMap((g) => [g.label, g.hint]),
      ...Object.values(ROLE_PRESET_SUMMARY),
    ];
    const bad = texts.filter((t) => SHOUTING.test(t) || CODE_LIKE.test(t));
    expect(bad).toEqual([]);
  });

  it("сторож проверен поломкой: ловит код права, капс и пустое пояснение", () => {
    expect(CODE_LIKE.test("reports.view")).toBe(true);
    expect(CODE_LIKE.test("agents.reset2fa")).toBe(true);
    expect(CODE_LIKE.test("Отчёты по сделкам и откуда приходят заявки.")).toBe(false);
    expect(SHOUTING.test("видит ТОЛЬКО собственные")).toBe(true);
    expect(SHOUTING.test("ЖК, ООО, ГУВД")).toBe(false);
  });
});
