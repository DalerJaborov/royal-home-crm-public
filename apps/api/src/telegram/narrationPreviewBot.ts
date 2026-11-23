/**
 * СТАРЫЕ КНОПКИ «ПРОСЛУШАТЬ ПЕРЕД ВЫПУСКОМ» (`nrp:a|c|k:<версия>`, 17.11.2026).
 *
 * С 18.11.2026 этого шага нет (lib/narrationPreview.ts): озвучку утверждают один раз — кнопкой «✅ Одобрить» у
 * самой озвучки (telegram/assistantNarration.ts) или «Утвердить и выпустить» в карточке, и ролик выходит сразу.
 * Сообщения с прежними кнопками остались в чатах; нажатие на них ничего не выпускает и не удаляет, а честно
 * отвечает, куда идти. Ничего не отправляет само — только ответ на нажатую кнопку.
 */
import { answerCallbackQuery, type TelegramCallbackQuery } from "./api.js";
import { chatLang } from "./assistantNarration.js";

const CALLBACK = /^nrp:[ack]:[0-9a-f-]{36}$/;
const STALE = {
  ru: "Эта кнопка устарела. Новую озвучку утверждают один раз в карточке объекта: «Утвердить и выпустить».",
  tg: "Ин тугма кӯҳна шуд. Овози навро як бор дар саҳифаи объект тасдиқ кунед: «Тасдиқ ва нашр».",
} as const;

export async function handleNarrationPreviewCallback(query: TelegramCallbackQuery): Promise<boolean> {
  if (!CALLBACK.test(query.data ?? "")) return false;
  const chatId = query.message?.chat?.id;
  const lang = chatId ? await chatLang(String(chatId)).catch(() => "ru" as const) : "ru";
  await answerCallbackQuery(query.id, STALE[lang]).catch(() => {});
  return true;
}
