import { z } from "zod";

const storedInt = z.number().int().nonnegative().max(2_147_483_647);
const money = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Untrusted model output. No coercion: "false" must never authorize an action. */
export const submitReplyLeadSchema = z.object({
  budgetMin: money.optional(),
  budgetMax: money.optional(),
  districtName: z.enum(["Исмоили Сомони", "Сино", "Фирдавси", "Шохмансур"]).optional(),
  type: z.enum(["APARTMENT", "HOUSE", "COMMERCIAL", "LAND"]).optional(),
  rooms: storedInt.optional(),
  notes: z.string().optional(),
  locationOutsideDushanbe: z.boolean().optional(),
  locationDifferentCountry: z.boolean().optional(),
}).strict().refine((v) => v.budgetMin == null || v.budgetMax == null || v.budgetMin <= v.budgetMax,
  { path: ["budgetMax"], message: "Budget bounds reversed" });

export const submitReplyShowingSchema = z.object({
  action: z.enum(["book", "reschedule", "cancel"]),
  propertyCode: storedInt.positive().optional(),
  day: z.union([z.enum(["today", "tomorrow", "after_tomorrow"]), z.iso.date()]).optional(),
  time: z.union([z.enum(["morning", "afternoon", "evening"]), z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)]).optional(),
}).strict();

export const submitReplyJobSchema = z.object({
  name: z.string().optional(), age: storedInt.optional(),
  studyingUniversity: z.boolean().optional(), studyingNow: z.boolean().optional(),
  employedNow: z.boolean().optional(), city: z.string().optional(),
  education: z.string().optional(), experience: z.string().optional(),
  salesExperience: z.boolean().optional(), targetEducation: z.boolean().optional(),
  hasCar: z.boolean().optional(), strongMotivation: z.boolean().optional(),
  achievements: z.string().optional(), languages: z.string().optional(),
  startWhen: z.string().optional(), phone: z.string().optional(), summary: z.string().optional(),
}).strict();

export interface SubmitReplyCapabilities {
  showings: boolean; askOwner: boolean; vacancies: boolean; promptEconomy: boolean;
  canSendPhotos: boolean; canSendGuide: boolean; topicLock: boolean;
}

export const SUBMIT_REPLY_ROLES = ["BUYER", "SELLER", "JOB", "PARTNER", "CLIENT_CARE", "VENDOR", "OTHER", "UNKNOWN"] as const;
export const SUBMIT_REPLY_TOPICS = ["price", "district", "rooms", "area", "photos", "showing", "documents", "payment", "sell_intake", "job", "other"] as const;

/** Keep the established string-to-bubbles compatibility, but never discard malformed members. */
export function submitReplySchema(c: SubmitReplyCapabilities) {
  const bubble = z.string().refine((v) => v.trim().length > 0, "Empty reply");
  return z.object({
    reply: z.union([bubble, z.array(bubble).min(1).max(2)]).transform((v) => typeof v === "string" ? [v] : v),
    ready: z.boolean(), confident: z.boolean(),
    intent: z.enum(["buy", "sell", "job", "rent", "other"]).optional(),
    lead: submitReplyLeadSchema.nullish().transform((v) => v ?? null),
    whoIsThis: c.promptEconomy ? z.enum(SUBMIT_REPLY_ROLES).optional() : z.never().optional(),
    showing: c.showings ? submitReplyShowingSchema.optional() : z.never().optional(),
    askOwner: c.askOwner ? z.string().nullable().optional() : z.never().optional(),
    callbackRequest: z.string().nullable().optional(),
    jobApplication: c.vacancies ? submitReplyJobSchema.nullable().optional() : z.never().optional(),
    showPropertyNumber: c.canSendPhotos ? storedInt.nullable().optional() : z.never().optional(),
    sendGuide: c.canSendGuide ? z.boolean().optional() : z.never().optional(),
    topic: c.topicLock ? z.enum(SUBMIT_REPLY_TOPICS) : z.never().optional(),
    topicLabel: c.topicLock ? z.string().optional() : z.never().optional(),
    openQuestion: c.topicLock ? z.string() : z.never().optional(),
    clientAnsweredOpenQuestion: c.topicLock ? z.boolean() : z.never().optional(),
  }).strict();
}

export type SubmitReply = z.output<ReturnType<typeof submitReplySchema>>;
