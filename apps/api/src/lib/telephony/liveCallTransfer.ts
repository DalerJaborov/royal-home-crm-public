import { prisma } from "../../db.js";
import { propertyOwnerAgentId } from "../propertyOwner.js";
import { isWithinConsultantHours } from "./consultantHours.js";
import { loadAmiCredentials } from "./amiClient.js";
import { loadAriCredentials } from "./ariClient.js";
import { hasLiveCall } from "./callTracker.js";
import {
  continueStasisChannelToAgent,
  redirectChannelToAgent,
  resolveDialTarget,
  stationHasRouteContext,
  type RouteFallback,
} from "./inboundRouting.js";
import { transferLiveVoiceCall } from "./liveVoiceBridge.js";
import { propertyWhisperFile } from "./propertyWhisper.js";
import { whisperFileForCall } from "./whisperSync.js";

/**
 * ПЕРЕВОД ИДУЩЕГО ЗВОНКА АГЕНТУ — ОДНО МЕСТО НА ВСЕХ (24.09.2026).
 *
 * Переводят двое: консультант на телефоне (ИИ, liveVoiceTransfer.ts) и оператор
 * кнопкой «Передать агенту объекта» во время разговора. Кому переводить, живой
 * ли агент, куда звонить и что станция примет — одно и то же у обоих, иначе
 * консультант соединил бы с агентом, до которого оператор не достал бы, и
 * наоборот. Разное только то, где сейчас канал звонящего:
 *  - у консультанта канал в Stasis-приложении живого голоса — выводится через
 *    ARI (continueStasisChannelToAgent), не взял агент — назад к консультанту;
 *  - у оператора канал в мосте с оператором — уводится AMI Redirect
 *    (redirectChannelToAgent), не взял агент — назад в очередь операторов.
 * Станции звонок в обоих случаях уходит тем же контекстом royalhome-agent-route и
 * теми же переменными, что перевод известного клиента его агенту.
 *
 * Третий случай (24.09.2026) — оператор переводит с офисного телефона кодом
 * 7+номер объекта (deskTransfer.ts): станция сама отдаёт канал звонящего в
 * Stasis-приложение CRM, и он выводится оттуда тем же continueStasisChannelToAgent,
 * что у консультанта, но без его сессии; не взял агент — очередь операторов.
 */

export type TransferAgent = {
  id: string;
  fullName: string;
  sipExtension: string | null;
  phone: string | null;
  whisperLanguage: string | null;
};

const agentSelect = {
  id: true,
  fullName: true,
  sipExtension: true,
  phone: true,
  whisperLanguage: true,
  isActive: true,
  frozenAt: true,
} as const;

async function usableAgent(
  agentId: string | null | undefined,
): Promise<TransferAgent | null> {
  if (!agentId) return null;
  const a = await prisma.agent.findUnique({
    where: { id: agentId },
    select: agentSelect,
  });
  return a && a.isActive && !a.frozenAt ? a : null;
}

/**
 * Кому переводить и почему. По порядку:
 *  1. названный объект — агенту, который его ведёт (propertyOwnerAgentId: тот же
 *     выбор, что у раздачи лидов по объекту);
 *  2. иначе клиент нашего агента — его агенту;
 *  3. иначе дежурному для перевода (Настройки → Живой голос), а не назначен —
 *     дежурному оператору обратных звонков.
 * Уволенный или замороженный агент пропускается.
 *
 * `skipOperatorWhenNoAnswer` (09.10.2026, аудит робота P1-4): консультант в режиме
 * «после оператора» (Settings.liveVoiceInboundMode = "no_answer") получает звонок как
 * раз потому, что оператор первой линии 20 с не снял трубку. Переводить «дежурному
 * оператору обратных звонков» — значит звонить тому же оператору ещё 30 с. В этом
 * режиме берётся только явный «дежурный для перевода»; нет его — перевода нет, и
 * робот говорит, что агент наберёт (а задачу ставит итог звонка). Оператору с
 * кнопкой «передать» (deskTransfer.ts) это не касается: флаг ставит только консультант.
 */
export async function pickTransferAgent(
  ctx: { clientId: string | null },
  propertyNumber: number | null,
  opts: { skipOperatorWhenNoAnswer?: boolean } = {},
): Promise<{
  agent: TransferAgent;
  because: "property" | "client" | "duty";
  propertyId: string | null;
} | null> {
  if (propertyNumber) {
    const p = await prisma.property.findFirst({
      where: {
        shortId: propertyNumber,
        deletedAt: null,
        status: { in: ["AVAILABLE", "RESERVED"] },
      },
      select: {
        id: true,
        intakeAgentId: true,
        assignedAgentId: true,
        createdById: true,
      },
    });
    const owner = p ? await usableAgent(propertyOwnerAgentId(p)) : null;
    if (owner && p)
      return { agent: owner, because: "property", propertyId: p.id };
  }
  if (ctx.clientId) {
    const c = await prisma.client.findUnique({
      where: { id: ctx.clientId },
      select: { deletedAt: true, assignedAgentId: true },
    });
    const own = c && !c.deletedAt ? await usableAgent(c.assignedAgentId) : null;
    if (own) return { agent: own, because: "client", propertyId: null };
  }
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { liveVoiceTransferAgentId: true, callbackOperatorAgentId: true, liveVoiceInboundMode: true },
  });
  const operatorAlreadyRang = !!opts.skipOperatorWhenNoAnswer && s?.liveVoiceInboundMode === "no_answer";
  const duty =
    (await usableAgent(s?.liveVoiceTransferAgentId)) ??
    (operatorAlreadyRang ? null : await usableAgent(s?.callbackOperatorAgentId));
  return duty ? { agent: duty, because: "duty", propertyId: null } : null;
}

/** Где сейчас канал звонящего (см. шапку файла). */
export type TransferChannel =
  | { kind: "consultant"; channelId: string }
  | { kind: "operator"; channelName: string }
  | { kind: "stasis"; channelId: string };

/**
 * Почему перевода нет. Каждая причина — своя фраза человеку: консультант говорит
 * её звонящему, оператор видит на кнопке.
 */
export type TransferRefusal =
  | "after_hours"
  | "no_phone"
  | "busy"
  | "no_station"
  | "offline"
  | "no_dialplan"
  | "failed"
  | "gone";

export async function transferLiveCallToAgent(input: {
  channel: TransferChannel;
  agent: TransferAgent;
  /** Для подсказки в ухо: она озвучивается заранее по карточке клиента. */
  clientId: string | null;
  /** Перевод по объекту — агент слышит приметы объекта (propertyWhisper.ts), а не
   *  клиента: «агент номер не помнит» (Dan 24.09.2026). Не озвучено — о клиенте. */
  propertyId?: string | null;
  ringSeconds: number;
  fallback: RouteFallback;
  /** Консультант переводит только в рабочие часы: ночью агент на мобильном не то,
   *  что обещали клиенту. Оператор в офисе, ему решать самому. */
  requireWorkingHours: boolean;
  /** Звонок отдан станции (канал консультанта ушёл в Dial к агенту) — ещё ДО конца
   *  сессии моста, которая ждёт запись разговора и базу. Только для kind "consultant". */
  onMoved?: () => void;
  /** Вызов перевода отменён моделью или упёрся в потолок: канал к агенту не уводим (LIVE05). */
  isCancelled?: () => boolean;
}): Promise<{ ok: true } | { ok: false; reason: TransferRefusal }> {
  const { agent } = input;
  if (input.requireWorkingHours && !(await isWithinConsultantHours()))
    return { ok: false, reason: "after_hours" };
  if (!agent.sipExtension) return { ok: false, reason: "no_phone" };
  if (hasLiveCall(agent.id)) return { ok: false, reason: "busy" };

  const [ari, ami] = await Promise.all([
    loadAriCredentials(),
    loadAmiCredentials(),
  ]);
  if (!ari || !ami) return { ok: false, reason: "no_station" };
  const dial = await resolveDialTarget(ari, agent.sipExtension, agent.phone);
  if (!dial) return { ok: false, reason: "offline" };
  const dialplan = await stationHasRouteContext(ami);
  if (!("present" in dialplan) || !dialplan.present)
    return { ok: false, reason: "no_dialplan" };

  const byProperty = input.propertyId
    ? await propertyWhisperFile({
        propertyId: input.propertyId,
        agentWhisperLanguage: agent.whisperLanguage,
      }).catch(() => null)
    : null;
  const whisperFile =
    byProperty ??
    (input.clientId
      ? await whisperFileForCall({
          clientId: input.clientId,
          agentWhisperLanguage: agent.whisperLanguage,
          direction: "in",
        }).catch(() => null)
      : null);
  const failLabel = `Звонок не переведён агенту ${agent.sipExtension}`;

  if (input.channel.kind === "consultant") {
    const outcome = await transferLiveVoiceCall(
      input.channel.channelId,
      async (channelId) => {
        const moved = await continueStasisChannelToAgent({
          channelId,
          dialTarget: dial.target,
          viaMobile: dial.viaMobile,
          ringSeconds: input.ringSeconds,
          fallback: input.fallback,
          whisperFile,
          failLabel,
        });
        if (moved) input.onMoved?.();
        return moved;
      },
      // Получатель — чтобы второй перевод ДРУГОМУ агенту не получил «ок» первого.
      agent.id,
      input.isCancelled,
    );
    return outcome === "ok" ? { ok: true } : { ok: false, reason: outcome };
  }

  if (input.channel.kind === "stasis") {
    const moved = await continueStasisChannelToAgent({
      channelId: input.channel.channelId,
      dialTarget: dial.target,
      viaMobile: dial.viaMobile,
      ringSeconds: input.ringSeconds,
      fallback: input.fallback,
      whisperFile,
      failLabel,
    });
    return moved ? { ok: true } : { ok: false, reason: "failed" };
  }

  const moved = await redirectChannelToAgent({
    channelName: input.channel.channelName,
    extension: agent.sipExtension,
    dialTarget: dial.target,
    viaMobile: dial.viaMobile,
    ringSeconds: input.ringSeconds,
    fallback: input.fallback,
    // Оператор уже говорит с человеком и сам нажал «передать» — «уже отвечен»
    // здесь не причина отказа, а исходное состояние.
    isAnswered: () => false,
    whisperFile,
    logLabel: `оператор передал звонок агенту ${agent.sipExtension}`,
    failLabel,
  });
  return moved.ok
    ? { ok: true }
    : {
        ok: false,
        reason:
          moved.reason === "station_not_configured" ? "no_station" : "failed",
      };
}
