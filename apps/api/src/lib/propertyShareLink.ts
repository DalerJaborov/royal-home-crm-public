import { randomBytes } from "node:crypto";
import { prisma, type TxClient } from "../db.js";
import { crmPublicBase } from "./crmPublicUrl.js";
import { logSystemError } from "./systemError.js";

export function shareLinkUrl(token: string): string {
  const base = crmPublicBase();
  return base ? `${base}/l/${token}` : `/l/${token}`;
}

/**
 * ТО ЖЕ САМОЕ, НО НА ПАЧКУ ОБЪЕКТОВ СРАЗУ (22.09.2026, сведение N+1) — один
 * подбор клиенту (`routes/clients/matching.ts`) раньше звал
 * `getOrCreatePropertyShareLink` по разу на каждый выбранный объект (пусть и
 * параллельно через `Promise.all`, это всё равно N запросов чтения + до N
 * запросов записи). Здесь один `findMany` находит уже существующие активные
 * ссылки разом, а недостающие уходят одним `createManyAndReturn`.
 */
export async function getOrCreatePropertyShareLinks(
  prisma: TxClient,
  params: { propertyIds: string[]; clientId: string | null; createdByAgentId: string }
): Promise<Map<string, { id: string; token: string; url: string }>> {
  const result = new Map<string, { id: string; token: string; url: string }>();
  if (params.propertyIds.length === 0) return result;

  const existing = await prisma.propertyShareLink.findMany({
    where: {
      propertyId: { in: params.propertyIds },
      clientId: params.clientId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { createdAt: "desc" },
  });
  // Самая свежая ссылка на объект — первая при сортировке по createdAt desc,
  // ровно то же правило, что и у одиночной версии выше (orderBy + первый берём).
  for (const link of existing) {
    if (!result.has(link.propertyId)) {
      result.set(link.propertyId, { id: link.id, token: link.token, url: shareLinkUrl(link.token) });
    }
  }

  const missingIds = params.propertyIds.filter((id) => !result.has(id));
  if (missingIds.length > 0) {
    const created = await prisma.propertyShareLink.createManyAndReturn({
      data: missingIds.map((propertyId) => ({
        propertyId,
        clientId: params.clientId,
        token: randomBytes(24).toString("base64url"),
        createdByAgentId: params.createdByAgentId,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })),
    });
    for (const link of created) {
      result.set(link.propertyId, { id: link.id, token: link.token, url: shareLinkUrl(link.token) });
    }
  }
  return result;
}

/**
 * Ссылка для несайтового (offSite) объекта, отдаваемая тем же путём, что и обычная
 * siteListingUrl — из кнопки «Отправить клиенту» / «Предложить» в MatchPropertiesModal
 * (владелец 19.08.2026: «просто чтобы отправлялось ссылкой как и обычные», без
 * отдельного экрана «Создать ссылку»). Агент не должен знать, что объект несайтовый —
 * кнопка та же, разница только в том, какой URL уходит в текст.
 *
 * Переиспользуем уже созданную АКТИВНУЮ (не отозванную, не истёкшую) ссылку на пару
 * (объект, клиент), если она есть — иначе повторная отправка тому же клиенту плодила
 * бы токен на токене без всякой пользы.
 */
export async function getOrCreatePropertyShareLink(
  prisma: TxClient,
  params: { propertyId: string; clientId: string | null; createdByAgentId: string }
): Promise<{ id: string; token: string; url: string }> {
  const existing = await prisma.propertyShareLink.findFirst({
    where: {
      propertyId: params.propertyId,
      clientId: params.clientId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return { id: existing.id, token: existing.token, url: shareLinkUrl(existing.token) };

  const token = randomBytes(24).toString("base64url");
  const link = await prisma.propertyShareLink.create({
    data: {
      propertyId: params.propertyId,
      clientId: params.clientId,
      token,
      createdByAgentId: params.createdByAgentId,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  return { id: link.id, token: link.token, url: shareLinkUrl(link.token) };
}

/**
 * ССЫЛКИ ГАСНУТ ВМЕСТЕ С ОБЪЕКТОМ (07.09.2026, разведка «осиротевшие спутники»).
 *
 * GET /l/:token уже отсекает удалённый объект по `property.deletedAt` — сама
 * утечка данных невозможна. Но `revokedAt` оставался пустым навсегда: список
 * ссылок карточки (PropertyShareLinksCard) продолжал показывать ссылку «активной»
 * на объект, которого уже нет, а восстановление объекта из Корзины молча
 * оживляло бы старую ссылку клиенту, которому её никто не пересылал заново.
 *
 * Best-effort по умолчанию — тот же приём, что у
 * closePendingPropertyDeleteRequests/closeClientSatellites. `tx` необязателен и
 * добавлен, чтобы участвовать в чужой открытой транзакции (см. комментарий у
 * closePendingPropertyDeleteRequests) — ошибка внутри по-прежнему гасится через
 * `.catch` и транзакцию не обрывает, а вот падение процесса между
 * `property.update` и этим отзывом ссылок теперь откатывает оба сразу.
 */
export async function revokePropertyShareLinks(propertyIds: string[], tx?: TxClient): Promise<void> {
  if (propertyIds.length === 0) return;
  const client = tx ?? prisma;
  await client.propertyShareLink
    .updateMany({
      where: { propertyId: { in: propertyIds }, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    .catch((err) => {
      void logSystemError(
        "api",
        `Публичные ссылки на удалённые объекты не отозваны (${propertyIds.join(", ")}): ${
          err instanceof Error ? err.message : err
        }`
      );
    });
  // «Отчёт владельцу» (03.10.2026) — тот же спутник объекта: гаснет вместе с ним, иначе
  // восстановление из Корзины молча оживило бы ссылку, которую агент уже мог забыть.
  // Отдельным блоком и со своим try/catch: сбой здесь не должен ронять отзыв ссылок клиентов.
  try {
    await client.propertyOwnerReportLink.updateMany({
      where: { propertyId: { in: propertyIds }, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  } catch (err) {
    void logSystemError(
      "api",
      `Ссылки «отчёта владельцу» на удалённые объекты не отозваны (${propertyIds.join(", ")}): ${
        err instanceof Error ? err.message : err
      }`
    );
  }
}
