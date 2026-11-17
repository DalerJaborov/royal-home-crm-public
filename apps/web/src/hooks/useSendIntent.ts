import { useState } from "react";
import { SendIntent } from "../lib/clientSend";

/** Ключ повтора отправки клиенту, живущий вместе с местом отправки (см. lib/clientSend.ts). */
export function useSendIntent(): SendIntent {
  const [intent] = useState(() => new SendIntent());
  return intent;
}
