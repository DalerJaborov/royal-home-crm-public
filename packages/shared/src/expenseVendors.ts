import { z } from "zod";

/**
 * ПОСТАВЩИКИ ПОДПИСОК И СЧЕТОВ (17.11.2026).
 *
 * Владелец 14.11: «добавить это всё автоматически, все подписки, что у нас есть, включая синюю
 * галочку». Подписка в CRM — это шаблон повторяющегося платежа (RecurringExpense) с поставщиком;
 * каждый месяц он сам заводит строку расхода, и у строки тот же поставщик (Expense.vendor).
 *
 * Поставщик нужен для двух правил:
 *  1. Ручная «Оплата Gemini» при заведённой подписке Gemini — «уже учтено» (expenseAutoOverlap.ts).
 *  2. Оценка ИИ (`ai:<месяц>`, журнал обращений по прайсу) НЕ считает поставщика, за которого в
 *     этом месяце есть настоящий счёт или подписка: иначе Gemini учтён дважды — оценкой ≈ 33 $ и
 *     счётом «ОПЛАТА ИИ» 2 000 с. (октябрь 2026). Счёт поставщика — правда, оценка — справка.
 */
export const EXPENSE_VENDORS = [
  "GEMINI", "OPENAI", "ANTHROPIC", "ELEVENLABS", "DEEPSEEK",
  "META_VERIFIED", "TELEGRAM_PREMIUM", "SERVER", "DOMAIN", "OTHER",
] as const;
export type ExpenseVendor = typeof EXPENSE_VENDORS[number];
export const expenseVendorSchema = z.enum(EXPENSE_VENDORS);

export const EXPENSE_VENDOR_LABELS: Record<ExpenseVendor, string> = {
  GEMINI: "Gemini (Google AI)",
  OPENAI: "OpenAI (ChatGPT)",
  ANTHROPIC: "Claude (Anthropic)",
  ELEVENLABS: "ElevenLabs (голос)",
  DEEPSEEK: "DeepSeek",
  META_VERIFIED: "Meta Verified (синяя галочка)",
  TELEGRAM_PREMIUM: "Telegram Premium",
  SERVER: "Сервер",
  DOMAIN: "Домен",
  OTHER: "Другой сервис",
};

/** Поставщики ИИ, чьи обращения CRM оценивает сама по журналу AiLog. */
export const AI_ESTIMATE_VENDORS: readonly ExpenseVendor[] = ["GEMINI", "OPENAI", "ANTHROPIC", "ELEVENLABS", "DEEPSEEK"];
export function isAiEstimateVendor(value: string | null | undefined): value is ExpenseVendor {
  return !!value && (AI_ESTIMATE_VENDORS as readonly string[]).includes(value);
}

/**
 * Граница слова без `\b` (кириллица) и без взгляда назад (старый Safari, сторож noRegexLookbehind).
 * Порядок важен: первым совпавшим считается поставщик строки.
 */
const B = "(?:^|[^\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
const VENDOR_WORDS: readonly [ExpenseVendor, RegExp][] = [
  ["META_VERIFIED", new RegExp(`meta\\s*verified|верифик|синяя\\s+галоч|синей\\s+галоч|синюю\\s+галоч|галочк|${B}tick${E}|нишони\\s+кабуд`, "iu")],
  ["GEMINI", new RegExp(`gemini|джемини|гемини|google\\s*ai|${B}гугл\\s*ии${E}|vertex`, "iu")],
  ["OPENAI", new RegExp(`openai|open\\s*ai|опен\\s*аи|опен\\s*ии|chat\\s*gpt|чат\\s*gpt|чатгпт|${B}gpt${E}|dall-?e`, "iu")],
  ["ANTHROPIC", new RegExp(`claude|клод|anthropic|антропик`, "iu")],
  ["ELEVENLABS", new RegExp(`eleven\\s*labs|элевен|илевен|11\\s*labs`, "iu")],
  ["DEEPSEEK", new RegExp(`deepseek|дипсик`, "iu")],
  ["TELEGRAM_PREMIUM", new RegExp(`telegram\\s*premium|телеграм\\s*премиум|тг\\s*премиум`, "iu")],
  ["SERVER", new RegExp(`${B}(?:сервер|vps|хостинг|hosting|hetzner|beget|бегет|timeweb|таймвеб|digitalocean)`, "iu")],
  ["DOMAIN", new RegExp(`${B}домен|${B}domain`, "iu")],
];

/** Поставщик по словам строки («Оплата Gemini за ноябрь» → GEMINI); не узнали — null. */
export function vendorOfText(text: string | null | undefined): ExpenseVendor | null {
  if (!text) return null;
  for (const [vendor, words] of VENDOR_WORDS) if (words.test(text)) return vendor;
  return null;
}

/**
 * Поставщик обращения из журнала AiLog: поле provider (новые записи) или имя модели (старые).
 * null — не узнали; такая оценка остаётся в строке ИИ всегда.
 */
export function aiLogVendor(provider: string | null | undefined, model: string | null | undefined): ExpenseVendor | null {
  const p = (provider ?? "").toLowerCase();
  // Старые записи хранят имя модели с префиксом API: «models/gemini-…».
  const m = (model ?? "").toLowerCase().replace(/^models\//, "");
  if (p === "google" || p === "gemini" || m.startsWith("gemini") || m.startsWith("imagen") || m.startsWith("veo")) return "GEMINI";
  if (p === "openai" || m.startsWith("gpt") || m.startsWith("dall-e") || m.startsWith("text-embedding") || m.startsWith("whisper") || m.startsWith("tts-")) return "OPENAI";
  if (p === "anthropic" || p === "claude" || m.startsWith("claude")) return "ANTHROPIC";
  if (p === "elevenlabs" || m.startsWith("eleven")) return "ELEVENLABS";
  if (p === "deepseek" || m.startsWith("deepseek")) return "DEEPSEEK";
  return null;
}

/** Строка журнала ИИ, сгруппированная по поставщику/модели (aiLog.groupBy). */
export interface AiCostGroup { provider: string | null; model: string | null; costUsd: unknown }

export interface AiEstimateSplit {
  /** Оценка, которая идёт в расходы месяца, в центах доллара. */
  countedCents: number;
  /** Оценка поставщиков, за которых есть настоящий счёт, — справка, в расходы не идёт. */
  coveredCents: number;
  /** Каких поставщиков не считали (по порядку EXPENSE_VENDORS). */
  coveredVendors: ExpenseVendor[];
}

/**
 * ПРАВИЛО «СЧЁТ ПОСТАВЩИКА СИЛЬНЕЕ ОЦЕНКИ»: за месяц, где у поставщика ИИ есть ОПЛАЧЕННЫЙ счёт,
 * помеченный «оплата ИИ, которым работает CRM» (`Expense.coversAiUsage`, ревью 17.11: подписка на
 * чат ChatGPT Plus / Claude Max обращения CRM не оплачивает), его оценка по журналу в расход не идёт. Суммы — центы доллара;
 * округление один раз на месяц, как и раньше (оценка приходит долями цента за вызов).
 */
export function splitAiEstimate(groups: readonly AiCostGroup[], billedVendors: Iterable<string>): AiEstimateSplit {
  const billed = new Set(billedVendors);
  let counted = 0;
  let covered = 0;
  const coveredSet = new Set<ExpenseVendor>();
  for (const g of groups) {
    const cost = Number(g.costUsd ?? 0);
    if (!Number.isFinite(cost) || cost === 0) continue;
    const vendor = aiLogVendor(g.provider, g.model);
    if (vendor && billed.has(vendor)) { covered += cost; coveredSet.add(vendor); } else counted += cost;
  }
  return {
    countedCents: Math.round(counted * 100),
    coveredCents: Math.round(covered * 100),
    coveredVendors: EXPENSE_VENDORS.filter((v) => coveredSet.has(v)),
  };
}

/** Текст строки ИИ за месяц: что посчитано и кто не посчитан, потому что есть счёт. */
export function aiEstimateNote(split: Pick<AiEstimateSplit, "coveredCents" | "coveredVendors">): string {
  const base = "Искусственный интеллект: оценка CRM по журналу обращений и прайсу, не счёт поставщика. Сумма обновляется раз в сутки.";
  if (!split.coveredVendors.length) return base;
  const names = split.coveredVendors.map((v) => EXPENSE_VENDOR_LABELS[v]).join(", ");
  return `${base} Не считаем ${names}: за этот месяц есть настоящий счёт или подписка (оценка ${(split.coveredCents / 100).toFixed(2)} $ только для справки).`;
}

/**
 * Готовые подписки для быстрого добавления: название и поставщик. Сумму, валюту и день списания
 * вводит человек — придумывать цены нельзя (правило владельца: данные не выдумывать).
 */
export const SUBSCRIPTION_PRESETS: readonly { vendor: ExpenseVendor; title: string; counterparty: string; coversAiUsage: boolean }[] = [
  // Gemini и ElevenLabs — это и есть ИИ, которым работает CRM (API и голос): их счёт снимает оценку.
  { vendor: "GEMINI", title: "Gemini API (ИИ для CRM)", counterparty: "Google", coversAiUsage: true },
  { vendor: "META_VERIFIED", title: "Meta Verified (синяя галочка)", counterparty: "Meta", coversAiUsage: false },
  { vendor: "ELEVENLABS", title: "ElevenLabs (голос)", counterparty: "ElevenLabs", coversAiUsage: true },
  // Подписки на чат (ChatGPT Plus, Claude Pro/Max) обращения CRM не оплачивают: оценку не трогают.
  { vendor: "OPENAI", title: "ChatGPT (подписка на чат)", counterparty: "OpenAI", coversAiUsage: false },
  { vendor: "ANTHROPIC", title: "Claude (подписка на чат)", counterparty: "Anthropic", coversAiUsage: false },
  { vendor: "SERVER", title: "Сервер CRM", counterparty: "", coversAiUsage: false },
  { vendor: "DOMAIN", title: "Домен royalhome.tj", counterparty: "", coversAiUsage: false },
  { vendor: "TELEGRAM_PREMIUM", title: "Telegram Premium", counterparty: "Telegram", coversAiUsage: false },
];
