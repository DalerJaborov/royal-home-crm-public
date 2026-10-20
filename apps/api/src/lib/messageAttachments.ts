/**
 * Как вложения переписки показываются наружу — в инбоксе и в карточке клиента.
 *
 * Фото и голосовые, присланные клиентом, открывает право `messages.viewAttachments`
 * (по умолчанию — админ, директор и агент по своим карточкам; владелец 17.08.2026
 * добавил его агенту, до этого было только у руководства). Текст переписки при этом
 * видят все, у кого есть доступ к разделу, — поэтому реплику отдаём целиком, а у
 * вложения снимаем имя файла.
 *
 * Имя файла — не секрет, но и не адрес: без права маршрут выдачи всё равно ответит
 * 403 (routes/attachments.ts). Обнуляем его по другой причине — чтобы интерфейс мог
 * честно написать «доступно руководству» вместо битой картинки, и чтобы имена не
 * расходились по журналам и вкладкам тех, кому они не нужны.
 *
 * Модуль разбирает значение из jsonb-колонки, то есть данные, которым нельзя
 * доверять по типу; из внешнего берётся только чистая функция маскировки телефона,
 * без сетевых и файловых зависимостей. Старая переписка (а её тысячи реплик) поля
 * attachments не имеет вовсе — для неё всё это ничего не меняет.
 *
 * ТЕЛЕФОН КЛИЕНТА В ЕГО СОБСТВЕННЫХ РЕПЛИКАХ (найдено владельцем 12.08.2026).
 * `clients.viewPhone` закрывает структурное поле `Client.phone` (см.
 * lib/clientPhone.ts), но клиенты постоянно диктуют номер прямо в переписке —
 * «мой номер 930001001». До этой правки такая реплика уходила сотруднику
 * НЕЗАВИСИМО от права: маска в @royal-home/shared/maskContacts исторически
 * трогала только ИСХОДЯЩИЕ сообщения агента (её комментарий явно говорит «не
 * трогает входящие клиента» — предпосылка была верна, пока телефон был виден
 * всем в самой карточке; с появлением `clients.viewPhone` 07.08.2026 она перестала
 * быть верной для тех, у кого права нет). Право на просмотр телефона обходилось
 * полностью тем, что клиент рано или поздно сам его называет.
 */

import { maskPhonesForReader, type ConversationMessage, type MessageAttachment } from "@royal-home/shared";

/**
 * Виды вложений, которые уходят наружу.
 *
 * «video» и «file» добавлены 16.08.2026 вместе с исправлением, которое стоит того,
 * чтобы его помнить: накануне видео и документы научились сохранять и рисовать
 * плеер, но ЗДЕСЬ они отсеивались — набор был из двух слов. Правка выглядела
 * выкаченной, а в переписке не менялось ничего. Ровно тот же случай, что и с полем
 * `at` ниже: слой отдачи наружу — белый список, и любое новое поле реплики надо
 * пропускать здесь явно, иначе его не увидит никто.
 */
const KINDS = new Set(["image", "audio", "video", "file"]);
type AttachmentKind = MessageAttachment["kind"];

// Форма реплики и вложения описана один раз в @royal-home/shared: её же читает
// браузер. Прежние имена оставлены псевдонимами — ими пользуется остальной файл
// и его вызывающие, а переименование ради переименования только шумит в истории.
export type PresentedAttachment = MessageAttachment;
export type PresentedMessage = ConversationMessage;

function presentAttachments(raw: unknown, allowed: boolean): PresentedAttachment[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const items: PresentedAttachment[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { kind, file, mime, url } = entry as { kind?: unknown; file?: unknown; mime?: unknown; url?: unknown };
    if (typeof kind !== "string" || !KINDS.has(kind)) continue;
    const presentedMime = typeof mime === "string" ? mime : "application/octet-stream";
    // Фотография объекта (из `/uploads`) или фото/видео, отправленное сотрудником
    // клиенту через R2 (`/media/chat/...`, см. routes/mediaProxy.ts) — у обоих вместо
    // имени в закрытом хранилище готовый путь. Показываем всем, кто видит переписку, —
    // агент должен знать, что клиенту УЖЕ показывали, иначе пришлёт то же самое второй раз.
    // Путь проверяем, потому что колонка jsonb: доверять её содержимому по типу нельзя.
    if (
      typeof url === "string" &&
      (url.startsWith("/uploads/") || url.startsWith("/api/v1/media/chat/")) &&
      !url.includes("..")
    ) {
      items.push({ kind: kind as AttachmentKind, mime: presentedMime, file: null, url });
      continue;
    }
    if (typeof file !== "string" || !file) continue;
    items.push({
      kind: kind as AttachmentKind,
      mime: presentedMime,
      file: allowed ? file : null,
    });
  }
  return items.length > 0 ? items : undefined;
}

/**
 * Переписка из jsonb-колонки → ответ API.
 *
 * Отдаём перечисленные поля, а не всю сохранённую реплику: в колонке лежит рабочее
 * состояние бота, и «прокидывать как есть» значит однажды случайно выставить наружу
 * то, чего там быть не должно.
 *
 * Обратная сторона белого списка: новое поле реплики надо не забыть добавить СЮДА.
 * Дважды не забыли — и дважды правка выглядела выкаченной, ничего не меняя на экране
 * (`at` с 01.08.2026, вложения «video»/«file» с 15.08.2026).
 */
export function presentMessages(
  raw: unknown,
  attachmentsAllowed: boolean,
  /** Есть ли у смотрящего право `clients.viewPhone`. По умолчанию true — вызовы,
   *  которым право безразлично (например, разбор ботом самой переписки), не
   *  обязаны о нём знать и не должны молча начать что-то прятать. Маскируют
   *  только те два маршрута, что реально отдают переписку сотруднику: /clients/:id
   *  и /conversations/:id (см. их вызовы presentMessages). */
  phonesAllowed = true
): PresentedMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { role, content, attachments, by, at, mid, mid2, replyToMid, deliveryStatus, translatedRu, feedback } = entry as {
      role?: unknown;
      content?: unknown;
      attachments?: unknown;
      by?: unknown;
      at?: unknown;
      mid?: unknown;
      mid2?: unknown;
      replyToMid?: unknown;
      deliveryStatus?: unknown;
      translatedRu?: unknown;
      feedback?: unknown;
    };
    const DELIVERY_STATUSES = ["sent", "delivered", "read", "failed"];
    if (role !== "user" && role !== "assistant") return [];
    const text = typeof content === "string" ? content : String(content ?? "");
    // Маскируем ОБЕ стороны реплики, а не только клиента: агент без права мог бы
    // иначе прочитать собственный номер бота/агентства из зеркального эха модели
    // и решить, что маска — редкость, а не правило. Дороже это не делает — сегмент
    // всё равно уже разобран на части функцией maskPhones.
    return [
      {
        role,
        // maskPhonesForReader, а не maskPhones: та пропускает ссылки целиком
        // (wa.me/992…, tel:+992…) — для исходящих это решение владельца, для
        // читателя без права на номер это открытый номер (ACCESS-02).
        content: phonesAllowed ? text : maskPhonesForReader(text).text,
        attachments: presentAttachments(attachments, attachmentsAllowed),
        // Только у role="assistant" и только тем же простым разбором, что и
        // остальные поля колонки: доверять форме jsonb нельзя. Отсутствует или
        // разобрать не удалось — интерфейс покажет это как ответ бота (см.
        // MessageSender в @royal-home/shared).
        by: role === "assistant" ? presentSender(by) : undefined,
        /**
         * Когда сказано — и по нему в переписке рисуются часы и разделители дней.
         * Поле есть у реплик с 01.08.2026, но наружу не отдавалось: экран показывал
         * время ровно там, где его не было, то есть нигде.
         */
        at: typeof at === "string" ? at : undefined,
        // Идентификаторы у Meta и ссылка на цитируемую реплику: по ним рисуется
        // цитата над сообщением (см. @royal-home/shared/conversationMessage).
        mid: typeof mid === "string" ? mid : undefined,
        mid2: typeof mid2 === "string" ? mid2 : undefined,
        replyToMid: typeof replyToMid === "string" ? replyToMid : undefined,
        deliveryStatus:
          typeof deliveryStatus === "string" && DELIVERY_STATUSES.includes(deliveryStatus)
            ? (deliveryStatus as ConversationMessage["deliveryStatus"])
            : undefined,
        // Перевод — те же слова клиента другим языком: если он диктовал номер,
        // номер остаётся и в переводе. Маскируем его так же, как content выше,
        // иначе право clients.viewPhone обходилось бы кнопкой «Показать перевод».
        translatedRu:
          typeof translatedRu === "string"
            ? phonesAllowed
              ? translatedRu
              : maskPhonesForReader(translatedRu).text
            : undefined,
        // Оценка ответа бота (17.09.2026, POST /conversations/:id/reply-feedback) —
        // тот же белый список: без явного разбора здесь кнопки «Верно»/«Неверно»
        // не увидят состояние после перезагрузки страницы (см. комментарий класса
        // выше про `at` и вложения «video»/«file»).
        feedback: presentFeedback(feedback, phonesAllowed),
      },
    ];
  });
}

function presentFeedback(raw: unknown, phonesAllowed: boolean): PresentedMessage["feedback"] {
  if (!raw || typeof raw !== "object") return undefined;
  const { verdict, note, by, at, lessonId, styleExampleId } = raw as {
    verdict?: unknown;
    note?: unknown;
    by?: unknown;
    at?: unknown;
    lessonId?: unknown;
    styleExampleId?: unknown;
  };
  if (verdict !== "good" && verdict !== "bad") return undefined;
  if (typeof by !== "string" || typeof at !== "string") return undefined;
  return {
    verdict,
    // Заметку правки пишет руководитель, и клиентский номер в ней — тот же номер
    // в свободном тексте: без права на него читателю он закрыт (ACCESS-02).
    note: typeof note === "string" ? (phonesAllowed ? note : maskPhonesForReader(note).text) : undefined,
    by,
    at,
    lessonId: typeof lessonId === "string" ? lessonId : undefined,
    styleExampleId: typeof styleExampleId === "string" ? styleExampleId : undefined,
  };
}

/**
 * Подпись реплики из jsonb → ответ API. Тот же белый список, что и у полей выше,
 * и та же ловушка: `kind: "manual"` («ответили руками из самого мессенджера»,
 * появился 17.08.2026) здесь не разбирался и молча превращался в `undefined`, а
 * `undefined` интерфейс рисует как «Бот» (см. MessageSenderBadge). Три недели вся
 * переписка, которую агент вёл из приложения Instagram, показывалась в CRM как
 * работа бота — владелец 07.09.2026: «написано бот, но откуда у бота такие
 * способности». Новый вид отправителя надо добавлять СЮДА тоже.
 */
export function presentSender(raw: unknown): PresentedMessage["by"] {
  if (!raw || typeof raw !== "object") return undefined;
  const { kind, agentId, agentName } = raw as { kind?: unknown; agentId?: unknown; agentName?: unknown };
  if (kind === "bot" || kind === "system" || kind === "manual") return { kind };
  if (kind === "agent" && typeof agentId === "string" && typeof agentName === "string") {
    return { kind: "agent", agentId, agentName };
  }
  return undefined;
}
