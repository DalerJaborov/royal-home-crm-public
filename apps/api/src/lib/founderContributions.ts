import {
  founderContributionCreateSchema, founderContributionListQuerySchema, founderContributionTotals, founderContributionUpdateSchema,
  founderCreateSchema, founderUpdateSchema,
  type FounderContributionItem, type FounderItem, type FounderTotals,
} from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { Prisma, type Founder, type FounderContribution } from "../generated/prisma/client.js";
import { centsToTjs, fromCents, loadMoneyContext, NO_USD_RATE_TEXT, toCents, usdRateForWrite } from "./money.js";
import { todayExpenseDay } from "./expenseWorkspace.js";

/**
 * ВЗНОСЫ УЧРЕДИТЕЛЕЙ — одна дверь записи для REST и помощницы (17.11.2026).
 * Правило итогов — packages/shared/src/founders.ts. Взнос не доход от продаж: ни выручка,
 * ни прибыль, ни комиссия его не видят (эта таблица больше нигде не читается).
 */
export class FounderCommandError extends Error {
  constructor(readonly status: number, readonly body: { error: string; [key: string]: unknown }) {
    super(body.error);
    this.name = "FounderCommandError";
  }
}
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): never => {
  throw new FounderCommandError(status, { error, ...extra });
};

const monthDate = (month: string) => new Date(`${month}-01T00:00:00.000Z`);
const FOUNDERS_LIMIT = 200;
const CONTRIBUTIONS_LIMIT = 5000;

export function founderDto(f: Pick<Founder, "id" | "name" | "sortOrder" | "deletedAt">): FounderItem {
  return { id: f.id, name: f.name, sortOrder: f.sortOrder, deleted: !!f.deletedAt };
}

/** Список учредителей: живые по порядку; удалённые — только если просили (история). */
export async function listFounders(opts: { includeDeleted?: boolean; db?: TxClient } = {}): Promise<FounderItem[]> {
  const rows = await (opts.db ?? prisma).founder.findMany({
    where: opts.includeDeleted ? {} : { deletedAt: null },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    take: FOUNDERS_LIMIT,
  });
  return rows.map(founderDto);
}

/** Одноимённый живой учредитель — не заводим второго «Илхома»: взносы разъедутся на двоих. */
async function assertNameFree(name: string, exceptId?: string) {
  const same = await prisma.founder.findFirst({
    where: { deletedAt: null, name: { equals: name, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (same) fail(409, `Учредитель «${name}» уже есть в списке`);
}

export async function createFounder(raw: unknown): Promise<FounderItem> {
  const parsed = founderCreateSchema.safeParse(raw);
  if (!parsed.success) fail(400, parsed.error!.issues[0]?.message ?? "Неверные данные");
  const name = parsed.data!.name;
  await assertNameFree(name);
  // Удалённый с тем же именем возвращается в список: его старые взносы снова при нём.
  const deleted = await prisma.founder.findFirst({ where: { deletedAt: { not: null }, name: { equals: name, mode: "insensitive" } } });
  const last = await prisma.founder.aggregate({ _max: { sortOrder: true } });
  const sortOrder = (last._max.sortOrder ?? 0) + 1;
  const row = deleted
    ? await prisma.founder.update({ where: { id: deleted.id }, data: { deletedAt: null, name, sortOrder } })
    : await prisma.founder.create({ data: { name, sortOrder } });
  return founderDto(row);
}

export async function updateFounder(id: string, raw: unknown): Promise<FounderItem> {
  const parsed = founderUpdateSchema.safeParse(raw);
  if (!parsed.success) fail(400, parsed.error!.issues[0]?.message ?? "Неверные данные");
  const current = await prisma.founder.findUnique({ where: { id } });
  if (!current || current.deletedAt) fail(404, "Учредитель не найден");
  if (parsed.data!.name) await assertNameFree(parsed.data!.name, id);
  return founderDto(await prisma.founder.update({ where: { id }, data: parsed.data! }));
}

/** Мягкое удаление: новые взносы на него не пишутся, прошлые остаются в итогах. */
export async function deleteFounder(id: string): Promise<FounderItem> {
  const current = await prisma.founder.findUnique({ where: { id } });
  if (!current || current.deletedAt) fail(404, "Учредитель не найден");
  return founderDto(await prisma.founder.update({ where: { id }, data: { deletedAt: new Date() } }));
}

export async function restoreFounder(id: string): Promise<FounderItem> {
  const current = await prisma.founder.findUnique({ where: { id } });
  if (!current) fail(404, "Учредитель не найден");
  if (!current!.deletedAt) return founderDto(current!);
  await assertNameFree(current!.name, id);
  return founderDto(await prisma.founder.update({ where: { id }, data: { deletedAt: null } }));
}

type ContributionWithFounder = FounderContribution & { founder: Pick<Founder, "name"> };

async function contributionDtos(rows: ContributionWithFounder[], db: TxClient = prisma): Promise<FounderContributionItem[]> {
  const [authors, money] = await Promise.all([
    db.agent.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => (r.createdById ? [r.createdById] : [])))] } }, select: { id: true, fullName: true } }),
    loadMoneyContext(db),
  ]);
  const names = new Map(authors.map((a) => [a.id, a]));
  return rows.map((r) => {
    const rate = r.currency === "USD" && Number(r.exchangeRate) > 0 ? Number(r.exchangeRate) : money.usdToTjs;
    return {
      id: r.id, founderId: r.founderId, founderName: r.founder.name, amount: r.amount.toString(), currency: r.currency,
      exchangeRate: r.exchangeRate?.toString() ?? null, amountTjs: fromCents(centsToTjs(toCents(r.amount), r.currency, { usdToTjs: rate })),
      date: r.date, month: r.month.toISOString().slice(0, 7), note: r.note,
      createdBy: r.createdById ? names.get(r.createdById) ?? null : null,
    };
  });
}

export async function listContributions(rawQuery: unknown): Promise<FounderContributionItem[]> {
  const parsed = founderContributionListQuerySchema.safeParse(rawQuery);
  if (!parsed.success) fail(400, "Неверный фильтр");
  const q = parsed.data!;
  const rows = await prisma.founderContribution.findMany({
    where: { deletedAt: null, ...(q.month ? { month: monthDate(q.month) } : {}), ...(q.founderId ? { founderId: q.founderId } : {}) },
    include: { founder: { select: { name: true } } },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: CONTRIBUTIONS_LIMIT,
  });
  return contributionDtos(rows);
}

export interface CreateContributionOptions { agentId: string; requestKey?: string; db?: TxClient }

/** Записать взнос. Курс доллара — свой или из Настроек; без курса доллар не пишем (как расходы). */
export async function createContribution(raw: unknown, opts: CreateContributionOptions): Promise<FounderContributionItem> {
  const parsed = founderContributionCreateSchema.safeParse(raw);
  if (!parsed.success) fail(400, parsed.error!.issues[0]?.message ?? "Неверные данные", { details: parsed.error!.flatten() });
  const data = parsed.data!;
  const db = opts.db ?? prisma;
  if (data.date > todayExpenseDay()) fail(400, "Взнос будущим числом не записывается");
  const founder = await db.founder.findUnique({ where: { id: data.founderId } });
  if (!founder || founder.deletedAt) fail(400, "Учредитель удалён из списка. Верните его в список или выберите другого");
  const rate = data.currency === "USD" ? data.exchangeRate ?? await usdRateForWrite(db) : 1;
  if (rate == null) fail(409, NO_USD_RATE_TEXT, { code: "NO_USD_RATE" });
  const row = {
    founderId: data.founderId, amount: data.amount, currency: data.currency, exchangeRate: rate,
    date: data.date, month: monthDate(data.date.slice(0, 7)), note: data.note?.trim() || null, createdById: opts.agentId,
    requestKey: opts.requestKey ?? null,
  };
  const include = { founder: { select: { name: true } } } as const;
  // Повтор с тем же ключом (двойное нажатие, повтор пачки) — тот же взнос; другой взнос под тем же
  // ключом — 409, как у расходов (ревью 17.11: upsert молча отдавал старый).
  const replay = async () => {
    const existing = await db.founderContribution.findUnique({ where: { requestKey: opts.requestKey! }, include });
    if (!existing) return null;
    const same = existing.founderId === row.founderId && Number(existing.amount) === row.amount && existing.currency === row.currency && existing.date === row.date;
    if (!same) fail(409, "Этот ключ уже использован для другого взноса", { code: "IDEMPOTENCY_CONFLICT" });
    return existing;
  };
  let created = opts.requestKey ? await replay() : null;
  if (!created) {
    try {
      created = await db.founderContribution.create({ data: row, include });
    } catch (err) {
      // Два одинаковых запроса в одну секунду: второй видит запись первого.
      if (!(opts.requestKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
      created = await replay();
      if (!created) throw err;
    }
  }
  return (await contributionDtos([created], db))[0]!;
}

export async function updateContribution(id: string, raw: unknown): Promise<FounderContributionItem> {
  const parsed = founderContributionUpdateSchema.safeParse(raw);
  if (!parsed.success) fail(400, parsed.error!.issues[0]?.message ?? "Неверные данные");
  const patch = parsed.data!;
  const current = await prisma.founderContribution.findUnique({ where: { id } });
  if (!current || current.deletedAt) fail(404, "Взнос не найден");
  if (patch.date && patch.date > todayExpenseDay()) fail(400, "Взнос будущим числом не записывается");
  if (patch.founderId && patch.founderId !== current!.founderId) {
    const founder = await prisma.founder.findUnique({ where: { id: patch.founderId } });
    if (!founder || founder.deletedAt) fail(400, "Учредитель удалён из списка");
  }
  const currency = patch.currency ?? current!.currency;
  let exchangeRate: number | null | undefined;
  if (patch.exchangeRate != null) exchangeRate = currency === "USD" ? patch.exchangeRate : 1;
  else if (patch.currency && patch.currency !== current!.currency) {
    exchangeRate = currency === "USD" ? await usdRateForWrite() : 1;
    if (exchangeRate == null) fail(409, NO_USD_RATE_TEXT, { code: "NO_USD_RATE" });
  }
  const updated = await prisma.founderContribution.update({
    where: { id },
    data: {
      ...(patch.founderId ? { founderId: patch.founderId } : {}),
      ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
      ...(patch.currency ? { currency: patch.currency } : {}),
      ...(exchangeRate !== undefined ? { exchangeRate } : {}),
      ...(patch.date ? { date: patch.date, month: monthDate(patch.date.slice(0, 7)) } : {}),
      ...(patch.note !== undefined ? { note: patch.note?.trim() || null } : {}),
    },
    include: { founder: { select: { name: true } } },
  });
  return (await contributionDtos([updated]))[0]!;
}

export async function deleteContribution(id: string): Promise<FounderContribution> {
  const current = await prisma.founderContribution.findUnique({ where: { id } });
  if (!current || current.deletedAt) fail(404, "Взнос не найден");
  return prisma.founderContribution.update({ where: { id }, data: { deletedAt: new Date() } });
}

export async function restoreContribution(id: string): Promise<FounderContributionItem> {
  const current = await prisma.founderContribution.findUnique({ where: { id }, include: { founder: true } });
  if (!current) fail(404, "Взнос не найден");
  if (current!.founder.deletedAt) fail(409, "Учредитель удалён из списка. Сначала верните его в список");
  const row = await prisma.founderContribution.update({ where: { id }, data: { deletedAt: null }, include: { founder: { select: { name: true } } } });
  return (await contributionDtos([row]))[0]!;
}

/** Итоги по учредителям: за месяц и за всё время. Используют Деньги и PDF-отчёт. */
export async function founderTotals(month: string): Promise<FounderTotals> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail(400, "Формат месяца: ГГГГ-ММ");
  const [founders, groups, money] = await Promise.all([
    prisma.founder.findMany({ take: FOUNDERS_LIMIT }),
    // Суммы базой по учредителю, месяцу, валюте и курсу — без потолка строк (ревью 17.11): сколько
    // бы взносов ни накопилось, итог «за всё время» не обрезается.
    prisma.founderContribution.groupBy({
      by: ["founderId", "month", "currency", "exchangeRate"],
      where: { deletedAt: null },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    loadMoneyContext(),
  ]);
  const rows = groups.map((g) => ({
    founderId: g.founderId, amount: g._sum.amount ?? 0, currency: g.currency, exchangeRate: g.exchangeRate,
    month: g.month.toISOString().slice(0, 7), count: g._count._all,
  }));
  const totals = founderContributionTotals(
    founders.map((f) => ({ id: f.id, name: f.name, sortOrder: f.sortOrder, deleted: !!f.deletedAt })),
    rows,
    month,
    money.usdToTjs,
  );
  // Счётчики взносов — по числу строк, а не групп.
  for (const f of totals.founders) {
    f.allTimeCount = rows.filter((r) => r.founderId === f.founderId).reduce((n, r) => n + r.count, 0);
    f.monthCount = rows.filter((r) => r.founderId === f.founderId && r.month === month).reduce((n, r) => n + r.count, 0);
  }
  return totals;
}
