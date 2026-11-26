import { z } from "zod";
import { prisma } from "../db.js";
import { logSystemError } from "../lib/systemError.js";
import { narrationRemixPending } from "../lib/narrationAutoFlow.js";
import { isHandoffPublishRunning } from "../lib/videoHandoff.js";
import { loadUsdRateInfo } from "../lib/money.js";
import { propertyPriceTjs } from "@royal-home/shared";
import {
  PRICE_DROP_STORY_MAX_ATTEMPTS,
  PROPERTY_STATUS_STORY_JOB_TYPE,
  isStoryKeyDead,
  priceDropVoiceCheck,
  publishPropertyPriceDropStory,
  publishPropertySoldStory,
  soldStoryEverPublished,
} from "../lib/instagramStories.js";
import { automationSwitchOn } from "../lib/automationSwitches.js";
import type { JobHandler } from "./registry.js";

/**
 * ИСТОРИЯ-РОЛИК «ЦЕНА СНИЖЕНА» / «ПРОДАНО» (25.11.2026, владелец: «подождать, когда ролик приготовится, и наложить
 * цена снижена, продано»). Ставится из lib/instagramStories.ts (queuePropertyPriceDropStory / queuePropertySoldStory).
 *
 * «Цена снижена»: пока CRM накладывает на ролик новую озвучку (с новой ценой в голосе — `narrationRemixPending`),
 * задание ждёт: бросает ошибку и очередь повторяет его через `backoff`; на последней попытке публикует всё равно,
 * чтобы история не пропала из-за застрявшей озвучки. Дальше — готовый ролик с карточкой первые секунды, а если
 * ролика нет или он не подошёл — обычная фото-карточка (lib/instagramStories.ts::publishCardStory).
 *
 * Идемпотентность: публикация проверяет суточный ограничитель по (объект, вид, канал) и сама записывает
 * PropertyStoryPost; повтор после успеха ничего не выложит второй раз.
 *
 * АВТОИСТОРИЯ «ПРОДАНО» (26.11.2026, `auto`): ставится при продаже (instagramStories.ts::queueAutoPropertySoldStory).
 * Перед публикацией заново: выключатель storySoldAutoEnabled, статус SOLD, «продано» по объекту ещё не выходило
 * (один раз на объект). Без `force` — рубильник автоисторий и суточный ограничитель решает сама публикация.
 *
 * МЁРТВЫЙ КЛЮЧ (401/190, дверь #432): повтора нет ни у одного вида — каждый повтор снова встречал бы Meta мёртвым
 * ключом. Отметку и тревогу ставит дверь; здесь одна строка журнала на эпизод.
 */
const schema = z.object({
  propertyId: z.string(),
  kind: z.enum(["PRICE_DROP", "SOLD"]),
  priceWasText: z.string().nullable(),
  priceWasTjs: z.number().nullable().optional(),
  queuedAt: z.number(),
  force: z.boolean().optional(),
  /** Поставлено автоматически при продаже (не кнопкой). */
  auto: z.boolean().optional(),
});
type Payload = z.infer<typeof schema>;

/** Ждать озвучку или публиковать: чистое решение, вынесено ради теста без базы. */
export function storyJobDecision(input: {
  kind: "PRICE_DROP" | "SOLD";
  remixPending: boolean;
  /** Идёт публикация нового ролика (после перемикса): история должна выйти ПОСЛЕ неё, а не раньше. */
  publishRunning?: boolean;
  /** Есть озвучка новее той, что звучит в ролике (ждёт утверждения или наложения, instagramStories::priceDropVoiceCheck). */
  narrationNewerPending?: boolean;
  attempt: number;
  maxAttempts: number;
}): "WAIT" | "PUBLISH" {
  if (input.kind !== "PRICE_DROP") return "PUBLISH";
  return (input.remixPending || input.publishRunning || input.narrationNewerPending) && input.attempt < input.maxAttempts ? "WAIT" : "PUBLISH";
}

export const propertyStatusStoryJob: JobHandler<Payload> = {
  type: PROPERTY_STATUS_STORY_JOB_TYPE,
  schema,
  // ffmpeg до 4 минут + ожидание обработки у Meta до 5 минут на Instagram и столько же на Facebook, и фото-запасной путь.
  timeoutMs: 20 * 60_000,
  backoff: () => 3 * 60_000,
  async run(payload, context) {
    const property = await prisma.property.findUnique({
      where: { id: payload.propertyId },
      select: { status: true, deletedAt: true, price: true, currency: true },
    });
    if (!property || property.deletedAt) return;
    // «Цена снижена» по объекту, который уже продан или снят, — враньё на картинке.
    if (payload.kind === "PRICE_DROP" && property.status !== "AVAILABLE") return;
    if (payload.kind === "PRICE_DROP" && payload.priceWasTjs) {
      // Цену успели поднять обратно (повторные снижения схлопываются, остаётся первая «была»): снижения уже нет.
      const rate = property.currency === "USD" ? (await loadUsdRateInfo()).rate : null;
      const nowTjs = propertyPriceTjs(property.price, property.currency, rate);
      if (nowTjs !== null && nowTjs >= payload.priceWasTjs) return;
    }
    // Повтор «продано» после частичного успеха (таймаут, подбор упавшего задания) ничего не выкладывает второй раз:
    // `force` обходит только рубильник и суточный ограничитель, а не то, что история этого задания уже вышла.
    // Автоистория «продано»: выключили, пока ждала паузу, или «продано» по объекту уже выходило — ничего не делаем.
    if (payload.kind === "SOLD" && payload.auto && !payload.force) {
      if (!(await automationSwitchOn("storySoldAutoEnabled"))) return;
      if (await soldStoryEverPublished(payload.propertyId)) return;
    }
    if (payload.kind === "SOLD") {
      const done = await prisma.propertyStoryPost.findFirst({
        where: { propertyId: payload.propertyId, kind: "SOLD", channel: "INSTAGRAM", publishedAt: { gte: new Date(payload.queuedAt - 1000) } },
        select: { id: true },
      });
      if (done) return;
    }

    const attempt = context?.attempt ?? 1;
    const priceDrop = payload.kind === "PRICE_DROP";
    const decision = storyJobDecision({
      kind: payload.kind,
      remixPending: priceDrop ? await narrationRemixPending(payload.propertyId) : false,
      publishRunning: priceDrop ? await isHandoffPublishRunning(payload.propertyId) : false,
      narrationNewerPending: priceDrop ? (await priceDropVoiceCheck(payload.propertyId)) === "WAIT_NEWER" : false,
      attempt,
      maxAttempts: PRICE_DROP_STORY_MAX_ATTEMPTS,
    });
    if (decision === "WAIT") throw new Error("озвучка с новой ценой ещё не легла в ролик — историю выложим следом");

    // «Продано» — статус перечитывается прямо перед публикацией (ревью #445): задание ждёт в очереди минуты,
    // за это время продажу могли отменить, и печать «Продано» на живом объекте была бы враньём.
    if (payload.kind === "SOLD") {
      const fresh = await prisma.property.findUnique({ where: { id: payload.propertyId }, select: { status: true, deletedAt: true, offSite: true } });
      if (!fresh || fresh.deletedAt || fresh.status !== "SOLD") return;
      // Объект стал «только для своих», пока задание ждало, — частный объект в истории не выкладываем.
      if (fresh.offSite) return;
    }

    const summary =
      payload.kind === "PRICE_DROP"
        ? await publishPropertyPriceDropStory(payload.propertyId, payload.priceWasText ?? "", payload.priceWasTjs ?? null, { video: true })
        : await publishPropertySoldStory(payload.propertyId, { force: payload.force ?? false, video: true });
    // История уже ждёт обработки у Meta: её дозавершит фоновый проход контейнеров. Повтор здесь выложил бы вторую.
    if (summary.pending) return;
    // Мёртвый ключ: повтор встретил бы Meta тем же ключом. Дверь #432 уже отметила аккаунт и подняла тревогу.
    if (isStoryKeyDead(summary)) {
      void logSystemError(
        "meta",
        `История «${payload.kind === "SOLD" ? "продано" : "цена снижена"}» (объект ${payload.propertyId}) не вышла: ключ Instagram не принят — повторять не будем, нужно «Заменить маркер»`,
        { dedupKey: `property-status-story-key-dead:${payload.kind}:${payload.propertyId}` }
      );
      return;
    }
    // Ничего не вышло и причина названа (Meta отказала, нет токена) — повтор через backoff; «выключено/уже было» — не ошибка.
    if (summary.attempted && summary.publishedParts === 0 && summary.error) throw new Error(summary.error);
  },
  async onGiveUp(payload) {
    await logSystemError(
      "meta",
      `История «${payload.kind === "SOLD" ? "продано" : "цена снижена"}» (объект ${payload.propertyId}) не вышла после всех попыток`,
      { dedupKey: `property-status-story-give-up:${payload.kind}:${payload.propertyId}` }
    );
  },
};
