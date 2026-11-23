import { mentionsPhoneRequest, phoneReminder } from "./replyGuards.js";

/**
 * «АГЕНТ ПОЗВОНИТ» — ТОЛЬКО КОГДА ЕСТЬ КУДА ЗВОНИТЬ, И НИКАКОГО «ҲОЗИР» (16.11.2026, аудит facts.md Ф4).
 *
 * Живые случаи старого бота:
 *  - Instagram Royal Home 14.11: «Дархост қабул шуд» → «Мунтазири занг бошед» — номера у бота
 *    НЕТ, звонить некуда; через три минуты менеджер руками попросил номер;
 *  - там же 14.11: «Вай ҳозир ба шумо занг зада…» — «прямо сейчас» обещать нельзя
 *    (agencyFacts.ts::callbackPromiseLine), агенты на связи по своему графику.
 *
 * Правило кодом, а не просьбой в промте:
 *  - номера нет — обещание звонка заменяется ОДНОЙ просьбой номера; если номер уже просили в
 *    прошлой реплике или лимит просьб исчерпан — обещание просто вырезается;
 *  - номер есть — обещание остаётся, но без «ҳозир/ҳамин ҳоло/прямо сейчас», а вызывающий
 *    обязан превратить его в сигнал агенту (lib/agentAttention.ts) — `promised: true`.
 */

/**
 * Обещание звонка в третьем лице: «агент занг мезанад», «занг зада, … аниқ мекунад», «позвонит»,
 * «свяжется». Повелительное и неопределённое НЕ берём (ревью #207, В2): «Позвоните нам: …»,
 * «Шумо метавонед ба офис занг задан», «занг занед» — это телефон агентства для клиента, а не
 * обещание, и вырезать его нельзя.
 */
const CALL_PROMISE =
  /(?<![\p{L}])(?:занг\s+(?:мезан(?:ад|анд|ем)|зада(?![\p{L}])(?!\s+метавон))|мунтазири\s+занг\p{L}*|(?:по|пере)звон(?:ит|ят|им)(?![\p{L}])|свяж(?:ется|утся|емся)(?![\p{L}])|тамос\s+(?:мегир(?:ад|анд|ем)|гирифта(?![\p{L}])))/iu;

const IMMEDIATELY =
  /(?<![\p{L}])(?:ҳозир(?:акак)?|хозир(?:акак)?|ҳамин\s+ҳоло|хамин\s+холо|ҳамин\s+замон|прямо\s+сейчас|сейчас\s+же|сию\s+минуту)(?![\p{L}])\s*/giu;

function isQuestion(sentence: string): boolean {
  return /\?\s*$/.test(sentence);
}

/** Фраза обещает звонок (и сама не просьба номера, и не вопрос). */
export function promisesCall(sentence: string): boolean {
  return CALL_PROMISE.test(sentence) && !isQuestion(sentence) && !mentionsPhoneRequest(sentence);
}

/**
 * «Передал вашу просьбу», «ба агент мерасонам», «аризаатонро қабул кардем»: обещание, что вопрос
 * дойдёт до агента, без слова «позвонит». Клиент ждёт агента ровно так же (живые чаты 17–18.11.2026:
 * #2f2c7d «Передал вашу просьбу» без карточки, Instagram «Ҳамаи ин шартҳоро ба агент расондам»).
 */
const HANDOVER_PROMISE = new RegExp(
  [
    // «Передал вашу просьбу», «передал ваше сообщение сотруднику», «передаю ваш вопрос агенту»
    String.raw`(?<![\p{L}])(?:передал[аи]?|переда(?:ю|м|ём))\s+(?:вашу|ваш|ваше|вашей)(?![\p{L}])`,
    // «Ваш запрос передаю агенту», «по объекту №208 передаю агенту»
    String.raw`(?<![\p{L}])(?:передал[аи]?|переда(?:ю|м|ём))\s+(?:[\p{L}\d№-]+\s+){0,3}?(?:агент|сотрудник|менеджер|специалист)\p{L}*`,
    // «ба агент мерасонам», «ба агент расондам»
    String.raw`(?<![\p{L}])ба\s+(?:агент|корманд|менеҷер)\p{L}*\s+(?:мерасон\p{L}*|расонд\p{L}*)`,
    // «Ваша заявка принята», «аризаатонро … қабул кардем», «Дархости шумо қабул шуд»
    String.raw`(?<![\p{L}])(?:заявк|ариза|дархост)\p{L}*(?:\s+шумо)?[\s,]+(?:[\p{L}\d-]+[\s,]+){0,8}?(?:принят\p{L}*|принял\p{L}*|қабул\s+(?:кард|шуд)\p{L}*)`,
    // «Мы приняли вашу заявку»
    String.raw`(?<![\p{L}])принял\p{L}*\s+(?:вашу\s+)?заявк\p{L}*`,
  ].join("|"),
  "iu"
);

/** «Агент не позвонит без согласия», «передам вашу благодарность команде» — не обещание агента. */
const NOT_A_PROMISE =
  /(?<![\p{L}])(?:не\s+(?:по|пере)звон\p{L}*|не\s+свяж\p{L}*|не\s+(?:принят|принял|переда)\p{L}*|принять|занг\s+намезан\p{L}*|қабул\s+намекун\p{L}*|благодарност\p{L}*|миннатдор\p{L}*)/iu;

/**
 * Условное обещание: «если удобно, напишите номер, и агент позвонит», «агар мувофиқ бошад…», «оставьте контакты».
 * Не mentionsPhoneRequest: она ловит и «Агент позвонит вам на ЭТОТ НОМЕР» — главное обещание ядра в WhatsApp.
 */
const CONDITIONAL_PROMISE =
  /(?<![\p{L}])(?:если|агар|оставьте|напишите|нависед|дайте|гузоред|бигузоред|фиристед|отправьте|пришлите|скиньте|укажите)(?![\p{L}])/iu;

/**
 * Бот пообещал, что агент свяжется: звонок или передача вопроса агенту. Для сторожа
 * «обещал — карточки нет» (lib/phoneLeadWatchdog.ts), а не для правки ответа: условное
 * обещание и просьба номера сюда не входят, вопрос тоже.
 */
export function promisesAgentContact(sentence: string): boolean {
  if (isQuestion(sentence) || CONDITIONAL_PROMISE.test(sentence) || NOT_A_PROMISE.test(sentence)) return false;
  return CALL_PROMISE.test(sentence) || HANDOVER_PROMISE.test(sentence);
}

export interface CallbackPromiseGuardResult {
  bubbles: string[];
  /** Обещание звонка ушло клиенту при известном номере — агенту нужен сигнал. */
  promised: boolean;
  /** Сколько фраз-обещаний заменено/вырезано. */
  changed: number;
}

export function guardCallbackPromises(input: {
  bubbles: string[];
  phoneKnown: boolean;
  /** Можно ли сейчас попросить номер: прошлый ответ не просил, лимит не исчерпан. */
  mayAskPhone: boolean;
  language: "ru" | "tg" | "mixed" | "unknown";
}): CallbackPromiseGuardResult {
  let promised = false;
  let changed = 0;
  let askAdded = input.bubbles.some((b) => mentionsPhoneRequest(b));
  const out = input.bubbles.map((bubble) =>
    bubble
      .split("\n")
      .map((line) =>
        line
          .split(/(?<=[.!?])[ \t]+/u)
          .map((sentence) => {
            if (!promisesCall(sentence)) return sentence;
            if (input.phoneKnown) {
              promised = true;
              const calm = sentence.replace(IMMEDIATELY, "").replace(/\s{2,}/g, " ").trim();
              if (calm !== sentence) changed += 1;
              return calm ? calm[0].toUpperCase() + calm.slice(1) : calm;
            }
            changed += 1;
            if (input.mayAskPhone && !askAdded) {
              askAdded = true;
              return phoneReminder(input.language);
            }
            return "";
          })
          .filter((s) => s.trim().length > 0)
          .join(" ")
      )
      .join("\n")
      .trim()
  );
  return { bubbles: changed > 0 ? out.filter((b) => b.length > 0) : input.bubbles, promised, changed };
}
