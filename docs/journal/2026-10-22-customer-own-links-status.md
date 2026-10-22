# 22.10.2026 — Публичные ссылки сайта и статус проданного объекта

- Причина: сайт выдаёт RU/TG/EN ссылки и собственный числовой ID. Он не равен
  короткому номеру CRM; у объектов, созданных в CRM, прямая siteListingId-связь
  может отсутствовать. Один trailing-number lookup не доказывает нужную карточку.
- Ссылки: точные публичные форматы, запрет preview/неизвестных вложенных путей,
  traversal и encoded separators. Старые UUID by-crm и публичные category aliases
  сохранены; глобальный website-lead helper и история идентификаторов не меняются.
- CORE: после подлинного выбора владельца хода читает только anonymous
  listing.getById на фиксированном royalhome.tj. Без cookies/Authorization,
  redirects, токенов Meta и model/provider calls. Четыре GET разделяют 2 секунды,
  каждый ответ ограничен 64 KiB и проверяется по схеме и точному site ID.
  Данные дают только public crmShortId; цену/доступность бот читает из CRM.
- Конфликты локальной связи и публичного номера остаются неоднозначными.
  Нераспознанная новая ссылка B не сохраняет прежний объект A. Проверяются
  исходный claim/deadline, актуальный controller/namespace и новый вход клиента;
  общая краткоживущая registry сохраняется при media/selection enrichment.
- SOLD: отдельное status-only наблюдение по известной публичной карточке.
  Контракт требует пустые price/address/link и отсутствие characteristics.
  Исторические условия продажи не читаются/не хешируются для такого ответа.
  RU/TG renderer сообщает статус один раз, без навязанного номера. Явный
  отдельный запрос клиента на звонок сохраняет обычный consent flow.
  Sold не разрешает показ/вопрос собственнику и не входит в поиск предложений.
  В подборке публикации он исключён; единичная публикация может сообщить статус.
- Проверки: pure alias/identity/privacy/budget cases; actual signed RAW→FINAL→
  elected CORE→tools→encrypted outbox на своей PostgreSQL; native physical-send
  freshness и публичный catalog; available→sold между tool/model rounds; пауза,
  новый IN, отмена исходного runtime, конфликт ID и unresolved B после A.
  Интеграция поймала двойную строку SOLD из automatic/model observations;
  устранено прицельным подавлением повторного статуса того же объекта.
  Последующая проверка замороженной R1 выявила такой же повтор цены AVAILABLE.
  R2 подавляет только одинаковые строки фактов той же карточки и signature;
  RESERVED-статус тоже сообщается один раз. Разные карточки и версии фактов,
  а также receipts и остальной текст этим механизмом не объединяются.
- Версия: явное покрытие URL/identity/publication-rule/action guards в coreHash.
  Shared status contract/presentation меняют также knowledgeSchemaHash и
  rendererHash. Нужны полный облачный прогон, обычный ship, независимые server
  checks и штатный retained-policy refresh с фактическими compatibility flags.
  До этих этапов локальные тесты не означают production готовность.
- Не входит: массовая миграция ID, голос, 100% cutover, retirement старого
  контроллера, новая страховка или передача сотруднику. Отдельное решение
  владельца полностью отключить новые bot-created handovers выполняется
  следующим механизмом; существующие HUMAN pauses/tasks/receipts сохраняются.
