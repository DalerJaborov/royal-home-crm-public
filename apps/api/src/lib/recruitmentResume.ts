import { recruitmentResumeSchema, type RecruitmentFactKey, type RecruitmentResume, type RecruitmentResumeFacts } from "@royal-home/shared";
import { normalizeCandidatePhone } from "./candidatePhone.js";

/** Deliberately conservative: only literal self-statements/labelled résumé
 * fields from the verified current input. No model inference or foreign history. */
type DraftFacts = { [K in keyof RecruitmentResumeFacts]?: Omit<NonNullable<RecruitmentResumeFacts[K]>, "sourceEventKey"> };
const statusAnswers = {
  studyingNow: {
    negative: /^(?:(?:нет|неа|не),?\s*)?(?:(?:я\s+)?(?:сейчас\s+)?не\s+(?:учусь|обучаюсь)(?:\s+сейчас)?|(?:ман\s+)?(?:ҳоло\s+)?намехонам)[.!]?$/iu,
    positive: /^(?:(?:да|ага|ҳа|ха|бале),?\s*)?(?:(?:я\s+)?(?:сейчас\s+)?(?:учусь|обучаюсь)(?:\s+сейчас)?|(?:ман\s+)?(?:ҳоло\s+)?мехонам)[.!]?$/iu,
  },
  employedNow: {
    negative: /^(?:(?:нет|неа|не),?\s*)?(?:(?:я\s+)?(?:сейчас\s+)?не\s+работаю(?:\s+сейчас)?|(?:ман\s+)?(?:ҳоло\s+)?кор\s+намекунам)[.!]?$/iu,
    positive: /^(?:(?:да|ага|ҳа|ха|бале),?\s*)?(?:(?:я\s+)?(?:сейчас\s+)?работаю(?:\s+сейчас)?|(?:ман\s+)?(?:ҳоло\s+)?кор\s+мекунам)[.!]?$/iu,
  },
};
// Explicit work/study verbs are status replies, not bare personal names.
const explicitStatusReply = /(?:^|\s)(?:учусь|обучаюсь|работаю|учится|работает|учиться|работать|намехонам|мехонам|намекунам|мекунам|мехонад|мекунад|намехонад|намекунад)(?=\s|$)/iu;
const mixedMessengerNameReply = /^(?<name>[\p{L}][\p{L}'’-]*(?:[ \t]+[\p{L}][\p{L}'’-]*){0,2}?)[ \t]+(?:(?:через|в)[ \t]+)?(?:телеграм(?:м)?|telegram|ватсап|whats[ \t]*app|мессенджер|инстаграм|instagram|директ)(?=$|[^\p{L}])(?<question>[^\r\n]{0,160}[?？])$/iu;
const messengerQuestionCue = /(?:^|[^\p{L}])(?:можно(?:[ \t]+ли)?|удобно|лучше|предпочитаете|написать|связаться|общаться|или|мумкин|метавонам)(?=$|[^\p{L}])/iu;
const nonNameQuestionPrefix = /^(?:(?:а|и|ну)[ \t]+)*(?:(?:можно|могу|можете)(?:[ \t]+(?:ли|мне|нам|вам|тебе))?|как(?:[ \t]+(?:мне|нам|вам|тебе))?(?:[ \t]+(?:можно|лучше))?)$/iu;
// Finite guard for common role labels, greetings, and communication requests.
// It cannot classify every word as a name or profession; a stored name remains
// a literal customer claim, never verified identity.
const nonNameReply = /^(?:(?:а|пожалуйста)[ \t]+)*(?:можно(?:[ \t]+ли)?|можете|могу|подскажите|скажите|напишите|пишите|пиши|свяжитесь|связаться|написать|ответьте|отвечайте|позвоните|перезвоните|звоните|обращайтесь|отправьте|пришлите|сообщите|уточните|удобно|лучше|предпочитаете|да|ага|ҳа|ха|бале|нет|неа|не|не знаю|потом|спасибо|салом|привет|здравствуйте|монтаж[её]р|видеограф|смм(?:-специалист)?|агент(?:[ \t]+по[ \t]+недвижимости)?|риелтор|дизайнер)(?:[ \t]+пожалуйста)?$/iu;
function hasNonNameContinuation(candidate: string): boolean {
  const words = candidate.trim().split(/[ \t]+/u);
  return words.slice(1).some((_, index) => {
    const suffix = words.slice(index + 1).join(" ");
    return nonNameQuestionPrefix.test(suffix) || nonNameReply.test(suffix);
  });
}
export function extractRecruitmentResumeFacts(input: string): DraftFacts {
  const facts: DraftFacts = {};
  const text = input.trim();
  const sourced = <T extends string | number | boolean>(value: T, quote: string) => ({ value, quote: quote.trim() });
  const clauses = text.split(/[.!?\n\r;]+/u).map(value => value.trim()).filter(Boolean);
  const age = clauses.map(clause => /^(?:мне\s+(\d{2})\s*(?:лет|года|год)(?!\p{L})|возраст\s*[:—-]\s*(\d{2})(?!\d)|ман\s+(\d{2})\s*сола)/iu.exec(clause)).find(Boolean);
  if (age) {
    const value = Number(age[1] ?? age[2] ?? age[3]);
    if (value >= 14 && value <= 100) facts.age = sourced(value, age[0]);
  }
  const name = clauses.map(clause => /^(?:меня зовут|имя\s*[:—-]|номи ман)\s+([\p{L}][\p{L}'’-]*(?:[ \t]+[\p{L}][\p{L}'’-]*){0,2}?)(?=$|[ \t]*[,;:!?？]|[ \t]+(?:(?:(?:через|в)[ \t]+)?(?:телеграм(?:м)?|telegram|ватсап|whats[ \t]*app|мессенджер|инстаграм|instagram|директ))(?=$|[^\p{L}]))/iu.exec(clause)).find(Boolean);
  if (name && !hasNonNameContinuation(name[1])) facts.name = sourced(name[1].trim(), name[0]);
  const phone = /(?:^|[\n\r])\s*(?:(?:мой\s+)?(?:телефон|номер|phone|тел)\s*[:—-]?\s*)?([+(\d][\d\s()-]{8,25})(?=$|[\n\r])/iu.exec(text);
  if (phone) {
    const value = normalizeCandidatePhone(phone[1]);
    if (value) facts.phone = sourced(value, phone[1]);
  }
  for (const line of text.split(/[\r\n]+/u)) {
    const labelled = /^(город|шаҳр|образование|таҳсилот|опыт|таҷриба|языки|забонҳо|навыки|малака|инструменты|программы|барномаҳо|готов начать|метавонам оғоз кунам)\s*[:—-]\s*(.{1,1800})$/iu.exec(line.trim());
    if (!labelled) continue;
    const labels: Record<string, "city" | "education" | "experience" | "languages" | "skills" | "tools" | "startWhen"> = {
      "город": "city", "шаҳр": "city", "образование": "education", "таҳсилот": "education", "опыт": "experience", "таҷриба": "experience",
      "языки": "languages", "забонҳо": "languages", "навыки": "skills", "малака": "skills", "инструменты": "tools", "программы": "tools",
      "барномаҳо": "tools", "готов начать": "startWhen", "метавонам оғоз кунам": "startWhen",
    };
    facts[labels[labelled[1].toLocaleLowerCase()]] = sourced(labelled[2], labelled[0]);
  }
  // Ambiguous, third-party and future-tense statements remain raw source text.
  for (const clause of clauses) {
    if (/^(?:я\s+)?(?:сейчас\s+)?не\s+(?:учусь|обучаюсь)$/iu.test(clause) || /^ман\s+ҳоло\s+намехонам$/iu.test(clause)) facts.studyingNow = sourced(false, clause);
    else if (/^(?:я\s+)?(?:сейчас\s+)?учусь\s+(?:в|на)\s+/iu.test(clause) && !/курс|тренинг/iu.test(clause)) facts.studyingNow = sourced(true, clause.slice(0, 2000));
    if (/^(?:я\s+)?(?:сейчас\s+)?(?:нигде\s+)?не\s+работаю$/iu.test(clause) || /^ман\s+ҳоло\s+кор\s+намекунам$/iu.test(clause)) facts.employedNow = sourced(false, clause);
    else if (/^(?:я\s+)?(?:сейчас\s+)?работаю\s+(?:в|на|у)\s+/iu.test(clause)) facts.employedNow = sourced(true, clause.slice(0, 2000));
  }
  if (text.length >= 30 && !text.includes("?") && /(?:меня зовут|мне\s+\d{2}\s+лет|я\s+(?:работал|работаю|умею|занимаюсь)|образование\s*:|опыт\s*:|номи ман|таҷриба\s*:)/iu.test(text)) {
    facts.about = sourced(text.slice(0, 2000), text.slice(0, 2000));
  }
  return facts;
}

export function extractRecruitmentAnswerFacts(text: string, answerTo?: RecruitmentFactKey | null): DraftFacts {
  const literal = extractRecruitmentResumeFacts(text);
  const reply = text.trim();
  // Keep the complete message as provenance when a label already supplied the
  // name; the label-derived value remains untouched.
  if (answerTo === "name" && literal.name && reply.length <= 2000) literal.name = { ...literal.name, quote: reply };
  // Only a server-proven immediately preceding accepted question may interpret
  // conversational answer text. Documents never acquire this interpretation.
  if (answerTo && reply && reply.length <= 2000 && (!/[?？]/u.test(reply) || answerTo === "name")) {
    const key = answerTo, quoted = <T extends string | number | boolean>(value: T) => ({ value, quote: reply });
    if (key === "age" && /^\d{2}(?:\s*(?:лет|года|год|сола))?$/iu.test(reply)) {
      const value = Number.parseInt(reply, 10); if (value >= 14 && value <= 100) literal.age = quoted(value);
    } else if (key === "studyingNow" || key === "employedNow") {
      // Bare yes/no refers to the proven question; a subject-bearing reply
      // must match that question's subject and its own polarity exactly.
      const negative = /^(?:нет|неа|не)[.!]?$/iu.test(reply) || statusAnswers[key].negative.test(reply);
      const positive = /^(?:да|ага|ҳа|ха|бале)[.!]?$/iu.test(reply) || statusAnswers[key].positive.test(reply);
      if (negative || positive) literal[key] = quoted(!negative);
    } else if (key === "phone") {
      const value = normalizeCandidatePhone(reply); if (value) literal.phone = quoted(value);
    } else if (key === "name" && !literal.name) {
      const mixed = mixedMessengerNameReply.exec(reply);
      const candidate = mixed?.groups?.name;
      // This stores only a customer-stated name claim under an accepted name
      // question; neither the text nor this parser verifies the person's identity.
      if (candidate && mixed.groups?.question && messengerQuestionCue.test(mixed.groups.question) &&
        !explicitStatusReply.test(candidate) && !nonNameReply.test(candidate) && !nonNameQuestionPrefix.test(candidate) &&
        !hasNonNameContinuation(candidate)) literal.name = quoted(candidate);
      else if (/^[\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*){0,2}$/u.test(reply) &&
        !explicitStatusReply.test(reply) && !nonNameReply.test(reply) && !nonNameQuestionPrefix.test(reply) &&
        !hasNonNameContinuation(reply)) literal.name = quoted(reply);
    } else if (["city", "about", "education", "experience", "languages", "startWhen", "skills", "tools"].includes(key)) {
      literal[key as "city" | "about" | "education" | "experience" | "languages" | "startWhen" | "skills" | "tools"] = quoted(reply);
    }
  }
  return literal;
}

export function collectRecruitmentResume(input: { previous?: unknown; text: string; sourceEventKey: string;
  sourceKind?: "message" | "document" | "assistant_call"; answerTo?: RecruitmentFactKey | null }): RecruitmentResume {
  const parsed = recruitmentResumeSchema.safeParse(input.previous);
  const literal = extractRecruitmentAnswerFacts(input.text, input.sourceKind === "document" ? undefined : input.answerTo);
  const incoming = Object.fromEntries(Object.entries(literal)
    .map(([key, fact]) => [key, { ...fact, sourceEventKey: input.sourceEventKey, ...(input.sourceKind ? { sourceKind: input.sourceKind } : {}) }]));
  // A résumé may be older than an explicit answer. OCR of an attachment must
  // not silently replace a field the candidate already answered in person.
  if (input.sourceKind === "document" && parsed.success) {
    for (const [key, fact] of Object.entries(parsed.data.facts)) {
      if (fact.sourceKind !== "document") delete incoming[key];
    }
  }
  return recruitmentResumeSchema.parse({ version: 1, facts: { ...(parsed.success ? parsed.data.facts : {}), ...incoming } });
}
