import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { isYoutubeScopeError, reportYoutubeScopeMissing } from "./youtubeScope.js";
import { decryptSecretSafe } from "../crypto.js";
import { formatPrice } from "../ai/seoGenerator.js";
import { loadMoneyContext, toTjs } from "./money.js";
import { buildPriceDisplay } from "./reelsCaptionTemplate.js";
import { loadCredentials } from "../messengers/meta.js";
import { editMessageCaption } from "../telegram/api.js";
import { updateFacebookVideoDescription, updateYouTubeDescription, type YouTubeCredentials } from "./socialPublish.js";
import { resyncPhotosIfPublished } from "./siteSync.js";
import { publishPropertyPriceDropStory } from "./instagramStories.js";
import { formatShortCode } from "@royal-home/shared";
import { logSystemAudit } from "./audit.js";
import { sendPushToAgent } from "../push.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";

/**
 * Подпись правили руками — цену в ней автоматически не заменить. Тихо оставить
 * старую цену нельзя: ролик выйдет с ней (владелец 07.10.2026). Пишем в историю
 * объекта и зовём ответственного и руководство — а не в журнал ошибок, который
 * они не читают.
 */
async function reportCaptionNeedsManualFix(property: {
  id: string;
  shortId: number;
  assignedAgentId: string | null;
  intakeAgentId: string | null;
  createdById: string | null;
}): Promise<void> {
  const code = formatShortCode("ОБ", property.shortId);
  logSystemAudit("PROPERTY_FIELDS_CHANGED", "Property", property.id, {
    shortId: property.shortId,
    changes: [
      {
        field: "reelsCaption",
        label: "Подпись к ролику",
        was: "старая цена в тексте",
        becomes: "цену в подписи нужно поправить руками",
      },
    ],
  });
  const body = "Цена изменилась, а в подписи к ролику старой цены нет дословно — поправьте цену в подписи вручную, иначе ролик выйдет со старой.";
  const url = `/properties/${property.shortId}`;
  const responsible = property.assignedAgentId ?? property.intakeAgentId ?? property.createdById;
  if (responsible) {
    await sendPushToAgent(responsible, { kind: "task", title: `${code}: поправьте цену в подписи`, body, url, tag: `property-caption-manual-${property.id}` });
  }
  await enqueueDirectorAlert({
    title: `${code}: цену в подписи править руками`,
    body,
    url,
    kind: "task",
    tag: `property-caption-manual-dir-${property.id}`,
    recipientRoles: ["DIRECTOR", "ADMIN"],
  });
}

/**
 * Цена поменялась на уже опубликованном объекте (владелец, 16.09.2026: «цена
 * снизилась, а пост не надо добавлять второй раз», и вторым заходом — «описание
 * на сайте не меняется») — правим текст и на сайте (description), и в уже
 * вышедших постах соцсетей (reelsCaption), а не публикуем дубль. Числовую цену
 * на сайте и так досылает существующий site-resync при любой правке карточки
 * (siteSync.ts, аудит №4 27.08) — этот файл чинит ПРОЗУ, которая называет цену
 * словами внутри текста и не пересчитывается сама по себе.
 *
 * ПОЧЕМУ НЕ ЗАНОВО ЗОВЁМ ИИ. Подпись уже содержит цену в ТОЧНОМ виде, в каком
 * её напечатал formatPrice в момент публикации (см. ai/reelsCaptionAi.ts —
 * "✅Цена: {formatPrice(...)}"), — просто заменяем старую отформатированную
 * строку на новую тем же форматом. Дёшево, детерминированно, и не рискует
 * hook/closing: их вообще не трогаем.
 *
 * ИНСТАГРАМ СЮДА НЕ ВХОДИТ. Instagram Graph API не даёт редактировать caption
 * уже опубликованного ig-media (Updating поддерживает только comment_enabled,
 * проверено 16.09.2026 по официальной документации Meta for Developers,
 * developers.facebook.com/docs/instagram-platform/reference/instagram-media —
 * раздел Updating). Единственный путь — переписать текст ВНУТРИ видео (то,
 * что видно в кадре), а это снова работа монтажёра, не автоматизация. Молчать
 * об этом было бы хуже, чем сказать прямо — пишем в журнал, чтобы кто-то
 * поправил вручную, если Instagram для этого объекта важен.
 */
/**
 * Итог посылки цены в посты — для исполнителя заявок на изменение (07.10.2026,
 * lib/propertyChangeExecutor.ts): `failed` — каналы, которые МОГЛИ обновиться
 * (Facebook/Telegram/YouTube), но отказали; Instagram/Threads сюда не входят — их
 * подпись через API менять нельзя вовсе, это «руками» и считается по `publishedChannels`.
 * Прежние вызывающие (PATCH карточки) результат не читают.
 */
export interface PriceSyncResult {
  /** Каналы, где подпись реально обновилась (FACEBOOK / TELEGRAM / YOUTUBE). */
  updated: string[];
  /** Отказы площадок и сбои: канал («—» для общего сбоя) и текст. */
  failed: { channel: string; error: string }[];
  /** Подпись не трогали и почему (правили руками, старой цены в ней нет) — пост остаётся со старой ценой. */
  skipped: string | null;
  /** Старой цены в сохранённой подписи дословно нет (её правили руками): подпись не тронута, поправить должен человек. */
  captionNeedsManualFix: boolean;
}

export async function syncPublishedPriceChange(
  propertyId: string,
  oldPrice: number,
  oldCurrency: string
): Promise<PriceSyncResult> {
  const result: PriceSyncResult = { updated: [], failed: [], skipped: null, captionNeedsManualFix: false };
  try {
    const property = await prisma.property.findUnique({ where: { id: propertyId } });
    if (!property || property.deletedAt) return result;

    const money = await loadMoneyContext();

    // САЙТ: property.description — независимо от соцсетей ниже (объект может
    // быть опубликован на сайте, но не в соцсетях, и наоборот). Владелец,
    // 16.09.2026, второй заход: «описание на сайте не меняется». Текст сайта
    // всегда в сомони (routes/properties/crud.ts, тот же день, более ранний
    // фикс) — считаем старую и новую цену В СОМОНИ по текущему курсу и меняем
    // подстроку, та же безопасная точная замена, что и в подписи ниже.
    if (property.publishedOnSite && property.description) {
      const oldPriceTjsText = formatPrice(toTjs(oldPrice, oldCurrency, money), "TJS");
      const newPriceTjsText = formatPrice(toTjs(Number(property.price), property.currency, money), "TJS");
      if (oldPriceTjsText !== newPriceTjsText && property.description.includes(oldPriceTjsText)) {
        const newDescription = property.description.split(oldPriceTjsText).join(newPriceTjsText);
        await prisma.property.update({ where: { id: propertyId }, data: { description: newDescription } });
        // Резонанс после записи, не до — site-resync иначе мог бы уйти со
        // старым текстом, если очередь заберёт задание раньше, чем допишется update.
        void resyncPhotosIfPublished(propertyId, "цена изменилась — описание пересчитано в сомони");
      }
    }

    // ИСТОРИЯ «ЦЕНА СНИЖЕНА» (владелец, 21.09.2026) — независимо от того, есть ли
    // reelsCaption и опубликован ли объект в соцсетях (проверка ниже про это);
    // сравнение — В СОМОНИ по текущему курсу, тем же способом, что и для описания
    // сайта выше, потому что валюта объекта могла быть сменена вместе с ценой.
    // ТОЛЬКО снижение — рост цены не публикуем (это не новость для покупателя, а
    // «опоздал», владелец просил именно так). Ждать не приходится: если цена не
    // изменилась в сомони, toTjs(oldPrice) === toTjs(newPrice) и условие ложно.
    const oldPriceTjs = toTjs(oldPrice, oldCurrency, money);
    const newPriceTjs = toTjs(Number(property.price), property.currency, money);
    // Только объект В ПРОДАЖЕ (находка №194): у зарезервированного, снятого, проданного
    // и ещё готовящегося объекта «цена снижена» — ложная новость для подписчиков.
    if (newPriceTjs < oldPriceTjs && property.status === "AVAILABLE") {
      // await, не void — publishPropertyPriceDropStory сама не бросает исключений
      // (все отказы уходят в logSystemError и возвращаются в summary), а вызывающая
      // сторона (routes/properties/crud.ts) и так уже зовёт syncPublishedPriceChange
      // через void — второй уровень fire-and-forget внутри только усложнил бы тесты
      // гонкой между записью PropertyStoryPost и проверкой в вызывающем коде.
      await publishPropertyPriceDropStory(propertyId, buildPriceDisplay(oldPrice, oldCurrency, money));
    }

    // ПОДПИСЬ В БАЗЕ ПЕРЕПИСЫВАЕТСЯ ВСЕГДА, и у неопубликованного объекта тоже
    // (владелец 07.10.2026): иначе агент меняет цену на проверке или на монтаже,
    // а ролик выходит с подписью, в которой стоит старая. Рассылка в сети ниже —
    // только у тех, кто уже вышел.
    if (!property.reelsCaption) return result;

    // Подпись соцсетей — та же двойная валюта, что при публикации (владелец,
    // 17.09.2026: «$113 350» → «1 050 755 с. ($113 350)»): для USD-объекта
    // buildPriceDisplay даёт ВСЮ строку целиком (сомони + доллары в скобках),
    // а не только долларовую часть — иначе замена оставляла бы в тексте
    // пересчёт по старому курсу рядом с новой суммой в долларах.
    const oldPriceText = buildPriceDisplay(oldPrice, oldCurrency, money);
    const newPriceText = buildPriceDisplay(Number(property.price), property.currency, money);
    if (oldPriceText === newPriceText) return result;
    // Подпись правили руками, и старой цены в ней дословно нет — лучше не трогать
    // чужую правку вслепую, чем испортить текст неточной заменой. Но и промолчать
    // нельзя: ответственный и руководство узнают, что цену надо поправить руками.
    if (!property.reelsCaption.includes(oldPriceText)) {
      result.skipped = "подпись правили руками — старой цены в ней нет, пост остался как был";
      result.captionNeedsManualFix = true;
      await reportCaptionNeedsManualFix(property);
      return result;
    }

    const newCaption = property.reelsCaption.split(oldPriceText).join(newPriceText);
    await prisma.property.update({ where: { id: propertyId }, data: { reelsCaption: newCaption } });

    if (!property.publishedChannels || property.publishedChannels.length === 0) return result;

    const channels = property.publishedChannels as string[];
    const postIds = (property.publishedPostIds ?? {}) as Record<string, string>;
    // ДОПОЛНИТЕЛЬНЫЕ ЧАТЫ TELEGRAM (26.09.2026) — тот же publishedPostIds, но
    // вложенный объект { chatId: messageId }, а не строка, поэтому отдельное
    // приведение типа. Правим их тем же editMessageCaption, что и основной
    // канал ниже — «message is not modified» уже не отказ там (см. докстринг
    // telegram/api.ts::editMessageCaption), приём общий для всех chat_id.
    const telegramExtraIds = (property.publishedPostIds as Record<string, unknown> | null)?.TELEGRAM_EXTRA as
      | Record<string, string>
      | undefined;
    const errors: string[] = [];

    if (channels.includes("INSTAGRAM")) {
      errors.push(
        "Instagram: подпись у опубликованного Reels нельзя поменять через API (Meta не разрешает) — поправьте цену в тексте видео и подписи вручную, если это важно"
      );
    }

    // THREADS (23.09.2026) — тем же доводом, что Instagram: площадка не даёт
    // редактировать текст опубликованного поста вовсе (см. докстринг
    // deleteThreadsPost в lib/socialPublish.ts).
    if (channels.includes("THREADS")) {
      errors.push(
        "Threads: подпись у опубликованного поста нельзя поменять через API (площадка не разрешает) — поправьте цену в тексте вручную, если это важно"
      );
    }

    if (channels.includes("FACEBOOK") && postIds.FACEBOOK) {
      const creds = await loadCredentials();
      if (creds.pageToken) {
        const fb = await updateFacebookVideoDescription(postIds.FACEBOOK, creds.pageToken, newCaption);
        if (!fb.ok) {
          errors.push(`Facebook: ${fb.error}`);
          result.failed.push({ channel: "FACEBOOK", error: String(fb.error) });
        } else result.updated.push("FACEBOOK");
      }
    }

    if (channels.includes("TELEGRAM")) {
      if (postIds.TELEGRAM) {
        const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { telegramChannelId: true } });
        if (settings?.telegramChannelId) {
          try {
            await editMessageCaption(settings.telegramChannelId, Number(postIds.TELEGRAM), newCaption);
            result.updated.push("TELEGRAM");
          } catch (err) {
            errors.push(`Telegram: ${err instanceof Error ? err.message : String(err)}`);
            result.failed.push({ channel: "TELEGRAM", error: err instanceof Error ? err.message : String(err) });
          }
        }
      }
      // Дополнительные чаты — отказ одного не мешает остальным и не ломает
      // правку основного канала выше (владелец 24.09.2026: не ломать существующее).
      if (telegramExtraIds) {
        for (const [chatId, messageId] of Object.entries(telegramExtraIds)) {
          if (!messageId) continue;
          try {
            await editMessageCaption(chatId, Number(messageId), newCaption);
            if (!result.updated.includes("TELEGRAM")) result.updated.push("TELEGRAM");
          } catch (err) {
            errors.push(`Telegram (доп. чат ${chatId}): ${err instanceof Error ? err.message : String(err)}`);
            result.failed.push({
              channel: "TELEGRAM",
              error: `доп. чат ${chatId}: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      }
    }

    if (channels.includes("YOUTUBE") && postIds.YOUTUBE) {
      const settings = await prisma.settings.findUnique({
        where: { id: "singleton" },
        select: { youtubeClientId: true, youtubeClientSecret: true, youtubeRefreshToken: true },
      });
      const creds: YouTubeCredentials = {
        clientId: settings?.youtubeClientId ?? undefined,
        clientSecret: decryptSecretSafe(settings?.youtubeClientSecret ?? null) ?? undefined,
        refreshToken: decryptSecretSafe(settings?.youtubeRefreshToken ?? null) ?? undefined,
      };
      // Заголовок YouTube — первая строка подписи (то же правило, что при
      // публикации в publishApprovedPost/publishYouTubeShort, там title = caption).
      const yt = await updateYouTubeDescription(creds, postIds.YOUTUBE, newCaption, newCaption);
      // Нет права у ключа — общая суточная строка (lib/youtubeScope.ts), не строка на объект.
      if (!yt.ok && isYoutubeScopeError(yt.error)) {
        reportYoutubeScopeMissing();
        result.failed.push({ channel: "YOUTUBE", error: "у ключа YouTube нет права менять описание" });
      } else if (!yt.ok) {
        errors.push(`YouTube: ${yt.error}`);
        result.failed.push({ channel: "YOUTUBE", error: String(yt.error) });
      } else result.updated.push("YOUTUBE");
    }

    if (errors.length > 0) {
      void logSystemError(
        "meta",
        `Объект ${propertyId}: цена изменилась, обновление в опубликованных постах — ${errors.join("; ")}`
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    result.failed.push({ channel: "—", error: `синхронизация упала: ${reason}` });
    void logSystemError(
      "meta",
      `Объект ${propertyId}: синхронизация новой цены в опубликованные посты упала: ${reason}`
    );
  }
  return result;
}
