import { z } from "zod";
import { isReadOnlyRole } from "@royal-home/shared";
import {
  VIDEO_REMAKE_REASONS,
  VIDEO_REMAKE_REASON_LABELS,
  formatPropertyCode,
  sendBackToMontajerSchema,
  type SendBackToMontajerInput,
} from "@royal-home/shared";
import { prisma } from "../../../db.js";
import { AssistantActionError, type AssistantActionActor } from "../../../lib/assistantActions.js";
import { buildMontajerMessageText } from "../../../lib/videoHandoff.js";
import { sendBackDenied, sendPropertyBackToMontajerAs, type SendBackActor } from "../../../lib/propertySendBack.js";
import { loadWriterRole, resolveRefOrThrow } from "./propertyToolSupport.js";
import { propertyHref } from "./propertyPresenter.js";
import { plainField } from "./safeField.js";
import type { AssistantWriteToolPlugin } from "./types.js";

/**
 * send_to_remake — «Вернуть монтажёру» (перемонтаж ролика), НЕОБРАТИМО.
 *
 * Исполняет `sendBackToMontajer` через ту же обёртку, что кнопка в карточке
 * (lib/propertySendBack.ts): права `canManageProperty`, «после публикации —
 * руководству» и «снять из соцсетей — маркетингу» проверяются теми же функциями.
 * Отката нет: монтажёру уже ушло задание, посты (если просили) сняты.
 *
 * Условность записи: счётчик `videoRemakeCount` растёт при каждом возврате, поэтому
 * «счётчик тот же, что в превью» (guard под замком объекта) значит «никто не
 * отправлял объект на перемонтаж с тех пор, как человек видел карточку».
 */
const rawSchema = z.object({
  ref: z.string().trim().min(1).max(200),
  reason: z.enum(VIDEO_REMAKE_REASONS),
  comment: z.string().trim().max(2000).optional(),
  removeFromSocial: z.boolean().optional(),
});
type Args = z.infer<typeof rawSchema>;

interface Snap {
  propertyId: string;
  shortId: number;
  status: string;
  videoHandoffStatus: string;
  videoRemakeCount: number;
  publishedChannels: string[];
  clipReviewStatus: string | null;
  [k: string]: unknown;
}

/** Тело в форме REST-схемы (комментарий обязателен для «Другое» и «Неверная надпись»). */
function toBody(args: Args): SendBackToMontajerInput {
  const parsed = sendBackToMontajerSchema.safeParse({
    reason: args.reason,
    comment: args.comment || undefined,
    removeFromSocial: args.removeFromSocial,
  });
  if (!parsed.success) throw new AssistantActionError(400, "BAD_ARGS", parsed.error.issues[0]?.message ?? "Неверные данные");
  return parsed.data;
}

async function actorWithRole(actor: AssistantActionActor): Promise<SendBackActor> {
  const role = await loadWriterRole(actor.agentId);
  return { agentId: actor.agentId, role, can: actor.can };
}

export const sendToRemakeExecutor = {
  tool: "send_to_remake",
  parseArgs(raw: unknown): Args {
    const args = rawSchema.parse(raw);
    toBody(args); // отказ в комментарии — понятным текстом ещё на разборе
    return args;
  },

  async snapshot(args: Args, actor: AssistantActionActor): Promise<Snap> {
    await loadWriterRole(actor.agentId);
    const { id } = await resolveRefOrThrow(args.ref);
    const property = await prisma.property.findUnique({
      where: { id },
      select: {
        id: true,
        shortId: true,
        status: true,
        deletedAt: true,
        videoHandoffStatus: true,
        videoRemakeCount: true,
        publishedChannels: true,
        clipReviewStatus: true,
      },
    });
    if (!property || property.deletedAt) throw new AssistantActionError(404, "ENTITY_NOT_FOUND", "Объект не найден");
    return {
      propertyId: property.id,
      shortId: property.shortId,
      status: property.status,
      videoHandoffStatus: property.videoHandoffStatus,
      videoRemakeCount: property.videoRemakeCount,
      publishedChannels: [...(property.publishedChannels ?? [])].sort(),
      clipReviewStatus: property.clipReviewStatus ?? null,
    };
  },

  async buildPreview(args: Args, snapshot: Record<string, unknown>, actor: AssistantActionActor) {
    const snap = snapshot as Snap;
    const body = toBody(args);
    const sender = await actorWithRole(actor);
    const property = await prisma.property.findUniqueOrThrow({ where: { id: snap.propertyId } });
    const code = formatPropertyCode(property.shortId);
    // Права и ВСЕ отказы функции возврата — тем же кодом, но без записи.
    const denied = sendBackDenied(sender, property, body.removeFromSocial);
    if (denied) throw new AssistantActionError(denied.status, "FORBIDDEN", denied.error);
    const dry = await sendPropertyBackToMontajerAs({
      propertyId: property.id,
      actor: sender,
      body,
      source: "crm",
      guard: { videoRemakeCount: snap.videoRemakeCount },
      dryRun: true,
    });
    if (!dry.ok) throw new AssistantActionError(dry.status, dry.stale ? "STALE" : "REFUSED", dry.error);

    // Текст, который прочитает монтажёр, — собирает та же функция, что и настоящая отправка.
    const message = await buildMontajerMessageText(property.id, { reason: body.reason, comment: body.comment ?? null });
    const channels = snap.publishedChannels.join(", ");
    return {
      title: `Перемонтаж ролика ${code}`,
      was: {
        Объект: `${code} · ${plainField(property.address, 80) ?? plainField(property.title, 80) ?? ""}`.trim(),
        "Ролик вышел в": channels || "нигде не отмечен",
        "Возвратов на перемонтаж": snap.videoRemakeCount,
      },
      becomes: {
        Причина: VIDEO_REMAKE_REASON_LABELS[body.reason],
        ...(body.comment ? { Комментарий: plainField(body.comment, 300) } : {}),
        "Текст монтажёру": plainField(message, 700),
        "Старый ролик": body.removeFromSocial
          ? "будет снят из соцсетей до передачи монтажёру"
          : "останется в соцсетях, пока не выйдет новый",
      },
      risk:
        "НЕОБРАТИМО: монтажёр получит задание, объект встанет в его очередь, прежний ролик пойдёт на переделку" +
        (body.removeFromSocial ? "; посты будут сняты (Instagram и TikTok — только руками)." : "."),
      irreversible: true,
    };
  },

  async execute(args: Args, actor: AssistantActionActor, ctx: { actionId: string; snapshotBefore: Record<string, unknown> }) {
    const before = ctx.snapshotBefore as Snap;
    const sender = await actorWithRole(actor);
    const outcome = await sendPropertyBackToMontajerAs({
      propertyId: before.propertyId,
      actor: sender,
      body: toBody(args),
      source: "crm",
      guard: { videoRemakeCount: before.videoRemakeCount },
      auditSource: { source: "assistant", actionId: ctx.actionId, tool: "send_to_remake" },
    });
    if (!outcome.ok) {
      if (outcome.stale) throw new AssistantActionError(409, "STALE", outcome.error, { stale: true });
      throw new AssistantActionError(outcome.status, "REFUSED", outcome.error);
    }
    const { result } = outcome;
    return {
      result: {
        queued: result.queued,
        message: result.message,
        propertyShortId: before.shortId,
        href: propertyHref(before.shortId),
        ...(result.social ? { socialRemoved: result.social.removed, socialManual: result.social.manual.map((m) => m.channel) } : {}),
      },
      audit: { entityType: "Property", entityId: before.propertyId },
    };
  },
};

export const sendToRemakePlugin: AssistantWriteToolPlugin = {
  name: "send_to_remake",
  level: "C",
  description:
    "Вернуть ролик объекта монтажёру на ПЕРЕМОНТАЖ с причиной (НЕОБРАТИМО: монтажёр получит задание). " +
    "Звать, когда просят «отправь ОБ-88 на перемонтаж», «ролик неправильный, верни монтажёру». " +
    "Причина обязательна: WRONG_CAPTION (неверная надпись), NO_MUSIC, WRONG_OBJECT, POOR_EDIT, CARD_DATA_CHANGED " +
    "(данные карточки изменились), OTHER; для OTHER и WRONG_CAPTION нужен comment. removeFromSocial=true — снять " +
    "старый ролик из соцсетей (только маркетинг/директор/админ). НЕ звать для смены цены или данных (это заявки) " +
    "и для объектов, у которых ролика ещё не было. После вызова ответь одной фразой: «Подтвердите — это необратимо».",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: "Номер объекта: «ОБ-000088», «88» или id" },
      reason: { type: "string", enum: [...VIDEO_REMAKE_REASONS], description: "Причина перемонтажа" },
      comment: { type: "string", description: "Комментарий монтажёру; обязателен для OTHER и WRONG_CAPTION" },
      removeFromSocial: { type: "boolean", description: "Снять старый ролик из соцсетей перед передачей (по умолчанию нет)" },
    },
    required: ["ref", "reason"],
  },
  statusPhrase: "Готовлю возврат ролика монтажёру…",
  allowed: (actor) => !isReadOnlyRole(actor.role),
  executor: sendToRemakeExecutor as unknown as AssistantWriteToolPlugin["executor"],
};
