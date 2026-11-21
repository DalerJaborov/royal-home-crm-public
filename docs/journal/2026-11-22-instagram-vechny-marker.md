# 22.11.2026 — Публикация в Instagram постоянным ключом компании

- Что изменилось:
  - Одна дверь «чем публиковать в Instagram»: `apps/api/src/lib/instagramPublisher.ts::resolveInstagramPublisher`.
    Сначала ключ компании (системный пользователь `royalhome-crm`, `Settings.metaIgManageToken`,
    срок «никогда»), если всё сходится; иначе личный ключ аккаунта, как раньше.
    Через неё идут: ролики (`socialPublish.ts`), истории видео и картинкой (`instagramStories.ts`),
    фото и карусели (`photoPosts.ts`, `socialReposts.ts`, `socialDigests.ts`, `socialVideoPosts.ts`),
    фоновое дозавершение контейнеров (`instagramPendingContainers.ts`) и живая проверка
    площадки на экране свободных роликов (`socialVideoChannels.ts`).
  - Условия ключа компании (`metaEternalTokens.ts::instagramCompanyPublishRoute`): рубильник
    «Instagram через постоянный ключ Meta» (тот же, что у переписки), ключ — маркер Facebook
    Login (`EAA…`), у аккаунта есть Страница, у ключа есть `instagram_basic`,
    `instagram_content_publish`, `pages_read_engagement`, и Meta подтверждает, что к Странице
    привязан именно этот Instagram. Адрес `graph.facebook.com/{ig-id}/media`, статус контейнера
    и `media_publish` подставляет уже существующий `metaGraph.ts::instagramRequest` по началу
    маркера `EAA` — сами функции публикации не менялись.
  - Тревога руководству «Ключ Instagram перестал работать — переподключите в Настройках → Каналы»
    при 401/190 личного ключа (при выборе пути) и ключа компании (при отказе публикации): общая
    дверь `channelKeyAlarm.ts`, «к сведению», раз в сутки на ключ. «Meta закрыла доступ к
    аккаунту» — своя дверь `instagramAccountAccess.ts`, второй тревоги нет.
  - «Проверить права» в Настройках → Каналы под полем «Маркер удаления Instagram»: тот же
    `GET /settings/meta-eternal` (право `settings.manage`), теперь отдаёт все выданные права и
    список нужных со словами (`COMPANY_KEY_SCOPE_CHECKS`). Маркер в ответ не попадает.
    В строке аккаунта Instagram — «Публикует постоянным ключом компании / личным ключом».
  - `tokenScopes.ts`: у «Маркера удаления Instagram» добавлены `instagram_content_publish` и
    `pages_read_engagement` — суточная проверка прав скажет, если их нет.
- Почему: 11–12.11 владелец сменил пароль Instagram, личный ключ IGAA умер (401 «session
  invalidated»), @royal.home.tj перестал публиковать. Переписка уже ушла на Страницу ключом
  компании (21.11), публикация — нет. Вечный ключ от пароля не зависит.
- Переписка (пункт 2 задания) не трогалась: путь через Страницу ключом компании уже есть
  (`metaEternalTokens.ts::routeMetaMessagingCall`, с 21.11 под тем же рубильником), вебхуки и
  подписка не менялись.
- Чем проверено: без сборки и прогона (в копии нет node_modules, по заданию не ставились).
  Типы и имена сверены чтением. Сторож `tests/instagram-publisher-one-door.test.ts` прогнан
  своей логикой через node на коде до правки (7 файлов-нарушителей) и после (0). Новые тесты:
  `tests/instagram-publish-company-key.test.ts` (выбор ключа, ролик на graph.facebook.com,
  одна тревога на 401, права без маркера). `docs/product-flows.*` пересобраны; `product-map.mjs`
  без пакета `typescript` не запускается — карту пересоберёт `npm run ship` на своде.
- Что осталось:
  - Прогнать `npm run precheck` и новые тесты; `npm run map`.
  - Живьём: «Проверить права» — увидеть `instagram_content_publish` и `pages_read_engagement`;
    затем один ролик — в журнале и на экране строка «Публикует постоянным ключом компании».
  - Статистика (`instagramInsights.ts`, онлайн-подписчики в `routes/settings.ts`, `postStats.ts`)
    по-прежнему берёт личный ключ — не в этой правке. Комментарии Instagram не проверял.
