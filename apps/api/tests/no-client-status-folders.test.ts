import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * СТОРОЖ: «ПАПОК» И СТАТУСОВ КЛИЕНТА БОЛЬШЕ НЕТ (владелец 16.11.2026).
 *
 * Дословно: «Удалить все папки и статусы типа активный и так далее, ничего
 * лишнего… лимитов заявок больше нет и не будет». Клиент либо в списке агента,
 * либо со сделкой, либо в Корзине (её делает только человек).
 *
 * Колонки workStatus / inactive* / deferred* / leadActiveLimit пока лежат в
 * схеме (их снимет отдельная миграция), поэтому TypeScript новую запись в них
 * не остановит. Останавливает этот тест:
 *  1. удалённые модули не возвращаются под тем же именем;
 *  2. в коде сервера нет НОВЫХ мест, где клиенту пишут/ищут «Неактивный»,
 *     «Отложенный», «Потерянный», «В архиве» — каждое оставшееся место названо
 *     ниже с причиной; новое место без причины — красный тест;
 *  3. лимит активных лидов никто не читает;
 *  4. кроны светофора, автостатусов, автокорзины, «хвоста» дозвона не регистрируются;
 *  5. поля светофора (inactive*) код не читает и не пишет.
 *
 * Проверено внесением поломки: строка `workStatus: "INACTIVE"` в любом файле
 * lib/ вне списка ниже краснит пункт 2 (16.11.2026).
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "generated") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Строки кода без комментариев — история в комментариях законна. */
function codeLines(file: string): string[] {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
}

const rel = (file: string) => path.relative(SRC, file).split(path.sep).join("/");
const FILES = walk(SRC);

const STATE_LITERAL =
  /workStatus:\s*"(INACTIVE|DEFERRED)"|status:\s*"(LOST|ARCHIVED)"|"status"\s*=\s*'(LOST|ARCHIVED)'|"workStatus"\s*=\s*'(INACTIVE|DEFERRED)'/;

/**
 * Оставшиеся места — ЧТЕНИЕ старых строк (до миграции, снимающей колонки) или
 * служебная пометка. Список только убывает.
 */
const ALLOWED_STATE_LITERALS: Record<string, string> = {
  "lib/ads/syncMetaAds.ts": "статус РЕКЛАМЫ Meta (ARCHIVED), не клиента",

  "lib/matchPolicy.ts": "чтение: подбор по старым DEFERRED-строкам",

  "lib/weeklyOperationalPreview.ts": "чтение: недельная сводка по старым DEFERRED",


  "services/leads/intake.ts":
    "служебная пометка «предложение вернуть клиента прежнему агенту не решено» (reactivationOffers) и снятие старого LOST при новом обращении",
};

describe("папок и статусов клиента больше нет — сторож", () => {
  it("удалённые модули не вернулись", () => {
    for (const gone of [
      "lib/inactiveTrafficLight.ts",
      "lib/noAnswerTrafficLight.ts",
      "lib/clientInactiveTextDetector.ts",
      "lib/silentClientAutoDeactivate.ts",
      "lib/lostInactiveTrashSweep.ts",
      "lib/deferredClients.ts",
      "lib/clientWorkStatus.ts",
      "lib/leadLimits.ts",
      "lib/clientAutoStatus.ts",
    ]) {
      expect(fs.existsSync(path.join(SRC, gone)), gone).toBe(false);
    }
  });

  it("новых мест с «Неактивный/Отложенный/Потерянный/В архиве» в коде сервера нет", () => {
    const offenders = FILES.filter((f) => !(rel(f) in ALLOWED_STATE_LITERALS)).flatMap((f) =>
      codeLines(f)
        .filter((line) => STATE_LITERAL.test(line))
        .map((line) => `${rel(f)}: ${line.trim()}`)
    );
    expect(
      offenders,
      "Состояний «Неактивный», «Отложенный», «Потерянный», «В архиве» больше нет (владелец 16.11.2026). " +
        "Конец работы с клиентом — Корзина (lib/trashClient.ts)."
    ).toEqual([]);
  });

  it("список исключений не врёт: каждое исключение ещё нужно", () => {
    const stale = Object.keys(ALLOWED_STATE_LITERALS).filter((file) => {
      const full = path.join(SRC, file);
      return !fs.existsSync(full) || !codeLines(full).some((line) => STATE_LITERAL.test(line));
    });
    expect(stale, "уберите из ALLOWED_STATE_LITERALS — там больше нет таких строк").toEqual([]);
  });

  it("лимит активных лидов никто не читает", () => {
    const readers = FILES.flatMap((f) =>
      codeLines(f)
        .filter((line) => /leadActiveLimit|weightedLeadSlotsEnabled|leadSlotWeight\w*Percent|OCCUPIES_SLOT_WHERE|slotsTaken|loadLeadLimits/.test(line))
        .map((line) => `${rel(f)}: ${line.trim()}`)
    );
    expect(readers, "«Лимитов заявок больше нет и не будет» (владелец 16.11.2026)").toEqual([]);
  });

  it("поля светофора (inactiveLevel, inactivePingCount, inactiveSince, inactiveReasonKey, inactiveEnteredAt) код не читает и не пишет", () => {
    const users = FILES.flatMap((f) =>
      codeLines(f)
        .filter((line) => /inactive(Level|PingCount|Since|ReasonKey|EnteredAt)|processNoAnswerTailAnchors|noAnswerTail/.test(line))
        .map((line) => `${rel(f)}: ${line.trim()}`)
    );
    expect(users, "Светофор удалён из кода целиком (владелец 16.11.2026); колонки снимет отдельная миграция").toEqual([]);
  });

  it("кроны светофора, автостатусов, отложенных и автокорзины не регистрируются", () => {
    const cron = codeLines(path.join(SRC, "cron.ts")).join("\n");
    for (const name of [
      "inactive-traffic-light",
      "deferred-clients-return",
      "client-auto-statuses",
      "silent-client-auto-deactivate",
      "lost-inactive-trash-sweep",
      "no-answer-tail",
    ]) {
      expect(cron.includes(`"${name}"`), name).toBe(false);
    }
  });
});

/**
 * 17.11.2026 (владелец): подписи статусов клиента исчезают из интерфейса ЦЕЛИКОМ —
 * и «Новый», и «На контакте», и все прочие; вкладки «Не на виду» нет; этапов
 * покупателя «Подбор»/«Переговоры» (Client.buyerStage) нет. Колонки в базе пока
 * лежат (их снимет отдельная миграция), поэтому возврат ловит этот сторож.
 * Проверено внесением поломки: `CLIENT_STATUS_LABELS` в любом файле сайта и
 * `buyerStage` в коде сервера краснят свои пункты.
 */
const WEB_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../web/src");
const SHARED_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/shared/src");

function walkWeb(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkWeb(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const WEB_FILES = walkWeb(WEB_SRC);
const webRel = (file: string) => path.relative(WEB_SRC, file).split(path.sep).join("/");

describe("статусы клиента не показываются нигде — сторож (17.11.2026)", () => {
  it("сайт не берёт подписи и цвета статусов клиента", () => {
    const offenders = WEB_FILES.flatMap((f) =>
      codeLines(f)
        .filter((line) => /CLIENT_STATUS_LABELS|CLIENT_STATUS_CHIP|CLIENT_STATUS_CLASSES/.test(line))
        .map((line) => `${webRel(f)}: ${line.trim()}`)
    );
    expect(offenders, "Подписи статусов клиента («Новый», «На контакте» и т.д.) сняты с экранов (владелец 17.11.2026)").toEqual([]);
  });

  it("сервер не отдаёт подписи статусов клиента (помощник, хронология, ИИ)", () => {
    const offenders = FILES.flatMap((f) =>
      codeLines(f)
        .filter((line) => /CLIENT_STATUS_LABELS/.test(line))
        .map((line) => `${rel(f)}: ${line.trim()}`)
    );
    expect(offenders).toEqual([]);
  });

  it("сортировки и фильтра по статусу клиента нет", () => {
    const shared = fs.readFileSync(path.join(SHARED_SRC, "querySchemas.ts"), "utf8");
    expect(shared).not.toMatch(/"status_(asc|desc)"/);
    const clientQuery = shared.slice(shared.indexOf("export const clientQuerySchema"));
    expect(clientQuery.slice(0, clientQuery.indexOf("});"))).not.toMatch(/\n\s+status:/);
  });

  it("вкладки «Не на виду» нет ни на телефоне, ни на компьютере", () => {
    expect(fs.existsSync(path.join(WEB_SRC, "components/ClientsSectionLane.tsx"))).toBe(false);
    expect(fs.existsSync(path.join(WEB_SRC, "components/mobile/mh/MhClientSections.tsx"))).toBe(false);
    const offenders = WEB_FILES.flatMap((f) =>
      codeLines(f)
        .filter((line) => /["'>]Не на виду/.test(line))
        .map((line) => `${webRel(f)}: ${line.trim()}`)
    );
    expect(offenders).toEqual([]);
    const app = fs.readFileSync(path.join(WEB_SRC, "App.tsx"), "utf8");
    expect(app).not.toMatch(/path="clients\/all-mine" element={<Clients/);
  });

  it("этапов покупателя «Подбор»/«Переговоры» (buyerStage) код не читает и не пишет", () => {
    const users = FILES.flatMap((f) =>
      codeLines(f)
        .filter((line) => /buyerStage/.test(line))
        .map((line) => `${rel(f)}: ${line.trim()}`)
    );
    expect(users).toEqual([]);
    const schemas = fs.readFileSync(path.join(SHARED_SRC, "schemas.ts"), "utf8");
    const branches = schemas.match(/export const SHOWING_OUTCOME_BRANCHES = \[([^\]]*)\]/)?.[1] ?? "";
    expect(branches).not.toMatch(/SELECTION|NEGOTIATION/);
  });
});
