// Что бот показал клиенту — для записи в переписку CRM. Вынесено из
// messengers/propertyShowcase.ts (31.10.2026) без смены поведения: тип нужен и ядру.
import type { PropertyCard, StoredAttachment } from "./shared.js";

/** Что бот показал клиенту — для записи в переписку CRM. */
export interface ShowcaseResult {
  /** Provider evidence, or a locally prepared website card. Missing IDs are not confirmation. */
  deliveryStatus?: "not_sent" | "sent" | "unknown" | "prepared";
  /** Доставленные фотографии в виде вложений реплики (lib/messageAttachments.ts).
   *  У каждого — свой `mid` (см. StoredAttachment): это отдельное сообщение Meta. */
  attachments: StoredAttachment[];
  /** Ссылка, ушедшая отдельным сообщением: пост в Instagram или карточка на сайте. */
  link: string | null;
  /** `message_id` этого сообщения-ссылки у Meta — нужен эху отличить своё от
   *  чужого (см. handleOutgoingEcho), как mid у фотографий. */
  linkMid?: string | null;
  /**
   * Гугл-ссылка на карту, ушедшая ОТДЕЛЬНОЙ настоящей геометкой в WhatsApp
   * (19.08.2026) — только у объектов с геокодированными координатами и только
   * в WhatsApp (Instagram/Messenger такой тип сообщения не поддерживают).
   * В переписке CRM хранится ссылкой на карту, а не картой — своего рендера
   * карты в интерфейсе пока нет, ссылка честнее, чем видимость поддержки.
   */
  locationLink?: string | null;
  locationMid?: string | null;
  /** Карточка для чата на сайте (23.08.2026) — см. PropertyCard в ai/shared.ts.
   *  У Meta-каналов вместо неё настоящие фотографии + ссылка выше. */
  websiteCard?: PropertyCard | null;
}
