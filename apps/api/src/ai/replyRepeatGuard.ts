import { mentionsPhoneRequest } from "./replyGuards.js";

/**
 * БОТ ПОВТОРЯЕТСЯ — ПОСЛЕДНИЙ РУБЕЖ ПЕРЕД ОТПРАВКОЙ (разбор 30.08.2026).
 *
 * ЧТО ПОКАЗАЛ ПРОД. За две недели: 17 дословных повторов реплики подряд и 13
 * переспросов уже отвеченного. Механизмы против этого есть и работают — удержание
 * темы (ai/topicLock.ts), `dropRepeatedQuestions` и `isRepeatOfLastReply`
 * (ai/replyGuards.ts), — но каждый смотрит СВОЙ узкий случай: вопрос из прошлых
 * ходов, дословный повтор ПРЕДЫДУЩЕЙ реплики. Повтор через одну реплику или
 * тот же текст с другим эмодзи проходили мимо всех.
 *
 * ЗДЕСЬ — грубая и дешёвая проверка поверх остальных: реплику, совпадающую с
 * любой из трёх последних наших, не отправляем вовсе. Никакого ИИ, одно
 * сравнение строк.
 *
 * ВТОРОЕ, РАДИ ЧЕГО НАПИСАН МОДУЛЬ: СЧЁТЧИК ПРОСЬБ ДАТЬ НОМЕР. Живой случай —
 * бот восемь раз подряд просил телефон у пожилой женщины, которая просто не
 * понимала, чего от неё хотят. Просьбу дописывает и сам код (ensurePhoneAskKept),
 * то есть «попросить ещё раз» происходит даже когда модель этого не делала.
 * После третьей просьбы бот обязан замолчать по этому поводу и позвать человека.
 */

/** Сколько наших последних реплик считаем «недавними». */
const RECENT_BOT_REPLIES = 3;

/** Сколько раз подряд можно попросить номер, прежде чем звать живого сотрудника. */
export const MAX_PHONE_ASKS = 3;

/**
 * Приводим текст к виду, в котором «то же самое» действительно совпадает:
 * регистр, пробелы, знаки препинания и эмодзи различий не создают — человек
 * читает такие две реплики как одну и ту же.
 */
export function normalizeForRepeatCheck(text: string): string {
  return text
    .toLowerCase()
    // Эмодзи и прочие символы вне букв/цифр — в пробел. \p{L}\p{N} с флагом u:
    // таджикская кириллица с диакритикой (ҷ, ӯ, ҳ) обязана остаться буквами.
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * ХОД БОТА ХРАНИТСЯ ОДНОЙ ЗАПИСЬЮ, А СРАВНИВАЕМ МЫ ПУЗЫРЯМИ (найдено 17.09.2026).
 *
 * Ответ бота уходит клиенту двумя сообщениями, а в историю диалога ложится ОДНОЙ
 * строкой через перевод строки (`[reply, reply2].join("\n")` в
 * messengers/conversation.ts). Фильтр же сравнивает КАЖДЫЙ пузырь целиком с
 * КАЖДОЙ сохранённой записью — и «Здравствуйте! Я консультант Royal Home.» никогда
 * не равно «Здравствуйте! Я консультант Royal Home.\nПодскажите, как к Вам
 * обращаться…». То есть на всех двухпузырных ответах защита от дословного повтора
 * не работала вовсе, молча.
 *
 * Живой случай: на «Саломалекм» бот повторил своё прошлое сообщение слово в слово,
 * обоими пузырями.
 *
 * Поэтому сравниваем и с записью целиком, и с каждой её строкой по отдельности.
 */
function expandStoredReplies(stored: string[]): string[] {
  const out: string[] = [];
  for (const entry of stored) {
    for (const piece of [entry, ...entry.split("\n")]) {
      const norm = normalizeForRepeatCheck(piece);
      if (norm.length > 0) out.push(norm);
    }
  }
  return out;
}

/**
 * Убирает пузыри, дословно повторяющие любую из последних реплик бота.
 *
 * @param bubbles что бот собирается отправить этим ходом.
 * @param botSaidBefore все прошлые реплики бота по порядку (последняя — в конце).
 */
export function dropRepeatedBubbles(
  bubbles: string[],
  botSaidBefore: string[],
  /**
   * Тексты, которые повторить НАДО, — исключения из правила.
   *
   * Зачем (поймано полным прогоном 30.08.2026, тест bot-topic-lock). Этот фильтр
   * стоит последним, уже ПОСЛЕ того как код осознанно вернул в ответ реплику,
   * которую клиент проигнорировал: незакрытый вопрос темы (ensureOpenQuestionKept)
   * и уточнение про названного сотрудника (ensureRequestedAgentNoticeKept). Обе по
   * определению звучали раньше — и наивная проверка «уже говорили» вырезала их
   * ровно тогда, когда они и должны прозвучать второй раз. У удержания темы свой
   * предел в три попытки (ai/topicLock.ts, MAX_OPEN_QUESTION_PRESSES), так что
   * бесконечного повтора это исключение не создаёт.
   *
   * Тот же приём уже применён строкой выше в dropRepeatedQuestions, который
   * принимает openQuestion исключением, — здесь он просто доведён до конца.
   */
  keepAnyway: (string | null | undefined)[] = []
): string[] {
  const recent = expandStoredReplies(botSaidBefore.slice(-RECENT_BOT_REPLIES));
  if (recent.length === 0) return bubbles;
  const allowed = new Set(
    keepAnyway.filter((t): t is string => !!t).map(normalizeForRepeatCheck).filter((t) => t.length > 0)
  );
  return bubbles.filter((b) => {
    const norm = normalizeForRepeatCheck(b);
    // Пустое и очень короткое («хуб», «👍») не считаем повтором: там совпадение
    // случайно, а вырезать вежливое согласие хуже, чем повторить его.
    if (norm.length < 12) return true;
    if (allowed.has(norm)) return true;
    return !recent.includes(norm);
  });
}

/** Реплика бота, в которой он просит телефон. */
function asksForPhone(text: string): boolean {
  return text.split(/(?<=[.!?])\s+/u).some((sentence) => {
    if (!mentionsPhoneRequest(sentence)) return false;
    // «Назовите» относится к телефону только при явном дополнении. Просто
    // «номер» может быть номером объекта; телефон в соседней фразе — уже принят.
    const explicitPhoneAsk = /(?<![\p{L}\p{N}])(?:назовите|оставьте|оставите|напишите|напишете|укажите|скажите|скиньте|отправьте|пришлите|дайте)(?:\s*,\s*|\s+)(?:(?:пожалуйста|ваш|вашего|свой|своего|другой|дополнительный|контактный|контактного|мобильный|мобильного|номер)\s*,?\s+){0,4}телефон(?:а)?(?![\p{L}\p{N}])/iu.test(sentence);
    if (explicitPhoneAsk) return true;
    if (/(?:номер|код)\s+(?:объекта|квартиры|публикации)(?![\p{L}\p{N}])/iu.test(sentence)) return false;
    // «гузоред»/«монед»/«партоед» — «оставьте» по-таджикски (28.09.2026).
    return /\?|(?:би)?навис|(?:би)?фирист|(?:би)?ди[ҳх]ед|(?:би)?гузор|(?:би)?монед|партоед|равон\s+кунед|оставьте|оставите|напишите|напишете|укажите|скажите|скиньте|отправьте|пришлите|дайте|nravis|navis|firist|gzor|guzor|monet|moned/iu.test(sentence);
  });
}

/**
 * ОДНА ПРОСЬБА НОМЕРА НА ОТВЕТ (28.09.2026, скриншот владельца).
 *
 * Бот ответил двумя пузырями подряд: «Рақаматонро гузоред, агенти мо занг
 * мезанад» и «Рақаматонро нависед, агенти мо занг зада…». Слова разные, поэтому
 * защита от дословного повтора (dropRepeatedBubbles) их пропускала, а сравнения
 * пузырей одного ответа между собой не было вовсе. Оставляем первую просьбу,
 * следующие убираем; просьба ДОПОЛНИТЕЛЬНОГО номера — другое дело, её не трогаем.
 */
export function keepOnePhoneAsk(bubbles: string[]): string[] {
  let asked = false;
  return bubbles.filter((b) => {
    if (!asksForPhone(b) || asksForAdditionalPhone(b)) return true;
    if (asked) return false;
    asked = true;
    return true;
  });
}

/**
 * Сколько раз бот уже просил номер в этом разговоре.
 *
 * Считаем по ВСЕЙ переписке, а не подряд идущим репликам: восемь просьб из
 * живого случая шли вперемешку с ответами на вопросы клиента, и «подряд» их не
 * посчитал бы никто.
 */
export function countPhoneAsks(botSaidBefore: string[]): number {
  return botSaidBefore.filter(asksForPhone).length;
}

/**
 * Убирает из пузыря только ФРАЗУ с просьбой номера, а не весь пузырь (03.10.2026):
 * «Раҳмат! Шартҳои бартерро низ дар қайд гирифтам. Рақами телефонатонро нависед.»
 * терял вместе с просьбой и полезную первую часть. Пузырь пропадает, только если
 * кроме просьбы в нём ничего не было.
 */
function stripAskSentences(bubbles: string[], isAsk: (sentence: string) => boolean): string[] {
  const out: string[] = [];
  for (const b of bubbles) {
    if (!isAsk(b)) {
      out.push(b);
      continue;
    }
    const kept = b
      .split(/(?<=[.!?])\s+/u)
      .filter((sentence) => !isAsk(sentence))
      .join(" ")
      .trim();
    if (/[\p{L}\p{N}]/u.test(kept)) out.push(kept);
  }
  return out;
}

/** Убирает из ответа просьбы снова дать номер. */
export function dropPhoneAsks(bubbles: string[]): string[] {
  return stripAskSentences(bubbles, asksForPhone);
}

/**
 * Просьба ДОПОЛНИТЕЛЬНОГО/другого номера, а не того же самого (регрессия
 * 22.09.2026, PR #708).
 *
 * clientPhoneKnown в conversation.ts запрещает просить номер повторно, когда он
 * уже лежит в карточке клиента — но «ещё рақами дигаре доред?» после того, как
 * агент назначен, это законная, отдельно защищённая сценой просьба про ВТОРОЙ
 * номер (tests/lead-name-capture.test.ts), а не повтор уже известного. Без этого
 * исключения asksForPhone/dropPhoneAsks не различает их и вырезает пузырь
 * целиком, роняя весь ответ бота (shouldReply: false).
 */
function asksForAdditionalPhone(text: string): boolean {
  if (!asksForPhone(text)) return false;
  return /ещё|дополнительн|другой|другие|боз|дигар|яна/iu.test(text);
}

/**
 * Убирает из ответа пузыри, просящие ТОТ ЖЕ номер, что уже есть в карточке
 * клиента, — но оставляет просьбу дать дополнительный/другой номер (см.
 * asksForAdditionalPhone выше). В отличие от dropPhoneAsks, которая режет любую
 * просьбу подряд после MAX_PHONE_ASKS и остаётся без изменений.
 */
export function dropKnownPhoneAsks(bubbles: string[]): string[] {
  return stripAskSentences(bubbles, (t) => asksForPhone(t) && !asksForAdditionalPhone(t));
}

/**
 * Сколько просьб дать номер в ЭТОЙ пачке пузырей — то, что нужно прибавить к
 * хранимому счётчику после отправки ответа.
 */
export function countPhoneAsksIn(bubbles: string[]): number {
  return bubbles.filter(asksForPhone).length;
}

/**
 * СКОЛЬКО РАЗ БОТ ПРОСИЛ НОМЕР — ЧЕСТНО, А НЕ ПО ОБРЕЗАННОЙ ЛЕНТЕ.
 *
 * countPhoneAsks считает по хранимой переписке, а она обрезана до
 * MAX_STORED_MESSAGES (40, messengers/appendMessages.ts). В длинном разговоре
 * ранние просьбы из ленты ВЫПАДАЮТ, счёт опускается ниже MAX_PHONE_ASKS, и бот
 * принимается просить номер заново — та самая навязчивость, против которой
 * предел и ставили (владелец 30.08.2026). В выгрузке 775 живых переписок
 * (20.09.2026) у одного лида набралось восемь просьб.
 *
 * Берём БОЛЬШЕЕ из хранимого счётчика и подсчёта по ленте, а не просто счётчик:
 * у разговоров, начатых до появления колонки, счётчик равен нулю, и поведение
 * для них не должно измениться. Лента же, пока она не обрезана, даёт тот же
 * ответ, что и счётчик, — расходятся они только там, где раньше терялся счёт.
 */
export function effectivePhoneAsks(storedCount: number, botSaidBefore: string[]): number {
  return Math.max(storedCount, countPhoneAsks(botSaidBefore));
}

/**
 * ТРЕТЬЕ, РАДИ ЧЕГО РАСШИРЕН МОДУЛЬ: СЧЁТЧИК «ВИДЕО НЕ ОТКРЫЛОСЬ» (разбор
 * 30.08.2026). Живой лид «Муродали»: за несколько дней подряд четыре чужих
 * рилса — замок, певец, стоматолог, борьба — и ни разу ни единого слова к
 * пересылке. Каждый раз бот честно отвечал заново одной и той же по смыслу
 * фразой (см. messengers/sharedMedia.ts, buildNote, ветка `isShare`):
 * «Ин видео дар ман кушода нашуд. Шумо чунин хона мекобед? Чандхонага?» —
 * известный приём накрутки просмотров/комментариев, только БЕЗ слова «лайк»
 * или «подпишись», которое ловит detectSpam (lib/incomingSpam.ts).
 *
 * detectSpam НАРОЧНО не отсекает голую пересылку без слов на одном сообщении —
 * она неотличима от горячего лида, который просто не подписал видео словами
 * (см. комментарий в detectSpam). Отличает их только ПОВТОР: настоящий лид
 * рано или поздно либо получает совпадение по объекту, либо отвечает на вопрос
 * бота словами — а накрутчик присылает ролик за роликом и не отвечает никогда.
 *
 * Форма счётчика та же, что и у просьбы телефона выше: считаем по ВСЕЙ
 * переписке, а не подряд идущим репликам. ПОРОГ — НАРОЧНО НИЖЕ, чем
 * MAX_PHONE_ASKS (требование владельца 30.08.2026: «усилить надо защиту от
 * спамеров... бот бедный сидит и отвечает всем»). Это разные вещи:
 * MAX_PHONE_ASKS считает СОБСТВЕННУЮ навязчивость бота (спросить один и тот же
 * вопрос трижды — уже перебор для живого разговора), а здесь считаем, сколько
 * раз подряд ЧУЖОЕ, ничем не подписанное видео имеет право остаться
 * неопознанным, прежде чем это перестаёт быть похоже на живого человека.
 * Настоящий горячий лид, скидывающий НАШИ ролики, находится по коду публикации
 * (findSharedProperty) с первой-второй попытки — findSharedProperty матчит по
 * прямой ссылке, по подписи и по номеру карточки, и почти всегда срабатывает
 * сразу. Третье подряд «не открылось» без единого слова между ними — это уже
 * не совпадение с плохо заполненной карточкой, а рассылка роликов веером.
 */

/** Сколько раз можно ответить «видео не открылось», прежде чем перестать
 *  повторяться на каждую новую пересылку того же самого. Ниже, чем
 *  MAX_PHONE_ASKS, — см. комментарий выше. */
export const MAX_UNRESOLVED_SHARE_REPLIES = 2;

/**
 * Реплика бота похожа на извинение «видео не открылось» — по-русски и по-
 * таджикски, теми же словами, что подсказка в sharedMedia.ts предлагает
 * модели. Ищем корень, а не фразу целиком: модель переформулирует каждый раз
 * по-своему (та же оговорка, что у PHONE_REQUEST выше).
 */
function isUnresolvedShareReply(text: string): boolean {
  return /кушода\s*нашуд|видео[^.!?\n]{0,60}не\s*(открыл|показыва)/iu.test(text);
}

/** Сколько раз бот уже извинился, что пересланное видео не открылось, — по
 *  ВСЕЙ переписке, тем же приёмом, что countPhoneAsks. */
export function countUnresolvedShareReplies(botSaidBefore: string[]): number {
  return botSaidBefore.filter(isUnresolvedShareReply).length;
}

/**
 * ПОВТОР СМЫСЛОМ, А НЕ БУКВОЙ (03.10.2026, живые сбои в Instagram и WhatsApp).
 *
 * dropRepeatedBubbles выше ловит только дословный повтор. Живые случаи прошли
 * мимо него: клиент дал номер, бот ответил «Маълумотро ба агент додам, ба зудӣ
 * занг зада…», а следом ещё тремя пузырями пересказал то же обещание другими
 * словами («агенти мо ба зудӣ … занг мезанад», «тавассути WhatsApp хабар
 * медиҳад»); в другом диалоге повтор отличался от прошлой реплики только
 * приветствием «Ваалейкум ассалом!»; в третьем один ответ задал два почти
 * одинаковых вопроса подряд. Для человека всё это — спам.
 *
 * Три правила, все по ФРАЗАМ, а не по пузырям целиком: полезная часть пузыря
 * («Бале, маҳз ҳамин хона») остаётся, уходит только повтор.
 *  1. Обещание «агент позвонит / передал агенту» — одно на разговор: если оно уже
 *     звучало в трёх последних репликах или раньше в этом же ответе, второе не
 *     уходит. Исключение — клиент сам спросил про звонок («когда позвонят?»).
 *  2. Фраза (не вопрос), совпадающая с недавней репликой по словам (приветствие,
 *     имя и знаки не в счёт), — повтор.
 *  3. Второй вопрос того же ответа, почти совпадающий с первым по словам, — лишний.
 */
const HANDOFF_PROMISE =
  /ба\s+агент\S*\s+(?:до?д|супор|расон)|агент\S*\s+(?:мо\s+)?[^.!?\n]{0,60}(?:занг|тамос|хабар\s+меди|позвон|свяж|перезвон)|передал\S*\s+[^.!?\n]{0,20}агент|заявк\S*\s+(?:принят|передан)|дархост\S*\s+қабул/iu;

/** Клиент сам спросил про звонок или агента — тогда повторить обещание можно. */
const ASKS_ABOUT_CALL =
  /(?:когда|кай|кто|кӣ|чи\s+вақт|чанд\s+соат)[^.!?\n]{0,40}(?:позвон|звон|занг|свяж|агент)|(?:позвон|звон|занг|свяж|агент)[^.!?\n]{0,40}(?:когда|кай|\?)/iu;

const FILLER_WORDS = new Set([
  "бале", "ҳа", "ха", "хуб", "фаҳмидам", "фахмидам", "мефаҳмам", "рахмат", "раҳмат", "ташаккур", "ок", "окей",
  "да", "хорошо", "понял", "поняла", "понятно", "спасибо", "ладно", "отлично", "ассалому", "ассалом", "алейкум",
  "ваалейкум", "салом", "здравствуйте", "привет",
]);

function contentWords(text: string): string[] {
  return normalizeForRepeatCheck(text)
    .split(" ")
    .filter((w) => w.length >= 3 && !FILLER_WORDS.has(w));
}

/** Доля общих слов. `by: "max"` — похожи целиком; `"min"` — короткая почти вся внутри длинной. */
function overlap(a: string[], b: string[], by: "max" | "min"): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  const common = [...setA].filter((w) => setB.has(w)).length;
  return common / (by === "max" ? Math.max(setA.size, setB.size) : Math.min(setA.size, setB.size));
}

function sentencesOf(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Остались одни «Бале, фаҳмидам» — такой пузырь сам по себе ничего не говорит. */
function fillerOnly(text: string): boolean {
  const words = normalizeForRepeatCheck(text).split(" ").filter(Boolean);
  return words.every((w) => FILLER_WORDS.has(w) || w.length < 3);
}

export function dropNearRepeats(
  bubbles: string[],
  botSaidBefore: string[],
  opts: { clientTurnText?: string; keepAnyway?: (string | null | undefined)[] } = {}
): string[] {
  const keep = new Set(
    (opts.keepAnyway ?? []).filter((t): t is string => !!t).map(normalizeForRepeatCheck).filter(Boolean)
  );
  const recentSentences = botSaidBefore.slice(-RECENT_BOT_REPLIES).flatMap(sentencesOf);
  const promiseAllowed = Boolean(opts.clientTurnText && ASKS_ABOUT_CALL.test(opts.clientTurnText));
  let promiseSaid = recentSentences.some((s) => HANDOFF_PROMISE.test(s));
  const askedNow: string[][] = [];
  const out: string[] = [];
  for (const bubble of bubbles) {
    if (keep.has(normalizeForRepeatCheck(bubble))) {
      out.push(bubble);
      continue;
    }
    const kept: string[] = [];
    for (const sentence of sentencesOf(bubble)) {
      if (keep.has(normalizeForRepeatCheck(sentence))) {
        kept.push(sentence);
        continue;
      }
      const words = contentWords(sentence);
      if (HANDOFF_PROMISE.test(sentence)) {
        if (promiseSaid && !promiseAllowed) continue;
        promiseSaid = true;
      }
      // Вопросы сюда не идут: повтор незакрытого вопроса решают удержание темы и
      // dropRepeatedQuestions со своими исключениями (ai/topicLock.ts).
      if (
        !/\?/.test(sentence) &&
        words.length >= 4 &&
        recentSentences.some((r) => overlap(words, contentWords(r), "max") >= 0.75)
      )
        continue;
      if (/\?/.test(sentence) && words.length >= 3) {
        if (askedNow.some((q) => overlap(words, q, "min") >= 0.6)) continue;
        askedNow.push(words);
      }
      kept.push(sentence);
    }
    const text = kept.join(" ").trim();
    if (!text) continue;
    // Пузырь целиком из вежливых слов, а его суть ушла как повтор, — не отправляем.
    if (kept.length < sentencesOf(bubble).length && fillerOnly(text)) continue;
    out.push(kept.length === sentencesOf(bubble).length ? bubble : text);
  }
  return out;
}
