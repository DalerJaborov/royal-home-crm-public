import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { autoResolveDuplicateErrors } from "../src/lib/autoResolveDuplicateErrors.js";

/**
 * АВТОЗАКРЫТИЕ ДУБЛЕЙ ОШИБОК (решение владельца 18.08.2026).
 *
 * До 25.09.2026 до этого файла не дотягивался ни один тест. Он идёт по
 * расписанию и ЗАКРЫВАЕТ записи в журнале ошибок: сломается в одну сторону —
 * директор снова разбирает десятки одинаковых строк руками; сломается в
 * другую — закроет последнюю живую ошибку или чужую разобранную человеком, и
 * поломка системы перестанет быть видна вовсе.
 *
 * Тексты ошибок здесь уникальны (в них `runId`), поэтому своя группа не
 * смешивается с чужими. Обратное неверно и это нормально: проход идёт по всей
 * таблице и закрывает дубли соседей тоже — ровно то, что он делает в проде.
 * Файлы тестов внутри процесса идут последовательно, так что чужую проверку
 * это не застаёт посреди работы.
 */

const runId = Date.now();
const SRC = "api";
const ids: string[] = [];

async function makeError(message: string, createdAt: Date, extra: Record<string, unknown> = {}) {
  const row = await prisma.errorLog.create({
    data: { source: SRC, message, createdAt, ...extra },
  });
  ids.push(row.id);
  return row;
}

async function state(id: string) {
  return prisma.errorLog.findUnique({ where: { id }, select: { resolvedAt: true, resolvedById: true } });
}

afterAll(async () => {
  await prisma.errorLog.deleteMany({ where: { id: { in: ids } } });
});

describe("Автозакрытие дублей ошибок", () => {
  it("из группы одинаковых остаётся открытой самая свежая, старые закрываются", async () => {
    const message = `Gemini недоступен ${runId}`;
    const oldest = await makeError(message, new Date(Date.now() - 3 * 3600_000));
    const middle = await makeError(message, new Date(Date.now() - 2 * 3600_000));
    const newest = await makeError(message, new Date(Date.now() - 1 * 3600_000));

    const resolved = await autoResolveDuplicateErrors();
    expect(resolved).toBeGreaterThanOrEqual(2);

    expect((await state(newest.id))?.resolvedAt).toBeNull();
    expect((await state(middle.id))?.resolvedAt).not.toBeNull();
    expect((await state(oldest.id))?.resolvedAt).not.toBeNull();
  });

  it("закрыл не человек: разобравший остаётся пустым", async () => {
    const message = `Курс валют не получен ${runId}`;
    const older = await makeError(message, new Date(Date.now() - 2 * 3600_000));
    await makeError(message, new Date(Date.now() - 1 * 3600_000));

    await autoResolveDuplicateErrors();

    const row = await state(older.id);
    expect(row?.resolvedAt).not.toBeNull();
    // В интерфейсе по пустому разобравшему видно, что это автоматика, а не сотрудник.
    expect(row?.resolvedById).toBeNull();
  });

  it("одиночную ошибку не трогает: закрывать нечего", async () => {
    const single = await makeError(`Одинокая поломка ${runId}`, new Date(Date.now() - 3600_000));
    await autoResolveDuplicateErrors();
    expect((await state(single.id))?.resolvedAt).toBeNull();
  });

  it("разобранное человеком не переписывается", async () => {
    const message = `Станция не ответила ${runId}`;
    const agent = await prisma.agent.findFirst({ where: { role: "ADMIN" }, select: { id: true } });
    const resolvedAt = new Date(Date.now() - 5 * 3600_000);
    const byHuman = await makeError(message, new Date(Date.now() - 6 * 3600_000), {
      resolvedAt,
      resolvedById: agent?.id ?? null,
    });
    await makeError(message, new Date(Date.now() - 2 * 3600_000));
    await makeError(message, new Date(Date.now() - 1 * 3600_000));

    await autoResolveDuplicateErrors();

    const row = await state(byHuman.id);
    expect(row?.resolvedAt?.getTime()).toBe(resolvedAt.getTime());
    expect(row?.resolvedById).toBe(agent?.id ?? null);
  });

  it("одинаковый текст из разных источников — разные группы", async () => {
    const message = `Одинаковый текст из двух мест ${runId}`;
    const web = await prisma.errorLog.create({
      data: { source: "web", message, createdAt: new Date(Date.now() - 3600_000) },
    });
    ids.push(web.id);
    const api = await makeError(message, new Date(Date.now() - 3600_000));

    await autoResolveDuplicateErrors();

    // По одной записи в каждой группе — закрывать нечего ни там, ни там.
    expect((await state(web.id))?.resolvedAt).toBeNull();
    expect((await state(api.id))?.resolvedAt).toBeNull();
  });
});
