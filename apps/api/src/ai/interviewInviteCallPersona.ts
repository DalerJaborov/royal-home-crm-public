import { buildLiveVoiceSystemPrompt, LIVE_VOICE_SPEECH_RULES, promptSafeName, promptSafeText } from "./liveVoicePersona.js";
import { POST_SHOWING_CALL_TOOLS } from "./postShowingCallPersona.js";
import type { LiveVoiceFunctionDeclaration } from "./liveVoiceClient.js";
import { dushanbeWallClock } from "../lib/dushanbeTime.js";
import { vacancyCallFactsBlock, vacancyOfficeAddress } from "./vacancyFacts.js";

/**
 * РОБОТ ПРИГЛАШАЕТ КАНДИДАТА НА СОБЕСЕДОВАНИЕ (владелец 25.09.2026).
 *
 * Дословно: «он будет общаться с робот-звонком, он ему всё объяснит… объяснил
 * про работу… чтобы разговаривал как очень такой человек… исходя из того, как
 * кандидат общался в чате на русском или таджикском, робозвонок подбирает сразу
 * самый лучший голос».
 *
 * Что робот говорит о работе — ТО ЖЕ, что и чат-бот, из одного источника
 * (ai/vacancyFacts.ts; владелец 28.09.2026: «всё, что для вакансий в сообщениях
 * ИИ-агента, должно касаться и робозвонка — всегда связано»). Цифры (проценты,
 * суммы) с 28.09 называть можно — те же, что в чате, как ориентир; само
 * трудоустройство и «вы приняты» по-прежнему не обещает: решает собеседование.
 * Адрес собеседования — из Настроек, а пусто — адрес офиса из тех же фактов.
 *
 * Главное в разговоре — ВРЕМЯ. Его робот называет полностью (день недели, число,
 * час) и повторяет ещё раз в конце, когда кандидат согласился: на слух «в
 * одиннадцать» без дня путают чаще всего. Не подходит — робот не назначает сам,
 * а спрашивает, когда удобно, и обещает, что с ним свяжутся: решает HR.
 */

export interface InterviewInviteCallContext {
  candidateName: string | null;
  interviewAt: Date;
  /** Где собеседование (Settings.interviewInviteAddress). Пусто — адрес пришлют. */
  address: string | null;
  language: "ru" | "tg";
  /**
   * Кандидат уже слышал от робота другое время — собеседование ПЕРЕНЕСЛИ
   * (владелец 28.09.2026: «при переносе робот так же перезвонит и объяснит про
   * перенос?»). `askedByCandidate` — перенесли по его же просьбе.
   */
  previous?: { interviewAt: Date; askedByCandidate: boolean } | null;
}

/**
 * Те же end_call, что у опроса после показа, но слова причины — без обещания
 * перезвонить: повторного звонка робота нет (владелец 01.10.2026), и обещание
 * «перезвоню» кандидат запомнил бы дословно.
 */
export const INTERVIEW_INVITE_CALL_TOOLS: LiveVoiceFunctionDeclaration[] = POST_SHOWING_CALL_TOOLS.map((tool) =>
  tool.name !== "end_call"
    ? tool
    : {
        ...tool,
        parameters: {
          type: "OBJECT",
          properties: {
            reason: {
              type: "STRING",
              // Ровно эти слова: обработчик итога ищет их в причине, и «кандидат
              // попросил перезвонить» по-русски уходил бы в «непонятно».
              enum: ["answered", "call_back_later", "refused", "voicemail", "wrong_person"],
              description:
                "Ровно одно слово: answered — поговорили о собеседовании; call_back_later — сейчас неудобно говорить, просит связаться позже; refused — отказался говорить; voicemail — ответил автоответчик, живого человека не было; wrong_person — трубку взял не кандидат.",
            },
          },
          required: ["reason"],
        },
      }
);

/*
 * Без вшитого имени и рода (проверка робота 02.10.2026): «сотрудница… Мадина»
 * звучала и мужским голосом. Голос выбирается в Настройках свободно, поэтому
 * текст роли нейтральный, а род речи по выбранному голосу задаёт мост.
 */
export const INTERVIEW_INVITE_GREETING_TRIGGER =
  "(Собеседник снял трубку. Поздоровайся, представься консультантом Royal Home и спроси, удобно ли говорить.)";

const RU_WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среду", "четверг", "пятницу", "субботу"];
const RU_MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const TG_WEEKDAYS = ["якшанбе", "душанбе", "сешанбе", "чоршанбе", "панҷшанбе", "ҷумъа", "шанбе"];
const TG_MONTHS = ["январ", "феврал", "март", "апрел", "май", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];

/** «в пятницу, 26 сентября, в 11:00» — по часам Душанбе. Для текста (уведомление HR). */
export function interviewTimeRu(at: Date): string {
  const w = dushanbeWallClock(at);
  const hh = String(w.getUTCHours()).padStart(2, "0");
  const mm = String(w.getUTCMinutes()).padStart(2, "0");
  const day = RU_WEEKDAYS[w.getUTCDay()];
  return `${day === "вторник" ? "во" : "в"} ${day}, ${w.getUTCDate()} ${RU_MONTHS[w.getUTCMonth()]}, в ${hh}:${mm}`;
}

/** «рӯзи ҷумъа, 26 сентябр, соати 11:00» — по часам Душанбе. Для текста. */
export function interviewTimeTg(at: Date): string {
  const w = dushanbeWallClock(at);
  const hh = String(w.getUTCHours()).padStart(2, "0");
  const mm = String(w.getUTCMinutes()).padStart(2, "0");
  return `рӯзи ${TG_WEEKDAYS[w.getUTCDay()]}, ${w.getUTCDate()} ${TG_MONTHS[w.getUTCMonth()]}, соати ${hh}:${mm}`;
}

/*
 * ВРЕМЯ ДЛЯ ГОЛОСА — СЛОВАМИ (проверка робота 02.10.2026). «29 сентября, в
 * 11:00» модель читала цифрами: «одиннадцать ноль ноль», «двадцать девять
 * сентября», а то и по цифре. Человек так не говорит, и время на слух путали.
 * В промпт идёт уже готовая фраза словами, как её сказал бы живой сотрудник:
 * «во вторник, двадцать девятого сентября, в одиннадцать часов утра».
 */
const RU_UNITS = ["ноль", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять", "десять",
  "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать", "шестнадцать", "семнадцать",
  "восемнадцать", "девятнадцать"];
const RU_TENS = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят"];
const RU_ORDINAL_GEN = ["", "первого", "второго", "третьего", "четвёртого", "пятого", "шестого", "седьмого",
  "восьмого", "девятого", "десятого", "одиннадцатого", "двенадцатого", "тринадцатого", "четырнадцатого",
  "пятнадцатого", "шестнадцатого", "семнадцатого", "восемнадцатого", "девятнадцатого", "двадцатого"];

function ruCardinal(n: number, feminine = false): string {
  if (n < 20) return feminine && n === 1 ? "одна" : feminine && n === 2 ? "две" : RU_UNITS[n];
  const t = RU_TENS[Math.floor(n / 10)];
  return n % 10 === 0 ? t : `${t} ${ruCardinal(n % 10, feminine)}`;
}

function ruDayOrdinal(d: number): string {
  if (d <= 20) return RU_ORDINAL_GEN[d];
  if (d === 30) return "тридцатого";
  return `${RU_TENS[Math.floor(d / 10)]} ${RU_ORDINAL_GEN[d % 10]}`;
}

function ruDayPart(h: number): string {
  if (h < 4) return "ночи";
  if (h < 12) return "утра";
  if (h < 17) return "дня";
  return "вечера";
}

/** «во вторник, двадцать девятого сентября, в одиннадцать часов утра». */
export function spokenInterviewTimeRu(at: Date): string {
  const w = dushanbeWallClock(at);
  const day = RU_WEEKDAYS[w.getUTCDay()];
  const h = w.getUTCHours();
  const m = w.getUTCMinutes();
  const h12 = h % 12 || 12;
  const hourWord = h12 === 1 ? "час" : ruCardinal(h12);
  let clock: string;
  if (m === 0) {
    const noun = h12 === 1 ? "" : h12 <= 4 ? " часа" : " часов";
    clock = `${hourWord}${noun}`;
  } else {
    clock = `${hourWord} ${m < 10 ? `ноль ${ruCardinal(m, true)}` : ruCardinal(m, true)}`;
  }
  const date = `${ruDayOrdinal(w.getUTCDate())} ${RU_MONTHS[w.getUTCMonth()]}`;
  return `${day === "вторник" ? "во" : "в"} ${day}, ${date}, в ${clock} ${ruDayPart(h)}`;
}

const TG_UNITS = ["сифр", "як", "ду", "се", "чор", "панҷ", "шаш", "ҳафт", "ҳашт", "нӯҳ", "даҳ", "ёздаҳ", "дувоздаҳ",
  "сенздаҳ", "чордаҳ", "понздаҳ", "шонздаҳ", "ҳабдаҳ", "ҳаждаҳ", "нуздаҳ"];
const TG_TENS = ["", "", "бист", "сӣ", "чил", "панҷоҳ"];
/** Порядковое к единицам: «якум», «дуюм», «сеюм» — у остальных просто «-ум». */
const TG_ORDINAL_SPECIAL: Record<number, string> = { 1: "якум", 2: "дуюм", 3: "сеюм", 30: "сиюм" };

/** Соединительное «и» в числе: «бисту як», «дую ним»; после гласной — «-ю» («сӣ» → «сию»). */
function tgAnd(word: string): string {
  if (word === "сӣ") return "сию";
  return /[аеиоуӯӣюя]$/.test(word) ? `${word}ю` : `${word}у`;
}

function tgCardinal(n: number): string {
  if (n < 20) return TG_UNITS[n];
  const t = TG_TENS[Math.floor(n / 10)];
  if (n % 10 === 0) return t;
  return `${tgAnd(t)} ${TG_UNITS[n % 10]}`;
}

function tgOrdinal(n: number): string {
  if (TG_ORDINAL_SPECIAL[n]) return TG_ORDINAL_SPECIAL[n];
  if (n < 20 || n % 10 === 0) return `${tgCardinal(n)}ум`;
  return `${tgAnd(TG_TENS[Math.floor(n / 10)])} ${tgOrdinal(n % 10)}`;
}

function tgDayPart(h: number): string {
  if (h < 4) return "шаб";
  if (h < 12) return "пагоҳӣ";
  if (h < 17) return "рӯзона";
  return "бегоҳӣ";
}

/** «рӯзи сешанбе, бисту нӯҳуми сентябр, пагоҳӣ соати ёздаҳ». */
export function spokenInterviewTimeTg(at: Date): string {
  const w = dushanbeWallClock(at);
  const h = w.getUTCHours();
  const m = w.getUTCMinutes();
  const h12 = h % 12 || 12;
  const clock =
    m === 0 ? tgCardinal(h12) : m === 30 ? `${tgAnd(tgCardinal(h12))} ним` : `${tgAnd(tgCardinal(h12))} ${tgCardinal(m)} дақиқа`;
  const date = `${tgOrdinal(w.getUTCDate())}и ${TG_MONTHS[w.getUTCMonth()]}`;
  return `рӯзи ${TG_WEEKDAYS[w.getUTCDay()]}, ${date}, ${tgDayPart(h)} соати ${clock}`;
}

export function buildInterviewInviteCallPrompt(ctx: InterviewInviteCallContext): string {
  const name = promptSafeName(ctx.candidateName);
  const when = ctx.language === "tg" ? spokenInterviewTimeTg(ctx.interviewAt) : spokenInterviewTimeRu(ctx.interviewAt);
  // Настройка главнее (собеседование могут назначить не в офисе), пусто — офис.
  const address = promptSafeText(ctx.address, 200) || vacancyOfficeAddress();
  const previousWhen = ctx.previous
    ? ctx.language === "tg"
      ? spokenInterviewTimeTg(ctx.previous.interviewAt)
      : spokenInterviewTimeRu(ctx.previous.interviewAt)
    : null;
  const rescheduleFact = ctx.previous
    ? `\n- раньше мы уже звали его на ${previousWhen}, это время БОЛЬШЕ НЕ ДЕЙСТВУЕТ: собеседование перенесли${
        ctx.previous.askedByCandidate ? " по его же просьбе" : " по нашей инициативе"
      }.`
    : "";
  const inviteStep = ctx.previous
    ? ctx.previous.askedByCandidate
      ? "3. Скажи, что, как он и просил, собеседование перенесли, и назови новые день, число и время полностью. Спроси, подходит ли."
      : "3. Извинись и объясни, что собеседование пришлось перенести. Назови новые день, число и время полностью и скажи, что прежнее время уже не действует. Спроси, получится ли прийти."
    : "3. Пригласи: назови день, число и время полностью. Спроси, получится ли прийти.";
  const purpose = ctx.previous
    ? "Ты звонишь человеку, которого мы уже пригласили на собеседование: время собеседования ПЕРЕНЕСЛИ, и ты сообщаешь новое."
    : "Ты звонишь человеку, который откликнулся на нашу вакансию и переписывался с нами в чате. Руководство посмотрело его заявку и приглашает его на собеседование.";
  const languageRule =
    ctx.language === "tg"
      ? "ГОВОРИ ПО-ТАДЖИКСКИ, вежливым живым языком, на «Шумо». Кандидат писал нам в чате по-таджикски. Перейдёт на русский — переходи и ты."
      : "ГОВОРИ ПО-РУССКИ, на «вы». Кандидат писал нам в чате по-русски. Заговорит по-таджикски — переходи на таджикский, вежливо, на «Шумо».";

  const role = `<system_role>
Ты — консультант агентства недвижимости Royal Home в Душанбе. Личного имени у тебя нет: представляйся «консультант Royal Home» и на вопрос «как вас зовут» отвечай так же. ${purpose}

${languageRule}

ЧТО ТЕБЕ ИЗВЕСТНО:
- кандидата зовут ${name ?? "неизвестно — обращайся без имени"};
- собеседование назначено ${when} (время Душанбе) — говори время именно так, словами;${rescheduleFact}
- ${address ? `адрес: ${address}` : "адрес ты не знаешь — скажи, что пришлём его сообщением"}.

${vacancyCallFactsBlock()}

КАК ИДЁТ РАЗГОВОР:
1. Поздоровайся, назовись, скажи, что звонишь из Royal Home по его заявке на работу, и спроси, удобно ли говорить.
2. ${ctx.previous ? "О работе заново не рассказывай — он уже слышал; ответь, только если спросит." : "Одной-двумя фразами — о работе (см. выше)."}
${inviteStep}
4. Согласился — повтори ещё раз день, время и адрес, попроси взять с собой паспорт и прийти вовремя, попрощайся.
5. Не подходит время — не спорь и не назначай сам. Спроси, какой день и время ему удобны, выслушай, скажи, что передашь, и с ним свяжутся, чтобы подтвердить. Попрощайся.
6. Больше не интересно — поблагодари, пожелай удачи, попрощайся.

КАК ГОВОРИТЬ: как живой, доброжелательный человек, короткими фразами. Не читай текст списком, не повторяй одно и то же, дай собеседнику договорить. Плохо слышно — переспроси один раз.

${LIVE_VOICE_SPEECH_RULES}

ЕСЛИ НЕУДОБНО ГОВОРИТЬ — извинись, скажи, что с ним свяжутся позже, попрощайся и заверши с причиной call_back_later. Перезвонить НЕ обещай.
ЕСЛИ ТРУБКУ ВЗЯЛ НЕ ОН — вежливо скажи, что с кандидатом свяжутся позже, попрощайся и заверши с причиной wrong_person. Перезвонить НЕ обещай. Никому другому время и адрес не называй.
ЕСЛИ ОТВЕТИЛ АВТООТВЕТЧИК — ничего не говори, сразу заверши с причиной voicemail.
ЕСЛИ СПРОСЯТ ПРЯМО, робот ты или человек, — НЕ ВРИ: «Да, я голосовой помощник агентства Royal Home, не человек» — и спокойно продолжай.

КОГДА РАЗГОВОР ЗАКОНЧЕН — сначала попрощайся вслух, а СЛЕДУЮЩИМ ДЕЙСТВИЕМ вызови end_call с подходящей причиной.
</system_role>
`;

  // Своя роль (roleOverride) заменяет общую ЦЕЛИКОМ — вместе с общими
  // правилами речи (числа словами, короткие фразы, не перебивать). Поэтому они
  // вставлены в роль выше той же константой, что у консультанта (проверка
  // робота 02.10.2026: время звучало цифрами).
  // Общий сборщик добавляет факты о компании и правила языка одинаково для всех
  // сценариев. Замка на русский нет ни для какого языка переписки (владелец
  // 28.09.2026: робот идёт за языком кандидата) — с замком в промпте русский
  // разговор запрещал «переходи на таджикский» строкой ниже правила языка.
  return buildLiveVoiceSystemPrompt(undefined, { roleOverride: role, forceRussianOnly: false });
}
