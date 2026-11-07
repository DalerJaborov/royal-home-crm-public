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
