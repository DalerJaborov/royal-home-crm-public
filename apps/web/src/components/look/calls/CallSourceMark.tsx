import { isWhatsappCallSource } from "@royal-home/shared";
import { RoyalCallFlag } from "./RoyalCallRow";
import { pillTone } from "../tileTone";

/**
 * МЕТКА «WhatsApp» У ВХОДЯЩЕГО (18.11.2026). Клиент позвонил голосом через WhatsApp,
 * шлюз SIP завёл звонок на станцию как обычный входящий; сервер отличает его по
 * каналу и отдаёт `source: "whatsapp"` (apps/api/src/lib/telephony/callSource.ts).
 *
 * Одна метка на все строки звонков — ПК и телефон, «новый вид» и прежний: иначе
 * метка, добавленная в одну строку, молча не появилась бы в соседней.
 * Обычная линия — ничего не рисуем: метка нужна только там, где канал необычный.
 */
export function CallSourceMark({ source, look }: {
  source?: string | null;
  /** royal — пометка «нового вида»; chip — прежний ПК; chip-xs — прежний телефон. */
  look: "royal" | "chip" | "chip-xs";
}) {
  if (!isWhatsappCallSource(source)) return null;
  const title = "Клиент позвонил через WhatsApp";
  if (look === "royal") return <span title={title}><RoyalCallFlag tone={pillTone("info")}>WhatsApp</RoyalCallFlag></span>;
  return <span className={look === "chip-xs" ? "chip ok xs" : "chip ok"} title={title}>WhatsApp</span>;
}
