import type { NarrationConfig } from "@royal-home/shared";
import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { mediaExecutionMode } from "./mediaExecution.js";
import { narrationProviderReady } from "./narrationGeneration.js";
import { NARRATION_CLOSED_STATUSES } from "./narrationOptOut.js";

/**
 * КОГДА CRM САМА ГОТОВИТ ОЗВУЧКУ — ОДНО МЕСТО (20.11.2026). Обход озвучки (lib/narrationAutoFlow.ts::runNarrationAutoFlow,
 * refreshNarrationDrafts, backfillMontageQueue) и строка монтажёру «Озвучка готовится…» (lib/narrationMontajerNote.ts) берут
 * условия ОТСЮДА. Живой случай 19.11: объект, заведённый 04.11, ушёл на перемонтаж, и монтажёру написали «Озвучка готовится» —
 * а озвучку этому объекту CRM не готовила и не будет: строка проверяла только рубильник «автоозвучка», а не то, что обход
 * действительно возьмёт именно этот объект. Правишь условия обхода — правишь их здесь, и строка за ними идёт сама.
 */

/** Рубильник «автоозвучка» включён и есть модель с голосами. */
export function narrationAutoEnabled(config: NarrationConfig): boolean {
  return config.autoGenerate === true && !!config.modelId && config.voices.length > 0;
}

/**
 * Обход вообще платит и готовит: автоозвучка включена, есть ключ, модель и голоса, отправка монтажёру на сервере LIVE.
 * В PREVIEW аудио некуда отдать, а кредиты списались бы (ревью 12.11.2026): черновики ждут включения LIVE.
 */
export function narrationPlannerOpen(config: NarrationConfig, key: string | null): key is string {
  return narrationAutoEnabled(config) && !!key && narrationProviderReady(config, key) && mediaExecutionMode("NARRATION") === "LIVE";
}

const DAY_MS = 86_400_000;

/** Объект, которому озвучка вообще положена и которой ещё нет ни одной версии. */
export function firstNarrationBaseWhere(): Prisma.PropertyWhereInput {
  return { deletedAt: null, narrationOff: false, status: { notIn: [...NARRATION_CLOSED_STATUSES] }, narrationVersions: { none: {} } };
}

/**
 * Подстраховка обхода: объект заведён мастером CRM или Шабнам за сутки, а озвучка не поставлена (сбой), либо он за сутки
 * попал в очередь монтажа. Заявки с сайта на модерации сюда не попадают (ревью 12.11.2026).
 */
export function freshNarrationWhere(now: Date): Prisma.PropertyWhereInput {
  return { createdAt: { gte: new Date(now.getTime() - DAY_MS) }, OR: [{ createdInCrmWizard: true }, { videoHandoffStatus: { in: ["QUEUED", "SENT_TO_EDITOR"] } }] };
}

/** Разовый проход по очереди монтажа (рубильник backfillMontageQueue, по умолчанию выключен): ролик в очереди или у монтажёра. */
export function backfillNarrationWhere(): Prisma.PropertyWhereInput {
  return { videoHandoffStatus: { in: ["QUEUED", "SENT_TO_EDITOR"] }, videoHandoffManualSince: null };
}

/**
 * Подготовит ли CRM первую озвучку ЭТОМУ объекту (у него нет ни одной версии): обход открыт и объект подходит под
 * подстраховку «свежий» или, при включённом рубильнике, под проход по очереди монтажа. Нет — монтажёру о подготовке не пишем.
 */
export async function crmWillPrepareFirstNarration(propertyId: string, config: NarrationConfig, key: string | null, now: Date = new Date()): Promise<boolean> {
  if (!narrationPlannerOpen(config, key)) return false;
  const reasons = [freshNarrationWhere(now), ...(config.backfillMontageQueue === true ? [backfillNarrationWhere()] : [])];
  return (await prisma.property.count({ where: { id: propertyId, ...firstNarrationBaseWhere(), OR: reasons } })) > 0;
}
