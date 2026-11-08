# 08.11.2026 — имя компании на аккаунт (Arvan Estate)

## Что и зачем
Подключили второй Instagram: Arvan Estate, дочерняя компания. Факты те же (Душанбе,
комиссия, офис, телефон), но бот обязан называть компанию «Арван» и никогда «Royal Home».
Имя «Royal Home» зашито в десятках кусков промта и готовых текстов, поэтому подмена
сделана одной функцией в точках выхода, а не копией промта.

## Что изменилось
- `MessengerAccount.brandName String?` + миграция `20261108100000_messenger_account_brand_name`
  (аддитивная, NULL у всех существующих аккаунтов = прежнее поведение).
- `messengers/accounts.ts`: поле в кэше, в `listAccounts`, `saveAccount` (undefined = не
  трогать, пусто = вернуть «Royal Home»), `accountBrandName(accountId)`.
- `routes/settings.ts`: `brandName` в схеме POST `/settings/messenger-accounts`.
- `ai/brandName.ts` (новый): `brandize` (чистая подмена «Royal Home» / «Royal Home Info» /
  `RoyalHome`; сайт royalhome.tj, ники и ссылки не трогает), `guardBrandLeak` (подмена +
  `logSystemError`, dedupKey `brand-name-leak`), `brandForAccount`, `brandForConversation`.
- Точки применения:
  - `ai/leadQualifier.ts::runQualifyTurn` — собранный `systemStable` и `system` перед `callAiText`;
  - `messengers/replyChain.ts::finalizeBotReply` — страховка на выходе (общий ряд для Meta,
    сайта и customer-lane; Telegram аккаунта не передаёт, ничего не меняется);
  - `ai/shortAgentReply.ts` — напоминание молчащему, подтверждение заявки, ответ собственнику
    (бренд по id диалога; в `conversation.ts`, `cron.ts`, `ownerQuestionAnswer.ts`,
    `askCandidatePhone.ts` добавлен `conversationId`);
  - `messengers/comments.ts` — промт комментариев, публичный ответ, личное по комментарию,
    письмо собственнику (`ownerDmText`);
  - `lib/absentAgentNotice.ts` — уведомление клиенту «агент в отъезде».
- UI `pages/settings/MessengerAccounts.tsx`: в форме добавления и в строке аккаунта поле
  «Как бот называет компанию (если не Royal Home)», чип «зовётся «…»».

## Проверено
- `tests/messenger-account-brand-name.test.ts` (12): промт аккаунта с брендом без «Royal Home» и
  с «Арван»; без бренда побайтово равен ходу без аккаунта; страховка на выходе; сохранение/чтение.
- Сторож проверен поломкой: убрал `brandize` в `runQualifyTurn` и бренд в `finalizeBotReply` —
  тесты покраснели; вернул — зелёные.

## Не менял (и почему)
- `lib/customerPublicModerationPolicy.ts::customerSellerPrivateReply` (customer-lane, публичный
  комментарий → личное продавцу): текст сверяется побайтово и хешем в
  `customerPublicOutreachMemory` / `CustomerPublicEffect.payloadHash`; подмена без переделки
  проверки сломает защищённый путь. ОСТАЁТСЯ ЗАДАЧЕЙ для отдельной правки, если Arvan
  подключат через customer-lane с публичной модерацией.
- `ai/recruitmentRecoveryReply.ts`, `lib/recruitmentCommunications*.ts`: кандидаты на вакансии
  (СМС/голос/хеш-проверка эха), у Arvan вакансий нет.
- `ai/offTopicGuard.ts` REPLIES: шаблоны не уходят клиенту (решение 21.08.2026 — молчание), а
  «offtopic» без названия; общий ряд всё равно подменит.
- WhatsApp (`lib/whatsappFirstContact.ts`), СМС входа, голос (`liveVoice*`, `*CallPersona`),
  Telegram-бот и группы, реклама/SEO/обложки — не Instagram-диалог аккаунта.

## Осталось / идеи
- Описание аккаунта в самом Instagram (био, имя профиля) от CRM не зависит.
- Если Arvan получит свою таблицу вакансий или объектов, имя в публичных карточках сайта
  подменять отдельно.

## Доработка после ревью PR #130 (08.11.2026)
- **Одна дверь для служебных текстов.** `lib/conversationDelivery.ts::deliverToConversation`: для
  отправителя bot/system/без отправителя текст проходит `brandize` по аккаунту цели (по
  `target.accountId`, а без него по диалогу). Закрывает реактивацию, напоминания о показе,
  оценку сделки, голосовые инструменты, «агент в отъезде». Подмена тихая: это шаблон, а не
  утечка модели, журнал утечек не шумит. Точечная правка в `absentAgentNotice.ts` убрана.
  В `ownerQuestionAnswer.ts` остался только `conversationId` в `shortAgentReply`: он нужен,
  чтобы подменить ПРОМТ короткой реплики, а не готовый текст.
- **Воронка лид-магнита.** `lib/leadMagnet.ts::brandedCampaign`: тексты кампании (приглашение,
  кнопки, подписка, публичные ответы, «выдано») под именем аккаунта-получателя на всех трёх
  входах. Файл чек-листа и ссылка не меняются: слова внутри PDF подменить нельзя (вопрос владельцу).
- **Клиентское ядро.** `lib/customerAgentEnrollment.ts`: аккаунт с `brandName` не зачисляется в
  CORE и не переводится LEGACY -> CORE, остаётся на прежнем пути; причина в журнале
  (`customer-agent-brand-blocked`). Подмены внутри ядра нет (хеши promptHash/payloadHash).
- **Шаблон имени.** Вынесен в чистый `ai/brandPattern.ts` (нет цикла с accounts.ts): ловит
  «Роял/Ройал/Рояль Хоум», перенос строки и узкий неразрывный пробел; «Royal Home Information»
  и «Royal Homes» по слову не ломаются. Имя со словом «Royal Home» запрещено при сохранении
  (400 в маршруте, ошибка в `saveAccount`).
- **Подписи постов.** `isOurBrandCaption` / `captionSaysForeign` принимают имя аккаунта: пост,
  подписанный «Арван», узнаётся как свой (вебхук личных сообщений). Без имени поведение прежнее.
  Не тронут `raiseUnknownShare` (строка руководителю): там нет имени аккаунта.
- **Аудит.** `POST /messenger-accounts` пишет в `logAudit` новое имя компании.
- **Тесты.** `messenger-account-brand-name-paths.test.ts` (доставка, короткие реплики, комментарии,
  воронка, шаблон, валидация, подписи), `messenger-account-brand-name-turn.test.ts` (целый ход
  через `processMessengerTurn`), кейс в `customer-agent-enrollment-postgres.test.ts`.
  Проверено поломкой по очереди: убрал `accountId` в вызове `finalizeBotReply` (conversation.ts),
  `leakSafe` в comments.ts, подмену в `deliverToConversation`, подмену промта в
  `shortAgentReply`, `brandedCampaign`, запрет в enrollment, проверку имени: каждый раз
  ровно свой тест краснел, файлы возвращены.
