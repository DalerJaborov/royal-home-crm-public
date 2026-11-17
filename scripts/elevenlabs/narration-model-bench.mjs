#!/usr/bin/env node
/**
 * ЗАМЕР МОДЕЛЕЙ ELEVENLABS ДЛЯ ОЗВУЧКИ РОЛИКОВ (11.11.2026).
 *
 * Тексты — настоящие формы объектов, собранные тем же построителем, что у мастера
 * CRM, Шабнам и сервера (`renderNarrationTemplate` из @royal-home/shared), по
 * стартовым таджикским шаблонам из миграции `20261111120000_narration_flow`.
 *
 * Модели и поддержка таджикского — по первоисточнику (elevenlabs.io/docs/overview/models,
 * сверено 11.11.2026): `tg` есть у `eleven_v4`, `eleven_v4_turbo` (и `eleven_v3`);
 * у `eleven_multilingual_v2` (29 языков) и `eleven_flash_v2_5` (32) таджикского НЕТ (подтверждено
 * и ответом API 11.11.2026) — по умолчанию замеряются только v4 и v4 Turbo; остальные — лишь
 * явным `--models` для сравнения цены. Цена за 1000 символов —
 * elevenlabs.io/pricing/api на 11.11.2026: v4 $0.08, v4 Turbo $0.04,
 * Multilingual v2 $0.08, Flash $0.04 (ставка одинакова на всех тарифах).
 *
 * ПО УМОЛЧАНИЮ НИЧЕГО НЕ ПЛАТИТ: печатает план и оценку цены. Платный прогон — только
 * с флагом --yes. Ключ берётся из ELEVENLABS_API_KEY и никогда не печатается.
 *
 *   node scripts/elevenlabs/narration-model-bench.mjs --voice <voice_id>            # план и цена
 *   node scripts/elevenlabs/narration-model-bench.mjs --voice <voice_id> --yes --budget-credits=N  # платно, только с ELEVENLABS_PAID_TESTS_APPROVED=<сегодня>
 *     [--out <папка вне git>] [--models eleven_v4,eleven_v4_turbo] [--language-code tg] [--texts 3]
 *
 * Пишет mp3 и `results.md` (таблица: модель, текст, задержка, символы, цена) в папку
 * вне репозитория — по умолчанию во временную папку системы.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openPaidBudget } from "./paid-guard.mjs";
import { makeClient } from "./lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PRICE_PER_1K = { eleven_v4: 0.08, eleven_v4_turbo: 0.04, eleven_multilingual_v2: 0.08, eleven_flash_v2_5: 0.04 };
const TAJIK = new Set(["eleven_v4", "eleven_v4_turbo"]);

const SAMPLES = [
  { type: "APARTMENT", rooms: 3, areaSqm: "86", floor: 5, totalFloors: 9, district: "Сино", price: "85000", currency: "USD" },
  { type: "APARTMENT", rooms: 1, areaSqm: "42", floor: 12, totalFloors: 16, district: "Исмоили Сомонӣ", price: "390000", currency: "TJS" },
  { type: "HOUSE", rooms: 6, areaSqm: "240", floor: null, totalFloors: 2, district: "Шоҳмансур", price: "230000", currency: "USD" },
  { type: "APARTMENT", rooms: 2, areaSqm: "64", floor: 1, totalFloors: 5, district: "Фирдавсӣ" },
  { type: "COMMERCIAL", rooms: null, areaSqm: "120", floor: 1, totalFloors: 3, district: "Сино", price: null, currency: null },
];

export function parseArgs(argv) {
  const args = { yes: false, out: null, voice: process.env.ELEVENLABS_VOICE_ID ?? null, models: [...TAJIK], languageCode: null, texts: 5, budgetCredits: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes") args.yes = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--voice") args.voice = argv[++i];
    else if (a === "--models") args.models = argv[++i].split(",").map((m) => m.trim()).filter(Boolean);
    else if (a === "--language-code") args.languageCode = argv[++i];
    else if (a.startsWith("--budget-credits")) args.budgetCredits = a.includes("=") ? a.split("=")[1] : argv[++i];
    else if (a === "--texts") args.texts = Math.max(1, Math.min(SAMPLES.length, Number(argv[++i]) || 5));
    else throw new Error(`Неизвестный флаг ${a}`);
  }
  return args;
}

export async function buildTexts(count) {
  const shared = await import(pathToFileURL(path.join(ROOT, "packages", "shared", "dist", "index.js")).href);
  const migration = (name) => readFileSync(path.join(ROOT, "apps", "api", "prisma", "migrations", name, "migration.sql"), "utf8");
  const first = JSON.parse(migration("20261111120000_narration_flow").split("$json$")[1]);
  // Стартовые шаблоны уже с ценой (отдельной миграции цены нет с 11.11.2026).
  const templates = first.filter((t) => t.lang === "tg");
  return SAMPLES.slice(0, count).map((facts, i) => {
    const template = templates[i % templates.length];
    return { id: `t${i + 1}`, template: template.id, text: shared.renderNarrationTemplate(template, facts) };
  });
}

export const estimateUsd = (model, chars) => ((PRICE_PER_1K[model] ?? 0.08) * chars) / 1000;

async function synthesize({ key, voice, model, text, languageCode }) {
  const started = performance.now();
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
    method: "POST", headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: model, ...(languageCode ? { language_code: languageCode } : {}) }),
    signal: AbortSignal.timeout(90_000), redirect: "error",
  });
  const audio = Buffer.from(await response.arrayBuffer());
  return { ok: response.ok && (response.headers.get("content-type") ?? "").startsWith("audio/"), status: response.status, ms: Math.round(performance.now() - started), audio };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const texts = await buildTexts(args.texts);
  const chars = texts.reduce((sum, t) => sum + t.text.length, 0);
  console.log(`Тексты (${texts.length}, всего ${chars} символов):`);
  for (const t of texts) console.log(`  ${t.id} [${t.template}] ${t.text}`);
  console.log("\nМодели и оценка цены:");
  for (const model of args.models) console.log(`  ${model}${TAJIK.has(model) ? "" : " (таджикского нет в списке языков)"}: ~$${estimateUsd(model, chars).toFixed(3)}`);
  const total = args.models.reduce((sum, model) => sum + estimateUsd(model, chars), 0);
  console.log(`  Итого: ~$${total.toFixed(3)}`);
  if (!args.yes) { console.log("\nПлатный прогон не запускался. Добавьте --yes, когда ключ и голос готовы."); return; }
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new Error("Нет ELEVENLABS_API_KEY в окружении");
  if (!args.voice) throw new Error("Нужен --voice <voice_id> (или ELEVENLABS_VOICE_ID)");
  const out = path.resolve(args.out ?? path.join(os.tmpdir(), `narration-bench-${new Date().toISOString().slice(0, 10)}`));
  if (out.startsWith(ROOT + path.sep) || out === ROOT) throw new Error("Папка для mp3 должна быть вне репозитория");
  // Замок платных проверок (#157): разрешение владельца на сегодня + бюджет кредитов; остаток читается бесплатно.
  const paid = await openPaidBudget({ env: process.env, values: { "budget-credits": args.budgetCredits }, request: makeClient({ apiKey: key }), say: console.log });
  if (paid.refused) throw new Error(paid.refused);
  mkdirSync(out, { recursive: true });
  const rows = [];
  bench: for (const model of args.models) for (const t of texts) {
    if (await paid.exhausted()) { console.log("Бюджет запуска исчерпан — остальное не озвучиваю."); break bench; }
    try {
      const r = await synthesize({ key, voice: args.voice, model, text: t.text, languageCode: args.languageCode });
      const file = r.ok ? `${model}-${t.id}.mp3` : "";
      if (r.ok) writeFileSync(path.join(out, file), r.audio);
      rows.push({ model, text: t.id, status: r.ok ? "ok" : `HTTP ${r.status}`, ms: r.ms, chars: t.text.length, usd: estimateUsd(model, t.text.length), file });
    } catch (err) {
      rows.push({ model, text: t.id, status: err instanceof Error ? err.name : "error", ms: null, chars: t.text.length, usd: estimateUsd(model, t.text.length), file: "" });
    }
    console.log(`  ${rows.at(-1).model} ${rows.at(-1).text}: ${rows.at(-1).status} ${rows.at(-1).ms ?? "—"} мс`);
  }
  const table = ["| Модель | Текст | Итог | Задержка, мс | Символов | Цена, $ | Файл |", "|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.model} | ${r.text} | ${r.status} | ${r.ms ?? ""} | ${r.chars} | ${r.usd.toFixed(4)} | ${r.file} |`)].join("\n");
  writeFileSync(path.join(out, "results.md"), `# Замер озвучки ${new Date().toISOString()}\n\nlanguage_code: ${args.languageCode ?? "не передавался"}\n\n${table}\n\n## Тексты\n\n${texts.map((t) => `- ${t.id} [${t.template}]: ${t.text}`).join("\n")}\n`);
  await paid.finish();
  console.log(`\nГотово: ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; });
}
