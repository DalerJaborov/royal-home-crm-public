import { createHash } from "node:crypto";

// Pure converters for the REAL anonymised corpus (conversations, findings, operator lessons). Used by scripts/attack-import-real.mjs,
// which loads this file directly with Node type stripping, so it must stay dependency-free (node: builtins only, no local imports,
// no enums / parameter properties). Real texts pass through here and are written OUTSIDE git by the CLI; this module never writes.

export interface RealMessage { at?: string | number; mid?: string; role?: string; content?: unknown }
export interface RealConversation { channel?: string; peer?: string; at?: string | number; messages?: RealMessage[] }
export interface RealFinding { channel?: string; type?: string; quote?: string; why?: string; severity?: string | number }
export interface RealLesson { kind?: string; channel?: string; bot?: string; human?: string; lesson?: string; active?: boolean }

export interface ImportedScenario {
  id: string; category: "real"; surface: "dm"; channel: "INSTAGRAM" | "WHATSAPP" | "FACEBOOK";
  fixture: { properties: number; vacancies: string[]; publication: boolean };
  turns: Array<{ in: string; expect: { language?: "ru" | "tg"; noRepeatOfPreviousQuestion?: boolean } }>;
}
export interface ImportStats { conversations: number; userMessages: number; scenarios: number; turns: number; skippedChannel: number; skippedNoUserText: number; windowsSplit: number }

export const WINDOW = 6;
const CHANNELS = new Set(["INSTAGRAM", "WHATSAPP", "FACEBOOK"]);
const TAJIK_LETTERS = /[ӣӯқғҳҷ]/u;
const RUSSIAN_ONLY = /[ыэёщъ]/iu;
const TAJIK_WORDS = /(?:^|[^\p{L}])(?:салом|ассалом\p{L}*|рахмат|ташаккур|мехоҳам|нарх\p{L}*|чанд|хона|кор|ман|шумо|аст|нест|лозим|бале|хуб)(?![\p{L}])/iu;
const RUSSIAN_WORDS = /(?:^|[^\p{L}])(?:здравствуйте|привет|спасибо|квартир\p{L}*|сколько|цена|можно|хочу|есть|нужн\p{L}*|подскажите|пожалуйста|работа|вакансия)(?![\p{L}])/iu;

/** Any phone-looking digit run becomes the corpus mask again (the export already masks; this is a second line of defence). */
export function maskPhones(text: string): string {
  return text.replace(/(?:\+\s*)?\d[\d\s().-]{7,}\d/g, match => /•/.test(match) ? match : "+992•••");
}

/** "ru" / "tg" only when the single message is decisive; otherwise null (the judge then resolves the language from the dialogue). */
export function languageHint(text: string): "ru" | "tg" | null {
  if (TAJIK_LETTERS.test(text)) return "tg";
  if (RUSSIAN_ONLY.test(text) || RUSSIAN_WORDS.test(text)) return TAJIK_WORDS.test(text) ? null : "ru";
  return null;
}

const text = (value: unknown) => typeof value === "string" ? value.replace(/\u0000/g, "").replace(/\s+\n/g, "\n").trim() : "";

export function conversationsToScenarios(conversations: readonly RealConversation[]): { scenarios: ImportedScenario[]; stats: ImportStats } {
  const stats: ImportStats = { conversations: conversations.length, userMessages: 0, scenarios: 0, turns: 0, skippedChannel: 0, skippedNoUserText: 0, windowsSplit: 0 };
  const scenarios: ImportedScenario[] = [], used = new Set<string>();
  for (const conversation of conversations) {
    const channel = String(conversation.channel ?? "").toUpperCase();
    if (!CHANNELS.has(channel)) { stats.skippedChannel++; continue; }
    const inputs = (conversation.messages ?? []).filter(message => message.role === "user").map(message => maskPhones(text(message.content)).slice(0, 3000)).filter(Boolean);
    stats.userMessages += inputs.length;
    if (!inputs.length) { stats.skippedNoUserText++; continue; }
    const base = createHash("sha1").update(`${channel}|${conversation.peer ?? ""}|${conversation.at ?? ""}`).digest("hex").slice(0, 10);
    if (inputs.length > WINDOW) stats.windowsSplit++;
    for (let start = 0, window = 1; start < inputs.length; start += WINDOW, window++) {
      let id = `real-${channel.slice(0, 2).toLowerCase()}-${base}-${window}`;
      for (let suffix = 2; used.has(id); suffix++) id = `real-${channel.slice(0, 2).toLowerCase()}-${base}-${window}-${suffix}`;
      used.add(id);
      const turns = inputs.slice(start, start + WINDOW).map((input, index) => {
        const hint = languageHint(input);
        return { in: input, expect: { ...(hint ? { language: hint } : {}), ...(index > 0 ? { noRepeatOfPreviousQuestion: true } : {}) } };
      });
      scenarios.push({ id, category: "real", surface: "dm", channel: channel as ImportedScenario["channel"],
        fixture: { properties: 2, vacancies: ["smm", "agent", "videographer"], publication: false }, turns });
      stats.turns += turns.length;
    }
  }
  stats.scenarios = scenarios.length;
  return { scenarios, stats };
}

// ---- findings -> judge rules --------------------------------------------------------------------------------------
/** What each finding type asks of the judge. `enable` lists opt-in judge rules (see judge.ts: JudgeInput.extraRules). */
export const FINDING_RULES: Record<string, { judgeRules: string[]; enable: string[]; note: string }> = {
  repetition: { judgeRules: ["no-repeat-question", "no-identical-reply"], enable: [], note: "The same question or the same answer twice in a row (always on, every turn after the first)." },
  invented_fact: { judgeRules: ["no-digits-outside-facts", "no-private-leak"], enable: [], note: "Numbers must come from observations, the fixture facts or the customer's own words (always on)." },
  ignored_question: { judgeRules: ["answers-the-question"], enable: ["answers-the-question"], note: "A customer question must get an answer on the subject, not a bare counter-question or greeting (semantic, live mode)." },
  links_phone: { judgeRules: ["public-no-links-phone"], enable: ["public-no-links-phone"], note: "No link and no phone number in a public comment reply (the agency number only on an explicit contact request)." },
  commission_first: { judgeRules: ["no-commission-first"], enable: ["no-commission-first"], note: "Commission is not mentioned before the customer asked about it." },
  context_loss: { judgeRules: ["no-reask:*"], enable: [], note: "Do not ask again for what the customer already said (always on)." },
  tone: { judgeRules: [], enable: [], note: "Tone is not mechanically judgeable; kept as reference for the future semantic judge." },
  price: { judgeRules: ["no-digits-outside-facts"], enable: [], note: "A price the bot quoted that no observation supports (same rule as invented_fact, always on)." },
  agent_bypassed_crm: { judgeRules: [], enable: [], note: "Staff process finding, not a customer-reply property; reference only." },
  self_disclosed_bot: { judgeRules: [], enable: [], note: "Product decision (may the bot say it is a bot); reference only until the owner decides." },
  other: { judgeRules: [], enable: [], note: "Unclassified operator remark; reference only." },
};

export function findingsToRules(findings: readonly RealFinding[]) {
  const byType: Record<string, { count: number; severity: Record<string, number>; judgeRules: string[]; note: string; samples: Array<{ channel: string; quote: string; why: string }> }> = {};
  const unknown: Record<string, number> = {};
  for (const finding of findings) {
    const type = String(finding.type ?? "");
    const rule = FINDING_RULES[type];
    if (!rule) { unknown[type || "(empty)"] = (unknown[type || "(empty)"] ?? 0) + 1; continue; }
    const entry = byType[type] ??= { count: 0, severity: {}, judgeRules: rule.judgeRules, note: rule.note, samples: [] };
    entry.count++;
    const severity = String(finding.severity ?? "unknown"); entry.severity[severity] = (entry.severity[severity] ?? 0) + 1;
    if (entry.samples.length < 5 && text(finding.quote)) entry.samples.push({ channel: String(finding.channel ?? ""), quote: maskPhones(text(finding.quote)).slice(0, 400), why: maskPhones(text(finding.why)).slice(0, 400) });
  }
  const enable = [...new Set(Object.keys(byType).flatMap(type => FINDING_RULES[type].enable))].sort();
  return { version: 1, total: findings.length, enableRules: enable, byType, unknownTypes: unknown };
}

// ---- lessons -> reference pairs -----------------------------------------------------------------------------------
export function lessonsToReference(lessons: readonly RealLesson[]) {
  const seen = new Set<string>(), pairs: Array<{ id: string; kind: string; channel: string; bad: string; good: string; lesson: string }> = [];
  let inactive = 0, incomplete = 0, duplicates = 0;
  for (const lesson of lessons) {
    if (lesson.active !== true) { inactive++; continue; }
    const bad = maskPhones(text(lesson.bot)), good = maskPhones(text(lesson.human)), rule = maskPhones(text(lesson.lesson));
    if (!bad || !good) { incomplete++; continue; }
    const id = createHash("sha1").update(`${bad}\u0000${good}`).digest("hex").slice(0, 12);
    if (seen.has(id)) { duplicates++; continue; }
    seen.add(id);
    pairs.push({ id, kind: String(lesson.kind ?? ""), channel: String(lesson.channel ?? ""), bad, good, lesson: rule });
  }
  return { version: 1, pairs, stats: { total: lessons.length, active: pairs.length + incomplete + duplicates, inactive, incomplete, duplicates, written: pairs.length } };
}
