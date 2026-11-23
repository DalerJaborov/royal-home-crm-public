import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * СТОРОЖ: НОВЫЙ ЧИТАТЕЛЬ ЗВОНКОВ НЕ ДОЛЖЕН СЧИТАТЬ «РАЗБОР УДАЛЁННОГО» РАБОТОЙ АГЕНТА (16.11.2026).
 *
 * Звонок РОПа клиенту из Корзины (lib/archiveReviewCall.ts) — запись `Interaction` type=CALL с
 * `archiveReview: true`, подписанная звонящим. Любой подсчёт, статус, штраф или отчёт, читающий CALL,
 * обязан взять `archiveReview: false` (или `notArchiveReview`). Сторож находит файлы, где в запросе есть
 * `type: "CALL"` (или список с "CALL"), и требует в них слово `archiveReview`, либо файл стоит в списке
 * осознанных исключений ниже: они читают расшифровку или факт разговора как свидетельство, заводят
 * запись или привязаны к объекту, а не к работе агента. Новый файл с CALL без отметки — красный:
 * либо добавьте `archiveReview: false`, либо внесите файл в список с причиной.
 */
const SRC = join(__dirname, "..", "src");

const REVIEWED_EVIDENCE_READERS = new Set([
  // читают расшифровку/факт разговора как свидетельство о клиенте, не как работу агента
  "ai/assistant/tools/getClientLastCall.ts",
  "ai/cardFill.ts",
  "ai/offCrmPauseCheck.ts",
  "ai/propertyDraft.ts",
  "ai/sellerFactsExtract.ts",
  "lib/clientIntentResolution.ts",
  "lib/clientPhoneCapture.ts",
  "lib/exposurePairEvidence.ts",
  "lib/importantOtherInquiries.ts",
  "lib/ownerVerificationSources.ts",
  "lib/postShowingCall.ts",
  "lib/postShowingCohort.ts",
  "lib/sellerBypassProbe.ts",
  // по объекту, а не по агенту
  "lib/propertyStats.ts",
  // заводят записи входящих/обратных звонков и голосовой почты, а не считают работу
  "lib/telephony/callbackConnect.ts",
  "lib/telephony/incomingCalls.ts",
  "lib/telephony/missedCallEscalation.ts",
  "lib/telephony/voicemailIngest.ts",
  "routes/ai.ts",
  "services/leads/intake.ts",
]);

const CALL_QUERY = /type:\s*"CALL"|type:\s*\{\s*in:\s*\[[^\]]*"CALL"|type\s*=\s*'CALL'|type='CALL'/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "generated" || name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("читатели звонков учитывают archiveReview", () => {
  it("каждый файл с запросом по CALL берёт archiveReview или стоит в списке исключений", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, "/");
      const text = readFileSync(file, "utf8");
      if (!CALL_QUERY.test(text)) continue;
      if (text.includes("archiveReview") || REVIEWED_EVIDENCE_READERS.has(rel)) continue;
      offenders.push(rel);
    }
    expect(offenders, `Читают CALL без archiveReview (см. шапку теста): ${offenders.join(", ")}`).toEqual([]);
  });

  it("список исключений не содержит несуществующих файлов", () => {
    const all = new Set(walk(SRC).map((f) => relative(SRC, f).replace(/\\/g, "/")));
    const stale = [...REVIEWED_EVIDENCE_READERS].filter((f) => !all.has(f));
    expect(stale).toEqual([]);
  });
});
