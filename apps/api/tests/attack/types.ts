import { z } from "zod";

// Attack-harness contracts: scenario corpus (synthetic in git, real outside git), per-turn outcome, judge verdicts.
// Pure data only: no prisma, no model, no network, so the judge and the importer are unit-testable without a database.

export const ATTACK_CATEGORIES = ["buyer", "seller", "job", "comment", "link", "media", "language", "abuse", "injection", "multi-turn", "dm-share", "real"] as const;
export type AttackCategory = typeof ATTACK_CATEGORIES[number];
export const QUESTION_PURPOSES = ["property", "budget", "location", "rooms", "name", "phone", "callback_consent", "topic", "role", "clarify_previous",
  "seller_details", "preferences", "job_position", "job_experience", "job_portfolio", "job_tools", "job_format", "job_start"] as const;
export type QuestionPurpose = typeof QUESTION_PURPOSES[number];

export const expectSchema = z.object({
  /** true: the customer must get a reply (silence is a failure). false: a reply is a failure (skip/moderation expected). */
  replied: z.boolean().optional(),
  /** Reply language. Default: language of the input as the product resolves it (explicit request, then dialogue history). */
  language: z.enum(["ru", "tg"]).optional(),
  /** Semantic topic of the reply (lexicon check, needs a real model to be meaningful). */
  topic: z.enum(["property", "job", "seller", "company", "policy"]).optional(),
  /** Question purposes the reply must NOT ask (matched against the fixed renderer sentences). */
  noQuestionOf: z.array(z.enum(QUESTION_PURPOSES)).optional(),
  mustNotContain: z.array(z.string().min(1)).optional(),
  mustContain: z.array(z.string().min(1)).optional(),
  /** Every number in the reply comes from the customer's own words, an observation or the fixture facts. Default on. */
  noDigitsOutsideFacts: z.boolean().optional(),
  /** No promise lexicon ("позвоним", "записал") without a matching receipt. Default on. */
  noPromise: z.boolean().optional(),
  /** The question sentence of the previous bot reply is not repeated. Default on. */
  noRepeatOfPreviousQuestion: z.boolean().optional(),
  /** public_comment: the comment is hidden/deleted/skipped instead of answered. */
  moderated: z.boolean().optional(),
  maxChars: z.number().int().positive().max(5000).optional(),
}).strict();
export type AttackExpect = z.infer<typeof expectSchema>;

export const perceptionSchema = z.object({
  language: z.enum(["ru", "tg", "unknown"]).default("unknown"), transcript: z.string().max(6000).default(""),
  subject: z.enum(["home_interior", "building_exterior", "floor_plan", "listing_card", "document", "person", "other", "not_visible"]).default("not_visible"),
  visible: z.array(z.enum(["kitchen", "bathroom", "bedroom", "living_room", "balcony", "stairs", "windows", "furniture", "renovation", "unfinished", "yard", "parking", "land", "floor_plan"])).max(8).default([]), readableText: z.string().max(2000).default(""),
  speech: z.enum(["clear", "partial", "none", "unintelligible"]).default("none"),
}).strict();
export const attachSchema = z.object({
  type: z.enum(["image", "video", "audio", "document", "ig_reel", "ig_post", "ig_reel_foreign", "ig_reel_own_unlinked"]),
  /** What the media perception returns for this file (the fixture supplies it in both model modes). */
  perception: perceptionSchema.optional(),
}).strict();
export type AttackAttach = z.infer<typeof attachSchema>;

export const turnSchema = z.object({ in: z.string().max(3000), attach: attachSchema.nullish(), expect: expectSchema.optional() }).strict();
export type AttackTurn = z.infer<typeof turnSchema>;

export const fixtureSchema = z.object({
  /** Number of published catalogue cards (p1..pN, see attackFixture.ts for their facts). */
  properties: z.number().int().min(0).max(4).default(1),
  /** Open vacancy keys: smm | agent | videographer | operator. */
  vacancies: z.array(z.enum(["smm", "agent", "videographer", "operator"])).default([]),
  /** public_comment: the post the comment sits under maps to property p1. */
  publication: z.boolean().default(false),
}).strict();
export type AttackFixtureSpec = z.infer<typeof fixtureSchema>;

export const scenarioSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_.-]{2,63}$/),
  category: z.enum(ATTACK_CATEGORIES),
  surface: z.enum(["dm", "public_comment"]),
  channel: z.enum(["INSTAGRAM", "WHATSAPP", "FACEBOOK"]),
  fixture: fixtureSchema.default({ properties: 1, vacancies: [], publication: false }),
  turns: z.array(turnSchema).min(1).max(8),
  /** Free note for the reader of a failing report. */
  note: z.string().max(300).optional(),
}).strict();
export type AttackScenario = z.infer<typeof scenarioSchema>;

export type TurnStatus = "replied" | "silent" | "held" | "moderated" | "escalated" | "skipped" | "error";
export interface AttackDecision { kind: string; question?: string; social?: string; refs?: string[]; reason?: string; action?: string }
export interface TurnOutcome {
  status: TurnStatus;
  /** Customer-visible text that physically left (empty when nothing was sent). */
  replies: string[];
  heldReason?: string;
  /** Last structured decision the model produced for this turn (null when none was parsed). */
  decision: AttackDecision | null;
  /** Public observations stored with the reply (facts, policies, receipts...). Serialised JSON. */
  observationsJson: string;
  modelCalls: number;
  error?: string;
}

/** Facts the reply may legitimately contain besides observations and the customer's own words. */
export interface JudgeFacts {
  /** Digit strings (spaces removed) from the fixture cards: short ids, price, area, rooms, floors. */
  numbers: readonly string[];
  /** Digit strings of phones the bot may print (the agency's public number). */
  allowedPhoneDigits: readonly string[];
  allowedHandles: readonly string[];
  /** Strings that must never appear in a reply (private addresses and other sentinels of the fixture). */
  forbidden?: readonly string[];
}

export type JudgeMode = "scripted" | "live";
export interface RuleVerdict { rule: string; pass: boolean; detail?: string; semantic?: boolean; skipped?: boolean }
export interface TurnJudgement { pass: boolean; verdicts: RuleVerdict[] }
