import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { runDuplicatesWeeklyDigestTick } from "../src/lib/duplicatesWeeklyDigest.js";
import { flushDirectorAlertQueue } from "../src/lib/directorAlertQueue.js";

/**
 * Еженедельное напоминание о вероятных дубликатах (владелец 06.09.2026, разбор
 * слепых зон п.3). Экран «Клиенты → Дубли» сам по себе ничего не толкает —
 * проверяем, что теперь раз в неделю тем, у кого есть право clients.merge,
 * уходит одно уведомление с текущим числом групп, без дублей внутри той же
 * недели и без уведомления, когда дублей нет вовсе.
 *
 * 07.09.2026: сама доставка теперь идёт через общую очередь алармов
 * руководству (lib/directorAlertQueue.ts) — runDuplicatesWeeklyDigestTick
 * только считает и ставит в очередь, flushDirectorAlertQueue доставляет,
 * только в часы алармов. Фиксированное время недельного крона (09:20 по
 * Душанбе) само по себе НЕ входит в часы алармов по умолчанию (9:50–14:45) —
 * поэтому flush здесь вызывается с отдельным, заведомо «дневным» моментом.
 */
// 12:00 по Душанбе того же понедельника — заведомо внутри часов алармов.
const FLUSH_NOW = new Date("2026-09-07T07:00:00Z");
const FLUSH_NOW_NEXT_WEEK = new Date("2026-09-14T07:00:00Z");

const runId = Date.now();
const password = "testpass123";
let directorId: string;
const agentIds: string[] = [];
const clientIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  directorId = (
    await prisma.agent.create({
      data: { fullName: `Директор дублей ${runId}`, phone: `+992984${runId}`, role: "DIRECTOR", passwordHash },
    })
  ).id;
  agentIds.push(directorId);
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { startsWith: "duplicates-weekly-" } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

/**
 * Тик считает группы дублей по ВСЕЙ базе. На CI база поднимается миграциями и
 * пуста — там это ноль; на стенде и на проде рядом лежат чужие карточки. Жёсткие
 * «0» и «1» были бы ожиданием пустой базы, а не проверкой поведения.
 *
 * Прирост от собственной пары тоже не годится: замер «сколько было» приходится
 * делать раньше, чем проверка, а на общей базе чужая пара за это время может
 * исчезнуть (проверено 11.09.2026 — так и вышло). Поэтому ниже проверяется то,
 * что ВНУТРЕННЕ согласовано и от чужих данных не зависит: тик поставил
 * уведомление тогда и только тогда, когда нашёл хоть одну группу, а число в
 * тексте — ровно то, которое он вернул.
 */
describe("Еженедельное напоминание о дублях", () => {
  it("уведомление ставится в очередь только тогда, когда группы нашлись", async () => {
    const tag = "duplicates-weekly-2026-09-07";
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag } });
    const result = await runDuplicatesWeeklyDigestTick(new Date("2026-09-07T04:20:00Z"));
    const queued = await prisma.pendingDirectorAlert.findFirst({ where: { tag } });
    if (result.notified === 0) expect(queued).toBeNull();
    else expect(queued).not.toBeNull();
  });

  it("есть пара с совпадающим хвостом номера — уходит одно уведомление, повтор в ту же неделю не дублирует", async () => {
    const tail = `${runId}`.slice(-9);
    const a = await prisma.client.create({
      data: {
        fullName: `Дубль А ${runId}`,
        phone: `+992${tail}`,
        kind: "BUYER",
        currency: "TJS",
        source: "WALK_IN",
      },
    });
    const b = await prisma.client.create({
      data: {
        fullName: `Дубль Б ${runId}`,
        // Другой префикс, тот же хвост из 9 цифр — ровно то, что ловит /clients/duplicates.
        phone: `+7${tail}`,
        kind: "BUYER",
        currency: "TJS",
        source: "WALK_IN",
      },
    });
    clientIds.push(a.id, b.id);

    const now = new Date("2026-09-07T04:20:00Z"); // понедельник, момент фактического крона (09:20 Душанбе)
    const first = await runDuplicatesWeeklyDigestTick(now);
    // Наша пара точно среди найденных, поэтому «не меньше одной»; сколько
    // именно — зависит от базы, и это не то, что проверяет тест.
    expect(first.notified).toBeGreaterThanOrEqual(1);
    await flushDirectorAlertQueue(FLUSH_NOW);

    const notes = await prisma.notification.findMany({ where: { agentId: directorId, tag: "duplicates-weekly-2026-09-07" } });
    expect(notes).toHaveLength(1);
    // Число в тексте — ровно то, которое вернул сам тик: проверяем связность
    // сообщения с подсчётом, а не совпадение с состоянием чужих карточек.
    expect(notes[0].body).toContain(`${first.notified} похож`);

    // Повторный тик в тот же день — тот же tag, upsertByTag схлопывает в одну строку.
    await runDuplicatesWeeklyDigestTick(new Date(now.getTime() + 60_000));
    await flushDirectorAlertQueue(FLUSH_NOW);
    const stillOne = await prisma.notification.findMany({ where: { agentId: directorId, tag: "duplicates-weekly-2026-09-07" } });
    expect(stillOne).toHaveLength(1);

    // Через неделю — новый tag, новое уведомление (не блокируется прошлым).
    const nextWeek = new Date("2026-09-14T04:20:00Z");
    const second = await runDuplicatesWeeklyDigestTick(nextWeek);
    expect(second.notified).toBeGreaterThanOrEqual(1);
    await flushDirectorAlertQueue(FLUSH_NOW_NEXT_WEEK);
    const nextWeekNotes = await prisma.notification.findMany({
      where: { agentId: directorId, tag: "duplicates-weekly-2026-09-14" },
    });
    expect(nextWeekNotes).toHaveLength(1);
  });
});
