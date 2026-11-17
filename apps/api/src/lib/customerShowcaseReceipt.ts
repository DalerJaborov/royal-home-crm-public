import type { ShowcaseResult } from "../ai/showcaseResult.js";

// Only an affirmative bot statement at a sentence/bubble boundary. Reported
// client/owner media, prices and new questions are not removed with the claim.
const PHOTO_ACK = /(^|[.!?\n]\s*)(?:я\s+)?(?:вот\s+(?:фото(?:графии)?|снимки)(?:\s+(?:объекта|квартиры|дома))?|(?:отправил(?:а)?|прислал(?:а)?|прикрепил(?:а)?|выслал(?:а)?|отправляю|присылаю)\s+(?:вам\s+)?(?:фото(?:графии)?|снимки)(?:\s+(?:объекта|квартиры|дома))?|ана\s+(?:расм(?:ҳо(?:яш)?)?|акс(?:ҳо(?:яш)?)?)(?:и\s+(?:хона|объект))?|(?:расм(?:ҳо(?:яш)?)?|акс(?:ҳо(?:яш)?)?)\s*(?:ро\s+)?(?:фиристодам|равон\s+кардам))(?=\s*$|[,.!?;:])(\s*[.,;:]\s*)?/giu;

/** Reconcile only a requested showcase acknowledgement against its actual
 * result. A missing provider ID is unknown, not a successful photo receipt.
 * Prepared website cards are shown in the caller's same durable append. */
export function reconcileCustomerShowcaseReply(bubbles: { reply: string; reply2?: string },
  receipt: Pick<ShowcaseResult, "deliveryStatus" | "attachments" | "linkMid" | "websiteCard">,
  language: "ru" | "tg"): { reply: string; reply2?: string; changed: boolean } {
  if (receipt.deliveryStatus === "sent" && receipt.attachments.some(item => item.kind === "image" && !!item.mid)) {
    return { ...bubbles, changed: false };
  }
  const replacement = receipt.deliveryStatus === "prepared" && receipt.websiteCard
    ? language === "ru" ? "Вот карточка объекта." : "Ана маълумоти объект."
    : receipt.deliveryStatus === "sent" && receipt.linkMid
      ? language === "ru" ? "Вот ссылка на объект." : "Ана пайванди объект."
      : receipt.deliveryStatus === "not_sent"
        ? language === "ru" ? "Фотографии пока не отправились." : "Расмҳо ҳоло фиристода нашуданд."
        : language === "ru" ? "Пока не могу подтвердить отправку фотографий." : "Ҳоло фиристодани расмҳоро тасдиқ карда наметавонам.";
  let changed = false, inserted = false;
  const fix = (text: string): string => text.replace(PHOTO_ACK, (span: string, prefix: string, separator: string | undefined, offset: number) => {
    // A relative clause describes existing/reported media, without witnessing
    // our own send. Leave it to the future structured receipt renderer rather
    // than deleting a client/owner statement with a larger language regexp.
    if (separator?.includes(",") && /^\s*котор/iu.test(text.slice(offset + span.length))) return span;
    changed = true;
    const answer = inserted ? "" : replacement; inserted = true;
    return `${prefix}${answer}${answer ? " " : ""}`;
  }).trim();
  const reply = fix(bubbles.reply), reply2 = bubbles.reply2 === undefined ? undefined : fix(bubbles.reply2);
  return { reply, ...(reply2 === undefined ? {} : { reply2 }), changed };
}
