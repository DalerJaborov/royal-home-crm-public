/**
 * ОПЕРАТОР ПРИЁМА ЗАЯВОК — РЕШЕНИЕ ШАГА (docs/bot-operator/SPEC.md: «Роли и шаги», «Чего бот не делает никогда», «Тон»,
 * таблица случаев 1–26).
 *
 * ЧИСТАЯ синхронная функция: без базы, сети, времени и случайности. Вариант фразы — счётчик в состоянии
 * (`spoken`), поэтому один и тот же вход всегда даёт один и тот же выход, и второй раз звучит другой вариант.
 *
 * Модель шаг не выбирает: она только понимает ход (understand.ts). Здесь — роли, шаги, пределы и запреты:
 *  - вопрос о роли не больше двух раз (второй раз другими словами), потом тишина;
 *  - вопрос о деталях один раз на роль, только про недостающее; любой ответ принимается;
 *  - номер известен (WhatsApp) — заявка в тот же ход (вопрос о деталях — в том же ответе), без «удобно?»;
 *    нет — детали и номер одним сообщением, потом просьба номера до `maxPhoneAsks`, потом один раз номер офиса;
 *  - комиссия продавцу — сама один раз (и на его прямой вопрос), покупателю — никогда;
 *  - после принятой заявки вопросов нет, новые детали — заметкой агенту;
 *  - роль не теряется между ходами, язык липкий (меняет только осмысленный текст клиента);
 *  - вне Душанбе — заявка с `outOfArea` (её решает директор), клиенту не отказываем;
 *  - грубость и жалоба — одна спокойная фраза, сотрудник, дальше молчим (сотрудника зовём ТОЛЬКО здесь).
 * Ответ — не больше двух шагов (в каждой фразе одно предложение), вопрос — только у вопроса о роли.
 */
import { operatorWhereVar } from "./phrases.js";
import {
  OPERATOR_DETAIL_FIELDS, type OperatorAction, type OperatorContext, type OperatorDecision, type OperatorDetailField, type OperatorDetails,
  type OperatorLanguage, type OperatorRole, type OperatorState, type OperatorStepOut, type PhraseKey, type PhraseVars, type Understanding,
} from "./types.js";

/** Что спрашиваем у покупателя и у продавца (SPEC, таблица ролей). */
export const OPERATOR_BUYER_FIELDS: readonly OperatorDetailField[] = ["rooms", "district", "budget"];
export const OPERATOR_SELLER_FIELDS: readonly OperatorDetailField[] = ["district", "rooms", "area", "floor", "renovation", "price"];
/** Шагов в ответе не больше двух: одна мысль на сообщение, не больше двух предложений (SPEC, правило 10 и «Тон»). */
export const OPERATOR_MAX_STEPS = 2;

export function emptyOperatorDetails(): OperatorDetails {
  return Object.fromEntries(OPERATOR_DETAIL_FIELDS.map(field => [field, null])) as OperatorDetails;
}

export function initialOperatorState(): OperatorState {
  return { version: 2, role: "unknown", step: "start", language: null, asked: { role: 0, details: 0, phone: 0 }, spoken: {},
    propertyId: null, details: emptyOperatorDetails(), callback: { when: null, textOnly: false }, noCall: false, phoneKnown: false,
    outOfArea: false, place: null, flags: { bargainAsked: false, adPriceAsked: false, propertyLineFor: null }, leadAccepted: false,
    staffCalled: false, closed: false, jobAnswered: null };
}

interface Draft { key: PhraseKey; vars: PhraseVars }
const draft = (key: PhraseKey, vars: PhraseVars = {}): Draft => ({ key, vars });

const DETAIL_LABEL: Readonly<Record<OperatorDetailField, string>> = {
  rooms: "комнат", district: "район", budget: "сумма", area: "площадь", floor: "этаж", renovation: "ремонт", price: "цена", units: "объектов",
};

/** Заметка агенту (по-русски, это не текст клиенту): роль, детали, пожелания, слова клиента. */
export function operatorLeadNote(s: OperatorState, u: Understanding, ctx: OperatorContext): string {
  const parts: string[] = [];
  const shortId = ctx.focus && ctx.focus.propertyId === s.propertyId ? ctx.focus.shortId : null;
  if (s.role === "seller") parts.push("Хочет продать");
  else if (s.role === "buyer_property") parts.push(shortId ? `Интересует объект №${shortId}` : "Спрашивал объект с рекламы, объект не определён");
  else if (s.role === "buyer") parts.push("Ищет недвижимость");
  else parts.push("Цель не названа, уточнить: покупка или продажа");
  const details = OPERATOR_DETAIL_FIELDS.flatMap(field => s.details[field] ? [`${DETAIL_LABEL[field]}: ${s.details[field]}`] : []);
  if (details.length) parts.push(details.join("; "));
  if (s.outOfArea) parts.push(`Объект не в Душанбе${s.place ? `: ${s.place}` : ""}`);
  if (s.flags.adPriceAsked) parts.push("Спрашивал цену объекта с рекламы");
  if (s.flags.bargainAsked) parts.push("Спрашивал про торг и скидку");
  if (s.callback.when) parts.push(`Когда звонить: «${s.callback.when}»`);
  if (s.callback.textOnly) parts.push(textOnlyNote(ctx));
  if (u.quote) parts.push(`Слова клиента: «${u.quote}»`);
  return parts.join(". ").slice(0, 600);
}

function leadRole(role: OperatorRole): "buyer" | "seller" | null {
  return role === "seller" ? "seller" : role === "buyer" || role === "buyer_property" ? "buyer" : null;
}

export function decide(prev: OperatorState, u: Understanding, ctx: OperatorContext): OperatorDecision {
  const s: OperatorState = structuredClone(prev);
  const actions: OperatorAction[] = [];
  const answers: Draft[] = [];
  const flow: Draft[] = [];
  const said = (key: PhraseKey) => (s.spoken[key] ?? 0) > 0;
  const commissionSaid = () => said("seller_intro") || said("seller_commission") || answers.some(a => a.key === "seller_commission");
  const callStaff = (reason: Extract<OperatorAction, { type: "call_staff" }>["reason"], manager = false) => {
    if (s.staffCalled && reason !== "complaint") return;
    s.staffCalled = true;
    actions.push({ type: "call_staff", reason, manager });
  };

  // ── язык: липкий, меняет только осмысленный текст ─────────────────────────
  if (u.language) s.language = u.language;
  else if (!s.language && u.languageHint) s.language = u.languageHint;
  // Чужой пост при неизвестном языке — таджикский (SPEC, случай 20); язык разговора от этого не меняется.
  const language: OperatorLanguage = s.language ?? (u.attachments.foreignPost ? "tg" : "ru");
  const finish = () => compose(s, language, answers, flow, actions);

  // ── факты хода в память ────────────────────────────────────────────────────
  if (ctx.leadExists && !s.leadAccepted) { s.leadAccepted = true; s.step = "done"; }
  const newCallback = !!u.callback.when && u.callback.when !== s.callback.when;
  const newTextOnly = u.callback.textOnly && !s.callback.textOnly;
  if (u.callback.when) s.callback.when = u.callback.when;
  if (u.callback.textOnly) s.callback.textOnly = true;
  if (u.phone) s.phoneKnown = true;
  const newOutOfArea = !!u.outsidePlace && !s.outOfArea;
  if (u.outsidePlace) { s.outOfArea = true; s.place = u.outsidePlace; }
  if (ctx.outOfArea) s.outOfArea = true;
  if (u.bargain) s.flags.bargainAsked = true;

  if (s.closed) return finish();
  // Грубость и жалоба — одна спокойная фраза и человек, дальше бот молчит (SPEC «Тон», случаи 22 и 26). Заявку не заводим.
  if (u.rude) {
    answers.push(draft("rude_calm")); callStaff("rude"); s.closed = true; s.step = "handoff";
    return finish();
  }
  if (u.complaint) {
    answers.push(draft("complaint_ack")); callStaff("complaint", true); s.closed = true; s.step = "handoff";
    return finish();
  }

  // ── вложение без своих слов: шаг не двигает ───────────────────────────────
  if (!u.hasText && !u.attachments.ownPost) {
    if (u.attachments.voice === "failed") { if (!said("voice_failed")) answers.push(draft("voice_failed")); }
    else if (u.attachments.foreignPost) { if (!said("foreign_post")) answers.push(draft("foreign_post")); }
    else if (u.attachments.media && (s.role === "seller" || s.role === "unknown") && !said("photo_ack")) answers.push(draft("photo_ack"));
    return finish();
  }
  if (u.attachments.foreignPost && !said("foreign_post")) answers.push(draft("foreign_post"));

  // ── ответы на прямые вопросы клиента (вопросов от бота здесь нет) ─────────
  const answerQuestions = (propertyLineComing: boolean) => {
    if (u.question === "fee") {
      if (s.role === "seller") answers.push(draft("seller_commission", { percent: ctx.sellerCommissionPercent }));
      // Кнопка рекламы объекта «Сколько стоят ваши услуги?» — вопрос об объекте: ответ строка объекта (SPEC, случай 10).
      else if (!(s.role === "buyer_property" && propertyLineComing)) answers.push(draft("buyer_free"));
    }
    if (u.question === "area") answers.push(draft("where_work"));
    if (u.question === "identity") answers.push(draft("identity", { brand: ctx.brandName }));
    if (u.botQuestion) answers.push(draft("bot_identity"));
    if (u.bargain) answers.push(draft("bargain"));
  };

  // ── заявка уже принята: вопросов нет ──────────────────────────────────────
  if (s.leadAccepted) {
    answerQuestions(false);
    // Продавцу комиссию называем сами один раз: если в ход заявки место занял ответ на его вопрос — теперь.
    if (s.role === "seller" && !commissionSaid() && answers.length === 0) answers.push(draft("seller_commission", { percent: ctx.sellerCommissionPercent }));
    if (newOutOfArea) {
      // Заявка уже ушла, а объект оказался не в Душанбе: пометка с признаком (этап 1.5 — решение директора), клиенту без отказа.
      actions.push({ type: "append_note", note: operatorLeadNote(s, u, ctx), phone: null, outOfArea: true });
      flow.push(draft("out_of_area_accepted"));
    } else if (newTextOnly) {
      actions.push({ type: "append_note", note: textOnlyNote(ctx), phone: null });
      flow.push(draft("text_only_noted", { where: operatorWhereVar(ctx.channel) }));
    } else if (newCallback) {
      actions.push({ type: "append_note", note: `Когда звонить: «${s.callback.when}»`, phone: null });
      flow.push(draft("callback_noted", { time: s.callback.when! }));
    } else if (u.callback.noCall) {
      actions.push({ type: "append_note", note: "Просит не звонить", phone: null });
      if (!said("no_call_ack")) flow.push(draft("no_call_ack"));
    } else if (u.phone) {
      actions.push({ type: "append_note", note: "Клиент написал номер для звонка", phone: u.phone });
      if (!said("note_added")) flow.push(draft("note_added"));
    } else if (u.hasDetails || u.outsidePlace || u.bargain) {
      actions.push({ type: "append_note", note: operatorLeadNote(s, u, ctx), phone: null });
      if (!said("note_added") && !u.bargain) flow.push(draft("note_added"));
    } else if (u.offTopic) {
      if (!said("off_topic")) flow.push(draft("off_topic"));
    } else if (u.thanksOnly && !said("welcome")) flow.push(draft("welcome"));
    return finish();
  }

  // ── не по теме: одна фраза, второй раз молчим (случай 24) ─────────────────
  if (u.offTopic && !u.role) {
    if (!said("off_topic")) answers.push(draft("off_topic"));
    return finish();
  }
  // ── аренда: отказ сразу (случай 17) ────────────────────────────────────────
  if (u.role === "rent" || (s.role === "rent" && u.role === null && !u.aboutThisProperty && !u.attachments.ownPost)) {
    s.role = "rent";
    if (!said("rent_refusal")) answers.push(draft("rent_refusal"));
    else if (u.thanksOnly && !said("welcome")) answers.push(draft("welcome"));
    return finish();
  }
  // ── вакансия: ровно по спрошенной должности (случаи 12, 13) ────────────────
  if (u.role === "job" || (u.role === null && !u.aboutThisProperty && (s.role === "job" || (s.role === "unknown" && ctx.ad.topic === "job")))) {
    s.role = "job";
    jobAnswer(s, u, ctx, language, answers, said);
    return finish();
  }

  // ── роль: явная новая роль меняет прежнюю, иначе прежняя остаётся ─────────
  const propertyRef = u.attachments.ownPost || (u.aboutThisProperty && !u.adOpener);
  let candidate: OperatorRole | null = null;
  if (u.role === "seller") candidate = "seller";
  else if (u.role === "buyer") candidate = propertyRef ? "buyer_property" : "buyer";
  else if (propertyRef) candidate = "buyer_property";
  else if (s.role === "unknown" && ctx.ad.topic === "property") candidate = "buyer_property";
  else if (s.role === "unknown" && ctx.ad.topic === "seller") candidate = "seller";
  // «Хочу купить» у покупателя объекта — тот же покупатель объекта, а не общий поиск.
  if (candidate === "buyer" && s.role === "buyer_property") candidate = null;
  if (candidate && candidate !== s.role) switchRole(s, candidate);
  for (const field of OPERATOR_DETAIL_FIELDS) { const value = u.details[field]; if (value) s.details[field] = value; }
  if (s.role === "buyer_property") {
    if (propertyRef && ctx.focus) s.propertyId = ctx.focus.propertyId;
    s.propertyId ??= ctx.focus?.propertyId ?? ctx.ad.propertyId ?? null;
  }
  const facts = s.role === "buyer_property" && ctx.focus && ctx.focus.propertyId === s.propertyId ? ctx.focus : null;
  const propertyLineComing = !!facts && (s.flags.propertyLineFor !== facts.propertyId || u.question === "property_price");
  answerQuestions(propertyLineComing);

  // ── «не звоните, я просто смотрю» (случай 25): номер больше не просим ─────
  if (u.callback.noCall && !u.phone) {
    s.noCall = true;
    if (!said("no_call_ack")) flow.push(draft("no_call_ack"));
    return finish();
  }

  const leadMessage = (): Draft => {
    const when = ctx.callbackWhen[language];
    if (s.outOfArea) return draft("out_of_area_accepted");
    if (s.callback.textOnly) return draft("lead_text_only", { where: operatorWhereVar(ctx.channel) });
    if (s.callback.when) return draft("lead_callback", { time: s.callback.when });
    if (u.phone && !ctx.phoneKnown) return draft("phone_received", { when });
    return draft("lead_known_phone", { when });
  };
  const phoneKnown = () => ctx.phoneKnown || s.phoneKnown;
  const acceptLead = () => {
    actions.push({ type: "accept_lead", role: leadRole(s.role), propertyId: s.role === "buyer_property" ? s.propertyId : null,
      phone: u.phone, note: operatorLeadNote(s, u, ctx), outOfArea: s.outOfArea, callbackWhen: s.callback.when,
      textOnly: s.callback.textOnly });
    s.leadAccepted = true; s.step = "done";
  };
  const contact = () => {
    if (phoneKnown()) {
      // Продавцу комиссию называем сами один раз — если раньше не успели (вопрос клиента занял место).
      if (s.role === "seller" && !commissionSaid() && answers.length === 0 && flow.length === 0) {
        flow.push(draft("seller_commission", { percent: ctx.sellerCommissionPercent }));
      }
      acceptLead();
      flow.push(leadMessage());
      return;
    }
    if (s.noCall) return;
    if (s.asked.phone < ctx.maxPhoneAsks) {
      flow.push(draft("ask_phone")); s.asked.phone += 1; s.step = "contact";
      return;
    }
    // Номер не дали после всех просьб: один раз номер офиса, дальше тишина. Людей до заявки не зовём (решение владельца
    // 13.11.2026: «никаких уведомлений не надо никому высылать, пока он не станет лидом»).
    if (!said("office_phone")) flow.push(draft("office_phone", { phone: ctx.officePhone }));
    s.step = "handoff";
  };
  // Клиент сам дал номер, просит человека, спрашивает «вы бот?» или торгуется — сразу шаг «контакт».
  const wantsContact = !!u.phone || u.question === "staff" || u.botQuestion || u.bargain;

  if (s.role === "unknown" || s.role === "rent" || s.role === "job") {
    if (wantsContact) { contact(); return finish(); }
    if (s.asked.role >= 2) {
      // Два непонятных ответа на вопрос о роли: молчим (до заявки людей не зовём; через сутки тишины — заново, state.ts).
      s.step = "handoff";
      return finish();
    }
    if (u.greeting && !said("greet") && !said("greet_assalom") && answers.length === 0) {
      flow.push(draft(u.greeting === "assalom" ? "greet_assalom" : "greet"));
    }
    flow.push(draft("ask_role")); s.asked.role += 1; s.step = "role";
    return finish();
  }

  if (s.role === "buyer_property") {
    if (facts && propertyLineComing) {
      const id = facts.shortId;
      flow.push(facts.sold ? draft("property_sold", { id }) : facts.priceText ? draft("property_price", { id, price: facts.priceText[language] })
        : draft("property_no_price", { id }));
      s.flags.propertyLineFor = facts.propertyId;
    } else if (!facts && (u.question === "property_price" || u.aboutThisProperty || u.question === "fee")) {
      s.flags.adPriceAsked = true;
    }
    contact();
    const decision = finish();
    // Строку объекта вытеснил ответ на вопрос клиента (не больше двух шагов): объект ещё не назван.
    if (!decision.steps.some(step => step.key.startsWith("property_"))) decision.state.flags.propertyLineFor = prev.flags.propertyLineFor;
    return decision;
  }

  // Покупатель (общий запрос) и продавец: один вопрос о деталях, потом контакт.
  if (wantsContact) { contact(); return finish(); }
  const fields = s.role === "seller" ? OPERATOR_SELLER_FIELDS : OPERATOR_BUYER_FIELDS;
  if (s.asked.details === 0) {
    const missing = fields.filter(field => !s.details[field]);
    if (missing.length === 0) { contact(); return finish(); }
    const seller = s.role === "seller";
    const all = missing.length === fields.length;
    // Номер известен (WhatsApp): заявка в ЭТОТ ход, вопрос о деталях — в том же ответе. Клиент, не ответивший на вопрос,
    // не пропадает (П1 приёмки 19.11). Время звонка, «пишите», вне Душанбе — обычная строка заявки без вопроса.
    if (phoneKnown() && (s.outOfArea || s.callback.textOnly || s.callback.when)) { contact(); return finish(); }
    s.asked.details = 1;
    if (seller && !commissionSaid() && answers.length === 0) flow.push(draft("seller_intro", { percent: ctx.sellerCommissionPercent }));
    if (phoneKnown()) {
      const when = ctx.callbackWhen[language];
      acceptLead();
      flow.push(all ? draft(seller ? "lead_and_details_seller" : "lead_and_details_buyer", { when }) : draft("lead_and_details_missing", { when, missing }));
      return finish();
    }
    // Номера нет: детали и номер одним сообщением — это первая просьба номера.
    if (!s.noCall && s.asked.phone < ctx.maxPhoneAsks) {
      flow.push(all ? draft(seller ? "ask_details_seller_phone" : "ask_details_buyer_phone") : draft("ask_details_missing_phone", { missing }));
      s.asked.phone += 1; s.step = "contact";
      return finish();
    }
    flow.push(all ? draft(seller ? "ask_details_seller" : "ask_details_buyer") : draft("ask_details_missing", { missing }));
    s.step = "details";
    return finish();
  }
  // Вопрос о деталях уже был: любой ответ принимается. Встречный вопрос клиента без деталей шаг не двигает и
  // вопрос о деталях не повторяет (SPEC, правило 5).
  const pureQuestion = answers.length > 0 && !u.hasDetails && !u.outsidePlace && !u.callback.when && !u.callback.textOnly;
  if (s.step === "details" && pureQuestion) return finish();
  contact();
  return finish();
}

function textOnlyNote(ctx: OperatorContext): string {
  return ctx.channel === "WHATSAPP" ? "Просит писать в WhatsApp, не звонить" : "Просит писать в переписке, не звонить";
}

function switchRole(s: OperatorState, role: OperatorRole): void {
  const buyerFamily = (r: OperatorRole) => r === "buyer" || r === "buyer_property";
  // Детали покупателя и продавца — разные (бюджет против цены): при смене стороны вопрос о деталях свой.
  if (!(buyerFamily(s.role) && buyerFamily(role))) { s.details = emptyOperatorDetails(); s.asked.details = 0; }
  // Объект — только у покупателя объекта: продавец говорит о своём, чужой объект его заявку не уводит.
  if (role !== "buyer_property") { s.propertyId = null; s.flags.propertyLineFor = null; }
  s.role = role;
}

function jobAnswer(s: OperatorState, u: Understanding, ctx: OperatorContext, language: OperatorLanguage, answers: Draft[],
  said: (key: PhraseKey) => boolean): void {
  const open = ctx.vacancies.open.filter(position => position.isOpen);
  const title = (position: (typeof open)[number]) => language === "tg" ? position.titleTg : position.titleRu;
  const matched = u.job.openKey ? open.find(position => position.key === u.job.openKey) ?? null : null;
  const asked = u.job.asked?.trim() || null;
  const key = matched ? `open:${matched.key}` : asked ? `asked:${asked.toLocaleLowerCase()}` : "list";
  if (s.jobAnswered === key) {
    if (u.thanksOnly && !said("welcome")) answers.push(draft("welcome"));
    return;
  }
  s.jobAnswered = key;
  const list = open.map(title);
  if (matched) answers.push(draft("job_open", { position: title(matched) }));
  else if (asked && list.length) answers.push(draft("job_closed", { position: asked, list }));
  else if (list.length) answers.push(draft("jobs_list", { list }));
  else answers.push(draft("jobs_none"));
  if (ctx.vacancies.contactPhone && (matched || list.length)) answers.push(draft("job_contact", { phone: ctx.vacancies.contactPhone }));
}

/** Не больше двух шагов: ответ на вопрос клиента первым, последний шаг потока (просьба, заявка) остаётся всегда. */
function compose(s: OperatorState, language: OperatorLanguage, answers: readonly Draft[], flow: readonly Draft[],
  actions: OperatorAction[]): OperatorDecision {
  let chosen = [...answers, ...flow];
  if (chosen.length > OPERATOR_MAX_STEPS) chosen = flow.length ? [answers[0] ?? flow[0]!, flow.at(-1)!] : chosen.slice(0, OPERATOR_MAX_STEPS);
  const seen = new Set<PhraseKey>();
  const steps: OperatorStepOut[] = [];
  for (const item of chosen) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    const variant = s.spoken[item.key] ?? 0;
    s.spoken[item.key] = variant + 1;
    steps.push({ key: item.key, vars: item.vars, variant });
  }
  return { state: s, language, steps, actions, silent: steps.length === 0 };
}
