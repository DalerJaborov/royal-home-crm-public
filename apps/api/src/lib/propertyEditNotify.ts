import { formatShortCode } from "@royal-home/shared";
import { prisma } from "../db.js";
import { sendPushToAgents } from "../push.js";
import { describeError } from "./describeError.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import type { PropertyFieldChange } from "./propertyChanges.js";
import { CAPTION_FACT_FIELDS } from "./publishedVideoFix.js";
import { findAgentsWithPermission } from "./recipients.js";
import { logSystemError } from "./systemError.js";
import { propertyFactsForMontajer, recordMontajerMessage } from "./videoHandoff.js";
import { sendToMontajer } from "./montageObservers.js";

/**
 * ПРАВКА ОБЪЕКТА ДО ПУБЛИКАЦИИ — КОМУ СООБЩИТЬ (владелец 07.10.2026).
 *
 * До публикации агент правит карточку свободно (замок только после неё, см.
 * @royal-home/shared propertyEditLock). Чтобы это не давало ролик с одними
 * цифрами и карточку с другими, правка сообщается тому, у кого объект сейчас:
 *
 * - на проверке (PENDING_REVIEW) — модераторам: карточка изменилась после отправки;
 * - на монтаже у монтажёра (SENT_TO_EDITOR) — монтажёру в Telegram «было → стало»,
 *   копия наблюдателям уходит сама (sendToMontajer); сохранённые «факты прошлой
 *   передачи» обновляются, иначе следующий diff «Что изменилось в карточке»
 *   считался бы от устаревшего;
 * - в очереди (QUEUED) — никому: buildMontajerMessageText читает факты из базы в
 *   момент отправки, монтажёр получит уже правильные;
 * - ролик уже получен и ждёт проверки или слота — модераторам и директору:
 *   цифры в кадре могли устареть, решает человек (вернуть монтажёру или нет).
 *
 * Ничего здесь не блокирует ответ PATCH: зовущий код не ждёт, любой отказ уходит
 * в журнал ошибок, а не в 500.
 */

const EXTERNAL_CALL_TIMEOUT_MS = 20_000;

/** Поля, о правке которых стоит сообщать: цена и всё, что стоит в подписи ролика. */
const VISIBLE_FIELDS: ReadonlySet<string> = new Set(["price", "currency", ...CAPTION_FACT_FIELDS]);

/** Поля, которые видны ВНУТРИ готового ролика (монтажёр набирает их в кадр). */
const FRAME_FIELDS: ReadonlySet<string> = new Set(["price", "currency", "areaSqm", "rooms", "floor", "totalFloors"]);

/** Статусы очереди монтажа, при которых готовый ролик уже у нас. */
function clipAlreadyReceived(p: { videoHandoffStatus: string; clipReviewStatus: string }): boolean {
  return p.videoHandoffStatus === "RECEIVED" || p.clipReviewStatus === "PENDING" || p.clipReviewStatus === "APPROVED";
}

export interface PropertyEditNotifyInput {
  before: {
    id: string;
    shortId: number;
    title: string;
    status: string;
    currency: string;
    videoHandoffStatus: string;
    clipReviewStatus: string;
  };
  after: { status: string; currency: string };
  /** Результат describePropertyChanges (уже «было → стало» человеческими словами). */
  changes: PropertyFieldChange[];
  actorId: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`таймаут ${ms} мс`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/** Строки «Цена: 50000 USD → 55000 USD; Этаж: 3 → 4» — только видимые поля. Пусто — сообщать нечего. */
export function visibleChangeLines(
  changes: PropertyFieldChange[],
  currencies: { before: string; after: string }
): { lines: string[]; frameChanged: boolean } {
  const visible = changes.filter((c) => VISIBLE_FIELDS.has(c.field));
  const priceChanged = visible.some((c) => c.field === "price");
  const lines: string[] = [];
  for (const c of visible) {
    if (c.field === "price") {
      lines.push(`${c.label}: ${c.was} ${currencies.before} → ${c.becomes} ${currencies.after}`);
    } else if (c.field === "currency" && priceChanged) {
      // Валюта уже показана рядом с суммой — отдельной строкой не дублируем.
      continue;
    } else {
      lines.push(`${c.label}: ${c.was} → ${c.becomes}`);
    }
  }
  return { lines, frameChanged: visible.some((c) => FRAME_FIELDS.has(c.field)) };
}

async function notifyModerators(
  propertyId: string,
  shortId: number,
  title: string,
  body: string,
  actorId: string,
  tag: string
): Promise<void> {
  const moderators = (await findAgentsWithPermission("properties.moderate")).filter((id) => id !== actorId);
  if (moderators.length === 0) return;
  await sendPushToAgents(moderators, { kind: "task", title, body, url: `/properties/${shortId}`, tag: `${tag}-${propertyId}` });
}

/** Монтажёру в Telegram: «⚠️ В карточке ОБ-… изменилось: …». Нет адресата — не молчим. */
async function notifyMontajerFactsChanged(input: PropertyEditNotifyInput, summary: string): Promise<void> {
  const { before } = input;
  const code = formatShortCode("ОБ", before.shortId);
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } });
  const montajer = settings?.videoMontajerAgentId
    ? await prisma.agent.findFirst({
        where: { id: settings.videoMontajerAgentId, isActive: true },
        select: { telegramChatId: true },
      })
    : null;
  const text = `⚠️ В карточке ${code} изменилось: ${summary}. Учтите в монтаже.`;

  if (!montajer?.telegramChatId) {
    // Монтажёр держит объект, а написать ему нельзя — это должен узнать человек.
    void logSystemError(
      "video-handoff",
      `Объект ${code}: карточка изменена, пока ролик у монтажёра, но монтажёр не назначен или не привязал Telegram — предупредить некого (${summary})`
    );
    await enqueueDirectorAlert({
      title: `${code}: правка на монтаже, монтажёр не получил`,
      body: `${summary}. Сообщите монтажёру сами.`,
      url: `/properties/${before.shortId}`,
      kind: "task",
      tag: `property-edit-montajer-unreachable-${before.id}`,
      recipientRoles: ["DIRECTOR", "ADMIN"],
    });
    return;
  }

  await withTimeout(sendToMontajer(montajer.telegramChatId, text, { copy: true, propertyShortId: before.shortId }), EXTERNAL_CALL_TIMEOUT_MS);
  await recordMontajerMessage(before.id, "FACTS_CHANGED", text);
  // Следующий «Что изменилось в карточке» (перемонтаж) считается от этих фактов.
  const facts = await propertyFactsForMontajer(before.id);
  if (facts) {
    await prisma.property.updateMany({
      where: { id: before.id, videoHandoffStatus: "SENT_TO_EDITOR" },
      data: { videoHandoffLastFactsText: facts },
    });
  }
}

/**
 * Вызывать после успешного PATCH, если статус объекта не менялся в этом же
 * запросе. Никогда не бросает.
 */
export async function notifyPropertyEditedBeforePublish(input: PropertyEditNotifyInput): Promise<void> {
  try {
    const { before, after, actorId } = input;
    if (before.status !== after.status) return;
    if (before.status !== "PENDING_REVIEW" && before.status !== "EDITING") return;

    const { lines, frameChanged } = visibleChangeLines(input.changes, { before: before.currency, after: after.currency });
    if (lines.length === 0) return;
    const summary = lines.join("; ");
    const code = formatShortCode("ОБ", before.shortId);

    if (before.status === "PENDING_REVIEW") {
      await notifyModerators(
        before.id,
        before.shortId,
        `${code} изменена после отправки на проверку`,
        summary,
        actorId,
        "property-edited-review"
      );
      return;
    }

    // EDITING
    if (before.videoHandoffStatus === "SENT_TO_EDITOR") {
      await notifyMontajerFactsChanged(input, summary);
      return;
    }
    if (before.videoHandoffStatus === "QUEUED") return; // текст соберётся свежим при отправке

    if (clipAlreadyReceived(before) && frameChanged) {
      const body = `Цифры в ролике могут быть устаревшими (${summary}). Вернуть монтажёру?`;
      await notifyModerators(before.id, before.shortId, `${code}: правка после готового ролика`, body, actorId, "property-edited-clip");
      await enqueueDirectorAlert({
        title: `${code}: правка после готового ролика`,
        body,
        url: `/properties/${before.shortId}`,
        kind: "task",
        tag: `property-edited-clip-dir-${before.id}`,
        recipientRoles: ["DIRECTOR", "ADMIN"],
        excludeAgentId: actorId,
      });
    }
  } catch (err) {
    void logSystemError("video-handoff", `Объект ${input.before.id}: уведомление о правке до публикации не ушло: ${describeError(err)}`);
  }
}

export type SourceFilesChange = "photos" | "video";

/**
 * Фото или видео-исходники изменены (загрузка, удаление): монтажёру — если ролик
 * у него, модераторам — если объект на проверке и этот материал уже был одобрен
 * (одобрение сбрасывается: модератор увидит объект на повторной проверке).
 * Никогда не бросает.
 */
export async function notifySourceFilesChanged(
  propertyId: string,
  material: SourceFilesChange,
  what: string,
  actorId: string
): Promise<void> {
  try {
    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: {
        id: true,
        shortId: true,
        title: true,
        status: true,
        currency: true,
        videoHandoffStatus: true,
        clipReviewStatus: true,
        photosApprovedAt: true,
        videoApprovedAt: true,
        deletedAt: true,
      },
    });
    if (!property || property.deletedAt) return;
    const code = formatShortCode("ОБ", property.shortId);
    const label = material === "photos" ? "фото" : "видео-исходники";
    const summary = `${what} (${label})`;

    if (property.status === "PENDING_REVIEW") {
      const stamp = material === "photos" ? property.photosApprovedAt : property.videoApprovedAt;
      if (!stamp) return; // одобрения не было — модератор и так увидит свежие файлы
      await prisma.property.updateMany({
        where: { id: property.id, status: "PENDING_REVIEW" },
        data: material === "photos" ? { photosApprovedAt: null } : { videoApprovedAt: null },
      });
      await notifyModerators(
        property.id,
        property.shortId,
        `${code}: материал изменён после одобрения`,
        `${summary} — одобрение снято, нужна повторная проверка`,
        actorId,
        "property-edited-files"
      );
      return;
    }

    if (property.status === "EDITING" && property.videoHandoffStatus === "SENT_TO_EDITOR") {
      await notifyMontajerFactsChanged(
        {
          before: { ...property, currency: property.currency },
          after: { status: property.status, currency: property.currency },
          changes: [],
          actorId,
        },
        `исходные файлы — ${summary}`
      );
    }
  } catch (err) {
    void logSystemError("video-handoff", `Объект ${propertyId}: уведомление об изменении файлов не ушло: ${describeError(err)}`);
  }
}
