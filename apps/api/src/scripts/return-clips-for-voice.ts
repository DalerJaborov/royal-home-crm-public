/**
 * РАЗОВЫЙ ВОЗВРАТ СДАННЫХ РОЛИКОВ МОНТАЖЁРУ «ВКЛЕЙТЕ ГОЛОС» (19.11.2026, решение владельца:
 * «Ролик который сдан отправить монтажеру»). Ролики сданы и вышли без голоса, потому что голос
 * монтажёру не уходил ни разу (передача искала роль EDITOR, правка этого же дня).
 *
 * По умолчанию СУХОЙ прогон: ничего не пишет и никому не отправляет, по каждому объекту печатает
 * «вернёт» или «пропустит — почему» (те же отказы под тем же замком, что у настоящего возврата).
 * С --apply — возвращает. Логика и условия — lib/narrationAutoFlow.ts::returnClipForNarrationVoice
 * (под тестом); повторный запуск ничего не задваивает.
 *
 *   node dist/scripts/return-clips-for-voice.js --ids 203,204,205
 *   node dist/scripts/return-clips-for-voice.js --ids 203,204,205 --apply
 */
import "dotenv/config";
import { prisma } from "../db.js";
import { returnClipForNarrationVoice } from "../lib/narrationAutoFlow.js";

const SCRIPT_SOURCE = "return-clips-for-voice-script";

function parseIds(argv: readonly string[]): number[] | null {
  const at = argv.findIndex((a) => a === "--ids" || a.startsWith("--ids="));
  if (at < 0) return null;
  const raw = argv[at].startsWith("--ids=") ? argv[at].slice("--ids=".length) : argv[at + 1];
  if (!raw) return null;
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  return ids.length && ids.every((n) => Number.isInteger(n) && n > 0) ? [...new Set(ids)] : null;
}

async function main() {
  const ids = parseIds(process.argv.slice(2));
  if (!ids) {
    console.error("Укажите номера объектов: --ids 203,204,205 (по умолчанию сухой прогон, --apply — вернуть)");
    process.exitCode = 2;
    return;
  }
  const apply = process.argv.includes("--apply");
  console.log(apply ? "РЕЖИМ: ВОЗВРАТ (--apply)" : "РЕЖИМ: сухой прогон, ничего не меняется");
  let refused = 0;
  const returned: string[] = [];
  const startedAt = new Date();
  for (const shortId of ids) {
    const property = await prisma.property.findUnique({ where: { shortId }, select: { id: true } });
    if (!property) { console.log(`№${shortId}: пропуск — объекта с таким номером нет`); continue; }
    const r = await returnClipForNarrationVoice(property.id, { includePublished: true, apply, source: SCRIPT_SOURCE });
    if ("reason" in r) {
      if (r.outcome === "REFUSED") refused++;
      console.log(`№${shortId}: ${r.outcome === "REFUSED" ? "отказ" : "пропуск"} — ${r.reason}`);
      continue;
    }
    if (r.outcome === "RETURNED") returned.push(property.id);
    const verb = r.outcome === "RETURNED" ? "возвращён монтажёру" : "вернёт монтажёру";
    console.log(`№${shortId}: ${verb} «вклейте голос», озвучка v${r.revision}${r.published ? "; ролик вышел — старые посты снимутся, когда выйдет новый" : ""}`);
  }
  // Запись аудита идёт «в отрыве» (lib/audit.ts): дождаться её до отключения от базы, иначе строка потеряется.
  if (returned.length) {
    const deadline = Date.now() + 15_000;
    let written = 0;
    while (Date.now() < deadline) {
      written = await prisma.auditLog.count({ where: { action: "PROPERTY_SENT_BACK_TO_MONTAJER", entityId: { in: returned }, createdAt: { gte: startedAt } } });
      if (written >= returned.length) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (written < returned.length) console.log(`Внимание: записей аудита ${written} из ${returned.length} — проверьте журнал действий`);
  }
  if (refused) process.exitCode = 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
