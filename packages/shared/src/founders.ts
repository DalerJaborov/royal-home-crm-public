import { z } from "zod";
import { expenseDateSchema } from "./expenseWorkspace.js";
import { centsToTjs, toCents } from "./money.js";

/**
 * ВЗНОСЫ УЧРЕДИТЕЛЕЙ (17.11.2026).
 *
 * Владелец 14.11: «Взнос от учредителей. Там их трое, поэтому надо имя писать вручную. Баходур.
 * Илхом. Мирсаид. И возможность удалить или добавить ещё кого-то».
 *
 * Взнос — деньги, которые учредитель вложил в компанию. Это НЕ доход от продаж: в выручку,
 * прибыль, комиссию и стоимость лида он не входит никогда. Отдельная таблица FounderContribution,
 * отдельный итог «вложено учредителями» по каждому — за месяц и за всё время.
 *
 * Учредитель удаляется мягко (deletedAt): его прошлые взносы остаются в истории и в итогах
 * «за всё время» с пометкой «удалён из списка», новые на него не записываются.
 */

export const founderNameSchema = z.string().trim().min(1, "Укажите имя").max(80);

export const founderCreateSchema = z.object({ name: founderNameSchema }).strict();
export const founderUpdateSchema = z.object({
  name: founderNameSchema.optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
}).strict();

const contributionAmount = z.coerce.number()
  .transform((v) => Math.round(v * 100) / 100)
  .pipe(z.number().positive("Сумма должна быть больше нуля").max(99_999_999.99, "Сумма слишком большая"));

export const founderContributionCreateSchema = z.object({
  founderId: z.uuid(),
  amount: contributionAmount,
  currency: z.enum(["TJS", "USD"]).default("TJS"),
  /** Курс доллара на день взноса; не указан — берётся из Настроек. */
  exchangeRate: z.number().positive().max(1000).nullish(),
  /** День, когда деньги внесены (по Душанбе). */
  date: expenseDateSchema,
  note: z.string().trim().max(300).nullish(),
}).strict();

export const founderContributionUpdateSchema = founderContributionCreateSchema.partial().strict();

export const founderContributionListQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  founderId: z.uuid().optional(),
});

export type FounderCreateInput = z.infer<typeof founderCreateSchema>;
export type FounderUpdateInput = z.infer<typeof founderUpdateSchema>;
export type FounderContributionCreateInput = z.input<typeof founderContributionCreateSchema>;
export type FounderContributionUpdateInput = z.input<typeof founderContributionUpdateSchema>;

export interface FounderItem {
  id: string;
  name: string;
  sortOrder: number;
  /** Удалён из списка: новые взносы не принимаются, история цела. */
  deleted: boolean;
}

export interface FounderContributionItem {
  id: string;
  founderId: string;
  founderName: string;
  amount: string;
  currency: "TJS" | "USD";
  exchangeRate: string | null;
  amountTjs: number;
  date: string;
  month: string;
  note: string | null;
  createdBy: { id: string; fullName: string } | null;
}

export interface FounderTotalsRow {
  founderId: string;
  name: string;
  deleted: boolean;
  /** Сомони за выбранный месяц. */
  monthTjs: number;
  /** Сомони за всё время. */
  allTimeTjs: number;
  monthCount: number;
  allTimeCount: number;
}

export interface FounderTotals {
  month: string;
  founders: FounderTotalsRow[];
  monthTjs: number;
  allTimeTjs: number;
}

export interface FounderContributionLike {
  founderId: string;
  amount: unknown;
  currency: string;
  exchangeRate: unknown;
  /** Первый день месяца «ГГГГ-ММ». */
  month: string;
}

/**
 * Итоги взносов по учредителям: за месяц и за всё время, в сомони до копейки. Курс — свой у
 * каждого взноса (зафиксирован в день записи); нет своего — курс CRM `usdToTjs`.
 * Порядок — как в списке учредителей; удалённые с взносами остаются в итогах.
 */
export function founderContributionTotals(
  founders: readonly { id: string; name: string; sortOrder: number; deleted: boolean }[],
  contributions: readonly FounderContributionLike[],
  month: string,
  usdToTjs: number,
): FounderTotals {
  const rows = new Map<string, { m: number; a: number; mc: number; ac: number }>();
  for (const c of contributions) {
    const rate = c.currency === "USD" && Number(c.exchangeRate) > 0 ? Number(c.exchangeRate) : usdToTjs;
    const cents = centsToTjs(toCents(c.amount), c.currency, rate);
    const row = rows.get(c.founderId) ?? { m: 0, a: 0, mc: 0, ac: 0 };
    row.a += cents; row.ac += 1;
    if (c.month === month) { row.m += cents; row.mc += 1; }
    rows.set(c.founderId, row);
  }
  const list = [...founders]
    .filter((f) => !f.deleted || rows.has(f.id))
    .sort((x, y) => Number(x.deleted) - Number(y.deleted) || x.sortOrder - y.sortOrder || x.name.localeCompare(y.name, "ru"))
    .map((f) => {
      const r = rows.get(f.id) ?? { m: 0, a: 0, mc: 0, ac: 0 };
      return { founderId: f.id, name: f.name, deleted: f.deleted, monthTjs: r.m / 100, allTimeTjs: r.a / 100, monthCount: r.mc, allTimeCount: r.ac };
    });
  const sum = (key: "monthTjs" | "allTimeTjs") => Math.round(list.reduce((acc, r) => acc + r[key] * 100, 0)) / 100;
  return { month, founders: list, monthTjs: sum("monthTjs"), allTimeTjs: sum("allTimeTjs") };
}

/**
 * Строка отчёта похожа на взнос учредителя («взнос Баходур», «вклад от Илхома», «аз Мирсаид»):
 * возвращает учредителя из списка или null. Имя ищется по основе (первые 4 буквы без окончания:
 * «Баходура», «Баходуру» → «Баходур»). Без слова «взнос/вклад/вложил/инвест» имя само по себе
 * взносом не считается: «такси Илхому» — расход.
 */
const CONTRIBUTION_WORDS = /взнос|вклад|влож|инвест|учредит|муассис|саҳм|сахм|ҳисса|хисса/iu;
export function founderOfContributionText(
  text: string | null | undefined,
  founders: readonly { id: string; name: string; deleted?: boolean }[],
): { id: string; name: string } | null {
  if (!text || !CONTRIBUTION_WORDS.test(text)) return null;
  const lower = text.toLowerCase().replace(/ё/g, "е");
  for (const f of founders) {
    if (f.deleted) continue;
    const name = f.name.trim().toLowerCase().replace(/ё/g, "е");
    if (!name) continue;
    const stem = name.length > 5 ? name.slice(0, name.length - 1) : name;
    if (lower.includes(stem)) return { id: f.id, name: f.name };
  }
  return null;
}
