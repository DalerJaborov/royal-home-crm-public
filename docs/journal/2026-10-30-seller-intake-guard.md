# 2026-10-30 — продавец получал отказ по аренде / голую комиссию (P6)

Что: новый чистый модуль `ai/customerAgentSellerGuard.ts`, подключён в `customerAgentCore.ts` сразу после разбора решения модели (DM). Если intake видит продавца, а решение — `reply/clarify` с refs только на `company_policy` про аренду (клиент про аренду не писал) или только про комиссию (клиент не спрашивал комиссию/стоимость/«сколько получу»), либо пустой `reply` с вопросом `topic` — подменяется на `clarify seller_details` с `social` модели. В трассу: `fallbackReason: invalid_model_decision`, `fallbackCause: repair:seller_policy_mismatch`.
`customerAgentRole.ts`: «на продажу» (не вопрос) = продавец.
Судья: `no-commission-first` не краснеет, если клиент сам спросил про комиссию/стоимость (ru+tg); `topic:seller` принимает честный отказ по аренде, когда клиент говорил про аренду.
Корпус: 4 сценария `seller-media-001..004`.
Почему: прогон Gemini 30.10, продавец 30/41.
Проверено: build apps/api 0; `customer-agent-seller-guard.test.ts` (красный без подмены, зелёный с ней), `attack/judge.test.ts`, core/renderer/intake, `--model scripted --category seller` 45/45.
Осталось: «Чиро муфассалтар...» покрыто только для пустого reply с topic; живой прогон Gemini не повторялся. Хук в core вне зоны P6 (P2 правит ветку attachmentOnly) — вставка 4 строк.
