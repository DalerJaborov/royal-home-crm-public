# 21.11.2026 — Instagram на постоянный ключ Meta

Решение владельца 21.11: «Да, переводи» (Instagram на ключ системного пользователя). Уточнение
координатора 21.11: переводить royal.home.tj и royalhome.info; Arvan (владелец: «арван потом его пока
заблокировали») оставить на старом пути, без будильника каждые полчаса.

## Сделано (ветка fix/ig-system-token-21-11)
- Рубильник «Instagram через постоянный ключ Meta» (`Settings.instagramCompanyKeyEnabled`, ВКЛ) в
  реестре «Автоматика», группа «Каналы связи». Instagram больше не ждёт отметки «App Review» и общего
  рубильника; путь через Страницу берётся только у аккаунта, прошедшего проверку (ключ компании, права,
  Страница с ЭТИМ Instagram). Отказ Meta на пути Страницы — один повтор личным маркером (было).
  Facebook-путь не тронут.
- Страницу аккаунта CRM находит сама (`autoLinkInstagramPages`, тик сторожа подписки раз в 3 ч, только
  поле `pageId`, с проверкой Instagram). После выката @royal.home.tj получит Страницу 873975375804470.
- Лента (сайт, узнавание роликов) и сверка переписок — тем же путём (`instagramMediaRequest`,
  `metaInboxReconcile`), чтобы не слепли при мёртвом личном маркере.
- «Meta закрыла доступ к аккаунту» (`MessengerAccount.accessLostAt`, `lib/instagramAccountAccess.ts`):
  одна отметка, одна запись, одна тревога руководству; сторож подписки, тишины, лента, продление,
  сверка такой аккаунт не трогают; суточная проверка молча пробует и снимает отметку при успехе;
  новый маркер снимает сразу.
- Тревоги Instagram (ключ умер, отказ пути Страницы, аккаунт молчит) — директору, РОПу и
  администратору, «к сведению», не чаще раза в сутки на аккаунт; «молчит» — раз на эпизод.
  Порог тишины у живого аккаунта (10+ переписок за неделю) — сутки, а не трое.
- Экран «Вечные ключи»: у строки Instagram — каким путём отвечает сейчас и «доступ закрыт Meta».

## Проверено
Тесты: `instagram-company-key.test.ts` (новый), `meta-eternal-tokens.test.ts`,
`instagram-webhook-subscription.test.ts`, `automation-switches.test.ts`; сборки; см. PR.

## Не проверено
Живой ответ клиенту без роли в приложении через Страницу (App Review, ниже) — смотреть после выката:
«Вечные ключи» → у Royal Home «Работает: была отправка», в журнале нет «отказ Meta на пути Страницы».

## Разведка и план (до правки)

## Что уже есть в коде (построено 12–13.11, #161/#162/#166, не включено)
- `lib/metaEternalTokens.ts` — одна дверь: выбор пути у физического вызова `meta.ts::callGraph`,
  `/me/messages` Instagram → `graph.facebook.com/{page}/messages` маркером Страницы от системного
  пользователя; при чётком отказе Meta (4xx) — один повтор личным маркером, Страница на скамейку 5 мин,
  тревога. Профиль собеседника (`instagramReadRequest`) идёт тем же путём.
- Включается только при: `Settings.metaSystemTokenPreferred` + `Settings.metaAppReviewApproved` +
  права ключа + `MessengerAccount.pageId` + Meta подтверждает, что к Странице привязан этот Instagram.
- Экран: Настройки → Каналы → «Вечные ключи» (`MetaEternalKeys.tsx`), кнопки «Найти Страницу», «Подписать Страницу».
- Сторож мёртвых ключей `lib/channelKeyAlarm.ts` (CRITICAL директору и админу, раз в 12 ч);
  сторож подписки и тишины `lib/instagramWebhookSubscription.ts` (только журнал).

## Прод, только чтение (21.11, ~10:00 UTC)
- Аккаунты Instagram: Royal Home 17841477393005072 (основной), Royal Home Info 17841438971591101,
  Arvan Estate 17841464398378814; все включены, `pageId` пуст у всех. Рубильник и «App Review» — выкл.
- Ключ системного пользователя royalhome-crm: действителен, SYSTEM_USER, срок «никогда», приложение
  Royal Home Reels 1684679092586215; права есть все нужные (instagram_basic, instagram_manage_messages,
  pages_messaging, pages_manage_metadata, business_management и др.).
- Страницы ключа: Royal.home.tj 873975375804470 ↔ @royal.home.tj; Arvan estate 1480983168421170 —
  Instagram к ней НЕ привязан. royalhome.info — ни к одной Странице ключа не привязан.
- Через Страницу маркером от ключа (GET): профиль @royal.home.tj — 200; лента `/{ig}/media` — 200;
  `/{page}/conversations?platform=instagram` — 50 переписок, 48 из 50 собеседников совпали с id
  диалогов CRM (их дали вебхуки входа через Instagram) → IGSID одинаковые, старые диалоги продолжаются.
- Страница Royal.home.tj уже подписана приложением Royal Home Reels на `feed,messages,messaging_postbacks`.
- Arvan: входящие встали 17.11 15:05 UTC (подписка вебхука в кабинете Meta «Выключено» — сообщение
  координатора); проверка CRM `GET /me/subscribed_apps` 17–20.11 этого не увидела. Маркер 401 с 20.11
  15:30 — текст Meta «You cannot access the app till you log in to www.instagram.com and follow the
  instructions» (проверка безопасности аккаунта, не смена пароля). Тревога директору ушла 20.11 20:20;
  «аккаунт молчит» — только строкой журнала с 20.11.
- Royal Home Info: последняя реплика клиента 10.11 — сторож тишины пишет в журнал каждые 3 ч, никто не видит.

## Документация (первоисточник)
- Instagram Messaging (через Страницу): «Apps with Standard Access can only interact with people who
  have a role on the app». https://developers.facebook.com/documentation/business-messaging/instagram-messaging/overview
- Вебхуки Instagram Messaging: «Webhooks will only be sent if the person using your app has a role on the app»,
  приложение должно быть опубликовано. https://developers.facebook.com/docs/messenger-platform/instagram/features/webhook
- Вход через Instagram: Standard Access покрывает свои аккаунты и добавленные в приложение — поэтому
  нынешний путь отвечает всем клиентам. https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api
- Отправка через Страницу: `/<PAGE_ID>/messages`, получатель — IGSID; маркер Страницы с instagram_manage_messages.
  https://developers.facebook.com/docs/messenger-platform/instagram/get-started

## БЛОКЕР
App Review (расширенный доступ к instagram_manage_messages) по документации обязателен, чтобы через
Страницу отвечать людям без роли в приложении. Против этого (ОЦЕНКА): Messenger той же Страницы
Royal.home.tj в том же приложении без App Review отвечает клиентам (72 диалога за 30 дней). У Arvan
Messenger 15.11 — наоборот, доходили только сообщения администратора (ФАКТ, META_PLAYBOOK).
Снимается живой проверкой: включить путь только для Royal Home и посмотреть первый ответ клиенту без
роли (при отказе Meta ответ уходит личным маркером — это уже в коде).

## План (после ответа)
1. Рубильник на аккаунт «Instagram через постоянный ключ Meta» в реестре «Автоматика»; включён, если
   проверка прошла (ключ, права, Страница, тот же Instagram); для Instagram отметка «App Review» не
   нужна, Facebook-путь не трогаем.
2. Страницу аккаунта CRM находит сама (раз в сутки, только своё поле `pageId`, с проверкой Instagram).
3. Тревога 401/190 по любому пути и «аккаунт молчит» → РОП и директор, несрочно, раз в сутки на аккаунт,
   с шагами. Порог тишины по обычному потоку аккаунта (Arvan — сутки, а не трое).
4. Карточка аккаунта: путь сейчас, жив ли, последняя входящая, сверка переписок.
5. Лента для сайта — через Страницу, если путь включён.
6. Тесты: выбор пути, запасной путь, тревога 401, повтор вебхука (ProcessedMessage уже держит дубли по mid).
