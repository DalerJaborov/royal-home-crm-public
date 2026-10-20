import { randomBytes } from "node:crypto";
import type { OwnerReportLinkInfo } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { crmPublicBase } from "../crmPublicUrl.js";

/**
 * ССЫЛКА «ОТЧЁТ ВЛАДЕЛЬЦУ» (03.10.2026): выдача, отзыв, адрес. Публичная страница —
 * routes/ownerReportPublic.ts, сборка цифр — lib/ownerReport/load.ts.
 *
 * Токен — 32 случайных байта из crypto.randomBytes, base64url (43 символа, 256 бит), НЕ uuid
 * и НЕ инкремент. Длиннее, чем у PropertyShareLink (24 байта): та ссылка отдаёт карточку,
 * которую и так видно на сайте, а эта — цифры интереса по объекту.
 */

export const OWNER_REPORT_TOKEN_BYTES = 32;
/** Форма токена: только base64url нужной длины. Всё остальное — 404 до обращения к базе. */
export const OWNER_REPORT_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function ownerReportUrl(token: string): string {
  const base = crmPublicBase();
  return base ? `${base}/o/${token}` : `/o/${token}`;
}

interface LinkRow {
  id: string;
  token: string;
  createdAt: Date;
  lastViewedAt: Date | null;
  viewsCount: number;
}

export function presentOwnerReportLink(link: LinkRow): OwnerReportLinkInfo {
  return {
    id: link.id,
    url: ownerReportUrl(link.token),
    createdAt: link.createdAt.toISOString(),
    lastViewedAt: link.lastViewedAt ? link.lastViewedAt.toISOString() : null,
    viewsCount: link.viewsCount,
  };
}

const SELECT = { id: true, token: true, createdAt: true, lastViewedAt: true, viewsCount: true } as const;

export function findActiveOwnerReportLink(propertyId: string) {
  return prisma.propertyOwnerReportLink.findFirst({
    where: { propertyId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: SELECT,
  });
}

/**
 * ИДЕМПОТЕНТНО: действующая ссылка возвращается как есть, новая заводится только когда
 * действующей нет (после отзыва). Два одновременных вызова: второй упирается в частичный
 * уникальный индекс `PropertyOwnerReportLink_propertyId_active_key` (P2002) и забирает
 * ссылку, созданную первым, — двух действующих ссылок на объект не бывает.
 */
export async function getOrCreateOwnerReportLink(
  propertyId: string,
  createdById: string
): Promise<{ link: LinkRow; created: boolean }> {
  const existing = await findActiveOwnerReportLink(propertyId);
  if (existing) return { link: existing, created: false };
  try {
    const link = await prisma.propertyOwnerReportLink.create({
      data: { propertyId, createdById, token: randomBytes(OWNER_REPORT_TOKEN_BYTES).toString("base64url") },
      select: SELECT,
    });
    return { link, created: true };
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      const raced = await findActiveOwnerReportLink(propertyId);
      if (raced) return { link: raced, created: false };
    }
    throw err;
  }
}

/** Отзыв действующей ссылки. true — отозвали, false — отзывать было нечего. */
export async function revokeOwnerReportLink(propertyId: string): Promise<boolean> {
  const { count } = await prisma.propertyOwnerReportLink.updateMany({
    where: { propertyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count > 0;
}
