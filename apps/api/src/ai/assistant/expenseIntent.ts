import { BW, EW, TAIL } from "../wordBoundary.js";

/**
 * СЛОВА ПРОСЬБЫ О РАСХОДАХ — ОДНО МЕСТО НА ВСЕ ВХОДЫ (17.11.2026, журнал прода 10–11.11).
 *
 * Директор пять раз писал «ҳамин хароҷотҳоро дар CRM ворид кун», «мана акс», «дуруст ворид кун»
 * и пять раз получил ответ без единого вызова: прежний шаблон подписи (telegram/assistantExpenseReceipt.ts)
 * требовал, чтобы подпись НАЧИНАЛАСЬ со слов «расход/харҷ/внеси…», и не знал «хароҷот» и «ворид кун».
 * Шаблон здесь — подсказка, куда отдать сообщение, а не дверь: запись всё равно идёт только карточкой
 * `add_expenses` с кнопкой «Записать» и правами finance.view + finance.manage.
 *
 * Границы слова — BW/EW/TAIL (ai/wordBoundary.ts): `\b` и `\w` по кириллице молчат.
 */

/** «Расход» на языках сотрудников: расход/трата/затрата, харҷ/хароҷот (тадж., и без ҷ), xarajat, expense. */
const NOUN = new RegExp(
  `${BW}(?:расход${TAIL}|трат${TAIL}|затрат${TAIL}|харҷ${TAIL}|харч${TAIL}|хароҷот${TAIL}|харочот${TAIL}|xarajat${TAIL}|harajat${TAIL}|expenses?${EW})`,
  "iu",
);
/** Глагол «внести/записать»: внеси, запиши, добавь, ворид кун, сабт кун, дохил кун, илова кун. */
const WRITE = new RegExp(
  `${BW}(?:внес${TAIL}|запиш${TAIL}|записа${TAIL}|занес${TAIL}|занест${TAIL}|добав${TAIL}|провед${TAIL}|провест${TAIL}|ворид${TAIL}|сабт${TAIL}|дохил${TAIL}|илова${TAIL}|kirit${TAIL}|record${EW}|enter${EW})`,
  "iu",
);
const CARD = new RegExp(`${BW}(?:карточк${TAIL}|корт${TAIL})`, "iu");
const REPEAT = new RegExp(`${BW}(?:повтор${TAIL}|покаж${TAIL}|показа${TAIL}|снова${EW}|ещё${EW}|еще${EW}|верни${TAIL}|такрор${TAIL}|боз${EW}|нишон${TAIL}|фирист${TAIL}|бифирист${TAIL}|пришли${TAIL}|отправ${TAIL})`, "iu");
/** «Фото» — без «аксар» («большинство»): только сами формы слова «акс». */
const PHOTO = new RegExp(`${BW}(?:фото${TAIL}|снимк${TAIL}|снимок${EW}|скрин${TAIL}|сурат${TAIL}|акс(?:ҳо|и|ро|ҳоро|ҳои)?${EW}|rasm${TAIL}|photos?${EW})`, "iu");
const HERE = new RegExp(`${BW}(?:вот|мана|инак|ана|here)${EW}`, "iu");
/**
 * Слова, которые остаются от «дуруст ворид кун» / «правильно внеси» / «ҳаминро сабт кун»: если после
 * их удаления в коротком сообщении ничего нет, это «запиши то, что уже показано», а не новая просьба.
 */
const FILLER = new RegExp(
  `${BW}(?:дуруст|правильно|верно|пожалуйста|лутфан|ҳамин|ҳаминро|ҳаминҳоро|хамин|хаминро|ин|инро|инҳоро|онро|онҳоро|их|это|эти|всё|все|ҳама|ҳамаашро|ҳамаро|хама|кун|кунед|кунӣ|crm|срм|в|дар|ба|да|ҳа|ха|уже|тез|быстрее|пас|ну)${EW}`,
  "giu",
);

const hasDigits = (text: string) => /\p{N}/u.test(text);

/** В подписи к фото/файлу или в сообщении названо слово «расход» (где угодно, не только в начале). */
export function mentionsExpenses(text: string): boolean {
  return NOUN.test(text);
}

/**
 * Просьба без самих данных — о том, что прислано раньше или будет прислано:
 * - `record` — «ҳамин хароҷотҳоро ворид кун», «внеси эти расходы», «вот фото расходов»;
 * - `card` — «повтори карточку», «кортро боз нишон деҳ»;
 * - `photo` — «мана акс, ворид кун», «вот фото, внеси» (нужен глагол записи; одно «вот фото» — не расходы);
 * - `write` — короткое «дуруст ворид кун», «запиши» без другого предмета.
 * В сообщении с цифрами данных хватает — это не сюда (null), его разбирает список или модель.
 */
export type ExpenseFollowupKind = "record" | "card" | "photo" | "write";

export function expenseFollowupKind(text: string): ExpenseFollowupKind | null {
  const clean = text.trim();
  if (!clean || clean.length > 300 || hasDigits(clean)) return null;
  if (NOUN.test(clean) && (WRITE.test(clean) || HERE.test(clean) || PHOTO.test(clean))) return "record";
  if (CARD.test(clean) && (REPEAT.test(clean) || WRITE.test(clean))) return "card";
  // «Вот фото» без слова «расход» и без глагола записи — не расходы: так присылают фото объекта, переписку,
  // что угодно (ревью волны 2, 22.11.2026). «Мана акс, ворид кун» (с глаголом) — по-прежнему расходы.
  if (PHOTO.test(clean) && WRITE.test(clean)) return "photo";
  if (clean.length <= 60 && WRITE.test(clean)) {
    const rest = clean.replace(new RegExp(WRITE.source, "giu"), " ").replace(FILLER, " ").replace(/[\s.,!?:;—–-]+/gu, "");
    if (!rest) return "write";
  }
  return null;
}
