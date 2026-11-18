# 18.11.2026 — Звонки из WhatsApp в CRM: метка, вебхук, сторожа, бот молчит на служебных событиях

- Что изменилось:
  - **Метка канала.** `IncomingCall.source` (`"phone"` | `"whatsapp"`, строка с умолчанием, миграция
    `20261118170000_incoming_call_source` — только `ADD COLUMN … DEFAULT 'phone'`). Решение — одна дверь
    `lib/telephony/callSource.ts`: канал станции `PJSIP/whatsapp-gw-…` = WhatsApp. Значения — `INCOMING_CALL_SOURCES`
    в `packages/shared`. Поле отдают `GET /calls/incoming` и `GET /calls/feed`; метка «WhatsApp»
    (`components/look/calls/CallSourceMark.tsx`) стоит во всех строках входящих: ПК и телефон, «новый вид» и прежний.
  - **Хронология.** «Входящий звонок клиента из WhatsApp: …» — WhatsApp ДОПИСАН после «Входящий звонок», а не вместо:
    по этому началу `lib/noContact.ts` (пропущенный входящий — не контакт агента) и `lib/telephony/callRecordings.ts`
    (поиск записи без добавочного) узнают входящий. Замена слов в начале строки, как предлагалось в задании, молча
    сломала бы оба места; тест держит начало строки.
  - **Карточка незнакомого** по звонку из WhatsApp заводится с источником `WHATSAPP` во всех трёх путях
    (`incomingCalls.ts`, `qualifyIncoming.ts::createClientForCall`, `autoLeadFromCall.ts`).
  - **СМС после пропущенного** (решение владельца): звонок из WhatsApp СМС не получает — одна проверка
    `missedCallFollowup.ts::missedCallSmsSkipForSource`, статус `whatsapp_call` (как остальные отказы — статусом).
    Задача «перезвонить» и пуши остаются как у обычного пропущенного (агенту клиента или общая).
  - **Вебхук, поле `calls`** (`messengers/whatsappCalls.ts`): connect/terminate и статусы звонка — одна строка в
    журнал контейнера (id звонка, событие, номер маской, статус, длительность), без записи в базу. Статусы звонка
    (`value.statuses`, `type: "call"`) больше не попадают в разбор доставки сообщений (`parseStatusUpdates`).
  - **Бот молчит на служебных событиях** (живой случай 18.11: после звонка Meta прислала
    `interactive.call_permission_reply` с `context.id = wacid.…`, бот ответил «не получается открыть вложение»).
    Решение на входе, в `parseIncoming` (им пользуются оба пути приёма — старый и ядро):
    `whatsappServiceEventReason` — ответ на звонок (`context.id` `wacid.…`), `call_permission_reply` → мимо бота,
    строка в журнале. По типам WhatsApp:
    - `reaction` — молчит (было с 01.08.2026);
    - `system` (смена номера и т. п.) — молчит;
    - `request_welcome` (открыл чат, ещё не писал) — молчит;
    - `unsupported` (Meta не смогла передать) — молчит, причина по-прежнему в журнал ошибок; раньше уходило боту
      «вложением» и в переписке CRM оставалось «[вложение: unsupported]» — теперь в переписке его нет;
    - `interactive` `button_reply` / `list_reply` — это слова человека: текст = подпись кнопки/строки (раньше тоже
      было «[вложение: interactive]»); `nfm_reply` — текст из `body`, если есть, иначе как раньше вложением;
    - `order` (заказ из каталога) — текст человека и id товаров словами;
    - `button` (кнопка шаблона) — без изменений.
  - **Сторож `can_receive_call_sip`** (`lib/whatsappCallingHealth.ts`, крон `whatsapp-calling-health` раз в час):
    звонки и SIP у номера включены, а Meta не даёт AVAILABLE — тревога «meta» с кодом и описанием Meta; снова
    AVAILABLE — закрывается сама. Звонки выключены — молчит, запроса о состоянии нет. Сбой самого запроса — своя
    тревога, тоже с автозакрытием. Таймаут 20 с, маркер только заголовком.
  - **Сторож офисного аппарата** (`lib/telephony/officeDeskPhoneWatch.ts`, из `runStationHealthTick` раз в 15 мин):
    приём заведён на аппарат (`incomingPrimaryTarget = "extension"`, 2020), а он не online на станции в рабочие часы
    (Settings.workHoursStart/End по Душанбе, без `companyDaysOff`) две проверки подряд — тревога «Офисный аппарат
    2020 не на связи с ЧЧ:ММ …»; снова на связи — закрывается. Ночью/в выходной и при обрыве связи со станцией
    не судит.
  - `ops/whatsapp-gateway/bin/wa-cert.sh` — правка координатора (режим ACME по http), вошла в этот коммит как есть.
- Почему: звонки WhatsApp заведены на станцию через шлюз SIP (`docs/whatsapp-calling-runbook.md`); CRM их не
  отличала, вебхук `calls` терялся молча, бот отвечал на служебные события, а 18.11 офисный аппарат весь день был
  выключен и этого никто не увидел.
- Чем проверено: `tests/whatsapp-call-source.test.ts`, `tests/whatsapp-call-webhook.test.ts` (в т. ч. вебхук целиком:
  `call_permission_reply` → 200, ни хода бота, ни исходящего; нарочно отключённый фильтр даёт 5 красных),
  `tests/whatsapp-calling-health.test.ts`, `tests/office-desk-phone-watch.test.ts`, новые случаи в
  `tests/missed-call-followup.test.ts`, `apps/web/.../CallSourceMark.test.tsx`; точечный набор API по телефонии и
  Meta; `npm run test:web`; `npm run precheck`. Кадров экранов нет — только тест разметки метки.
- Что осталось:
  - связать событие вебхука (WACID) с каналом станции через `RH_WA_CALL_ID` — длительность/статус Meta рядом со
    строкой журнала;
  - BSUID вместо номера (клиент с именем пользователя без номера) → связка BSUID ↔ клиент по диалогам WhatsApp;
  - сообщение автоответчика после звонка из WhatsApp заводит карточку с источником PHONE_CALL
    (`voicemailIngest.ts` не знает канал звонка);
  - иностранный номер из 9 цифр вместе с кодом страны `toCrmPhone` прочтёт как таджикский (редкий случай, не чинили);
  - кадры журнала входящих с меткой на ПК и телефоне — у сборщика пачки.
