/**
 * ЗАКОН О ВЛАДЕНИИ КЛИЕНТОМ (17.09.2026) — единственная реализация.
 *
 * Источник: `docs/law/lead-ownership.md` (П-1…П-12, дословно из решения
 * владельца, `docs/audit/lead-ownership-17-09.md` §2 и §4). Разбор механизмов,
 * которые нарушали закон до этой правки — `docs/audit/recon-17-09/02-auto-transfer-mechanisms.md`.
 *
 * ЧИСТЫЙ МОДУЛЬ (договор для пачки А2 — сигнатуры не менять без согласования):
 * никаких вызовов Prisma внутри предикатов — снимок карточки передаётся
 * параметром (`OwnershipSnapshot`), собирает его `ownershipLoad.ts` одним
 * запросом. Без импортов из `lib/*` — иначе цикл `lib/changeClientAgent.ts` →
 * `services/leads/ownershipPolicy.ts` → `lib/*` → обратно ловит
 * `audit:deps` (`no-circular`, `.dependency-cruiser.cjs`).
 */

/** Снимок карточки, достаточный, чтобы решить, можно ли передать клиента
 *  автоматически. Собирается одним запросом в `ownershipLoad.ts`. */
export interface OwnershipSnapshot {
  id: string;
  assignedAgentId: string | null;
  acceptedAt: Date | null;
  firstContactAt: Date | null;
  lastAgentAttemptAt: Date | null;
  /** Interaction агента, НЕ SYSTEM/STATUS_CHANGE, с момента assignedAt. */
  contactAttempts: number;
  ownPropertyLead: boolean;
  kind: string;
  status: string;
  workStatus: string;
  deletedAt: Date | null;
}

/**
 * П-2. Контакт состоялся — ЛЮБАЯ попытка агента связаться с клиентом: звонок
 * любой длительности (в т.ч. «не ответил», «недоступен», «неверный номер»),
 * сообщение из CRM (даже без ответа), показ, встреча. Единое определение,
 * больше нигде не переопределяется (было 5 версий — `firstCall`: CALL ≥30с,
 * `returningClientRouting`: TALKED, `reactivationOffers`: любой CALL,
 * `clientTransfer`: попытка, `returns`: типы Interaction — см. разбор §(б)).
 *
 * Источники-признаки (любой из трёх достаточен): `firstContactAt` (первая
 * запись в Interaction по клиенту, независимо от исхода), `lastAgentAttemptAt`
 * (звонок с исходом дозвона, показ/встреча, исходящее сообщение через CRM —
 * см. комментарий у поля в schema.prisma), либо счётчик `contactAttempts`
 * (Interaction агента не SYSTEM/STATUS_CHANGE с момента `assignedAt` —
 * покрывает случай, когда обе отметки времени по какой-то причине не
 * проставлены, но запись в хронологии уже есть).
 */
export function hasContactAttempt(s: OwnershipSnapshot): boolean {
  return !!s.firstContactAt || !!s.lastAgentAttemptAt || s.contactAttempts > 0;
}

export type AutoTransferVerdict =
  | { allowed: true }
  | { allowed: false; ruleNo: "П-3" | "П-1"; reason: string };

/**
 * П-3. После принятия (`acceptedAt`) и контакта (П-2) клиент НЕ уходит другому
 * агенту автоматически. НИКОГДА. Любой крон/детектор, желающий передать такого
 * клиента, обязан вместо передачи эскалировать руководителю
 * (`escalateInsteadOfTransfer`), а владелец остаётся.
 *
 * П-1 (дополнительно, до самой П-3): удалённый клиент (Корзина) автоматика не
 * трогает вовсе — владельца меняет только явное восстановление
 * (`routes/clients/card.ts::/restore`, actorId человека).
 *
 * `toAgentId` в ctx не влияет на вердикт — закон не разрешает передачу
 * «своему же агенту» иначе, чем любому другому; параметр оставлен в контракте
 * ради диагностики (в тексте эскалации видно, кому механизм пытался отдать
 * клиента) и потому что пачка А2 конкретных механизмов может захотеть отличать
 * «эскалация вместо передачи» от «эскалация вместо снятия» (toAgentId: null).
 */
export function canAutoTransfer(
  s: OwnershipSnapshot,
  ctx: { mechanism: string; toAgentId: string | null }
): AutoTransferVerdict {
  if (s.deletedAt) {
    return {
      allowed: false,
      ruleNo: "П-1",
      reason: `клиент в Корзине — автоматика (${ctx.mechanism}) не меняет владельца удалённой карточки`,
    };
  }
  if (s.acceptedAt && hasContactAttempt(s)) {
    return {
      allowed: false,
      ruleNo: "П-3",
      reason: `клиент принят и контакт состоялся — закон П-3 запрещает автопередачу (механизм: ${ctx.mechanism})`,
    };
  }
  return { allowed: true };
}

/**
 * П-5. Передать клиента ПОСЛЕ контакта может только человек с правом
 * `clients.assign` либо сам агент кнопкой «Передать» — с актором в аудите.
 * Здесь — обратная сторона `canAutoTransfer`: источники, у которых
 * `actorId == null` НЕДОПУСТИМ в принципе (это не автоматика с политикой,
 * а действие человека, которое обязано указать, кто его совершил).
 *
 * СПИСОК СУЖЕН НАМЕРЕННО (17.09.2026, пачка А1) до источников, чьи вызывающие
 * УЖЕ передают настоящий `actorId` на 100% путей — иначе включение проверки
 * само стало бы новым нарушением закона (тихий отказ вместо тихой передачи).
 * Проверено по каждому источнику:
 *  - `lifecycle.assign` — эталон (`routes/clients/lifecycle.ts:227`, actorId
 *    от `req.agent`);
 *  - `restore` — `routes/clients/card.ts`, actorId от `req.agent`;
 *  - `freeze` — `routes/agents.ts`, actorId руководителя, снимающего агента;
 *  - `handover` — `lib/agentHandover.ts::handoverAgentWork` до этой правки НЕ
 *    принимала actorId вовсе (`actorId: null` на каждый клиент, разбор
 *    `recon-17-09/02-...md` №7: «AuditLog.agentId=null — кто передал не
 *    виден»); добавлен третий параметр `actorId`, оба вызывающих
 *    (`routes/agents.ts` POST /:id/handover и DELETE /:id) теперь передают
 *    `req.agent!.id`.
 *
 * ОСТАВЛЕНО ПАЧКЕ А2 (см. отчёт по этому заданию): `transfer`/`lost.transfer`/
 * `transfer.escalate`/`transfer.pending` (`lib/clientTransfer.ts` — 4 места,
 * везде `actorId: null`, инициатор-агент нигде не передаётся сейчас — нужно
 * тянуть по всем вызывающим, это уже отдельный периметр); `refuse`
 * (`lib/clientRefuse.ts` — ОДНА строка `source: "refuse"` обслуживает и кнопку
 * агента, и автодетектор ИИ, у обоих `actorId: null`; включать проверку можно
 * только после того, как А2 разведёт их на разные `source`, иначе кнопка
 * агента начнёт падать вместе с автодетектором). `lifecycle.claim` не входит —
 * маршрут удаляется этим же заданием (пул «ничьих», см. ниже).
 */
// `deactivate` (23.09.2026): отключение учётки в routes/agents.ts, actorId
// всегда из req.agent — lib/agentLeadRelease.ts, как у freeze.
const HUMAN_ONLY_SOURCES = new Set(["lifecycle.assign", "restore", "freeze", "handover", "deactivate"]);

export function requireHumanActor(source: string): boolean {
  return HUMAN_ONLY_SOURCES.has(source);
}
