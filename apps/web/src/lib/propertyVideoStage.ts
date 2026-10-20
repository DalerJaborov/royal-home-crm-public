import { dushanbeDate } from "./date";
import type { Property } from "../types";

/**
 * ЭТАП РОЛИКА ОДНОЙ СТРОКОЙ (контракт 06.10.2026, «Ролик: этап с сервера»).
 *
 * Берётся ТОЛЬКО из того, что отдаёт сервер: `videoHandoff` (очередь, у монтажёра,
 * получен), `status` объекта и `videoCount`. Права на правку здесь не участвуют.
 * Раньше плашка «ждём сырое видео» рисовалась по праву «мне можно править этот
 * объект» (жалоба владельца 21.09.2026: видео уже на монтаже, а на экране «ждём»),
 * а блок «Ролик» противоречил чипу «На монтаже» (разбор review-mobile.md).
 *
 * `tone` — цвет точки `.quiet .dot` в теме: `lav` рабочий этап монтажа, `ok` готово,
 * `warn` отложено, `neutral` без цвета. Строки нет (`null`), когда сказать нечего:
 * объект в продаже без монтажа, закрытый объект.
 */
export type VideoStageTone = "lav" | "ok" | "warn" | "neutral";

export interface VideoStageLine {
  tone: VideoStageTone;
  text: string;
}

const day = (iso: string) => dushanbeDate(iso, { day: "numeric", month: "long" });

export function videoStageLine(
  p: Pick<Property, "status" | "videoHandoff" | "videoCount" | "offSite">,
): VideoStageLine | null {
  const vh = p.videoHandoff ?? null;
  if (vh) {
    if (vh.status === "QUEUED") {
      if (vh.heldAt) return { tone: "warn", text: `Монтаж отложен${vh.holdReason ? `: ${vh.holdReason}` : ""}` };
      const ahead = vh.queuePosition != null && vh.queuePosition > 1 ? vh.queuePosition - 1 : 0;
      return { tone: "lav", text: ahead > 0 ? `В очереди на монтаж, перед ним ${ahead}` : "В очереди на монтаж" };
    }
    if (vh.status === "SENT_TO_EDITOR") {
      const since = vh.sentAt ? ` с ${day(vh.sentAt)}` : "";
      const who = vh.montajer?.fullName ? ` · монтажёр ${vh.montajer.fullName}` : "";
      return { tone: "lav", text: `На монтаже${since}${who}` };
    }
    // RECEIVED. Снятие с монтажа тоже даёт RECEIVED, но без `receivedAt`: «ролик
    // получен» там было бы неправдой (тот же разбор в PropertyVideoFixCard).
    if (!vh.receivedAt) return { tone: "neutral", text: "Снят с монтажа" };
    if (vh.clipReview.status === "PENDING") return { tone: "lav", text: "Готовый ролик ждёт проверки" };
    return { tone: "ok", text: `Ролик готов, получен ${day(vh.receivedAt)}` };
  }
  if (p.offSite) return null;
  if (p.status === "AWAITING_VIDEO") {
    return {
      tone: "neutral",
      text: (p.videoCount ?? 0) > 0 ? "Сырое видео загружено, ждёт проверки" : "Ждём сырое видео от агента",
    };
  }
  return null;
}
