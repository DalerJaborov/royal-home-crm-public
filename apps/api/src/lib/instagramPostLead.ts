import { prisma } from "../db.js";
import { propertyOwnerAgentId } from "./propertyOwner.js";

/**
 * КЛИЕНТ ПРИСЛАЛ ССЫЛКУ НА ПОСТ — ЛИД УХОДИТ АГЕНТУ ЭТОГО ОБЪЕКТА
 * (владелец 09.09.2026).
 *
 * Правило «свой объект» уже есть и работает двумя путями: бот показывал этому
 * человеку объект (`pickByShownProperty`) и описание совпало с объектом агента
 * (`pickByPropertyMatch`, порог 90%). Оба — ДОГАДКИ разной точности.
 *
 * Присланная ссылка догадкой не является: человек прямо показал, какой объект ему
 * нужен. Поэтому она стоит в лесенке ПЕРВОЙ, выше совпадения по описанию, и
 * уступает только прямой просьбе назвать сотрудника («мне нужен Умед») — та
 * называет человека, а эта объект.
 *
 * ПОЧЕМУ ЭТО ДЁШЕВО. Ссылка на публикацию уже хранится в карточке
 * (`Property.instagramUrl`), и рядом, в той же строке, лежит агент объекта
 * (`intakeAgentId`). Никакого нового источника данных не нужно — нужно только
 * сопоставить.
 *
 * СРАВНИВАЕМ ПО КОДУ ПОСТА, А НЕ ПО СТРОКЕ ЦЕЛИКОМ. Один и тот же пост приходит
 * десятком разных ссылок: с `www` и без, с `/reel/` и `/p/`, с хвостом
 * `?igsh=...` от кнопки «Поделиться», со слешем на конце и без. Сравнение строк
 * не сработало бы почти никогда — а именно так выглядит правило, которое «есть,
 * но не срабатывает» (та же болезнь, что была у phoneLeakedAt).
 */

/** Код поста Instagram из ссылки: /p/<code>, /reel/<code>, /reels/<code>, /tv/<code>. */
export function instagramPostCode(url: string): string | null {
  const m = /instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/i.exec(url);
  return m ? m[1] : null;
}

/** Все коды постов, встреченные в тексте сообщения клиента. */
export function instagramPostCodesIn(text: string): string[] {
  const codes = new Set<string>();
  for (const raw of text.match(/https?:\/\/\S+/gi) ?? []) {
    const code = instagramPostCode(raw);
    if (code) codes.add(code);
  }
  return [...codes];
}

export interface PostLeadMatch {
  propertyId: string;
  propertyShortId: number;
  agentId: string;
}

/**
 * Найти объект по ссылке из сообщения клиента и вернуть агента, который его вёл.
 *
 * Объект должен быть в продаже: по проданному или снятому лид хозяину не отдаём —
 * человек прислал ссылку на пост, который просто ещё висит в ленте.
 */
export async function findAgentByInstagramPost(text: string): Promise<PostLeadMatch | null> {
  const codes = instagramPostCodesIn(text);
  if (codes.length === 0) return null;

  const candidates = await prisma.property.findMany({
    where: {
      instagramUrl: { not: null },
      deletedAt: null,
      status: { in: ["AVAILABLE", "RESERVED"] },
      // Хозяин хоть в каком-то из трёх полей (propertyOwnerAgentId, 11.09.2026) —
      // раньше требовался именно intakeAgentId, и пост объекта без интейкера, но
      // с назначенным риелтором, никому лида не приносил.
      OR: codes.flatMap((c) => [
        { instagramUrl: { contains: c }, intakeAgentId: { not: null } },
        { instagramUrl: { contains: c }, assignedAgentId: { not: null } },
        { instagramUrl: { contains: c }, createdById: { not: null } },
      ]),
    },
    select: { id: true, shortId: true, instagramUrl: true, intakeAgentId: true, assignedAgentId: true, createdById: true },
    take: 20,
  });

  for (const p of candidates) {
    const code = p.instagramUrl ? instagramPostCode(p.instagramUrl) : null;
    const ownerId = propertyOwnerAgentId(p);
    if (code && codes.includes(code) && ownerId) {
      return { propertyId: p.id, propertyShortId: p.shortId, agentId: ownerId };
    }
  }

  /**
   * ФОТО-ПОСТ (28.09.2026, agent-brief.md) — ПОСЛЕ основного поиска по
   * instagramUrl, ровно тот же класс ссылки на пост, только у объекта без
   * ролика: карусель/одиночное фото в Instagram, permalink сохранён в
   * PropertyPhotoPost, а не в Property.instagramUrl (то поле остаётся пустым —
   * фото-пост не Reels, см. докстринг lib/photoPosts.ts).
   */
  for (const code of codes) {
    const post = await prisma.propertyPhotoPost.findFirst({
      where: { channel: "INSTAGRAM", status: "PUBLISHED", permalink: { contains: code } },
      orderBy: { createdAt: "desc" },
      select: { propertyId: true },
    });
    if (!post) continue;
    const property = await prisma.property.findFirst({
      where: { id: post.propertyId, deletedAt: null, status: { in: ["AVAILABLE", "RESERVED"] } },
      select: { id: true, shortId: true, intakeAgentId: true, assignedAgentId: true, createdById: true },
    });
    const ownerId = property ? propertyOwnerAgentId(property) : null;
    if (property && ownerId) {
      return { propertyId: property.id, propertyShortId: property.shortId, agentId: ownerId };
    }
  }
  return null;
}
