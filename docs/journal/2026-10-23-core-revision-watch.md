# 2026-10-23 — ядро нового бота: сторож версии и узкий coreHash (F01)

**Что.** `loadVerifiedCustomerAgentRevision` при HELD `current_artifact_revision_mismatch` / `current_artifact_verification_unavailable` пишет в журнал ошибок (`ai`, dedupKey `customer-agent-revision-held:<id>`, окно сутки, один раз на ревизию в процессе) русский текст с указанием «Настройки → Новый бот → Обновить версию бота». Исключение из прежнего `catch {}` попадает в тот же журнал (имя и сообщение, 200 символов, без стека). Новое: `lib/customerAgentRevisionAlert.ts`, `lib/customerAgentRevisionStartCheck.ts` (проверка на старте `index.ts` и `worker.ts`: политика scoped+ACTIVE и активная ревизия не current — запись сразу). `coreHash` больше не включает общие утилиты: `privateFiles`, `safeFetch`, `ffmpeg`, `workingHours`, `services/leads/intake`, `messengers/attachments`, `incomingSpam`, `commentHate`, `listingAd`.

**Почему.** 22.10 релиз про вакансии (PR30 тронул `privateFiles.ts`) сменил coreHash, ядро молчало 15 часов (34 сообщения, 12 переписок), оповещения не было.

**Не сделано намеренно.** Автоматический refresh без администратора — решение кода, не менялось.

**Проверено.** `npm run build --workspace=apps/api` — 0. Тесты `customer-agent-revision-alert.test.ts` (9) и `customer-agent-core-hash-scope.test.ts` (13) зелёные; без починки 12 из 22 красные. С базой нужно прогнать: `customer-original-source-artifact`, `customer-own-site-artifact` (их setup трогает БД; список файлов, которые они сторожат, не менялся), `customer-agent-registration-postgres`, `customer-agent-routine-refresh-postgres`.

**Осталось / риск.** Модерацию публичных комментариев решают `incomingSpam`/`commentHate`/`listingAd` через `customerPublicModerationPolicy` (он в coreHash): правка этих словарей теперь не требует обновления версии, но и не фиксируется ею. Сторож показывает только расхождение, но не лечит его. После выката этой правки (она сама меняет coreHash) потребуется один ручной «Обновить версию бота».
