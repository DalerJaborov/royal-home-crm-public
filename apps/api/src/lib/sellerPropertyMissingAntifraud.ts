import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { isWithinAlarmHours } from "./workingHours.js";
import { logTimeline } from "./timeline.js";

const DAY_MS = 86_400_000;

interface SellerPropertyMissingSettings {
  warnDays: number;
  criticalDays: number;
}

export async function loadSellerPropertyMissingSettings(): Promise<SellerPropertyMissingSettings> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { sellerPropertyMissingWarnDays: true, sellerPropertyMissingCriticalDays: true },
  });
  return {
    warnDays: s?.sellerPropertyMissingWarnDays ?? 3,
    criticalDays: s?.sellerPropertyMissingCriticalDays ?? 5,
  };
}

export type SellerPropertyMissingLevel = "WARN" | "CRITICAL";

export interface SellerPropertyMissingItem {
  id: string;
  shortId: number;
  fullName: string;
  propertyAcceptedAt: Date;
  daysSince: number;
  level: SellerPropertyMissingLevel;
  assignedAgent: { id: string; fullName: string; avatarUrl: string | null } | null;
  securityReview: string | null;
}

/**
 * Антифрод «продавец без объекта» (владелец 21.08.2026, Settings.sellerPropertyMissingWarnDays/
 * CriticalDays, см. комментарий у полей в schema.prisma): продавец принят в работу
 * (Client.propertyAcceptedAt, исход звонка PROPERTY_ACCEPTED), а карточки объекта
 * всё ещё нет. Первый срок — жёлтая метка в дашборде руководителя (см. Oversight.tsx),
 * второй — красная и уходит в СБ (escalateSellerPropertyMissing ниже).
 *
 * До 31.08.2026 warnDays существовал в схеме, но читался только для другого —
 * переноса dueAt «Итога приёмки» вперёд (routes/me.ts) — отдельного сигнала
 * руководителю не было вовсе, а criticalDays не читался нигде.
 *
 * ЗАКРЫТИЕ ТРЕБОВАНИЯ — то же условие, что и у «Итога приёмки»: карточка объекта
 * реально создана с sellerClientId = этот клиент (routes/properties.ts, POST /).
 * sellerClientId — строка без внешнего ключа (см. её же комментарий в schema.prisma),
 * поэтому проверяется отдельным запросом, а не join'ом.
 */
export async function findSellerPropertyMissing(now: Date): Promise<{
  warnDays: number;
  criticalDays: number;
  items: SellerPropertyMissingItem[];
}> {
  const { warnDays, criticalDays } = await loadSellerPropertyMissingSettings();
  const warnCutoff = new Date(now.getTime() - warnDays * DAY_MS);

  /**
   * «У ПРОДАВЦА НЕТ ОБЪЕКТА» ОТСЕИВАЕТСЯ В SQL, ДО LIMIT (аудит Codex 04.10, CHANNEL-NEW-06).
   * Раньше брались 500 самых давних приёмов, а продавцов с объектом отбрасывали уже в памяти:
   * 500 здоровых давних продавцов навсегда занимали выборку, и продавец без объекта за ними
   * не эскалировался никогда. sellerClientId — строка без внешнего ключа, реляционным фильтром
   * Prisma это не выразить, поэтому id кандидатов выбирает сырой запрос.
   */
  const candidateIds = (
    await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT c.id
      FROM "Client" c
      WHERE c.kind = 'SELLER'
        AND c."deletedAt" IS NULL
        AND c.status NOT IN ('LOST', 'DEAL_CLOSED', 'ARCHIVED')
        AND c."propertyAcceptedAt" IS NOT NULL
        AND c."propertyAcceptedAt" <= ${warnCutoff}
        AND NOT EXISTS (
          SELECT 1 FROM "Property" p WHERE p."sellerClientId" = c.id AND p."deletedAt" IS NULL
        )
      ORDER BY c."propertyAcceptedAt" ASC
      LIMIT 500
    `)
  ).map((r) => r.id);
  if (candidateIds.length === 0) return { warnDays, criticalDays, items: [] };

  const candidates = await prisma.client.findMany({
    where: { id: { in: candidateIds } },
    orderBy: { propertyAcceptedAt: "asc" },
    select: {
      id: true,
      shortId: true,
      fullName: true,
      propertyAcceptedAt: true,
      securityReview: true,
      assignedAgent: { select: { id: true, fullName: true, avatarUrl: true } },
    },
  });

  const items: SellerPropertyMissingItem[] = candidates
    .map((c) => {
      const daysSince = Math.floor((now.getTime() - c.propertyAcceptedAt!.getTime()) / DAY_MS);
      return {
        id: c.id,
        shortId: c.shortId,
        fullName: c.fullName,
        propertyAcceptedAt: c.propertyAcceptedAt!,
        daysSince,
        level: daysSince >= criticalDays ? "CRITICAL" : ("WARN" as SellerPropertyMissingLevel),
        assignedAgent: c.assignedAgent,
        securityReview: c.securityReview,
      };
    });
  return { warnDays, criticalDays, items };
}

/**
 * ЭСКАЛАЦИЯ В СБ — крон-тик (cron.ts, каждые 30 минут вместе со светофором
 * неактивных), не побочный эффект чтения дашборда: GET /oversight/* не пишет.
 *
 * Критичный случай (daysSince >= criticalDays), у которого СБ ещё не открывала
 * карточку (securityReview===null), получает securityReview="PENDING" — тем же
 * способом, что и остальные пути в очередь СБ (routes/clients/lifecycle.ts,
 * REASONS_REQUIRING_SECURITY_REVIEW), плюс пуш руководству.
 *
 * ДЕДУП — переходом null→PENDING в самом updateMany (where: securityReview: null):
 * повторный тик того же клиента увидит securityReview уже не null и молча
 * пропустит. Решение СБ (CLEARED/CONFIRMED) не трогаем — человек уже разобрался,
 * повторная эскалация была бы спором с его выводом, а не помощью.
 */
export async function escalateSellerPropertyMissing(now: Date = new Date()): Promise<{ escalated: number }> {
  // Директора/СБ не будим ночью — решение владельца 03.09.2026 «3б», тот же
  // приём, что у sellerNoPropertyAlarm.ts. Гейт стоит ПЕРЕД самой эскалацией
  // (не только перед пушем): securityReview остаётся null, дневной тик (каждые
  // 30 минут) увидит того же кандидата и эскалирует сам — переход null→PENDING
  // и есть дедуп, откладывать его на «эскалировать ночью, но не пушить» нельзя,
  // иначе утренний тик не найдёт уже сменившийся статус и просто промолчит.
  // Окно то же, что у всех алармов руководству (isWithinAlarmHours,
  // Settings.alarmHoursStart/End), а не окно раздачи лидов.
  if (!(await isWithinAlarmHours(now))) return { escalated: 0 };

  const { items } = await findSellerPropertyMissing(now);
  const critical = items.filter((i) => i.level === "CRITICAL" && i.securityReview === null);
  if (critical.length === 0) return { escalated: 0 };

  let escalated = 0;
  for (const c of critical) {
    const result = await prisma.client.updateMany({
      where: { id: c.id, securityReview: null },
      data: { securityReview: "PENDING" },
    });
    if (result.count === 0) continue; // securityReview сменился между чтением и записью — уже не наш случай

    // П-10 §b.5: раньше запись об обвинении подписывалась agentId самого
    // обвиняемого агента — actor system, subjectAgentId (не agentId) указывает,
    // о ком речь, без ложного «сам на себя написал».
    await logTimeline({
    investigationOnly: true,
      clientId: c.id,
      actor: { kind: "system", source: "sellerPropertyMissingAntifraud", subjectAgentId: c.assignedAgent?.id ?? null },
      type: "SYSTEM",
      notes: `Антифрод «продавец без объекта»: ${c.daysSince} дн после приёма в работу объекта всё ещё нет — карточка передана в СБ`,
    });
    escalated++;
    // Часы алармов (владелец 07.09.2026): карточка уже ушла в СБ (securityReview
    // выше), откладывается только уведомление руководству о ней.
    void enqueueDirectorAlert({
      title: "🚩 Продавец без объекта — критично",
      body: `${c.fullName}: ${c.daysSince} дн без карточки объекта — карточка передана в СБ`,
      url: `/clients/${c.shortId}`,
      tag: `seller-property-missing-${c.id}`,
      // Карточка уже ушла в СБ — это верхняя ступень антифрода, а не сводка.
      level: "CRITICAL",
      recipientRoles: ["ADMIN", "DIRECTOR"],
    });
  }
  return { escalated };
}
