import { prisma } from "../db.js";
import { geoMatchKey } from "./geoNormalize.js";

/**
 * Район по имени из разговора — БЕЗ УЧЁТА РЕГИСТРА, одно правило на все каналы
 * (ночная проверка 24.09.2026, «горячие файлы» №5).
 *
 * Модель пишет «сино», в справочнике «Сино». Приём с сайта (routes/webhooks.ts)
 * и оба Telegram-приёма (telegram/bot.ts, messengers/telegramDirectMessages.ts)
 * давно искали через `mode: "insensitive"` — а приём в каналах Meta
 * (messengers/conversation.ts) сравнивал точно, и район из разговора молча не
 * попадал в карточку. Четыре копии одного правила заменены одной функцией:
 * следующая копия не разъедется.
 *
 * Возвращает id района или undefined — как и было у каждого из четырёх мест.
 */
export async function findDistrictIdByName(name: string | null | undefined): Promise<string | undefined> {
  const wanted = name?.trim();
  if (!wanted) return undefined;
  const district = await prisma.district.findFirst({
    where: { name: { equals: wanted, mode: "insensitive" } },
    select: { id: true },
  });
  if (district) return district.id;
  // Таджикское написание и латиница (29.09.2026): «Шоҳмансур», «Фирдавсӣ»,
  // «Sino» — тот же район. Импорт таблицы заводил на «Шоҳмансур» пятый район,
  // а помощник и окно касания молча теряли фильтр. Районов единицы — сверяем
  // в памяти тем же ключом, что и места в разговоре.
  const key = geoMatchKey(wanted);
  if (!key) return undefined;
  const all = await prisma.district.findMany({ select: { id: true, name: true }, take: 200 });
  return all.find((d) => geoMatchKey(d.name) === key)?.id;
}
