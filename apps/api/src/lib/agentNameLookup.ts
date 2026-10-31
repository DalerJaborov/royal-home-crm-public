import { prisma } from "../db.js";

/**
 * СОТРУДНИК ПО ИМЕНИ, КАК ЕГО НАЗЫВАЕТ ЧЕЛОВЕК В ЧАТЕ (31.10.2026, ИИ-помощник П3).
 *
 * «Передай Сайфуллоеву», «клиенты агента Нозы» — модель знает только слова, а
 * запись идёт по id. Правило одно: выбирать за человека НЕЛЬЗЯ. Ровно один
 * подходящий активный сотрудник — он; ни одного или несколько — отказ со списком
 * кандидатов, пусть человек уточнит. Полное совпадение имени (без учёта регистра
 * и лишних пробелов) сильнее частичного: «Иванов Иван» не путается с
 * «Иванов Иван Петрович».
 *
 * Только активные (`isActive`): уволенному ничего не назначают и его не ищут.
 * Замороженные (отпуск) находятся — пусть отказ скажет причину словами
 * `checkManualAssignTarget`, а не «не найден».
 */
export type AgentNameMatch =
  | { kind: "one"; agent: { id: string; fullName: string } }
  | { kind: "none" }
  | { kind: "many"; candidates: { id: string; fullName: string }[] };

const MAX_CANDIDATES = 6;
const normalize = (text: string) => text.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();

export async function findActiveAgentByName(rawName: string): Promise<AgentNameMatch> {
  const name = rawName.replace(/\s+/g, " ").trim();
  if (name.length < 2) return { kind: "none" };
  const tokens = name.split(" ").filter((t) => t.length >= 2).slice(0, 4);
  if (tokens.length === 0) return { kind: "none" };
  const rows = await prisma.agent.findMany({
    where: {
      isActive: true,
      AND: tokens.map((token) => ({ fullName: { contains: token, mode: "insensitive" as const } })),
    },
    select: { id: true, fullName: true },
    orderBy: { fullName: "asc" },
    take: MAX_CANDIDATES + 1,
  });
  if (rows.length === 0) return { kind: "none" };
  const exact = rows.filter((row) => normalize(row.fullName) === normalize(name));
  if (exact.length === 1) return { kind: "one", agent: exact[0] };
  if (rows.length === 1) return { kind: "one", agent: rows[0] };
  return { kind: "many", candidates: rows.slice(0, MAX_CANDIDATES) };
}
