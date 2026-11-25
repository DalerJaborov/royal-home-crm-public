import { z } from "zod";
import { SELLER_SWITCH_LABELS } from "./sellerAutomationSwitches.js";

/**
 * ВЫКЛЮЧАТЕЛИ «АВТОМАТИКА ИИ И НАПОМИНАНИЯ» (владелец 19.11.2026).
 *
 * Слова владельца: «оставить все эти функции просто сделать переключатели, эти
 * функции очень полезные, а потом решим что выключить». Ничего не удалено: у каждого
 * механизма ниже есть своя строка в Настройках. По умолчанию ВСЁ ВКЛЮЧЕНО
 * (`@default(true)` в базе, `?? true` здесь): выкат миграции поведение не меняет,
 * выключает только человек. Выключенный механизм просто ничего не делает — ни записи,
 * ни задачи, ни уведомления; остальной ход (ответ клиенту, звонок, запись разговора)
 * идёт как обычно.
 *
 * ОДНО МЕСТО: список полей, схема сохранения (её встраивает PATCH /settings),
 * группы и подписи для экрана. Сервер (apps/api/src/lib/automationSwitches.ts) и экран
 * (apps/web/src/pages/settings/AutomationSwitchesSection.tsx) берут всё отсюда.
 *
 * Два выключателя уже существовали и здесь не дублируются:
 *  - «Застой: продавец без объекта» — `dealStaleSellersEnabled` (sellerAutomationSwitches.ts),
 *    стоит в группе «Задачи» этого экрана тем же полем;
 *  - «Клиент в Telegram без ответа» — `telegramSilenceWatchEnabled` (не трогаем).
 */
export const AUTOMATION_SWITCH_KEYS = [
  "aiCardFromCallEnabled",
  "aiAgentShowingAutoBookEnabled",
  "aiJobSeekerAutoDetachEnabled",
  "dealStaleBuyersEnabled",
  "notifyClientWaitingEnabled",
  "notifyRobotTookCallEnabled",
  "notifyTrashAnomalyEnabled",
  "notifyPropertyReviewOverdueEnabled",
  "botRepliesAfterLeadEnabled",
  "botSpamFilterEnabled",
  "botCoreFailAlertEnabled",
  "botRetryCapEnabled",
  "shabnamSocialPublishEnabled",
  "shabnamGroupAutoMemoryEnabled",
  "chatMediaTranscodeEnabled",
  "outgoingMediaCompressEnabled",
  "shabnamGroupUnaddressedEnabled",
  "telegramPhoneLinkEnabled",
  "instagramCompanyKeyEnabled",
  "showingAgreementAskEnabled",
  "showingOutcomeAskEnabled",
  "clientRecordResultEnabled",
] as const;

export type AutomationSwitchKey = (typeof AUTOMATION_SWITCH_KEYS)[number];

/** Нет строки настроек или поля — ВКЛЮЧЕНО: то же умолчание, что у колонки в базе. */
export const AUTOMATION_SWITCH_DEFAULT = true;

/**
 * Исключения из общего умолчания. «Записать результат» в карточке клиента (владелец 22.11.2026) по умолчанию ВЫКЛЮЧЕНА:
 * ИИ пишет итог звонка не для коротких звонков, и ручная кнопка рядом только путает. Колонка в базе тоже `DEFAULT false`.
 */
export const AUTOMATION_SWITCH_DEFAULT_OFF: ReadonlySet<AutomationSwitchKey> = new Set<AutomationSwitchKey>([
  "clientRecordResultEnabled",
  // Ревью 25.11.2026: Telegram — канал кода входа, привязка по одному контакту слабее входа по СМС. Колонка `DEFAULT false`.
  "telegramPhoneLinkEnabled",
]);

/** Как поля лежат в ответе GET /settings (и в строке Settings базы). */
export type AutomationSwitches = Record<AutomationSwitchKey, boolean>;

/** Часть схемы PATCH /settings: каждое поле — необязательный boolean (встраивается через `.shape`). */
export const automationSwitchesUpdateSchema = z.object(
  Object.fromEntries(AUTOMATION_SWITCH_KEYS.map((key) => [key, z.boolean().optional()])) as Record<
    AutomationSwitchKey,
    z.ZodOptional<z.ZodBoolean>
  >
);

export function isAutomationSwitchOn(
  settings: Partial<Record<AutomationSwitchKey, boolean | null | undefined>> | null | undefined,
  key: AutomationSwitchKey
): boolean {
  return settings?.[key] ?? !AUTOMATION_SWITCH_DEFAULT_OFF.has(key);
}

export interface AutomationSwitchLabel {
  /** Название строки на экране. */
  title: string;
  /** Что происходит, пока выключатель ВКЛЮЧЁН (правило SwitchRow: пояснение — про текущее положение). */
  on: string;
  /** Что происходит, пока выключатель ВЫКЛЮЧЕН. */
  off: string;
}

export const AUTOMATION_SWITCH_LABELS: Record<AutomationSwitchKey, AutomationSwitchLabel> = {
  aiCardFromCallEnabled: {
    title: "ИИ дописывает карточку клиента по звонку",
    on: "После разговора ИИ сам вносит в карточку бюджет, район, комнаты и заметки из того, что сказал клиент.",
    off: "Карточку по звонку ИИ не трогает и разговор для этого не разбирает. Расшифровка и итог звонка остаются.",
  },
  aiAgentShowingAutoBookEnabled: {
    title: "ИИ сам назначает показ по разговору агента",
    on: "Если агент договорился о показе словами (в переписке или по телефону), ИИ сам записывает показ.",
    off: "Показ по разговору агента не назначается. Назначить можно кнопкой, бот и помощник записывают как раньше.",
  },
  aiJobSeekerAutoDetachEnabled: {
    title: "ИИ снимает агента, если клиент ищет работу",
    on: "Если клиент с агентом написал или позвонил насчёт вакансии, карточка сама уходит в «Вакансии», а агент снимается.",
    off: "Существующие карточки сами не меняются: агент остаётся. Анкета кандидата и уведомление приходят, кнопка «В кандидаты» работает.",
  },
  dealStaleBuyersEnabled: {
    title: "Застой: покупатель без сделки",
    on: "Покупателю без сделки дольше срока из «Застой сделки» агенту ставится задача «Закройте сделку».",
    off: "По покупателям эта задача не ставится.",
  },
  notifyClientWaitingEnabled: {
    title: "Напоминание «клиент молчит 30 минут»",
    on: "Если клиент написал, а ему никто не ответил 30 минут, ответственному (или руководству) приходит напоминание, и повтор, если переписку взял сотрудник и молчит.",
    off: "Этих напоминаний нет. Сообщения «бот сломался» и «бот передал клиента сотруднику» приходят всегда.",
  },
  notifyRobotTookCallEnabled: {
    title: "«Робот взял звонок, послушайте»",
    on: "Когда робот ответил на входящий звонок, директор и администратор получают уведомление со ссылкой на прослушивание.",
    off: "Уведомления нет. Робот отвечает и запись звонка идёт как обычно.",
  },
  notifyTrashAnomalyEnabled: {
    title: "«Много удалений у агента»",
    on: "Если у одного агента за сутки в Корзину ушло 5 клиентов и больше, директор и администратор получают уведомление.",
    off: "Уведомления нет. Удаления работают как обычно.",
  },
  notifyPropertyReviewOverdueEnabled: {
    title: "«Объект долго на проверке»",
    on: "Если объект завис на проверке дольше срока, проверяющему или руководству приходит уведомление.",
    off: "Уведомления нет. Срок по-прежнему красится на карточке объекта.",
  },
  // 24.11.2026: ход бота упал с исключением (customer_core_unavailable), клиенту тишина: звать агента сразу, не через 30 минут.
  botCoreFailAlertEnabled: {
    title: "Бот сломался на ходе: сразу позвать агента",
    on: "Ход бота упал, клиенту ничего не ушло: ответственный (или руководство) получает сигнал сразу, а не через 30 минут. Клиенту текст не отправляется.",
    off: "Сигнал придёт только через 30 минут от сторожа «клиент молчит» (если он включён).",
  },
  // 24.11.2026 (разбор прода): повтор «зависших» крутил одни и те же переписки по 31–35 раз без ответа и тратил ИИ.
  botRetryCapEnabled: {
    title: "Бот не может ответить: не повторять бесконечно",
    on: "Если бот трижды подряд решил, что на сообщение отвечать не нужно, он больше не повторяет попытку 6 часов. Если ключ канала не работает, бот сразу останавливается на 2 часа и сообщает ответственному. О клиенте без ответа напомнит сторож «клиент ждёт ответа», если он включён. Кнопка «Повторить зависшим» снимает остановку сразу.",
    off: "Бот повторяет попытку каждые полчаса, пока клиент не получит ответ: тратит ИИ, даже если ответ не может уйти.",
  },
  // Владелец 20.11.2026: «таким спамерам как то не отвечать или как то сэкономить токены».
  botSpamFilterEnabled: {
    title: "Спам — без ответа",
    on: "Просьбы денег, «лайк, коммент, подпишитесь», реклама чужих услуг: бот не отвечает и не тратит ИИ. Номер или слова о квартире, цене, вакансии — всегда обычный ответ.",
    off: "Бот отвечает и на такие сообщения, как на обычные.",
  },
  // Владелец 20.11.2026: «если после передачи агенту клиент опять что-то написал, бот не должен же молчать».
  botRepliesAfterLeadEnabled: {
    title: "Бот отвечает и после заявки",
    on: "Клиент пишет после заявки: бот коротко отвечает, новое передаёт агенту заметкой. Молчит, пока сотрудник сам ведёт переписку.",
    off: "После заявки бот отвечает только на новую деталь и простые вопросы (условия, где работаем, часы), на остальное молчит и ждёт агента.",
  },
  // Владелец 21.11.2026: «Учить Шабнам публиковать ролики без объекта и карусели?» — «да».
  shabnamSocialPublishEnabled: {
    title: "Шабнам публикует ролики и фото без объекта",
    on: "Сотрудник с правом маркетинга присылает Шабнам ролик или до 10 фото, она готовит подпись и показывает пост. В соцсети он уходит только после кнопки «Опубликовать».",
    off: "Шабнам не готовит такие посты. Ролики к объектам она принимает как раньше, пост без объекта можно сделать в разделе «Ролики».",
  },
  // Владелец 24.11.2026: «молчит, пока не напишешь "Шабнам"», новички пишут, она не отвечает.
  shabnamGroupUnaddressedEnabled: {
    title: "Шабнам отвечает в группах без обращения",
    on: "В рабочей группе Шабнам сама отвечает на ясный рабочий вопрос (цена и статус объекта, «найдите варианты», как сделать что-то в CRM), не чаще раза в 12 секунд. На болтовню и разговор людей между собой не отвечает. «Шабнам, помолчи» выключает это на полчаса.",
    off: "В группах Шабнам отвечает только тем, кто её позвал: по имени, через /ai или ответом на её сообщение.",
  },
  // Ревью 25.11.2026: в привязанный Telegram приходит код входа, поэтому по умолчанию выключено.
  telegramPhoneLinkEnabled: {
    title: "Привязка Telegram по номеру",
    on: "Новичок в группе жмёт кнопку, делится номером в личке с ботом и вводит код из СМС на этот номер. Директора и администратора по номеру не привязывает: им только через профиль.",
    off: "Telegram привязывают только в CRM: Профиль → Telegram. Шабнам новичку в группе подсказывает этот путь.",
  },
  // Владелец 24-25.11.2026: «Шабнам в группах молчит без обращения»: память группы никто не включал.
  shabnamGroupAutoMemoryEnabled: {
    title: "Шабнам запоминает разговор в подключённой группе",
    on: "Подключённая группа сама начинает помнить последние сообщения (7 дней, без ссылок и контактов), включая тех, кто ещё не привязан к CRM. Без этого Шабнам не отвечает на вопросы без обращения и не знает, о чём говорили.",
    off: "Новые подключённые группы ничего не запоминают, пока память не включена вручную. Уже запомненное остаётся до срока.",
  },
  // Владелец 25.11.2026: «фото, видео, голосовые клиентов не открываются в CRM».
  outgoingMediaCompressEnabled: {
    title: "Фото и видео клиенту — как в WhatsApp",
    on: "CRM сама сжимает фото и видео под предел канала (WhatsApp 16 МБ, Instagram 25 МБ) и отправляет в фоне: клиент получает настоящее видео, а не ссылку. Очень длинное видео уходит ссылкой на просмотр. Геометка с фото удаляется.",
    off: "Файл уходит как есть: видео больше предела канала — ссылкой, тяжёлое фото — отказом.",
  },
  chatMediaTranscodeEnabled: {
    title: "Голосовые и видео клиентов открываются на любом телефоне",
    on: "Если телефон или браузер сотрудника не умеет играть присланный файл (например, голосовое WhatsApp на старом iPhone), CRM один раз делает понятную ему копию. Оригинал не меняется.",
    off: "Копии не делаются: такой файл можно только скачать и открыть другим приложением.",
  },
  // Владелец 22.11.2026: итог звонка пишет ИИ, ручная кнопка в карточке пока спрятана.
  clientRecordResultEnabled: {
    title: "Кнопка «Записать результат» в карточке клиента",
    on: "В карточке клиента (в меню «Ещё» и под кнопками на телефоне) есть кнопка «Записать результат»: можно вручную записать, чем закончился разговор или показ, в том числе задним числом.",
    off: "Кнопки «Записать результат» в карточке нет. Итог звонка пишет ИИ, показ назначается кнопкой «Назначить показ».",
  },
  // Владелец 21.11.2026: «Да, переводи» — Instagram на постоянный ключ компании (смена пароля не глушит бота).
  instagramCompanyKeyEnabled: {
    title: "Instagram через постоянный ключ Meta",
    on: "Аккаунт Instagram, у которого проверка прошла (Страница Facebook с этим Instagram выдана ключу компании), отвечает через Страницу и публикует ролики, истории и фото постоянным ключом. Смена пароля Instagram бота и публикации не глушит. Если Meta откажет в ответе, он уйдёт личным ключом аккаунта.",
    off: "Все аккаунты Instagram отвечают и публикуют личными ключами, как раньше. После смены пароля Instagram аккаунт нужно подключить заново.",
  },
  // Владелец 22.11.2026: «показы делать уведомлением с кнопками в Шабнам… можно своими словами отвечать».
  showingAgreementAskEnabled: {
    title: "Шабнам переспрашивает о показе",
    on: "Если ИИ услышал в звонке или прочитал в переписке о показе, но не понял время или объект, через минуту Шабнам спрашивает агента. Нет Telegram или нет ответа — тот же вопрос в CRM.",
    off: "Не переспрашивает, всё как раньше: показ по звонку ставится сам, только если в подборе ровно один подходящий объект.",
  },
  showingOutcomeAskEnabled: {
    title: "«У вас был показ?» после показа",
    on: "Через час после показа Шабнам спрашивает агента: был показ или нет, и что дальше с клиентом. Нет Telegram или нет ответа — тот же вопрос в CRM.",
    off: "Не спрашивает. Показ отмечают в календаре или в карточке клиента.",
  },
};

export interface AutomationSwitchGroup {
  id: "ai" | "tasks" | "notifications" | "bot";
  title: string;
  /** Ключи группы: свои и уже существовавшие (`dealStaleSellersEnabled`). */
  keys: ReadonlyArray<AutomationSwitchKey | "dealStaleSellersEnabled">;
}

/** Группы и порядок строк на экране. */
export const AUTOMATION_SWITCH_GROUPS: readonly AutomationSwitchGroup[] = [
  {
    id: "ai",
    title: "ИИ решает за агента",
    keys: ["aiCardFromCallEnabled", "aiAgentShowingAutoBookEnabled", "showingAgreementAskEnabled", "aiJobSeekerAutoDetachEnabled", "shabnamSocialPublishEnabled", "shabnamGroupAutoMemoryEnabled", "shabnamGroupUnaddressedEnabled", "telegramPhoneLinkEnabled", "clientRecordResultEnabled"],
  },
  { id: "tasks", title: "Задачи", keys: ["dealStaleSellersEnabled", "dealStaleBuyersEnabled"] },
  {
    id: "notifications",
    title: "Уведомления",
    keys: ["showingOutcomeAskEnabled", "notifyClientWaitingEnabled", "notifyRobotTookCallEnabled", "notifyTrashAnomalyEnabled", "notifyPropertyReviewOverdueEnabled"],
  },
  // Instagram через ключ компании — в группе бота (ревью #344: новых групп на экране не заводим).
  { id: "bot", title: "Бот клиентов", keys: ["botRepliesAfterLeadEnabled", "botSpamFilterEnabled", "botCoreFailAlertEnabled", "botRetryCapEnabled", "instagramCompanyKeyEnabled", "chatMediaTranscodeEnabled", "outgoingMediaCompressEnabled"] },
];

/** Подпись строки по ключу — для уже существовавшего выключателя берётся его родная. */
export function automationSwitchLabel(key: AutomationSwitchKey | "dealStaleSellersEnabled"): AutomationSwitchLabel {
  return key === "dealStaleSellersEnabled" ? SELLER_SWITCH_LABELS.dealStaleSellersEnabled : AUTOMATION_SWITCH_LABELS[key];
}
