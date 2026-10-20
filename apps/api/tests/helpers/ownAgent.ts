import bcrypt from "bcrypt";
import { prisma } from "../../src/db.js";

/**
 * СВОЙ АГЕНТ ДЛЯ ТЕСТА, А НЕ ПЕРВЫЙ НАЙДЕННЫЙ В БАЗЕ (20.09.2026).
 *
 * Полтора десятка файлов брали исполнителя так:
 * `prisma.agent.findFirst({ where: { isActive: true } })` — и сразу `agent!.id`.
 * Агентов в базу тестов не сеет никто (`prisma:seed` в ci.yml стоит только перед
 * дымовыми проверками экранов и до тестов API не доходит), поэтому такой файл
 * зелёный ровно тогда, когда в его шард попал сосед, успевший завести агента и
 * ещё не убравший его за собой. От состава шарда и от порядка файлов зависеть
 * не должно ничто: на чистой базе эти файлы падали то «expected null not to be
 * null», то вовсе «Cannot read properties of null (reading id)» — причём падение
 * выглядело как поломка кода, а не как отсутствие данных. Найдено 20.09.2026:
 * девять падений в пяти файлах, и все пять чинятся одинаково — своим агентом.
 *
 * Убирать за собой — `deleteAgentsWithTraces` (cleanupAgents.ts): агент общий
 * ресурс, и раздача лидов могла отдать ему чужую карточку.
 */
export async function createTestAgent(fullName: string, role: "AGENT" | "DIRECTOR" = "AGENT"): Promise<string> {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  const agent = await prisma.agent.create({
    data: {
      fullName,
      // Случайный номер, а не производный от времени: два файла, запущенные в одну
      // миллисекунду, дали бы один и тот же и упали на уникальном индексе.
      phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`,
      role,
      passwordHash,
    },
  });
  return agent.id;
}
