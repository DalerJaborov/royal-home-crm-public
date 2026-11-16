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
