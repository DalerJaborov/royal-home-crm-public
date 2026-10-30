import { z } from "zod";
import { customerAgentForeignShareOnly, type CustomerAgentAttachmentInput } from "./customerAgentAttachmentInput.js";
import { customerDmAbuseKind, customerDmForeignShareNoise } from "./customerAgentAbuse.js";
import { foldCustomerText } from "./customerAgentRole.js";
import { clientOwnWords } from "./untrustedContent.js";
import { BW, EW, TAIL } from "./wordBoundary.js";

/**
 * "Spammer" mute (30.10.2026). The same people forward other people's reels and like-exchange chains to us every day, several
 * times a day, often as a reply to an advertisement. Answering them costs tokens and teaches nothing; answering them with a
 * robot phrase hurts the brand. After two such turns within a week the dialogue is muted for a month: the input is still
 * accepted and stored (the operator sees it), but the core calls no model, no media perception and sends nothing.
 *
 * Pure rules only; the state lives in `BotConversation.leadDraft.spamMute` (lib/customerSpamMuteStore.ts, no migration).
 * Nothing here is a verdict about a person, and nothing mutes a FIRST turn: the mark needs two earlier spam turns.
 */
export const SPAM_TURNS_TO_MUTE = 2;
export const SPAM_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const SPAM_MUTE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REMEMBERED_TURNS = 8;

export const customerSpamMuteSchema = z.object({
  /** Spam turns seen (most recent last); `key` makes a retried event count once. */
  turns: z.array(z.object({ key: z.string().min(1).max(64), at: z.string().datetime() }).strict()).max(MAX_REMEMBERED_TURNS).default([]),
  mutedUntil: z.string().datetime().optional(),
}).strict();
export type CustomerSpamMute = z.infer<typeof customerSpamMuteSchema>;

/** Tolerant read of whatever sits under `leadDraft.spamMute`: anything unreadable is "no mark", never an error. */
export function customerSpamMuteFrom(raw: unknown): CustomerSpamMute {
  const parsed = customerSpamMuteSchema.safeParse(raw);
  return parsed.success ? parsed.data : { turns: [] };
}

export function customerSpamMuteActive(state: CustomerSpamMute, now: Date): boolean {
  return !!state.mutedUntil && Date.parse(state.mutedUntil) > now.getTime();
}

/**
 * Real interest in what we sell or rent, in the customer's OWN words: housing, price, address, buy/sell/rent verbs, one of our
 * object numbers or links, or a phone number. Any of it ends the mute at once, so a person who spams and then genuinely asks
 * is never silenced. Written in the folded alphabet of `foldCustomerText`; word edges are BW/EW/TAIL, never `\w`/`\b`.
 */
const INTEREST = new RegExp([
  `${BW}(?:квартир|кувартир|комнат|хона|хавли|хучра|участ|земельн|замин|манзил|недвижим|жиль|новостройк|ипотек|дуплекс|пентхаус)${TAIL}`,
  `${BW}(?:дом(?:а|у|е|ом|ик\\p{L}*)?|дача|дачу|дачи|двушк\\p{L}*|трешк\\p{L}*|однушк\\p{L}*|студи[яюи])${EW}`,
  `${BW}(?:цен[аыуе]|ценой|стоимост|стоит|почем|сколько|нарх|чанд\\s+(?:пул|аст|мешавад|сомони|доллар))${TAIL}`,
  `${BW}(?:адрес|сурога|локаци|район|ноих|микрорайон|ориентир)${TAIL}`,
  `${BW}(?:продам|продаю|продаем|продать|продается|мефурушам|мефурушем|фуруш|куплю|купить|покупк|покупа|харидан|харидорам|мехарам|мехарем|харид|снять|сниму|сдам|сдаю|сдается|аренд|ичора|ичорагир)${TAIL}`,
  `${BW}(?:обект|обявлени|элон|риелтор|риэлтор|рассрочк|кредит|задаток|просмотр)${TAIL}`,
  `${BW}(?:об|ob)\\s*[-№#]?\\s*\\d{1,6}${EW}`, `№\\s*\\d{1,6}${EW}`,
  `${BW}(?:narx|price|cena|tsena|skolko|kvartira|xona|hona|dom|adres|address|nomer|telefon|vacancy|rabota)${TAIL}`,
  `${BW}royal\\s*home${TAIL}`,
].join("|"), "iu");
const PHONE = /(?:\+?\d[\s().-]?){7,}/u;

export function customerSpamInterest(text: string): boolean {
  const own = clientOwnWords(text).normalize("NFKC");
  if (!own.trim()) return false;
  if (PHONE.test(own) && own.replace(/\D/gu, "").length >= 7) return true;
  return INTEREST.test(foldCustomerText(own));
}

/**
 * Is THIS turn a spam turn (counts toward the mute)? A forwarded foreign publication with nothing asked, or the like-exchange /
 * promotion words of the abuse guard, and in either case no interest word beside them. `attachmentInput` is the one the core
 * receives, i.e. already marked `foreign_share` by the server lookup; an unmarked "share" is never counted.
 */
export function customerSpamTurn(input: { inputText: string; attachmentInput?: CustomerAgentAttachmentInput }): boolean {
  if (customerSpamInterest(input.inputText)) return false;
  if (customerDmAbuseKind(input.inputText) === "spam") return true;
  return customerAgentForeignShareOnly(input.attachmentInput) && customerDmForeignShareNoise(input.inputText);
}

/** The state after one more spam turn: remembers the turn once, forgets turns older than the window, sets the mark at the threshold. */
export function customerSpamMuteRecord(state: CustomerSpamMute, turn: { key: string; now: Date }): CustomerSpamMute {
  const since = turn.now.getTime() - SPAM_WINDOW_MS;
  const kept = state.turns.filter(item => Date.parse(item.at) >= since && item.key !== turn.key);
  const turns = [...kept, { key: turn.key, at: turn.now.toISOString() }].slice(-MAX_REMEMBERED_TURNS);
  const alreadyMuted = customerSpamMuteActive(state, turn.now);
  return { turns, ...(alreadyMuted ? { mutedUntil: state.mutedUntil } :
    turns.length >= SPAM_TURNS_TO_MUTE ? { mutedUntil: new Date(turn.now.getTime() + SPAM_MUTE_MS).toISOString() } : {}) };
}

/** Decision for a turn that arrives while the mark may be set. */
export function customerSpamMuteGate(state: CustomerSpamMute, input: { inputText: string; now: Date }): "muted" | "released" | "open" {
  if (!customerSpamMuteActive(state, input.now)) return "open";
  return customerSpamInterest(input.inputText) ? "released" : "muted";
}

/** Reason of the no-reply hold of a muted turn (a quiet outcome, not an alarm). */
export const SPAM_MUTED_NO_REPLY = "spam_muted_no_reply";
