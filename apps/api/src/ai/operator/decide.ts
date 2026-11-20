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
 *  - роль понятна и номер есть (WhatsApp или в словах клиента) — заявка в этот же ход; номера нет — просьба номера до
 *    `maxPhoneAsks`, потом один раз номер офиса. Детали до заявки НЕ собираем (владелец 20.11.2026: «агент для чего тогда
 *    существует?»): один мягкий необязательный вопрос о деталях — в ответе с заявкой, ответ уходит агенту заметкой;
 *  - номер в словах клиента — заявка ВСЕГДА (любая роль, кроме вакансии и аренды), даже после грубости или жалобы;
 *  - комиссия продавцу — сама один раз, только если продавцом он назвался сам (не по теме рекламы), и на его прямой вопрос;
 *    покупателю — никогда;
 *  - после принятой заявки бот не молчит (владелец 20.11.2026): отвечает коротко по делу, вопрос и новую деталь передаёт
 *    агенту заметкой и говорит об этом; без подбора объектов, без вопросов о бюджете и районе, без повтора одной фразы.
 *    Молчит после заявки только на «ок» и смайлик, на повторное «спасибо», пока клиент дописывает подряд, и пока сотрудник
 *    сам ведёт переписку (`ctx.staffActive`);
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
/** Продавцу — три главных пункта, а не анкета: площадь, этаж, ремонт агент узнает сам (владелец 20.11.2026). */
export const OPERATOR_SELLER_FIELDS: readonly OperatorDetailField[] = ["district", "rooms", "price"];
/** Справочные ответы, которые в разговоре звучат один раз (повтор — не та же фраза, а сигнал человеку). */
const ONCE_PER_CONVERSATION: ReadonlySet<PhraseKey> = new Set(["where_work", "work_hours", "identity", "bot_identity", "buyer_free"]);
/** Отметки «передал агенту» после заявки: клиент дописывает подряд — отмечаем один раз на серию. */
const ACK_KEYS: ReadonlySet<PhraseKey> = new Set(["note_added", "question_noted", "lead_status", "no_agent_noted"]);
/** Вопросы, на которые у бота до заявки фактов нет: ответ «скажет агент», а не голая просьба номера (владелец 21.11.2026). */
const QUESTION_FOR_AGENT: ReadonlySet<Understanding["question"]> = new Set(["other", "property_other", "property_price"]);
/** Шагов в ответе не больше двух: одна мысль на сообщение, не больше двух предложений (SPEC, правило 10 и «Тон»). */
export const OPERATOR_MAX_STEPS = 2;

export function emptyOperatorDetails(): OperatorDetails {
  return Object.fromEntries(OPERATOR_DETAIL_FIELDS.map(field => [field, null])) as OperatorDetails;
}

export function initialOperatorState(): OperatorState {
  return { version: 2, role: "unknown", step: "start", language: null, asked: { role: 0, details: 0, phone: 0 }, spoken: {},
    propertyId: null, details: emptyOperatorDetails(), callback: { when: null, textOnly: false }, noCall: false,
    outOfArea: false, place: null, flags: { bargainAsked: false, adPriceAsked: false, propertyLineFor: null, lastAck: false, sellerByWords: false, bothRoles: false,
      roleChangedFrom: null, clientTurns: 0, phoneAskTurn: 0, signaled: [], closedBy: null }, leadAccepted: false,
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
  if (s.role === "seller" && s.flags.bothRoles) parts.push("Хочет и продать своё, и купить другое (две роли): продажа — эта заявка, покупку уточнить");
  else if (s.role === "seller") parts.push("Хочет продать");
  else if (s.role === "buyer_property") parts.push(shortId ? `Интересует объект №${shortId}` : "Спрашивал объект с рекламы, объект не определён");
  else if (s.role === "buyer") parts.push("Ищет недвижимость");
  else parts.push("Цель не названа, уточнить: покупка или продажа");
  const details = OPERATOR_DETAIL_FIELDS.flatMap(field => s.details[field] ? [`${DETAIL_LABEL[field]}: ${s.details[field]}`] : []);
  if (details.length) parts.push(details.join("; "));
  if (s.outOfArea) parts.push(`Объект не в Душанбе${s.place ? `: ${s.place}` : ""}`);
  if (s.flags.roleChangedFrom) parts.push(`Роль изменилась: сначала ${s.flags.roleChangedFrom === "seller" ? "продавал" : "покупал"}, теперь ${leadRole(s.role) === "seller" ? "продаёт" : "покупает"}`);
  if (s.flags.adPriceAsked) parts.push("Спрашивал цену объекта с рекламы");
  if (s.flags.bargainAsked) parts.push("Спрашивал про торг и скидку");
  if (s.callback.when) parts.push(`Когда звонить: «${s.callback.when}»`);
  if (s.callback.textOnly) parts.push(textOnlyNote(ctx));
  else if (s.noCall) parts.push("Просит не звонить");
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
  if (u.bothRoles) s.flags.bothRoles = true;
  // Содержательный ход клиента (не «ок», не приветствие, не кнопка): по ним — пауза между просьбами номера (21.11.2026).
  if (u.hasText && !u.ackOnly && !u.thanksOnly && !u.greetingOnly && !u.adOpener) s.flags.clientTurns = (s.flags.clientTurns ?? 0) + 1;
  // Продавцом клиент назвался сам (не только тема рекламы «для собственников»): комиссию сами называем только ему.
  if (u.role === "seller") s.flags.sellerByWords = true;
  else if (u.role === "buyer") s.flags.sellerByWords = false;
  const commissionSaid = () => said("seller_intro") || said("seller_commission") || answers.some(a => a.key === "seller_commission");
  const callStaff = (reason: Extract<OperatorAction, { type: "call_staff" }>["reason"]) => {
    if (s.staffCalled && reason !== "complaint") return;
    s.staffCalled = true;
    actions.push({ type: "call_staff", reason });
  };
  /**
   * Бот молчит по делу («не понял», вложения, номер не дали): сигнал на КАЖДОЕ такое молчание — дверь «клиент ждёт» держит
   * один сигнал на эпизод ожидания (ключ — начало неотвеченной серии). Так новый эпизод (после ответа человека) снова даёт
   * сигнал, а серия сообщений подряд — один (ревью #333, третий круг). «Ок» и «спасибо» сигнала не дают.
   */
  const signal = (reason: "unclear" | "attachments" | "no_phone") => {
    if (u.ackOnly || u.thanksOnly) return;
    actions.push({ type: "call_staff", reason });
  };
  /** Раз в сутки на переписку (после срока эстафеты бот отвечает сам, но сотруднику знать полезно — не на каждый ход). */
  const signalDaily = (reason: "staff_thread") => {
    if (s.flags.signaled.includes(reason)) return;
    s.flags.signaled = [...s.flags.signaled, reason];
    actions.push({ type: "call_staff", reason });
  };
  let handoff: OperatorDecision["handoff"];

  // ── язык: липкий, меняет только осмысленный текст ─────────────────────────
  if (u.language) s.language = u.language;
  // В сообщении языка нет (номер, «ок»): язык разговора — по последней реплике с ясным языком (клиента или сотрудника), а не
  // «русский по умолчанию» и не устаревшая память (20.11.2026: таджикский разговор, номер, ответ ушёл по-русски).
  else if (u.contextLanguage) s.language = u.contextLanguage;
  else if (!s.language && u.languageHint) s.language = u.languageHint;
  // Чужой пост при неизвестном языке — таджикский (SPEC, случай 20); язык разговора от этого не меняется.
  const language: OperatorLanguage = s.language ?? (u.attachments.foreignPost ? "tg" : "ru");
  let yielded = false;
  const finish = () => {
    // Справочный ответ (где работаем, часы, «вы бот?», «для покупателя бесплатно», «кто вы») звучит в разговоре ОДИН раз:
    // повторять его — пластинка (живые диалоги 12–14.11: «работаем только в Душанбе» по три раза). Повтор вопроса — без
    // той же фразы; если сказать больше нечего — сигнал человеку (ревью #333, часовая сверка 20.11).
    const repeated = answers.filter(item => ONCE_PER_CONVERSATION.has(item.key) && said(item.key));
    if (repeated.length) {
      for (const item of repeated) answers.splice(answers.indexOf(item), 1);
      if (!answers.length && !flow.length && !u.ackOnly && !u.thanksOnly &&
        !actions.some(action => action.type === "call_staff" || action.type === "follow_up")) actions.push({ type: "call_staff", reason: "repeat_question" });
    }
    const decision = compose(s, language, answers, flow, actions);
    // ИНВАРИАНТ (ревью #333): после заявки карточка без живого агента, бот молчит не на «ок» и человека в этом ходе не
    // звали — руководство узнаёт дверью «клиент ждёт». С живым агентом сигнал — его штатный пуш о каждом сообщении.
    if (decision.silent && !handoff && s.leadAccepted && !ctx.cardAgentActive && !u.ackOnly && !u.thanksOnly &&
      !decision.actions.some(action => action.type === "call_staff" || action.type === "follow_up")) decision.actions.push({ type: "follow_up" });
    // Заявка ещё в очереди приёма (карточки нет): слова клиента — пометкой, она дождётся карточки и уйдёт агенту.
    if (decision.silent && !handoff && s.leadAccepted && !ctx.leadExists && ctx.leadPending && !u.ackOnly && !u.thanksOnly &&
      !decision.actions.some(action => action.type === "append_note")) {
      decision.actions.push({ type: "append_note", note: u.quote ? `Клиент пишет: «${u.quote}»` : "Клиент прислал вложение без слов", phone: null });
    }
    return { ...decision, ...(handoff ? { handoff } : {}), ...(yielded ? { yielded: true as const } : {}) };
  };

  // ── факты хода в память ────────────────────────────────────────────────────
  if (ctx.leadExists && !s.leadAccepted) { s.leadAccepted = true; s.step = "done"; }
  // Карточку удалили (или заявка так и не завелась), а память говорит «заявка принята»: клиент — снова новый. Роль, язык
  // и детали остаются, шаг и счётчики вопросов — с начала (ревью 19.11, Р1). Пока задание приёма в очереди — не трогаем.
  if (!ctx.leadExists && !ctx.leadPending && s.leadAccepted) {
    s.leadAccepted = false; s.step = "start"; s.asked = { role: 0, details: 0, phone: 0 };
    delete s.spoken.note_added; delete s.spoken.no_agent_noted;
  }
  const newCallback = !!u.callback.when && u.callback.when !== s.callback.when;
  const newTextOnly = u.callback.textOnly && !s.callback.textOnly;
  if (u.callback.when) s.callback.when = u.callback.when;
  if (u.callback.textOnly) s.callback.textOnly = true;
  // Клиент сам дал номер — это согласие на звонок: прежнее «не звоните» снимается.
  if (u.phone) s.noCall = false;
  const newOutOfArea = !!u.outsidePlace && !s.outOfArea;
  if (u.outsidePlace) { s.outOfArea = true; s.place = u.outsidePlace; }
  if (ctx.outOfArea) s.outOfArea = true;
  if (u.bargain) s.flags.bargainAsked = true;

  if (s.closed) {
    // Разговор ведёт человек (грубость, жалоба): бот молчит, но номер клиента — всегда заявка, а новая деталь — заметка;
    // человек узнаёт и о новом сообщении (один сигнал на эпизод, держит дверь).
    if (u.phone && !s.leadAccepted) acceptLeadSilently(s, u, ctx, actions);
    else if (s.leadAccepted && (u.phone || u.hasDetails)) actions.push({ type: "append_note", note: operatorLeadNote(s, u, ctx), phone: u.phone });
    // Повтор — не новая жалоба: агенту (копия руководству была один раз, при самой жалобе) (ревью #333, четвёртый круг).
    if (!u.ackOnly && !u.thanksOnly) actions.push({ type: "call_staff", reason: "closed_followup" });
    return finish();
  }
  // Грубость и жалоба — одна спокойная фраза и человек, дальше бот молчит (SPEC «Тон», случаи 22 и 26). Заявку не заводим.
  if (u.rude) {
    answers.push(draft("rude_calm")); callStaff("rude"); s.closed = true; s.flags.closedBy = "rude"; s.step = "handoff";
    return finish();
  }
  if (u.complaint) {
    answers.push(draft("complaint_ack")); callStaff("complaint"); s.closed = true; s.flags.closedBy = "complaint"; s.step = "handoff";
    return finish();
  }

  // ── переписку ведёт сотрудник, заявки ещё нет (эстафета 20.11.2026, запасной вариант): бот не спрашивает ни роль, ни номер,
  // клиенту не отвечает, сотрудник получает сигнал; номер клиента — всё равно заявка.
  // Сотрудник писал здесь НЕДАВНО (в пределах срока из Настроек): бот молчит и зовёт его (ревью #333, второй круг: не
  // навсегда — после срока ход обычный, без повторного приветствия, и сигнал). Номер в словах, или WhatsApp с ясной ролью —
  // заявка всё равно; вакансия — путь рекрутёра.
  if (!s.leadAccepted && ctx.staffThread && ctx.staffActive) {
    const wordsRole = u.role === "seller" || u.role === "buyer" ? u.role : s.role === "seller" || s.role === "buyer" || s.role === "buyer_property" ? s.role : null;
    if (u.role === "job" && ctx.recruiterPath) { s.role = "job"; handoff = "recruiter"; return finish(); }
    const notCandidate = s.role !== "job" && s.role !== "rent" && u.role !== "job" && u.role !== "rent";
    if (u.role === "seller") s.role = "seller"; else if (u.role === "buyer" && s.role === "unknown") s.role = "buyer";
    if (notCandidate && (u.phone || (ctx.phoneKnown && wordsRole))) acceptLeadSilently(s, u, ctx, actions);
    // Отдельного «клиент ждёт» нет: сотрудник сейчас сам переписывается (ему — штатный пуш о сообщении), а если он молчит
    // дольше нормы — сторож молчания (тишина помечена `yielded`, не намеренной) (ревью #333, третий круг).
    yielded = true;
    return finish();
  }
  // Сотрудник писал раньше срока: бот снова ведёт разговор, а сотруднику — «клиент пишет в вашу переписку» раз в сутки.
  if (!s.leadAccepted && ctx.staffThread) signalDaily("staff_thread");

  // ── вложение без своих слов: один короткий ответ, повтор — тишина и один сигнал человеку (20.11.2026) ─────────
  if (!u.hasText && !u.attachments.ownPost) {
    const before = answers.length;
    if (u.attachments.voice === "failed") { if (!said("voice_failed")) answers.push(draft("voice_failed")); }
    // Чужой пост без слов (владелец 21.11.2026: «спамерам не отвечать»): тишина сразу, без ответа и без сигнала. Свой пост
    // (наш аккаунт, наш объект) сюда не попадает — это `ownPost`, вопрос об объекте.
    else if (u.attachments.foreignPost) return finish();
    else if (u.attachments.media && s.role === "seller" && !said("photo_ack")) answers.push(draft("photo_ack"));
    else if (!s.leadAccepted && s.role === "unknown" && !said("media_received") && !said("photo_ack")) {
      answers.push(draft("media_received"));
      if (s.asked.role < 2) { flow.push(draft("ask_role")); s.asked.role += 1; s.step = "role"; }
    }
    if (answers.length === before && !s.leadAccepted) signal("attachments");
    return finish();
  }
  if (u.attachments.foreignPost && !said("foreign_post")) answers.push(draft("foreign_post"));

  // ── ответы на прямые вопросы клиента (вопросов от бота здесь нет) ─────────
  const answerQuestions = (propertyLineComing: boolean) => {
    // «Какие у вас условия?» от продавца — тот же вопрос о комиссии (живой прогон 19.11, перенесено из неотправленной правки).
    if (u.question === "fee" || (u.question === "services" && s.role === "seller")) {
      if (s.role === "seller") answers.push(draft("seller_commission", { percent: ctx.sellerCommissionPercent }));
      // Кнопка рекламы объекта «Сколько стоят ваши услуги?» — вопрос об объекте: ответ строка объекта (SPEC, случай 10).
      else if (!(s.role === "buyer_property" && propertyLineComing)) answers.push(draft("buyer_free"));
    }
    if (u.question === "area") answers.push(draft("where_work"));
    // «Вы бот?» модель часто метит и как «кто вы»: «Нет, это агентство…» прозвучало бы отрицанием бота (живой прогон 19.11).
    if (u.question === "identity" && !u.botQuestion) answers.push(draft("identity", { brand: ctx.brandName }));
    if (u.question === "hours" && ctx.workHours) answers.push(draft("work_hours", { from: ctx.workHours.from, to: ctx.workHours.to }));
    if (u.botQuestion) answers.push(draft("bot_identity"));
    // Продавец сам собственник: «агент обсуждает с собственником» ему не подходит (ревью 19.11, Р8).
    if (u.bargain) answers.push(draft(s.role === "seller" ? "bargain_seller" : "bargain"));
  };

  // ── заявка уже принята: вопросов о бюджете и районе нет, подборок нет, но клиент не остаётся в тишине ─────────────
  // (владелец 20.11.2026: «если после передачи агенту клиент опять что-то написал, бот не должен же молчать»; август
  // 2026: «вторым голосом» продавать нельзя — поэтому только короткий ответ по делу и заметка агенту).
  if (s.leadAccepted) {
    // Вопрос о работе и после заявки ведёт путь рекрутёра, а не тишина (живой прогон 19.11, перенесено).
    if (u.role === "job" && ctx.recruiterPath) { answers.length = 0; flow.length = 0; handoff = "recruiter"; return finish(); }
    const extra = ctx.afterLeadReplies !== false;
    answerQuestions(false);
    // Продавцу комиссию называем сами один раз — только если продавцом он назвался сам (не по рекламе «для собственников»).
    if (s.role === "seller" && s.flags.sellerByWords && !commissionSaid() && answers.length === 0) {
      answers.push(draft("seller_commission", { percent: ctx.sellerCommissionPercent }));
    }
    // Карточка без живого агента: «передал агенту» — неправда; честно «записали», руководство узнаёт (Р4).
    const noAgent = !ctx.cardAgentActive;
    // Клиент дописывает подряд: «передал агенту» звучит один раз на серию, дальше — молча в заметку.
    const burst = !!ctx.recentTurn && s.flags.lastAck;
    const noted = (key: PhraseKey, vars: PhraseVars = {}, oncePerDay = true): void => {
      if (burst && (ACK_KEYS.has(key) || noAgent)) return;
      if (noAgent) { if (extra || !said("no_agent_noted")) flow.push(draft("no_agent_noted", { when: ctx.noAgentWhen[language] })); return; }
      // Новое поведение: каждая новая деталь отмечается (варианты по кругу), прежнее — один раз в сутки.
      if (extra || !oncePerDay || !said(key)) flow.push(draft(key, vars));
    };
    const note = (text: string, more: { phone?: string | null; outOfArea?: true } = {}) =>
      actions.push({ type: "append_note", note: text, phone: more.phone ?? null, ...(more.outOfArea ? { outOfArea: true as const } : {}) });
    // Роль, названная ЭТИМ ходом («хочу продать»), идёт в заметку как новая цель, память роли разговора не трогает.
    const goalRole = u.role === "seller" ? "seller" as const : u.role === "buyer" ? "buyer" as const : null;
    const newGoal = !!goalRole && leadRole(s.role) !== goalRole;
    const noteState = goalRole ? { ...s, role: goalRole } : s;
    const askedProperty = !!ctx.focus && (u.attachments.ownPost || (u.aboutThisProperty && !u.adOpener) || u.question === "property_price" ||
      (u.adOpener && ctx.ad.topic === "property"));
    // Что-то по делу, что не легло ни в одну полку ниже: «адрес офиса?», «а документы нужны?», «звоните завтра днём».
    // Одно слово без вопроса («Ершп», «Мр») — не дело для агента: ни «передал», ни заметки (прод 20.11, 8598aef1).
    const substantive = u.hasText && !u.ackOnly && !u.thanksOnly && !u.greetingOnly && !u.adOpener && u.quote.trim().length >= 4 &&
      (u.question !== "none" || u.quote.trim().split(/\s+/u).length >= 2);
    if (askedProperty && ctx.focus) {
      const f = ctx.focus;
      flow.push(f.sold ? draft("property_sold", { id: f.shortId }) : f.priceText ? draft("property_price", { id: f.shortId, price: f.priceText[language] })
        : draft("property_no_price", { id: f.shortId }));
      note(`Спрашивает объект №${f.shortId}${u.quote ? `: «${u.quote}»` : ""}`);
    } else if (newOutOfArea) {
      // Заявка уже ушла, а объект оказался не в Душанбе: пометка с признаком (этап 1.5 — решение директора), клиенту без отказа.
      note(operatorLeadNote(s, u, ctx), { outOfArea: true });
      if (noAgent) noted("out_of_area_accepted"); else flow.push(draft("out_of_area_accepted"));
    } else if (newTextOnly) {
      note(textOnlyNote(ctx));
      noted("text_only_noted", { where: operatorWhereVar(ctx.channel) }, false);
    } else if (newCallback) {
      note(`Когда звонить: «${s.callback.when}»`);
      noted("callback_noted", { time: s.callback.when! }, false);
    } else if (u.callback.noCall) {
      s.noCall = true;
      note("Просит не звонить");
      if (!said("no_call_ack")) flow.push(draft("no_call_ack"));
    } else if (u.phone) {
      note("Клиент написал номер для звонка", { phone: u.phone });
      noted("note_added");
    } else if (u.hasDetails || u.outsidePlace || u.bargain || newGoal) {
      note(operatorLeadNote(noteState, u, ctx));
      if (!u.bargain) noted("note_added");
    } else if (u.offTopic) {
      if (!said("off_topic")) flow.push(draft("off_topic"));
    } else if (extra && u.question === "status") {
      // «Когда позвонят?»: напоминание агенту — заметкой в карточку (агент получает пуш о сообщении клиента штатно).
      note(`Клиент спрашивает, когда с ним свяжутся${u.quote ? `: «${u.quote}»` : ""}`);
      noted("lead_status");
    } else if (extra && goalRole && !newGoal) {
      // Клиент повторил то, что уже в заявке («хочу продать»): напоминаем, что заявка у агента, один раз в сутки.
      if (!said("lead_reminder") && !said("no_agent_noted")) flow.push(noAgent ? draft("no_agent_noted", { when: ctx.noAgentWhen[language] }) : draft("lead_reminder"));
    } else if (extra && answers.length === 0 && substantive) {
      // Вопрос по делу — «передал ваш вопрос»; сообщение без вопроса — «передал агенту». Оба — заметкой в карточку.
      const asked = u.question !== "none" || /[?]/u.test(u.quote);
      note(`${asked ? "Вопрос клиента" : "Клиент пишет"}: «${u.quote}»`);
      noted(asked ? "question_noted" : "note_added");
    } else if (extra && u.greetingOnly && answers.length === 0) {
      if (!said("lead_reminder") && !said("no_agent_noted")) {
        flow.push(draft(u.greeting === "assalom" ? "greet_assalom" : "greet"));
        flow.push(noAgent ? draft("no_agent_noted", { when: ctx.noAgentWhen[language] }) : draft("lead_reminder"));
      }
    } else if (u.thanksOnly && !said("welcome")) flow.push(draft("welcome"));
    if (noAgent && actions.some(action => action.type === "append_note")) actions.push({ type: "follow_up" });
    // Инвариант (ревью #333): карточка без живого агента, бот молчит не на «ок» — руководство узнаёт.
    else if (noAgent && !answers.length && !flow.length && !u.ackOnly && !u.thanksOnly) actions.push({ type: "follow_up" });
    // Сотрудник сам ведёт переписку прямо сейчас: бот молчит, заметки агенту остаются (агенту — штатный пуш о сообщении).
    if (ctx.staffActive) {
      answers.length = 0; flow.length = 0; yielded = true;
      // Карточка без живого агента: о сообщении клиента узнаёт руководство (дверь «клиент ждёт»).
      if (noAgent && !actions.some(action => action.type === "follow_up")) actions.push({ type: "follow_up" });
    }
    return finish();
  }

  // ── не по теме: одна фраза, второй раз молчим (случай 24) ─────────────────
  if (u.offTopic && !u.role && !u.phone) {
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
    // Вакансии ведёт прежний путь рекрутёра (анкета кандидата, Ноза): оператор ход отдаёт и сам не отвечает (ревью 19.11,
    // Р6). Свои фразы о вакансиях — только запасной ответ, когда приём вакансий выключен в Настройках.
    if (ctx.recruiterPath) { answers.length = 0; flow.length = 0; handoff = "recruiter"; return finish(); }
    jobAnswer(s, u, ctx, language, answers, said);
    return finish();
  }

  // ── роль: явная новая роль меняет прежнюю, иначе прежняя остаётся ─────────
  const propertyRef = u.attachments.ownPost || (u.aboutThisProperty && !u.adOpener);
  let candidate: OperatorRole | null = null;
  if (u.role === "seller") candidate = "seller";
  else if (u.role === "buyer") candidate = propertyRef ? "buyer_property" : "buyer";
  // Модель и слабая находка кода назвали разные стороны (слепое ревью #345): роль не угадываем — вопрос «купить или продать?».
  else if (u.roleConflict && s.role === "unknown") candidate = null;
  else if (propertyRef) candidate = "buyer_property";
  // РОЛЬ — ПО СЛОВАМ КЛИЕНТА (владелец 20.11.2026: «чтобы покупатели не путались с продавцами»). Тема рекламы роль не
  // даёт: на рекламе «для собственников» пишут и покупатели (прод 20.11: «Салом» → заявка продавца; таджикская кнопка →
  // заявка покупателя). Без слов о роли — приветствие и вопрос «купить или продать?». Исключение одно: реклама КОНКРЕТНОГО
  // объекта, который сервер знает (фокус), и не голое приветствие — это интерес к объекту (SPEC, таблица ролей).
  else if (s.role === "unknown" && ctx.ad.topic === "property" && ctx.focus && !u.greetingOnly && !u.roleConflict) candidate = "buyer_property";
  // «Хочу купить» у покупателя объекта — тот же покупатель объекта, а не общий поиск.
  if (candidate === "buyer" && s.role === "buyer_property") candidate = null;
  if (candidate && candidate !== s.role) {
    // Роль сменилась словами клиента («сначала покупал, теперь продаю»): агенту в заметке «роль изменилась» (21.11.2026).
    const from = leadRole(s.role), to = leadRole(candidate);
    if (from && to && from !== to) s.flags.roleChangedFrom = from;
    switchRole(s, candidate);
  }
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
    // Повторное «не звоните» без номера: ответа нет — человек узнаёт (ревью #333, третий круг).
    else if (!answers.length) signal("no_phone");
    return finish();
  }
  // «Нет, просто узнать», «Да нет, пока не надо» после предложения звонка (слепое ревью #345): номер не просим, коротко «пишите,
  // когда удобно» один раз. Это не вечное «не звоните»: следующий вопрос по делу — снова интерес.
  if (said("offer_call") && u.declines && !u.phone && u.question === "none" && !u.placeQuestion && !u.showing && !u.hasDetails &&
    s.role !== "buyer" && s.role !== "seller") {
    if (!said("no_call_ack")) flow.push(draft("no_call_ack"));
    return finish();
  }

  /** Один мягкий необязательный вопрос о деталях — в ответе с заявкой, только про недостающее (владелец 20.11.2026). */
  const detailsWithLead = (): Draft | null => {
    if (s.asked.details > 0 || (s.role !== "buyer" && s.role !== "seller")) return null;
    const fields = s.role === "seller" ? OPERATOR_SELLER_FIELDS : OPERATOR_BUYER_FIELDS;
    const missing = fields.filter(field => !s.details[field]);
    if (missing.length === 0) return null;
    s.asked.details = 1;
    const when = ctx.callbackWhen[language];
    return missing.length === fields.length ? draft(s.role === "seller" ? "lead_and_details_seller" : "lead_and_details_buyer", { when })
      : draft("lead_and_details_missing", { when, missing });
  };
  const leadMessage = (): Draft => {
    const when = ctx.callbackWhen[language];
    if (s.outOfArea) return draft("out_of_area_accepted");
    // «Пишите» или «не звоните» (Р3): заявка без обещания звонка — агент напишет.
    if (s.callback.textOnly || s.noCall) return draft("lead_text_only", { where: operatorWhereVar(ctx.channel) });
    if (s.callback.when) return draft("lead_callback", { time: s.callback.when });
    const details = detailsWithLead();
    if (details) return details;
    if (u.phone && !ctx.phoneKnown) return draft("phone_received", { when });
    return draft("lead_known_phone", { when });
  };
  // Номер известен только по каналу (WhatsApp) или из слов ЭТОГО хода: номер прошлых ходов нигде не сохранён (Р2).
  const phoneKnown = () => ctx.phoneKnown || !!u.phone;
  /**
   * ИНТЕРЕС (владелец 21.11.2026: «почему то слишком быстро он номер берет»). Номер просим (или заводим заявку по номеру
   * WhatsApp), только когда клиент сам назвал роль, хочет показ, торгуется, просит человека, согласился на предложенный
   * звонок, назвал время или детали. Вопрос об объекте, цене, месте — ответ и ОДИН раз предложение звонка, без просьбы
   * номера в том же сообщении. Номер в словах клиента — заявка всегда.
   */
  const agreedToCall = said("offer_call") && u.declines !== true && (u.agrees === true || u.ackOnly);
  /**
   * Второй вопрос по делу после предложения звонка — тоже интерес (слепое ревью #345: на рекламе объекта клиент спрашивал цену,
   * место, этаж, документы, ремонт, а бот отвечал «скажет агент», номер не просил, заявку не заводил). В WhatsApp — заявка.
   */
  const askedAgain = said("offer_call") && u.declines !== true &&
    (QUESTION_FOR_AGENT.has(u.question) || u.question === "fee" || !!u.placeQuestion || u.aboutThisProperty);
  // Роль названа словами — интерес; покупатель только по вопросу этого хода («Квартира продаётся?») — ещё нет: ответ и
  // предложение звонка, номер (в WhatsApp — заявка) — при следующем шаге клиента (слепое ревью #345).
  // «Интересует эта квартира», «хочу купить эту» на объекте — роль словами этого хода, тоже интерес.
  const roleInterest = ((s.role === "buyer" || s.role === "seller") && !(u.roleByQuestion && leadRole(prev.role) !== leadRole(s.role))) ||
    ((u.role === "buyer" || u.role === "seller") && !u.roleByQuestion);
  const strongInterest = !!u.phone || roleInterest || u.showing === true || agreedToCall || u.bargain ||
    askedAgain || u.question === "staff" || u.botQuestion || u.hasDetails || !!u.callback.when || u.callback.textOnly;
  /**
   * За ответом «скажет агент» пойдёт номер или заявка: иначе это обещание без пути (клиент просил не звонить, номер не дали,
   * или интереса нет, а предложение звонка уже звучало — тогда «скажет агент» не обещаем).
   */
  const contactPathOpen = () => (strongInterest || !said("offer_call")) &&
    (phoneKnown() || (!s.noCall && (s.asked.phone < Math.min(ctx.maxPhoneAsks, 2) || !said("office_phone"))));
  /** Не больше двух просьб номера за разговор и не в соседних ходах: следующая — через два содержательных хода клиента. */
  const phoneAsksMax = Math.min(ctx.maxPhoneAsks, 2);
  const phoneAskCooled = () => s.asked.phone === 0 || (s.flags.clientTurns ?? 0) - (s.flags.phoneAskTurn ?? 0) >= 2;
  const contact = () => {
    if (u.phone || (phoneKnown() && strongInterest)) {
      acceptLeadSilently(s, u, ctx, actions);
      flow.push(leadMessage());
      return;
    }
    // «Не звоните» без номера: бот номер больше не просит, а человек узнаёт один раз (инвариант ревью #333: клиент не
    // остаётся и без ответа, и без человека).
    if (s.noCall) { if (!flow.length && !answers.length) signal("no_phone"); return; }
    if (!strongInterest) {
      if (!said("offer_call")) flow.push(draft("offer_call"));
      else if (!flow.length && !answers.length) signal("no_phone");
      return;
    }
    if (s.asked.phone < phoneAsksMax || said("ask_phone") || said("ask_phone_seller")) {
      // «Хорошо / ладно / хоп» сразу на просьбу номера, а номера нет — согласие: одна короткая просьба «куда позвонить» (это
      // продолжение того же шага, не новая просьба; слепое ревью #345). Дальше — по правилу пауз.
      const justAsked = s.asked.phone > 0 && s.step === "contact" && (s.flags.clientTurns ?? 0) - (s.flags.phoneAskTurn ?? 0) <= 1;
      if (justAsked && (u.agrees || u.ackOnly) && !u.declines && !said("phone_where")) { flow.push(draft("phone_where")); return; }
    }
    if (s.asked.phone < phoneAsksMax) {
      if (!phoneAskCooled()) {
        // Пауза между просьбами номера: на слова по делу — короткое «понял» (детали уйдут в заявку), без той же просьбы.
        if (!flow.length && !answers.length) { if (u.hasText && !u.ackOnly && !u.thanksOnly) flow.push(draft("got_it")); else signal("no_phone"); }
        return;
      }
      flow.push(draft(s.role === "seller" ? "ask_phone_seller" : "ask_phone")); s.asked.phone += 1; s.flags.phoneAskTurn = s.flags.clientTurns ?? 0; s.step = "contact";
      return;
    }
    // Номер не дали после всех просьб: один раз номер офиса, дальше тишина. Людей до заявки не зовём (решение владельца
    // 13.11.2026: «никаких уведомлений не надо никому высылать, пока он не станет лидом»).
    if (!said("office_phone")) flow.push(draft("office_phone", { phone: ctx.officePhone }));
    else signal("no_phone");
    s.step = "handoff";
  };
  /** Приветствие в ответ на приветствие (SPEC «Тон») — и там, где ответ ведёт к номеру или заявке (прод 21.11: «Салом алейкум…» → голое «нависед»). */
  const greetBack = () => {
    if (!u.greeting || said("greet") || said("greet_assalom") || ctx.staffThread) return;
    if (!answers.length && !flow.length) return;
    flow.push(draft(u.greeting === "assalom" ? "greet_assalom" : "greet"));
  };
  // Клиент сам дал номер, просит человека, спрашивает «вы бот?» или торгуется — сразу шаг «контакт».
  const wantsContact = !!u.phone || u.question === "staff" || u.botQuestion || u.bargain;

  if (s.role === "unknown" || s.role === "rent" || s.role === "job") {
    if (wantsContact) { contact(); greetBack(); return finish(); }
    if (s.asked.role >= 2) {
      // Два непонятных ответа на вопрос о роли: молчим и один раз зовём человека (20.11.2026; кому — лесенка двери
      // «клиент ждёт»: агент, руководство поштучно не беспокоим). Через сутки тишины — заново (state.ts).
      s.step = "handoff";
      signal("unclear");
      return finish();
    }
    // Приветствие в ответ на приветствие (SPEC «Тон») — всегда первым, даже рядом с ответом на вопрос (перенесено из 19.11).
    if (u.greeting && !said("greet") && !said("greet_assalom") && !ctx.staffThread) {
      flow.push(draft(u.greeting === "assalom" ? "greet_assalom" : "greet"));
    }
    flow.push(draft("ask_role")); s.asked.role += 1; s.step = "role";
    return finish();
  }

  if (s.role === "buyer_property") {
    const placeAsked = !!u.placeQuestion;
    if (facts && (propertyLineComing || placeAsked)) {
      const id = facts.shortId;
      // «Где объект?» — район и город с сайта (и цена, если есть); места в карточке нет — честно «расскажет агент».
      // Место — ровно район и город с сайта (siteSync: location = район, город); «Рудаки» вслух не называем (SPEC «Тон»).
      const place = facts.place && !/р[уӯ]дак/iu.test(facts.place) ? facts.place : null;
      if (placeAsked && !facts.sold && place) {
        flow.push(facts.priceText ? draft("property_place_price", { id, place, price: facts.priceText[language] })
          : draft("property_place", { id, place }));
      } else {
        if (placeAsked && !facts.sold) answers.push(draft("place_by_agent"));
        flow.push(facts.sold ? draft("property_sold", { id }) : facts.priceText ? draft("property_price", { id, price: facts.priceText[language] })
          : draft("property_no_price", { id }));
      }
      s.flags.propertyLineFor = facts.propertyId;
    } else if (!facts) {
      if (u.question === "property_price" || u.aboutThisProperty || u.question === "fee") s.flags.adPriceAsked = true;
      // Объект не определён: на вопрос — честный ответ, а не голая просьба номера (владелец 21.11.2026, прод fc9996a9).
      if (!answers.length && contactPathOpen()) {
        if (placeAsked) answers.push(draft("place_by_agent"));
        else if (QUESTION_FOR_AGENT.has(u.question) || (u.aboutThisProperty && u.question !== "none")) answers.push(draft("details_by_agent"));
      }
    }
    // Объект известен, его строка уже звучала, а клиент спрашивает другое («документы готовы?»): не голая просьба номера.
    if (facts && !answers.length && !flow.length && QUESTION_FOR_AGENT.has(u.question) && u.question !== "property_price" && contactPathOpen()) {
      answers.push(draft("details_by_agent"));
    }
    contact();
    greetBack();
    const decision = finish();
    // Строку объекта вытеснил ответ на вопрос клиента (не больше двух шагов): объект ещё не назван.
    if (!decision.steps.some(step => step.key.startsWith("property_"))) decision.state.flags.propertyLineFor = prev.flags.propertyLineFor;
    return decision;
  }

  // Покупатель (общий запрос) и продавец: сразу шаг «контакт» — заявка (номер есть) или просьба номера. Детали до заявки
  // не собираем: мягкий вопрос о них — в ответе с заявкой (владелец 20.11.2026). Продавцу, который назвался сам, — условия.
  if (s.role === "seller" && s.flags.sellerByWords && !commissionSaid() && answers.length === 0 && !s.noCall) {
    flow.push(draft("seller_intro", { percent: ctx.sellerCommissionPercent }));
  }
  // Вопрос по делу, на который у бота нет фактов: честно «скажет агент», потом номер или заявка (не голая просьба номера).
  if (!answers.length && !flow.length && QUESTION_FOR_AGENT.has(u.question) && contactPathOpen()) {
    answers.push(draft(u.placeQuestion ? "place_by_agent" : "details_by_agent"));
  }
  // Явная роль, номера нет (решение 21.11.2026 к SPEC п. 8, владелец: «слишком быстро он номер берет»): первым ответом — тёплое
  // слово и ОДИН короткий вопрос по делу (покупателю — район, комнаты, бюджет; продавцу — что и где), номер — следующим ходом.
  // В WhatsApp номер известен: заявка сразу (contact), вслух номер не просим.
  const firstQuestion = roleFirstQuestion(s, u, phoneKnown());
  if (firstQuestion) { flow.push(firstQuestion); greetBack(); return finish(); }
  contact();
  greetBack();
  return finish();
}

/** Первый вопрос по делу на явную роль без номера: один раз за разговор, только про недостающее. */
function roleFirstQuestion(s: OperatorState, u: Understanding, phoneKnown: boolean): Draft | null {
  if (phoneKnown || s.noCall || s.asked.details > 0 || s.asked.phone > 0 || (s.role !== "buyer" && s.role !== "seller")) return null;
  // Покупатель только по вопросу: ответ и предложение звонка (contact), а не анкета.
  if (u.roleByQuestion) return null;
  // Клиент уже сам торопит контакт (торг, показ, человек, время звонка): вопрос о деталях не нужен, сразу номер.
  if (u.bargain || u.showing || u.question === "staff" || u.botQuestion || u.callback.when || u.callback.textOnly) return null;
  const fields = s.role === "seller" ? OPERATOR_SELLER_FIELDS : OPERATOR_BUYER_FIELDS;
  const missing = fields.filter(field => !s.details[field]);
  if (missing.length === 0) return null;
  s.asked.details = 1;
  return missing.length === fields.length ? draft(s.role === "seller" ? "role_details_seller" : "role_details_buyer")
    : draft("role_details_missing", { missing });
}

/** Заявка: действие для приёма и «заявка принята» в памяти. Номер — из слов этого хода, иначе номер канала (WhatsApp). */
function acceptLeadSilently(s: OperatorState, u: Understanding, ctx: OperatorContext, actions: OperatorAction[]): void {
  actions.push({ type: "accept_lead", role: leadRole(s.role), propertyId: s.role === "buyer_property" ? s.propertyId : null,
    phone: u.phone, note: operatorLeadNote(s, u, ctx), outOfArea: s.outOfArea, callbackWhen: s.callback.when,
    textOnly: s.callback.textOnly, noCall: s.noCall });
  s.leadAccepted = true; s.step = "done";
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
  // Приветствие в ответ на приветствие (SPEC «Тон») — одно-два слова, в предел шагов не входит и идёт первым.
  const isGreeting = (item: Draft) => item.key === "greet" || item.key === "greet_assalom";
  const greeting = flow.find(isGreeting) ?? null;
  const rest = flow.filter(item => !isGreeting(item));
  let chosen = [...answers, ...rest];
  if (chosen.length > OPERATOR_MAX_STEPS) chosen = rest.length ? [answers[0] ?? rest[0]!, rest.at(-1)!] : chosen.slice(0, OPERATOR_MAX_STEPS);
  if (greeting) chosen = [greeting, ...chosen];
  const seen = new Set<PhraseKey>();
  const steps: OperatorStepOut[] = [];
  for (const item of chosen) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    const variant = s.spoken[item.key] ?? 0;
    s.spoken[item.key] = variant + 1;
    steps.push({ key: item.key, vars: item.vars, variant });
  }
  // Серия «передал агенту»: помним, что прошлый ответ был только отметкой (тишина серию не прерывает).
  if (steps.length) s.flags.lastAck = steps.every(step => ACK_KEYS.has(step.key));
  return { state: s, language, steps, actions, silent: steps.length === 0 };
}
