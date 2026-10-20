import { parseShortCode } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { mentionedCardNumber } from "../propertyMentionFromText.js";
import { toSearchTokens, toTokenVariants } from "../searchTokens.js";

/**
 * Найти объект, который ИИ распознал в расшифровке звонка — адрес, ЖК, номер
 * объекта или ссылка (Пачка 1 п.4, 11.09.2026: «если в расшифровке звонка ИИ
 * выделил объект — передавать propertyId явно, найдя объект по этим признакам
 * существующим поиском, без новой эвристики»).
 *
 * Существующий поиск — тот же токенный поиск по названию/адресу, что у
 * каталога объектов (routes/properties/list.ts, lib/searchTokens.ts): раскладка,
 * транслитерация и таджикские буквы уже решены там, копировать не нужно.
 */
export async function resolveCallPropertyHint(hint: string | null | undefined): Promise<string | null> {
  const text = hint?.trim();
  if (!text) return null;

  // Голое число — это №объекта (shortId), тот же номер, что виден агенту в
  // карточке и в ссылке /listing/by-crm/<id>.
  //
  // П-13 (18.09.2026, docs/audit/recon-17-09/07-routing-code.md §E находка #2):
  // статус проверяем так же, как токенный поиск ниже — без этого голый номер
  // давно проданного/снятого объекта всё равно уводил лид «хозяину», которого
  // у этого объекта фактически больше нет.
  //
  // НОМЕР СЛОВАМИ (24.09.2026, проход по классам после ОБ-000118): модель пишет
  // подсказку как услышала — «объект №112», «ОБ-000118», «объект номер 118», — и
  // прежняя проверка «только цифры» пропускала их все: самая сильная примета
  // терялась, а слова короче четырёх букв поиск ниже отбрасывает. Номер берём
  // по коду карточки («ОБ-…») или по поводу «объект/№» — тем же правилом, что в
  // чате (ai/propertyMentionGuard.ts): голое число внутри фразы («квартира 12»
  // в адресе) номером объекта не считается.
  // Код клиента («ПК-000475») — не номер объекта, поэтому приставка только «ОБ».
  const byCode = /^(?:об|ob)?[-\s]?\d{1,9}$/i.test(text) ? parseShortCode(text) : null;
  const mentioned = byCode ?? Number(mentionedCardNumber(text) ?? NaN);
  if (Number.isSafeInteger(mentioned) && mentioned > 0) {
    const byShortId = await prisma.property.findFirst({
      where: { shortId: mentioned, deletedAt: null, status: { in: ["AVAILABLE", "RESERVED"] } },
      select: { id: true },
    });
    if (byShortId) return byShortId.id;
  }

  const tokens = toSearchTokens(text);
  if (tokens.length === 0) return null;

  const candidates = await prisma.property.findMany({
    where: {
      deletedAt: null,
      status: { in: ["AVAILABLE", "RESERVED"] },
      AND: tokens.map((token) => ({
        OR: toTokenVariants(token).flatMap((variant) => [
          { title: { contains: variant, mode: "insensitive" as const } },
          { address: { contains: variant, mode: "insensitive" as const } },
          { instagramUrl: { contains: variant, mode: "insensitive" as const } },
        ]),
      })),
    },
    select: { id: true },
    take: 2,
  });
  // Ровно один кандидат — иначе обрывок общего смысла («квартира», «Сино») нашёл
  // бы десяток объектов, и угадывать среди них рискованнее, чем не угадывать
  // вовсе (лид тогда просто уходит обычной очередью, как раньше).
  return candidates.length === 1 ? candidates[0].id : null;
}
