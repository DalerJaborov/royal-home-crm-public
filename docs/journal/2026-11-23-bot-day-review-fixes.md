# 23.11.2026 — разбор суток бота на проде: починки A–E

Источник: замаскированные переписки и комментарии прода за 22–23.11 (20 диалогов, 20 комментариев; только чтение).
Ветка `fix/bot-day-review-23-11`. Каждая починка — с тестом на живой случай.

## A. «С вами свяжутся сегодня» без человека и повтор невыполненного обещания (C6)
- `ai/operator/phrases.ts` `no_agent_noted`: без срока и без «свяжутся» — «Записали, ваше сообщение увидит сотрудник.»
  (tg: «Навиштем, паёматонро корманди мо мебинад.»). Звучит и после невыполненного обещания.
- `lib/contactPromiseUnkept.ts` (новый, чистый): бот обещал связаться ≥ 2 ч и ≤ 90 дн назад, после — ни звонка
  (`Client.lastAgentAttemptAt`), ни ответа сотрудника → `ctx.promiseUnkept` (`lib/operatorTurn.ts`).
- `ai/operator/decide.ts`: при `promiseUnkept` — без «он с вами свяжется / ответит», сигнал `call_staff: promise_unkept`.
- `lib/clientWaitingAlert.ts`: адресат — закреплённый агент → агент объекта, который клиент продаёт
  (`Property.sellerClientId`) → для жалобы и `promise_unkept` — последний агент (`Client.lastAgentId`); жалоба и
  `promise_unkept` — агенту пушем И копией руководству (РОП, директор, админ).
- `ai/callbackPromiseGuard.ts`: словарь обещаний узнаёт «Передал Сурайё, чтобы она позвонила вам завтра».

## B. Комментарии
- Одно слово «объект»: `ai/propertyObjectWord.ts` (`объект|обьект|обект|обэкт`), подключено в
  `lib/customerPropertyReferenceText.ts`, `ai/propertyMentionGuard.ts`, `ai/assistantFastPath.ts`, а по классу — в
  `lib/customerPropertyFactIntent.ts`, `lib/customerSearchSelection.ts` («обьект 2» читался как «второй вариант»),
  `messengers/sharedMedia.ts`, `messengers/sharedPostCard.ts`, `ai/customerSpamMute.ts`, `lib/clipPropertyRecognition.ts`,
  `ai/operator/understand.ts` (там `объект${TAIL}` на сложенном тексте без «ъ» не срабатывал вовсе).
  Сторож `tests/property-object-word-one-door.test.ts`.
- Повтор публичного ответа: `lib/commentReplyRepeat.ts` — одна дверь для ядра (`lib/customerPublicAgentTurn.ts`) и прежнего
  пути (`messengers/comments.ts`): тот же текст тому же автору под тем же постом за 7 дней не уходит; комментарий со словами
  или «?» — человеку (`duplicate_public_reply`), реакция — тихо.
- Отказ ядра по пределу шагов (`round_limit`, `tool_limit`, `output_limit`) — больше не «технический»: человеку всегда, при
  любом положении рубильников (`lib/commentWaitingAlert.ts`); FAILED и повтор — вид `unanswered`.

## C. Facebook: «Ба директ навиштем» до личного
- `messengers/comments.ts`: сначала личное, потом публичный ответ; личное не ушло — из ответа вырезаются слова о директе
  (`ai/commentDirectMention.ts`), пусто — нейтральный ответ. То же в ветке собственника (`contactOwner`).
- Отказ Meta: пометка `dm_failed:<вид>:<код>/<подкод>` и `logSystemError` с текстом Meta, ключ `comment-dm-failed:<канал>:<код>`.

## D/E. Понимание оператора
- Кнопка рекламы не источник вопроса: в контекст модели не идёт; вопрос модели без вопроса в словах этого сообщения после
  кнопки отбрасывается (C8 «Покупаем»).
- `roleByQuestion` — только если в словах есть вопрос (C10 «Купит квартира»).
- Приветствия: общий список `SALAAM_WORDS` (`ai/adTemplatePhrase.ts`) с «алекум» и др., его же берут
  `ai/customerDmLanguage.ts` и `ai/clientLanguage.ts` (C2).
- Отказ без предложения звонка («Не. Рахмат», «нет спасибо», «лозим нест») — «Напишите, когда будет удобно», вопрос о роли
  не повторяется; язык — таджикский, если таджикские слова и только общее «не» (C1).

## Не трогали (ждёт решения владельца)
Политика «без сильного интереса заявку не создаём» и тихая заявка через 2 часа — без изменений.

Проверка: точечные тесты на стенде (`agent_4791`), `tsc --noEmit` API.
