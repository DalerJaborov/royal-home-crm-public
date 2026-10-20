import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { notificationLevelOf } from "@royal-home/shared";
import { prisma } from "../src/db.js";
import { createNotification, createNotifications } from "../src/lib/notifications.js";
import { sendPushToAgents } from "../src/push.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * ЧЕТЫРЕ УРОВНЯ ПО СУТИ ДЕЛА (владелец 09.09.2026, переделано 12.09.2026:
 * ждёт решения / критичное / инсайты / прочее — вместо шкалы громкости).
 *
 * Главное, что здесь проверяется, — не сама запись уровня, а ДВА способа его
 * молча потерять:
 *
 *  1. Уровень выводится из вида уведомления. Если бы его требовалось указывать
 *     явно, сотня старых мест вызова писала бы NORMAL, и раздел «Срочное» стоял
 *     бы пустым — то есть его бы не было.
 *
 *  2. sendPushToAgents ПИШЕТ ТУ ЖЕ СТРОКУ ЛЕНТЫ вторым проходом, с тем же tag.
 *     Без уровня в payload этот второй проход пересчитал бы важность из kind и
 *     затёр бы явный URGENT — каждый аларм по отдельности выглядел бы верным, а
 *     «Срочное» тихо пустело.
 */

const runId = Date.now();
let agentId: string;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Получатель ${runId}`, phone: `+992959${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { agentId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

async function levelOfTag(tag: string): Promise<string | undefined> {
  const row = await prisma.notification.findFirst({ where: { agentId, tag }, orderBy: { createdAt: "desc" } });
  return row?.level;
}

describe("Уровень по виду уведомления", () => {
  /** Первый уровень владельца — «ждёт моего решения». У агента это ровно лид:
   *  пока он не принял, клиент на той стороне остаётся без ответа. */
  it("новый лид — ждёт решения агента", () => {
    expect(notificationLevelOf("lead")).toBe("APPROVAL");
  });

  it("Royal Score и сообщение клиента — прочее, контроль руководителя — критичное", () => {
    expect(notificationLevelOf("score")).toBe("OTHER");
    expect(notificationLevelOf("message")).toBe("OTHER");
    expect(notificationLevelOf("oversight")).toBe("CRITICAL");
  });

  it("незнакомый вид — «прочее», а не критичное", () => {
    expect(notificationLevelOf("alarm")).toBe("OTHER");
    expect(notificationLevelOf(null)).toBe("OTHER");
  });

  it("явно заданный уровень перебивает вид", () => {
    expect(notificationLevelOf("score", "CRITICAL")).toBe("CRITICAL");
    // Мусор вместо уровня игнорируется, а не записывается как есть.
    expect(notificationLevelOf("lead", "ОЧЕНЬ СРОЧНО")).toBe("APPROVAL");
    expect(notificationLevelOf("score", "ОЧЕНЬ СРОЧНО")).toBe("OTHER");
  });
});

describe("Первый уровень — то, что блокирует работу других", () => {
  /**
   * Владелец назвал этот уровень первым и объяснил почему: «они блокируют
   * работу людей». Проверяем не формулировку, а что три названных им повода
   * действительно попадают в APPROVAL, а не тонут в «Прочем».
   *
   * Проверка нужна именно здесь: у всех трёх `kind: "oversight"`, умолчание по
   * которому — CRITICAL. Без явной пометки они легли бы во второй раздел, и
   * очередь одобрений выглядела бы пустой при полном ящике заявок.
   */
  const sources = [
    ["заявка на удаление клиента", "apps/api/src/routes/clients/deleteRequests.ts"],
    ["спор о числе объектов", "apps/api/src/routes/clients/propertyCountDisputes.ts"],
    ["фото и видео объекта на проверку", "apps/api/src/lib/propertyPipeline.ts"],
  ] as const;

  it.each(sources)("%s помечена уровнем APPROVAL в коде", async (_what, file) => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL(`../../../${file}`, import.meta.url), "utf8");
    expect(src).toContain('level: "APPROVAL"');
  });

  it("APPROVAL не выводится из вида — только явной пометкой", () => {
    // oversight по умолчанию критичный: если пометку в коде потеряют,
    // заявка молча уедет во второй раздел, и тест выше это поймает.
    expect(notificationLevelOf("oversight")).toBe("CRITICAL");
  });
});

describe("Запись в ленту", () => {
  it("уровень не указан — выводится из вида", async () => {
    const tag = `lvl-default-${runId}`;
    await createNotification({ agentId, kind: "score", title: "Royal Score", body: "+2", tag });
    expect(await levelOfTag(tag)).toBe("OTHER");
  });

  it("уровень указан явно — записывается он", async () => {
    const tag = `lvl-explicit-${runId}`;
    await createNotifications([agentId], {
      kind: "alarm",
      level: "CRITICAL",
      title: "Продавец не может связаться с агентом",
      body: "второй день",
      tag,
    });
    expect(await levelOfTag(tag)).toBe("CRITICAL");
  });

  /**
   * Тот самый второй проход. Аларм пишет строку сам (await, чтобы её сразу
   * видели тесты), а следом sendPushToAgents пишет её же по тому же tag.
   */
  it("push по тому же tag НЕ понижает явно заданный уровень", async () => {
    const tag = `lvl-push-${runId}`;
    const payload = {
      kind: "oversight" as const,
      level: "CRITICAL" as const,
      title: "Продавец без объекта",
      body: "5 дней после съёмки",
      tag,
    };
    await createNotifications([agentId], payload);
    expect(await levelOfTag(tag)).toBe("CRITICAL");
    await sendPushToAgents([agentId], payload);
    // Запись ленты внутри sendPushToAgents идёт через void. Дожидаемся самой записи —
    // она увеличивает count строки (схлопывание по tag), — а не гадаем паузой: под
    // нагрузкой 300 мс не хватало, и тест проверял СТАРУЮ строку (№202).
    await waitFor(
      async () => ((await prisma.notification.findFirst({ where: { agentId, tag }, select: { count: true } }))?.count ?? 0) >= 2,
      { label: "вторая запись ленты по тому же tag (count ≥ 2)" }
    );
    expect(await levelOfTag(tag)).toBe("CRITICAL");
  });

  it("повторение того же повода может сменить уровень", async () => {
    const tag = `lvl-raise-${runId}`;
    await createNotification({ agentId, kind: "task", title: "Задача просрочена", body: "первый раз", tag });
    expect(await levelOfTag(tag)).toBe("OTHER");
    await createNotification({
      agentId,
      kind: "task",
      level: "CRITICAL",
      title: "Задача просрочена четвёртый раз",
      body: "четвёртый раз",
      tag,
    });
    expect(await levelOfTag(tag)).toBe("CRITICAL");
    // И это по-прежнему ОДНА строка, а не две — схлопывание по tag не сломано.
    expect(await prisma.notification.count({ where: { agentId, tag } })).toBe(1);
  });
});
