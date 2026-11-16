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
 *  4. кроны светофора, автостатусов, автокорзины не регистрируются снова.
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
  "lib/marketingInsights.ts": "чтение: старые LOST в недельной аналитике",
  "lib/matchPolicy.ts": "чтение: подбор по старым DEFERRED-строкам",
  "lib/reactivationCampaign.ts": "чтение: кампания возврата по старым LOST/INACTIVE",
  "lib/weeklyOperationalPreview.ts": "чтение: недельная сводка по старым DEFERRED",
  "routes/oversight.ts": "чтение: серия потерь агента по старым LOST",
  "routes/reports.ts": "чтение: отчёт по старым LOST",
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

  it("кроны светофора, автостатусов, отложенных и автокорзины не регистрируются", () => {
    const cron = codeLines(path.join(SRC, "cron.ts")).join("\n");
    for (const name of [
      "inactive-traffic-light",
      "deferred-clients-return",
      "client-auto-statuses",
      "silent-client-auto-deactivate",
      "lost-inactive-trash-sweep",
    ]) {
      expect(cron.includes(`"${name}"`), name).toBe(false);
    }
  });
});
