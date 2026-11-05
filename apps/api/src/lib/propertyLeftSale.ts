import { closeVideoHandoff } from "./videoHandoff.js";
import { removePropertyPhotoPosts } from "./photoPosts.js";
import { removePropertySocialReposts } from "./socialReposts.js";
import { retireSocialAfterSale } from "./propertySoldSocial.js";
import { cancelFutureShowingsForOffSale } from "./trashProperty.js";
import { describeError } from "./describeError.js";
import { logSystemError } from "./systemError.js";

/**
 * ОБЪЕКТ УШЁЛ С ПРОДАЖИ — ОДНА ФУНКЦИЯ НА ВСЕ ПУТИ (02.10.2026, аудит «Проданный объект»).
 *
 * Объект становится проданным/снятым/в резерве по четырём путям: ручная правка
 * статуса (PATCH /properties/:id), закрытие сделки и её создание
 * (routes/deals.ts) и ночная сверка (lib/propertyAutoStatus.ts). До правки
 * соц-посты, повторы, место монтажёра и будущие показы гасились только в PATCH:
 * объект, проданный сделкой, продолжал светиться в Instagram/Facebook/Telegram,
 * держал монтажёра, а клиенту приходило «завтра показ» проданной квартиры.
 *
 * Всё best-effort и фоном: статус уже записан, и сбой чистки не должен его
 * откатывать, — но каждый сбой идёт в «Здоровье системы».
 *
 * RESERVED гасит только монтаж: бронь может сняться тем же днём, и фото-посты и
 * показы ей не мешают так, как продажа и снятие.
 */
export type LeftSaleKind = "sold" | "withdrawn" | "reserved";

const REASON: Record<LeftSaleKind, string> = {
  sold: "продан",
  withdrawn: "снят с продажи",
  reserved: "в резерве",
};

export function closeWorkAfterLeavingSale(propertyId: string, kind: LeftSaleKind): void {
  const reason = REASON[kind];
  const fail = (what: string, source: "video-handoff" | "meta" | "api") => (err: unknown) =>
    void logSystemError(source, `Объект ${propertyId}: ${what} при смене статуса (${reason}) не удалось: ${describeError(err)}`);

  // Место монтажёра: без этого очередь «строго по одному» встаёт за проданным
  // объектом (25.09.2026, А3).
  void closeVideoHandoff(propertyId, { holdQueue: false, reason }).catch(fail("закрытие монтажа", "video-handoff"));
  if (kind === "reserved") return;

  // Фото-посты и повторы: публикации снимаются, отложенные слоты гасятся.
  void removePropertyPhotoPosts(propertyId).catch(fail("снятие фото-постов", "meta"));
  void removePropertySocialReposts(propertyId).catch(fail("снятие повторов", "meta"));
  // Будущие показы — клиенту не приходит напоминание о проданной квартире.
  void cancelFutureShowingsForOffSale([propertyId], kind === "sold").catch(fail("снятие показов", "api"));
  // Основной ролик — только при продаже (29.10.2026): снятый с продажи объект часто
  // возвращается, и его ролик должен дождаться этого на месте.
  if (kind === "sold") void retireSocialAfterSale(propertyId).catch(fail("снятие роликов из соцсетей", "meta"));
}
