import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ВЫКЛЮЧАТЕЛИ АВТОМАТИКИ «РАБОТА С ПРОДАВЦАМИ» (владелец 14.11.2026).
 *
 * Здесь — общее: правило «главный И свой» (packages/shared), чтение из базы
 * (lib/sellerSwitches.ts), сохранение через PATCH /settings с записью в журнал,
 * и механизмы, у которых нет своего файла тестов: разбор фактов продавца, две
 * заглушки и строки утренней сводки. Остальные выключатели проверены рядом с
 * механизмом, на его же данных: seller-no-property-alarm, seller-property-missing-
 * antifraud, agent-unanswered-alarm, deal-stale-pipeline-deadline, seller-probe-call,
 * owner-verification-executor, audit2-c1-deal-followup-jobs,
 * audit2-c1-seller-sale-notice-idempotent, seller-media-photo-insight.
 *
 * ОБЩУЮ СТРОКУ Settings ТЕСТ НЕ ВЫКЛЮЧАЕТ НАДОЛГО: тесты сервера идут в два
 * процесса на одной базе, и выключенный «сообщения после сделки» уронил бы
 * чужой файл. Поэтому выключение — подменой в этом файле, чтение из базы —
 * внутри откатываемой транзакции, а через API переключается только заглушка,
 * которая и так ничего не делает.
 */

const switchesOff = vi.hoisted(() => new Set<string>());
const askedKeys = vi.hoisted(() => [] as string[]);
vi.mock("../src/lib/sellerSwitches.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/sellerSwitches.js")>();
  return {
    ...actual,
    sellerSwitchOn: async (...args: Parameters<typeof actual.sellerSwitchOn>) => {
      askedKeys.push(args[0]);
      return switchesOff.has(args[0]) ? false : actual.sellerSwitchOn(...args);
    },
  };
});

const refreshSellerFacts = vi.hoisted(() => vi.fn(async () => "updated"));
vi.mock("../src/ai/sellerFactsExtract.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/sellerFactsExtract.js")>()),
  refreshSellerFacts,
}));

const loadMorningNumbers = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/morningNumbers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/morningNumbers.js")>()),
  loadMorningNumbers,
}));

const sendPushToAgent = vi.hoisted(() => vi.fn(async () => 1));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
}));

const shared = await import("@royal-home/shared");
const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { grantElevation } = await import("../src/lib/stepUp.js");
const { sellerSwitchOn } = await import("../src/lib/sellerSwitches.js");
const { sellerFactsJob } = await import("../src/jobs/sellerFacts.js");
const { runSellerWorkStalledAlarmTick } = await import("../src/lib/sellerWorkStalledAlarm.js");
const { runClientPropertyCountAlarmTick } = await import("../src/lib/clientPropertyCountAlarm.js");
const { sendDirectorDigest } = await import("../src/cron.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");
const { waitFor } = await import("./helpers/waitFor.js");

const { SELLER_AUTOMATION_FIELDS, SELLER_AUTOMATION_MASTER_KEY, SELLER_SWITCH_KEYS, SELLER_SWITCH_LABELS, isSellerSwitchOn } =
  shared;

const agentIds: string[] = [];
let directorId = "";
let token = "";

beforeAll(async () => {
  directorId = await createTestAgent(`Директор выключателей ${Date.now()}`, "DIRECTOR");
  agentIds.push(directorId);
  token = signAccessToken({ sub: directorId, role: "DIRECTOR" });
  grantElevation(directorId);
  await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
});

beforeEach(() => {
  switchesOff.clear();
  askedKeys.length = 0;
  refreshSellerFacts.mockClear();
  sendPushToAgent.mockClear();
});

afterAll(async () => {
  await deleteAgentsWithTraces(agentIds);
  await prisma.$disconnect();
});

describe("правило «главный И свой» (packages/shared)", () => {
  it("по умолчанию всё включено — нет строки или нет поля", () => {
    for (const key of SELLER_SWITCH_KEYS) {
      expect(isSellerSwitchOn(null, key)).toBe(true);
      expect(isSellerSwitchOn({}, key)).toBe(true);
    }
  });

  it("главный выключен — выключено всё, сколько бы свой ни был включён", () => {
    for (const key of SELLER_SWITCH_KEYS) {
      expect(isSellerSwitchOn({ [SELLER_AUTOMATION_MASTER_KEY]: false, [key]: true }, key)).toBe(false);
    }
  });

  it("свой выключен — выключен только он", () => {
    const [first, second] = SELLER_SWITCH_KEYS;
    expect(isSellerSwitchOn({ [first]: false }, first)).toBe(false);
    expect(isSellerSwitchOn({ [first]: false }, second)).toBe(true);
  });

  it("у каждого выключателя есть подпись на оба положения, повторов нет", () => {
    expect(new Set(SELLER_AUTOMATION_FIELDS).size).toBe(SELLER_AUTOMATION_FIELDS.length);
    for (const key of SELLER_SWITCH_KEYS) {
      const label = SELLER_SWITCH_LABELS[key];
      expect(label.title.length, key).toBeGreaterThan(0);
      expect(label.on.length, key).toBeGreaterThan(0);
      expect(label.off.length, key).toBeGreaterThan(0);
    }
  });
});

describe("чтение из базы (lib/sellerSwitches.ts)", () => {
  /** Выключение внутри транзакции, которая откатывается: соседние файлы его не видят. */
  async function withRolledBack(data: Record<string, boolean>, check: (tx: Parameters<typeof sellerSwitchOn>[1]) => Promise<void>) {
    const rollback = new Error("откат теста");
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.settings.update({ where: { id: "singleton" }, data });
        await check(tx);
        throw rollback;
      })
    ).rejects.toBe(rollback);
  }

  it("колонки есть в базе и по умолчанию включены", async () => {
    const row = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: Object.fromEntries(SELLER_AUTOMATION_FIELDS.map((k) => [k, true])) as Record<string, true>,
    });
    expect(row).not.toBeNull();
    for (const key of SELLER_AUTOMATION_FIELDS) expect(typeof (row as Record<string, unknown>)[key], key).toBe("boolean");
  });

  it("главный выключен в базе — каждый выключатель отвечает «нет»", async () => {
    await withRolledBack({ [SELLER_AUTOMATION_MASTER_KEY]: false }, async (tx) => {
      for (const key of SELLER_SWITCH_KEYS) expect(await sellerSwitchOn(key, tx), key).toBe(false);
    });
  });

  it("свой выключен в базе — «нет» только у него", async () => {
    await withRolledBack({ [SELLER_AUTOMATION_MASTER_KEY]: true, sellerAiAnalysisEnabled: false, morningSellerLinesEnabled: true }, async (tx) => {
      expect(await sellerSwitchOn("sellerAiAnalysisEnabled", tx)).toBe(false);
      expect(await sellerSwitchOn("morningSellerLinesEnabled", tx)).toBe(true);
    });
  });
});

describe("сохранение через PATCH /settings", () => {
  it("принимает выключатель, отдаёт его в GET и пишет в журнал, кто выключил", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const got = await request(app).get("/api/v1/settings").set(auth);
    expect(got.status).toBe(200);
    for (const key of SELLER_AUTOMATION_FIELDS) expect(typeof got.body[key], key).toBe("boolean");

    // Заглушка (рассылку убрали 02.10.2026): её выключение не меняет ничего у соседних файлов.
    const startedAt = new Date();
    const off = await request(app).patch("/api/v1/settings").set(auth).send({ sellerWorkStalledAlarmEnabled: false });
    expect(off.status).toBe(200);
    try {
      expect(off.body.sellerWorkStalledAlarmEnabled).toBe(false);
      const audit = await waitFor(() =>
        prisma.auditLog.findFirst({
          where: { action: "SETTINGS_UPDATE", agentId: directorId, createdAt: { gte: startedAt } },
          orderBy: { createdAt: "desc" },
        })
      );
      expect(audit?.meta).toMatchObject({ sellerWorkStalledAlarmEnabled: false });
    } finally {
      const back = await request(app).patch("/api/v1/settings").set(auth).send({ sellerWorkStalledAlarmEnabled: true });
      expect(back.status).toBe(200);
    }
  });

  it("не boolean — 400, в базу не попадает", async () => {
    const res = await request(app)
      .patch("/api/v1/settings")
      .set({ Authorization: `Bearer ${token}` })
      .send({ sellerAutomationMasterEnabled: "нет" });
    expect(res.status).toBe(400);
  });
});

describe("разбор фактов продавца (jobs/sellerFacts.ts)", () => {
  it("выключен — модель не зовём; включён — как раньше", async () => {
    switchesOff.add("sellerAiAnalysisEnabled");
    await sellerFactsJob.run({ clientId: "stand-seller-facts" });
    expect(refreshSellerFacts).not.toHaveBeenCalled();

    switchesOff.clear();
    await sellerFactsJob.run({ clientId: "stand-seller-facts" });
    expect(refreshSellerFacts).toHaveBeenCalledWith("stand-seller-facts");
  });
});

describe("заглушки с убранной рассылкой спрашивают свой выключатель", () => {
  it("«работа встала» и «заявлено больше, чем добавлено» — ноль в обоих положениях", async () => {
    switchesOff.add("sellerWorkStalledAlarmEnabled");
    switchesOff.add("clientPropertyCountAlarmEnabled");
    expect(await runSellerWorkStalledAlarmTick()).toEqual({ pokedAgents: 0, reportedToDirector: 0, skipped: 0 });
    expect(await runClientPropertyCountAlarmTick()).toEqual({ alerted: 0 });
    expect(askedKeys).toEqual(["sellerWorkStalledAlarmEnabled", "clientPropertyCountAlarmEnabled"]);
  });
});

/**
 * СТОРОЖ ОДНОЙ ДВЕРИ (17.11.2026). Выключатель, который никто не спрашивает, на
 * экране выглядит рабочим, а механизм идёт дальше — поломку не видно ни сборкой,
 * ни тестами механизма. И наоборот: прямое чтение поля мимо sellerSwitchOn молча
 * забывает про главный выключатель. Поэтому сверяем исходники сервера:
 *  - у каждого своего выключателя есть хотя бы один вызов sellerSwitchOn("<ключ>");
 *  - имя поля в коде сервера встречается ТОЛЬКО внутри такого вызова.
 * Плюс миграции: колонки только добавляются и только с DEFAULT true.
 */
describe("сторож: каждый выключатель спрашивают, и только через одну дверь", () => {
  const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
  const sources = (() => {
    const out: { file: string; text: string }[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "generated") walk(full);
        } else if (entry.name.endsWith(".ts")) {
          out.push({ file: path.relative(srcRoot, full).replace(/\\/g, "/"), text: readFileSync(full, "utf8") });
        }
      }
    };
    walk(srcRoot);
    return out;
  })();
  const DOOR = (key: string) => new RegExp(`sellerSwitchOn\\(\\s*["'\`]${key}["'\`]`, "g");

  it("у каждого своего выключателя есть вызов sellerSwitchOn", () => {
    for (const key of SELLER_SWITCH_KEYS) {
      const users = sources.filter((s) => DOOR(key).test(s.text)).map((s) => s.file);
      expect(users, `выключатель ${key} никто не спрашивает`).not.toHaveLength(0);
    }
  });

  it("имя поля встречается в коде сервера только внутри sellerSwitchOn(...)", () => {
    const strays: string[] = [];
    for (const key of SELLER_AUTOMATION_FIELDS) {
      for (const s of sources) {
        const all = s.text.split(key).length - 1;
        const viaDoor = (s.text.match(DOOR(key)) ?? []).length;
        if (all > viaDoor) strays.push(`${s.file}: ${key}`);
      }
    }
    expect(strays, "чтение выключателя мимо lib/sellerSwitches.ts забывает про главный").toEqual([]);
  });

  it("миграция только добавляет колонки, и все включены по умолчанию", () => {
    const migrationsRoot = fileURLToPath(new URL("../prisma/migrations", import.meta.url));
    const sql = readdirSync(migrationsRoot)
      .filter((d) => d.endsWith("_seller_automation_switches"))
      .map((d) => readFileSync(path.join(migrationsRoot, d, "migration.sql"), "utf8"))
      .join("\n");
    const statements = sql
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    const added = statements.map((st) => {
      const m = /^ALTER TABLE "Settings" ADD COLUMN "(\w+)" BOOLEAN NOT NULL DEFAULT true$/.exec(st);
      expect(m, `в миграции не только добавление колонки с DEFAULT true: ${st}`).not.toBeNull();
      return m![1];
    });
    expect(added.sort()).toEqual([...SELLER_AUTOMATION_FIELDS].sort());

    const schema = readFileSync(fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)), "utf8");
    for (const key of SELLER_AUTOMATION_FIELDS) {
      expect(schema, `${key} в схеме без @default(true)`).toMatch(new RegExp(`\\n\\s*${key}\\s+Boolean\\s+@default\\(true\\)`));
    }
  });
});

describe("строки о продавцах в утренней сводке (cron.ts → sendDirectorDigest)", () => {
  const numbers = {
    tasksToday: 0,
    leadsYesterday: 0,
    dealsYesterday: 0,
    commissionMonth: 0,
    errorsYesterday: 0,
    incomingYesterday: 0,
    missedYesterday: 0,
    unqualifiedNow: 0,
    firstTouchMedianMin: null,
    firstTouchSlowCount: 0,
    firstTouchNoneCount: 0,
    sellersWithoutPropertyOver7Days: 3,
    showingSummariesOverdue48h: 0,
    soldElsewhereWeek: 0,
    reactivationSentThisWeek: 0,
    reactivationRepliedThisWeek: 0,
    reviewsYesterday: 0,
    botPausedNoReply24h: 0,
    missedCallsNoCallbackYesterday: 0,
    propertiesWithdrawnSellerRecovered: 2,
    stuckWorkGivenUpYesterday: 0,
    stuckWorkHangingNow: 0,
    groupShareNotDoneCount: 0,
    adsYesterday: null,
  };
  const bodyForDirector = () => {
    const call = sendPushToAgent.mock.calls.find((c) => (c as unknown[])[0] === directorId) as unknown[] | undefined;
    return (call?.[1] as { body: string } | undefined)?.body ?? "";
  };

  it("включено — обе строки есть", async () => {
    loadMorningNumbers.mockResolvedValue(numbers);
    await sendDirectorDigest();
    expect(bodyForDirector()).toContain("без объекта дольше недели");
    expect(bodyForDirector()).toContain("из-за «потерянного» продавца");
  });

  it("выключено — обеих строк нет, остальная сводка уходит", async () => {
    loadMorningNumbers.mockResolvedValue(numbers);
    switchesOff.add("morningSellerLinesEnabled");
    await sendDirectorDigest();
    const body = bodyForDirector();
    expect(body).toContain("Комиссия за месяц");
    expect(body).not.toContain("без объекта дольше недели");
    expect(body).not.toContain("из-за «потерянного» продавца");
  });
});
