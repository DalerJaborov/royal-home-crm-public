import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * ТОЧНАЯ ПОМЕТКА «ПЕРЕДАН» В ЛЕНТЕ УВЕДОМЛЕНИЙ (Пачка 19, 12.09.2026).
 *
 * До Notification.retiredAt/retiredReason фронт красил «Передан» эвристикой
 * (kind==="lead" && read && url на карточку клиента,
 * apps/web/src/lib/notificationTransferHint.ts, удалён этой пачкой) —
 * лид, который агент честно принял и прочитал сам, тоже подходил под условие.
 *
 * Здесь проверяем именно НОВЫЙ признак:
 * 1. `closeNotifications` ставит retiredAt (не null) и retiredReason (текст
 *    причины) на погашенной строке — сырым `$queryRaw`, потому что клиент
 *    Prisma в этом заходе не перегенерирован (см. agent-brief Пачка 19) и не
 *    знает о новых колонках; `prisma.notification.findMany` их тоже не отдаст
 *    до `prisma generate`.
 * 2. Обычное «агент открыл ленту и прочитал» (`POST /:id/read`, эмулируем
 *    прямым `update({ data: { read: true } })`, как остальные тесты этого
 *    файла-соседа notification-grouping.test.ts) НЕ ставит retiredAt — это и
 *    есть разница со старой эвристикой.
 * 3. Счётчик непрочитанных (`read:false`, тот же запрос, что
 *    `routes/notifications.ts::GET /`) исключает погашенную retired-строку,
 *    потому что closeNotifications ставит read=true и retiredAt ОДНИМ вызовом.
 */

const { prisma } = await import("../src/db.js");
const { closeNotifications, createNotification } = await import("../src/lib/notifications.js");

const runId = Date.now();
let agentId: string;
const clientId = `11111111-1111-4111-8111-${String(runId).padStart(12, "0")}`;

async function retiredColumns(id: string) {
  const rows = await prisma.$queryRaw<{ retiredAt: Date | null; retiredReason: string | null; read: boolean }[]>`
    SELECT "retiredAt", "retiredReason", "read" FROM "Notification" WHERE id = ${id}
  `;
  return rows[0] ?? null;
}

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент retired-флага", phone: `+992936${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

beforeEach(async () => {
  await prisma.notification.deleteMany({ where: { agentId } });
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { agentId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("closeNotifications — ставит retiredAt/retiredReason, а не только read", () => {
  it("гашение по tag помечает retiredAt и кладёт человекочитаемую причину", async () => {
    await createNotification({
      agentId,
      kind: "lead",
      title: "🔔 Новый лид",
      body: "Клиент retired-теста",
      url: `/clients/9001`,
      tag: `lead-${clientId}`,
    });
    const [before] = await prisma.notification.findMany({ where: { agentId, tag: `lead-${clientId}` } });
    expect((await retiredColumns(before.id))?.retiredAt).toBeNull();

    await closeNotifications(agentId, { clientId, clientShortId: 9001 }, "Клиент передан Иванову");

    const after = await retiredColumns(before.id);
    expect(after?.read).toBe(true);
    expect(after?.retiredAt).not.toBeNull();
    expect(after?.retiredReason).toBe("Клиент передан Иванову");
  });

  it("обычное «агент прочитал сам» retiredAt не ставит — разница со старой эвристикой", async () => {
    await createNotification({
      agentId,
      kind: "lead",
      title: "🔔 Новый лид",
      body: "Клиент, которого агент честно принял",
      url: `/clients/9002`,
      tag: `lead-own-${runId}`,
    });
    const [row] = await prisma.notification.findMany({ where: { agentId, tag: `lead-own-${runId}` } });

    // То же самое, что делает POST /notifications/:id/read.
    await prisma.notification.update({ where: { id: row.id }, data: { read: true } });

    const after = await retiredColumns(row.id);
    expect(after?.read).toBe(true);
    expect(after?.retiredAt).toBeNull();
  });

  it("счётчик непрочитанных (read:false) исключает погашенную retired-строку", async () => {
    await createNotification({
      agentId,
      kind: "lead",
      title: "🔔 Новый лид",
      body: "Клиент retired-счётчика",
      url: `/clients/9003`,
      tag: `lead-count-${runId}`,
    });

    const unreadBefore = await prisma.notification.count({ where: { agentId, read: false } });
    expect(unreadBefore).toBe(1);

    await closeNotifications(agentId, { clientId: `count-${runId}`, clientShortId: 9003 }, "Клиент передан Петрову");

    const unreadAfter = await prisma.notification.count({ where: { agentId, read: false } });
    expect(unreadAfter).toBe(0);
  });

  it("длинная причина обрезается до 300 символов — подпись строки, не полный текст", async () => {
    await createNotification({
      agentId,
      kind: "lead",
      title: "🔔 Новый лид",
      body: "Клиент с длинной причиной",
      url: `/clients/9004`,
      tag: `lead-long-${runId}`,
    });
    const [row] = await prisma.notification.findMany({ where: { agentId, tag: `lead-long-${runId}` } });

    const longReason = "Агент заморожен руководителем: " + "очень подробное объяснение ".repeat(20);
    await closeNotifications(agentId, { clientId: `long-${runId}`, clientShortId: 9004 }, longReason);

    const after = await retiredColumns(row.id);
    expect(after?.retiredReason?.length).toBeLessThanOrEqual(300);
  });
});
