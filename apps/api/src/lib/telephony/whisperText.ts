import { createHash } from "node:crypto";
import { dushanbeDayRange } from "../dushanbeTime.js";
import { isPlaceholderName } from "../placeholderName.js";

/**
 * ЧТО АГЕНТ УСЛЫШИТ В УХО ПЕРЕД СОЕДИНЕНИЕМ — сборка фразы из полей карточки.
 *
 * Идея владельца 20.08.2026: «агент ответил на звонок, но даже не знает, с кем
 * общается». Станция играет ему короткую справку о звонящем, клиент её не слышит.
 *
 * ТРИ ПРАВИЛА, ИЗ КОТОРЫХ ВЫРОС ЭТОТ ФАЙЛ.
 *
 * 1. ИМЯ ПЕРВЫМ, ВСЕГДА. Агент мог отвлечься и услышать только начало фразы —
 *    и тогда услышать он должен имя, а не слово «входящий». По той же причине на
 *    входящих нет метки направления: у человека звонит трубка, он и так знает, что
 *    ему звонят. На исходящих метка, наоборот, полезна — звонок мог уйти из списка
 *    задач, и человек уже забыл, кого набрал.
 *
 * 2. КОРОТКО. Пока играет подсказка, ЖИВОЙ КЛИЕНТ СЛУШАЕТ ГУДКИ. Две-три секунды он
 *    не заметит, шесть — решит, что трубку не берут, и положит. Поэтому состав фразы
 *    настраивается (Settings.callWhisper*Parts), а рядом с настройкой в интерфейсе
 *    показывается длительность: настройка, отъедающая время у клиента, обязана
 *    показывать, сколько именно она отъедает.
 *
 * 3. НИКАКИХ ДОГАДОК. Всё, кроме aiHint, собирается из полей карточки и соврать не
 *    может. Устаревшая подсказка хуже отсутствующей: услышав «фурӯшанда» у человека,
 *    который сегодня покупает, агент войдёт в разговор уверенно и неправильно —
 *    поэтому у каждой озвученной фразы есть отпечаток исходных данных (whisperDigest),
 *    и при любом расхождении файл переозвучивается.
 */

/** Язык того, КОМУ играем (сотрудника), а не клиента. */
export type WhisperLanguage = "tg" | "ru";
/** "in" — клиент звонит нам, "out" — мы звоним клиенту. */
export type WhisperDirection = "in" | "out";

/**
 * Блоки, из которых собирается фраза. Владелец выбирает состав в Настройках, а
 * порядок фиксирован здесь — переставлять его в настройках означало бы дать
 * возможность собрать фразу, начинающуюся не с имени (см. правило 1 выше).
 */
export const WHISPER_PARTS = ["label", "name", "role", "anchor", "budget", "promise", "recency", "aiHint"] as const;
export type WhisperPart = (typeof WHISPER_PARTS)[number];

export function isWhisperPart(value: string): value is WhisperPart {
  return (WHISPER_PARTS as readonly string[]).includes(value);
}

/** Данные карточки в том виде, в каком их видит фраза. Ничего лишнего сюда не кладём:
 *  всё, что попадёт в этот объект, попадёт и на диск АТС в виде звука. */
export interface WhisperSource {
  fullName: string;
  kind: "BUYER" | "SELLER" | "OTHER";
  /** Тип жилья, который ищет покупатель (или которое продаёт продавец). */
  propertyType: "APARTMENT" | "HOUSE" | "COMMERCIAL" | "LAND" | null;
  /** Название района — имя собственное, произносится как есть на любом языке. */
  districtName: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  currency: "USD" | "TJS";
  /** Когда с клиентом последний раз общались (звонок, встреча, переписка). */
  lastContactAt: Date | null;
  /** Незакрытая договорённость: на какую дату обещан следующий шаг. */
  promisedAt: Date | null;
  /** Зацепка от ИИ по истории — короткая фраза уже на нужном языке либо null. */
  aiHint: string | null;
}

interface Dictionary {
  outgoingLabel: string;
  roles: Record<WhisperSource["kind"], string | null>;
  propertyTypes: Record<NonNullable<WhisperSource["propertyType"]>, string>;
  /** «манзил ДАР Сомонӣ» — предлог места. */
  inDistrict: (type: string | null, district: string) => string;
  thousands: (value: number, currency: WhisperSource["currency"]) => string;
  budgetUpTo: (amount: string) => string;
  budgetRange: (from: string, to: string) => string;
  promise: (day: string) => string;
  recency: (day: string) => string;
  /** Относительные дни. Дальше двух недель точность не нужна — важен сам факт «давно». */
  today: string;
  yesterday: string;
  tomorrow: string;
  daysAgo: (n: number) => string;
  daysAhead: (n: number) => string;
  weekAgo: string;
  monthAgo: string;
  longAgo: string;
  /** Чем заменить имя, которого на самом деле нет (заглушка карточки, номер). */
  unknownCaller: string;
  /** Просьба к сотруднику спросить имя — звучит последней, когда имени нет. */
  askName: string;
}

const DICTIONARIES: Record<WhisperLanguage, Dictionary> = {
  tg: {
    outgoingLabel: "Занги баромад",
    roles: { BUYER: "харидор", SELLER: "фурӯшанда", OTHER: null },
    propertyTypes: { APARTMENT: "манзил", HOUSE: "ҳавлӣ", COMMERCIAL: "тиҷоратӣ", LAND: "замин" },
    inDistrict: (type, district) => (type ? `${type} дар ${district}` : `ноҳияи ${district}`),
    thousands: (value, currency) => `${value} ҳазор ${currency === "USD" ? "доллар" : "сомонӣ"}`,
    budgetUpTo: (amount) => `то ${amount}`,
    budgetRange: (from, to) => `аз ${from} то ${to}`,
    promise: (day) => `ваъда: ${day}`,
    recency: (day) => `сӯҳбати охирин: ${day}`,
    today: "имрӯз",
    yesterday: "дирӯз",
    tomorrow: "пагоҳ",
    daysAgo: (n) => `${n} рӯз пеш`,
    daysAhead: (n) => `баъди ${n} рӯз`,
    weekAgo: "як ҳафта пеш",
    monthAgo: "як моҳ пеш",
    longAgo: "кайҳо",
    unknownCaller: "мизоҷи нав",
    askName: "номашро пурсед",
  },
  ru: {
    outgoingLabel: "Исходящий",
    roles: { BUYER: "покупатель", SELLER: "продавец", OTHER: null },
    propertyTypes: { APARTMENT: "квартира", HOUSE: "дом", COMMERCIAL: "коммерция", LAND: "участок" },
    inDistrict: (type, district) => (type ? `${type} в районе ${district}` : `район ${district}`),
    thousands: (value, currency) => `${value} тысяч ${currency === "USD" ? "долларов" : "сомони"}`,
    budgetUpTo: (amount) => `до ${amount}`,
    budgetRange: (from, to) => `от ${from} до ${to}`,
    promise: (day) => `обещание: ${day}`,
    recency: (day) => `последний разговор: ${day}`,
    today: "сегодня",
    yesterday: "вчера",
    tomorrow: "завтра",
    daysAgo: (n) => `${n} дня назад`,
    daysAhead: (n) => `через ${n} дня`,
    weekAgo: "неделю назад",
    monthAgo: "месяц назад",
    longAgo: "давно",
    unknownCaller: "новый клиент",
    askName: "спросите имя",
  },
};

/**
 * Сколько дней между датой и «сегодня» ПО ДУШАНБЕ. Контейнер живёт в UTC, и наивная
 * разница в миллисекундах называла бы вчерашний вечерний звонок сегодняшним ровно до
 * пяти утра — см. lib/dushanbeTime.ts.
 */
function dayDistance(date: Date, now: Date): number {
  const a = dushanbeDayRange(date).start.getTime();
  const b = dushanbeDayRange(now).start.getTime();
  return Math.round((a - b) / 86_400_000);
}

/** «дирӯз», «як ҳафта пеш» — человеческая давность вместо даты. */
function relativeDay(date: Date, now: Date, dict: Dictionary): string {
  const diff = dayDistance(date, now);
  if (diff === 0) return dict.today;
  if (diff === -1) return dict.yesterday;
  if (diff === 1) return dict.tomorrow;
  if (diff > 1) return diff <= 14 ? dict.daysAhead(diff) : dict.longAgo;
  const ago = -diff;
  if (ago <= 6) return dict.daysAgo(ago);
  if (ago <= 13) return dict.weekAgo;
  if (ago <= 45) return dict.monthAgo;
  return dict.longAgo;
}

/** Бюджет округляется до тысяч: «сто пятьдесят две тысячи триста» вслух — это лишние
 *  полторы секунды, за которые клиент успевает положить трубку. */
function budgetPhrase(src: WhisperSource, dict: Dictionary): string | null {
  const toThousands = (value: number) => Math.round(value / 1000);
  const min = src.budgetMin && src.budgetMin > 0 ? toThousands(src.budgetMin) : null;
  const max = src.budgetMax && src.budgetMax > 0 ? toThousands(src.budgetMax) : null;
  if (max && min && min !== max) return dict.budgetRange(String(min), dict.thousands(max, src.currency));
  const single = max ?? min;
  if (!single) return null;
  return dict.budgetUpTo(dict.thousands(single, src.currency));
}

/** Объект-зацепка: то, чем этот клиент отличается от остальных в памяти агента. */
function anchorPhrase(src: WhisperSource, dict: Dictionary): string | null {
  const type = src.propertyType ? dict.propertyTypes[src.propertyType] : null;
  if (src.districtName) return dict.inDistrict(type, src.districtName);
  return type;
}

/**
 * ИМЯ ЛИ ЭТО ВООБЩЕ.
 *
 * Найдено на живых данных 20.08.2026, в первый же час после включения: агенту
 * зачитывалось «Входящий. фурӯшанда. манзил дар Исмоили Сомонӣ». «Входящий» —
 * не имя, а заглушка, которой CRM называет карточку, заведённую автоматически по
 * звонку с незнакомого номера (`Входящий +992…`, см. autoLeadFromCall.ts). Пока
 * человек не назвался, имени у карточки нет, и произносить эту заглушку — значит
 * говорить агенту заведомую чепуху с уверенной интонацией.
 *
 * Возвращаем вместо неё честное «новый номер»: агент слышит ровно то, что есть.
 */
function spokenName(fullName: string, dict: Dictionary): string | null {
  const name = fullName.trim();
  if (!name) return null;
  // Общий признак заглушки на весь проект (lib/placeholderName.ts): он знает и про
  // «Входящий ***67», и про «Покупатель №42» бота, и про «Клиент Instagram», и про
  // ник вместо имени. Список ниже оставлен как второй рубеж — он ловит заглушку,
  // за которой идут ещё слова («Покупатель Умед»).
  if (isPlaceholderName(name)) return dict.unknownCaller;
  const first = name.split(/\s+/)[0];
  // Заглушки CRM и просто номер вместо имени: цифры вслух — потерянные секунды.
  // «Покупатель»/«продавец» именем — живой случай с прода 20.08: карточка заведена
  // руками без имени, и фраза выходила «Покупатель. харидор» — роль дважды.
  if (/^(входящ|клиент|неизвестн|покупатель|продавец|харидор|фурӯшанда|unknown|no ?name)/i.test(first)) {
    return dict.unknownCaller;
  }
  if (/^[\d+()\-\s]+$/.test(first)) return dict.unknownCaller;

  /**
   * ИМЯ БЕЗ ЕДИНОЙ БУКВЫ — НЕ ИМЯ. Живой случай 21.08.2026: у клиента из Instagram
   * в имени стоял значок «🎓», и синтез потратил на него 3,6 секунды — он честно
   * попытался прочитать картинку словами. Агент услышал бы вместо имени описание
   * эмодзи, а квота ушла бы в никуда.
   *
   * Значки убираем и из нормальных имён тоже («Фаррух 🏠» → «Фаррух»): в Instagram
   * их лепят к имени постоянно, а вслух они всегда лишние.
   */
  const letters = first.replace(/[^\p{L}\p{M}'`-]/gu, "").trim();
  if (!letters) return dict.unknownCaller;
  return letters;
}

/**
 * ЧТО СИНТЕЗ РЕЧИ НЕ ПРОЧИТАЕТ В ПРИНЦИПЕ — отсеиваем ДО отправки в модель.
 *
 * Найдено в журнале прода 22.08.2026: сотни записей «Синтез речи не вернул звук для
 * куска» на кусках «🎓», «@nozil760», «raxxmanzadee», «nozil». Это не сбой модели —
 * это мусор на входе. Имя в карточке приходит из Instagram, а там вместо имени часто
 * стоит ник (@nozil760) или логин строчными латиницей (raxxmanzadee). Модель просит
 * читать по-таджикски и на такой строке честно возвращает молчание, а мы записывали
 * это в журнал как поломку и на каждом проходе крона (раз в пять минут) тратили на
 * неё запрос из суточной квоты — по кругу, вечно.
 *
 * ЧТО ИМЕННО ОТСЕИВАЕМ (и почему не больше):
 *  - кусок без единой буквы: одни значки, цифры или знаки препинания;
 *  - ник: строка, начинающаяся с «@»;
 *  - логин латиницей: одно слово латиницей БЕЗ заглавной — так пишут ники, а имена
 *    люди пишут с заглавной.
 *
 * Латиницу с заглавной НЕ ТРОГАЕМ намеренно: «Hokimshoh», «Alex», «Mercedes-Benz» —
 * это настоящие имена и марки, и решать за модель, что она их не осилит, мы не вправе.
 */
const LATIN_LOGIN = /^[a-z][a-z0-9._-]*$/;

export function isSpeakablePiece(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (!/\p{L}/u.test(value)) return false;
  if (value.startsWith("@")) return false;
  return !LATIN_LOGIN.test(value);
}

/**
 * Значки из свободного текста (зацепка от ИИ). В имени их убирает spokenName, а зацепку
 * ИИ пишет сам и вполне может вставить «🏠» — вслух это всегда лишнее и стоит секунд.
 */
function stripSymbols(text: string): string {
  return text.replace(/[^\p{L}\p{M}\p{N}\s.,:;!?«»"'()\-+]/gu, " ").replace(/\s+/g, " ").trim();
}

export interface WhisperTextOptions {
  language: WhisperLanguage;
  direction: WhisperDirection;
  /** Состав фразы; неизвестные значения молча игнорируются — настройка из будущей
   *  версии не должна ронять звонок в сегодняшней. */
  parts: readonly string[];
  /** Подставляется в тестах; в бою — текущее время. */
  now?: Date;
}

/**
 * Собрать фразу. Пустая строка означает «озвучивать нечего» — например, у клиента нет
 * ни имени, ни вида: тогда файл не создаётся вовсе и агент просто не слышит подсказки.
 */
export function buildWhisperText(src: WhisperSource, opts: WhisperTextOptions): string {
  const dict = DICTIONARIES[opts.language];
  const now = opts.now ?? new Date();
  const wanted = new Set(opts.parts.filter(isWhisperPart));
  const chunks: string[] = [];

  // Метка направления только на исходящих: на входящих она отнимает первую — самую
  // ценную — секунду у имени (см. правило 1 в шапке файла).
  if (wanted.has("label") && opts.direction === "out") chunks.push(dict.outgoingLabel);

  /**
   * «СПРОСИТЕ ИМЯ» — ПОДСКАЗКА СОТРУДНИКУ, КОГДА ИМЕНИ У КАРТОЧКИ НЕТ (30.08.2026).
   *
   * Жалоба владельца: «некоторые клиенты дают своё имя, а ИИ не вставляет имя в
   * карточку», и отдельным пунктом — чтобы имя спрашивали И ПО ТЕЛЕФОНУ. Голосового
   * бота у нас нет и не предвидится: с человеком по телефону говорит человек. Значит
   * спросить имя может только он — а для этого он должен знать, что имени нет.
   *
   * Просьба звучит ПОСЛЕДНЕЙ и только вместе с блоком имени: первая секунда
   * принадлежит имени (правило 1 в шапке файла), а тут его как раз нет — но и начинать
   * подсказку с указания сотруднику, что ему делать, значит отодвинуть всё остальное.
   */
  let nameUnknown = false;

  if (wanted.has("name")) {
    const spoken = spokenName(src.fullName, dict);
    nameUnknown = !spoken || spoken === dict.unknownCaller;
    // Только первое слово: «Фаррух Раҳимов Абдуллоевич» вслух — три секунды, и по
    // имени-отчеству клиента в агентстве всё равно никто не зовёт.
    if (spoken) chunks.push(spoken);
  }

  if (wanted.has("role")) {
    const role = dict.roles[src.kind];
    if (role) chunks.push(role);
  }

  if (wanted.has("anchor")) {
    const anchor = anchorPhrase(src, dict);
    if (anchor) chunks.push(anchor);
  }

  if (wanted.has("budget")) {
    const budget = budgetPhrase(src, dict);
    if (budget) chunks.push(budget);
  }

  // Договорённость — только пока она жива: обещание, просроченное на месяц, агенту
  // уже ничего не подсказывает, а время звучания отнимает.
  if (wanted.has("promise") && src.promisedAt) {
    const diff = dayDistance(src.promisedAt, now);
    if (diff >= -7 && diff <= 14) chunks.push(dict.promise(relativeDay(src.promisedAt, now, dict)));
  }

  if (wanted.has("recency") && src.lastContactAt) {
    chunks.push(dict.recency(relativeDay(src.lastContactAt, now, dict)));
  }

  if (wanted.has("aiHint") && src.aiHint) {
    const hint = stripSymbols(src.aiHint);
    if (hint) chunks.push(hint);
  }

  // Только если есть что сказать и кроме просьбы: фраза, состоящая из одного
  // «спросите имя», — это указание сотруднику вместо справки о звонящем, и ради него
  // одного отнимать у клиента секунды гудков (правило 2 в шапке) не за что.
  if (nameUnknown && chunks.length > 0) chunks.push(dict.askName);

  // Точка между кусками — не пунктуация ради пунктуации: синтез речи делает на ней
  // паузу, и агент слышит «Фаррух · харидор · манзил», а не слитную скороговорку.
  // Неозвучиваемые куски (ник, логин, одни значки) выбрасываются здесь, а не в
  // синтезе: фраза в Настройках обязана показывать ровно то, что услышит агент.
  return chunks.filter(isSpeakablePiece).join(". ");
}

/**
 * Те же куски фразы, но списком — для сборки файла из отдельно озвученных частей
 * (lib/telephony/whisperClips.ts).
 *
 * Почему рядом с buildWhisperText, а не вместо него: текст целиком нужен человеку —
 * он показывается в Настройках и хранится в базе как «что услышит агент». Список
 * нужен машине. Обе формы обязаны совпадать по составу, поэтому собираются одним
 * кодом: buildWhisperText — это те же части, склеенные точками.
 */
export function buildWhisperParts(src: WhisperSource, opts: WhisperTextOptions): string[] {
  const text = buildWhisperText(src, opts);
  return text ? text.split(". ").filter(Boolean) : [];
}

/**
 * Отпечаток данных, из которых собрана фраза. Совпал — озвучивать заново нечего.
 *
 * В отпечаток входят И НАСТРОЙКИ (состав блоков, язык, голос): сменил владелец голос
 * или добавил бюджет в состав — все файлы обязаны переозвучиться, иначе настройка
 * подействует только на новых клиентов, а на старых будет тихо игнорироваться.
 *
 * Даты округляются до дня: иначе отпечаток менялся бы каждую секунду («последний
 * разговор» считается от текущего времени), и агентство переозвучивало бы всю базу
 * каждый прогон крона.
 */
/**
 * Версия ПРАВИЛ сборки фразы. Меняется, когда меняется сам текст при тех же данных
 * карточки, — и тогда вся база переозвучивается.
 *
 * Без неё правка правил не действует на уже озвученных клиентов: отпечаток считается
 * от полей карточки, а поля не изменились. Ровно так 20.08.2026 «Входящий» продолжал
 * бы звучать именем клиента и после того, как это починили.
 *
 * 2 — заглушки вместо имени («Входящий +992…», голый номер) больше не произносятся.
 * 3 — к заглушкам добавлены «Покупатель»/«продавец» именем (роль звучала дважды).
 * 4 — вместо «новый номер» звучит «новый клиент» / «мизоҷи нав» (владелец 20.08.2026:
 *     агенту важен человек, а не номер).
 * 5 — значки в имени («🎓», «Фаррух 🏠») не читаются вслух: синтез описывал картинку
 *     словами и тратил на это секунды и квоту.
 * 6 — неозвучиваемые куски (ник «@nozil760», логин «raxxmanzadee», одни значки в
 *     зацепке ИИ) выбрасываются из фразы: модель на них молчит, а мы на каждом
 *     проходе крона тратили на них запрос из квоты (журнал прода 22.08.2026).
 * 7 — у карточки без имени фраза заканчивается просьбой «спросите имя», и признак
 *     заглушки взят общий (lib/placeholderName.ts): «Покупатель №42» и «Клиент
 *     Instagram» раньше зачитывались агенту как настоящее имя клиента.
 */
const TEXT_RULES_VERSION = 7;

export function whisperDigest(src: WhisperSource, opts: WhisperTextOptions & { voice: string }): string {
  const day = (date: Date | null) => (date ? dushanbeDayRange(date).start.toISOString().slice(0, 10) : null);
  // ОТНОСИТЕЛЬНЫЕ СРОКИ ЗАВИСЯТ ОТ СЕГОДНЯШНЕГО ДНЯ (CHANNEL-NEW-24, 04.10.2026): даты
  // фактов не меняются, а «сегодня» назавтра становится «вчера». В отпечаток кладём
  // саму произносимую фразу срока (как её собирает buildWhisperText): пока она та же
  // («давно», «неделю назад»), переозвучки нет, как только сменилась — подсказка
  // пересобирается. Блок, которого нет в составе фразы, на отпечаток не влияет.
  const dict = DICTIONARIES[opts.language];
  const now = opts.now ?? new Date();
  const wanted = new Set(opts.parts.filter(isWhisperPart));
  const promiseDiff = src.promisedAt ? dayDistance(src.promisedAt, now) : null;
  const promisedSpoken =
    wanted.has("promise") && src.promisedAt && promiseDiff !== null && promiseDiff >= -7 && promiseDiff <= 14
      ? relativeDay(src.promisedAt, now, dict)
      : null;
  const lastContactSpoken = wanted.has("recency") && src.lastContactAt ? relativeDay(src.lastContactAt, now, dict) : null;
  const payload = JSON.stringify({
    name: src.fullName,
    kind: src.kind,
    propertyType: src.propertyType,
    district: src.districtName,
    budgetMin: src.budgetMin,
    budgetMax: src.budgetMax,
    currency: src.currency,
    lastContact: day(src.lastContactAt),
    promised: day(src.promisedAt),
    lastContactSpoken,
    promisedSpoken,
    aiHint: src.aiHint,
    language: opts.language,
    direction: opts.direction,
    voice: opts.voice,
    parts: [...opts.parts].filter(isWhisperPart).sort(),
    rules: TEXT_RULES_VERSION,
  });
  return createHash("sha1").update(payload).digest("hex");
}

/**
 * На каком языке играть подсказку конкретному сотруднику. null — не играть вовсе:
 * либо человек отказался («off»), либо возможность выключена в агентстве.
 */
export function resolveWhisperLanguage(
  agentLanguage: string | null | undefined,
  agencyLanguage: string
): WhisperLanguage | null {
  const value = agentLanguage ?? agencyLanguage;
  if (value === "off") return null;
  return value === "ru" ? "ru" : "tg";
}
