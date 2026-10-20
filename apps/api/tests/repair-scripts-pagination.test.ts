import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Разовые ремонтные скрипты apps/api/scripts обходят ВСЕХ, а не первые N
 * (аудит Codex 04.10, OPS08).
 *
 * mask-phone-in-client-names брал `take: 500` без курсора и без фильтра, и при
 * живых клиентах больше 500 повторный запуск читал те же 500 строк;
 * backfill-extra-phones-from-notes брал первые 200 с широким `contains "номер"`,
 * где записи, которым переносить нечего, навсегда занимали окно. Теперь страницы
 * идут по курсору `id > последний`.
 *
 * База подменена хранилищем в памяти: findMany честно исполняет where/orderBy/take
 * (и курсор id.gt), update пишет в него же. Сам скрипт запускает main() при
 * импорте, поэтому он грузится заново (resetModules) с нужным argv.
 */

type Row = { id: string; shortId: number; fullName: string; requirementsNotes: string | null; extraPhones: string[]; createdAt: Date };

let store: Row[] = [];
const updates: Array<{ id: string; data: Record<string, unknown> }> = [];

type Where = {
  deletedAt?: null;
  id?: { gt: string };
  requirementsNotes?: { contains: string };
};
type Args = { where?: Where; orderBy?: { id?: "asc"; createdAt?: "asc" }; take?: number };

function findMany({ where = {}, orderBy, take }: Args): Row[] {
  let rows = [...store];
  const gt = where.id?.gt;
  if (gt !== undefined) rows = rows.filter((r) => r.id > gt);
  const contains = where.requirementsNotes?.contains;
  if (contains) rows = rows.filter((r) => (r.requirementsNotes ?? "").toLowerCase().includes(contains.toLowerCase()));
  // Без orderBy Postgres отдаёт строки как лежат; берём порядок вставки.
  if (orderBy?.id) rows.sort((a, b) => (a.id < b.id ? -1 : 1));
  if (orderBy?.createdAt) rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return take === undefined ? rows : rows.slice(0, take);
}

let disconnected: () => void = () => {};

vi.mock("../src/db.js", () => ({
  prisma: {
    client: {
      findMany: (args: Args) => Promise.resolve(findMany(args)),
      update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id: where.id, data });
        const row = store.find((r) => r.id === where.id)!;
        if (typeof data.fullName === "string") row.fullName = data.fullName;
        if ("requirementsNotes" in data) row.requirementsNotes = data.requirementsNotes as string | null;
        if (data.extraPhones) row.extraPhones = (data.extraPhones as { set: string[] }).set;
        return Promise.resolve(row);
      },
    },
    $disconnect: () => {
      disconnected();
      return Promise.resolve();
    },
  },
}));
// Подбор свободных номеров ходит в базу за конфликтами; здесь важен только обход страниц.
vi.mock("../src/lib/clientPhones.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/clientPhones.js")>()),
  pickFreeExtraPhones: (found: string[]) => Promise.resolve(found),
}));
vi.mock("../src/ai/leadQualifier.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/leadQualifier.js")>()),
  normalizeDigits: (d: string) => d,
}));

const pad = (i: number) => `c${String(i).padStart(4, "0")}`;
const mk = (i: number, over: Partial<Row> = {}): Row => ({
  id: pad(i),
  shortId: i,
  fullName: `Клиент ${i}`,
  requirementsNotes: null,
  extraPhones: [],
  createdAt: new Date(2026, 0, 1, 0, 0, i),
  ...over,
});

/** Запуск скрипта как из командной строки: main() стартует при импорте, ждём его $disconnect. */
async function runScript(file: string, argv: string[]): Promise<string> {
  vi.resetModules();
  const done = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  const saved = process.argv;
  process.argv = ["node", file, ...argv];
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a) => void lines.push(a.join(" ")));
  try {
    await import(/* @vite-ignore */ file);
    await done;
  } finally {
    process.argv = saved;
    log.mockRestore();
  }
  return lines.join("\n");
}

afterEach(() => {
  store = [];
  updates.length = 0;
});

describe("mask-phone-in-client-names: клиенты за первыми 500", () => {
  const SCRIPT = "../scripts/mask-phone-in-client-names.ts";

  it("номер в имени 501-го клиента исправляется, повтор больше ничего не находит", async () => {
    store = Array.from({ length: 500 }, (_, i) => mk(i));
    store.push(mk(500, { fullName: "Входящий +992910001003" }));

    const first = await runScript(SCRIPT, ["--apply"]);
    expect(first).toContain("Просмотрено карточек: 501");
    expect(updates.map((u) => u.id)).toEqual([pad(500)]);
    expect(store[500].fullName).not.toContain("910001003");

    updates.length = 0;
    const second = await runScript(SCRIPT, ["--apply"]);
    expect(second).toContain("С номером в имени: 0");
    expect(updates).toEqual([]);
  });

  it("без --apply не пишет ничего, но видит и хвост выборки", async () => {
    store = Array.from({ length: 500 }, (_, i) => mk(i));
    store.push(mk(500, { fullName: "Входящий +992910001003" }));
    const out = await runScript(SCRIPT, []);
    expect(out).toContain("С номером в имени: 1");
    expect(updates).toEqual([]);
  });
});

describe("backfill-extra-phones-from-notes: записи без переноса не занимают окно навсегда", () => {
  const SCRIPT = "../scripts/backfill-extra-phones-from-notes.ts";

  it("клиент за первыми 200 «номерных» заметок тоже обрабатывается", async () => {
    // 200 карточек, где «номер» есть, а строки «другие номера» нет: continue, из выборки они не выходят.
    store = Array.from({ length: 200 }, (_, i) => mk(i, { requirementsNotes: `номер дома ${i}` }));
    store.push(mk(200, { requirementsNotes: "Другие номера, которые оставил клиент: 030001023, 000001018" }));

    await runScript(SCRIPT, ["--apply"]);
    expect(updates.map((u) => u.id)).toEqual([pad(200)]);
    expect(store[200].extraPhones).toEqual(["030001023", "000001018"]);
    expect(store[200].requirementsNotes).toBeNull();

    updates.length = 0;
    await runScript(SCRIPT, ["--apply"]);
    expect(updates).toEqual([]);
  });
});
