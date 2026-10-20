/**
 * НОРМАЛИЗАЦИЯ ТЕЛЕФОНА КАНДИДАТА (найдено 04.09.2026 полным обходом раздела
 * «Вакансии» — «зайди глубоко в код, ищи баги»).
 *
 * ЧТО БЫЛО НЕ ТАК. `parseJobApplication` (ai/jobApplication.ts) брало поле phone
 * из ответа модели БЕЗ ПРОВЕРКИ — просто обрезало до 40 символов. Для обычных
 * лидов (buy/sell/rent) модели номер вообще не доверяют: код достаёт его сам,
 * прямо из текста клиента (extractTypedPhone в ai/leadQualifier.ts), и это не
 * прихоть — этому предшествовали настоящие потери номеров (разбор 03.09.2026,
 * «потерянные лиды»: 030001023 из четырёх присланных подряд, "0937001122" без
 * ведущего нуля и т.д. — каждая строка там написана по следам конкретного
 * пропавшего клиента). У кандидата на вакансию телефон теперь — ЕДИНСТВЕННОЕ
 * поле, которое решает, попадёт ли анкета в очередь вообще (`HAS_PHONE` в
 * routes/vacancies.ts, решение владельца 03.09.2026) — здесь цена доверия
 * модели голому тексту выше, чем где-либо ещё в этом разделе.
 *
 * Без проверки: кандидат, который в ответ на просьбу о номере написал «оставлю
 * попозже», получал `phone: "оставлю попозже"` — непустую строку, которая
 * проходит HAS_PHONE, светит кнопкой `tel:оставлю попозже` и молча выпадает из
 * автоматической просьбы позвонить снова (lib/askCandidatePhone.ts берёт только
 * `phone IS NULL OR phone = ''`). Кандидат навсегда «с телефоном», по которому
 * нельзя позвонить.
 *
 * ПОЧЕМУ СВОЙ РАЗБОР, А НЕ ИМПОРТ extractTypedPhone. ai/leadQualifier.ts сам
 * импортирует parseJobApplication из ai/jobApplication.ts — обратный импорт
 * замкнул бы эти два модуля друг на друга. Заводить ради одной функции общий
 * модуль и трогать код обычных лидов, закалённый реальными инцидентами, — риска
 * больше, чем пользы для узкой правки одного раздела. Поэтому строгие форматы
 * ниже — намеренный ПОВТОР strictPhone/normalizeDigits из leadQualifier.ts, а не
 * их вызов. Если формат номеров когда-нибудь изменится — поправить нужно оба
 * места, и они специально не спрятаны друг за другом, чтобы это было видно.
 */

/** Ровно те же форматы, что strictPhone в leadQualifier.ts. */
function strictCandidatePhone(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[^\d]/g, "");
  const explicitPlus = trimmed.startsWith("+");

  const localTj = digits.length === 9 && /^[3-9]/.test(digits);
  const localTjDialed = digits.length === 10 && /^0[3-9]/.test(digits);
  const tjWithCode = digits.length === 12 && digits.startsWith("992");
  const tjWithCodeDialed = digits.length === 13 && /^9920[3-9]/.test(digits);
  const ruKz = digits.length === 11 && /^[78]/.test(digits);
  const international = explicitPlus && digits.length >= 10 && digits.length <= 15;

  if (!localTj && !localTjDialed && !tjWithCode && !tjWithCodeDialed && !ruKz && !international) return null;
  return normalizeCandidateDigits(digits);
}

/** Ровно тот же разбор, что normalizeDigits в leadQualifier.ts. */
function normalizeCandidateDigits(digits: string): string {
  if (digits.length === 9) return `+992${digits}`;
  if (digits.length === 10 && digits.startsWith("0")) return `+992${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith("8")) return `+7${digits.slice(1)}`;
  if (digits.length === 13 && digits.startsWith("9920")) return `+992${digits.slice(4)}`;
  return `+${digits}`;
}

/**
 * Телефон кандидата — то, что модель положила в поле `phone` инструмента
 * (ai/jobApplication.ts). Возвращает международный формат («+992...») или
 * `undefined`, если строка не похожа на номер вовсе: пустое поле здесь честнее
 * мусора, который потом светит нерабочей ссылкой `tel:` и выглядит как «телефон
 * есть», хотя позвонить по нему нельзя.
 *
 * Мягкий запасной разбор (девять–пятнадцать цифр без явного формата) — как
 * второй проход extractTypedPhone, но БЕЗ его первого шага (`phoneCandidates` +
 * вырезание URL): там модель ищет число посреди свободного текста вперемешку с
 * ценами и годами, а здесь она уже целенаправленно заполняла поле «Телефон
 * кандидата, если дал» — доверять всей строке безопаснее.
 *
 * ЗАПАСНОЙ РАЗБОР — ТОЛЬКО ДЛЯ ИНОСТРАННОГО НОМЕРА БЕЗ «+» (02.10.2026). Раньше он
 * брал любые 9–15 цифр, и «012345678» становился «+992012345678», а «9001112223» —
 * «+9001112223»: оба выглядели как телефон, кнопка звонка была, дозвониться нельзя.
 * Все настоящие таджикские записи (9 цифр с 3–9, 10 с 0, 12 с 992, 13 с 9920) уже
 * узнаёт строгий разбор выше, так что 9–10 цифр, которые он отверг, — это мусор, а не
 * «другой формат». Остаётся то, ради чего запасной путь и нужен: кандидат из России,
 * Узбекистана, Турции, написавший номер с кодом страны, но без «+» («998901234567»,
 * «905321234567»), — 11–15 цифр, не с нуля и не с 992 (кривая таджикская запись с
 * кодом страны — тоже мусор: правильную строгий разбор уже принял бы).
 */
export function normalizeCandidatePhone(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const strict = strictCandidatePhone(trimmed);
  if (strict) return strict;

  const digits = trimmed.replace(/[^\d]/g, "");
  const foreignWithoutPlus =
    digits.length >= 11 && digits.length <= 15 && !digits.startsWith("0") && !digits.startsWith("992");
  if (foreignWithoutPlus) return normalizeCandidateDigits(digits);
  return undefined;
}
