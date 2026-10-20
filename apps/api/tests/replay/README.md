# P04: ограниченный replay и структурные проверки

Harness исполняет существующие qualifier/reply chain и отдельные реальные ходы
CRM на собственном PostgreSQL stand. Он не создаёт второй бизнес-движок и не
проверяет качество живой модели: все AI-ответы и внешняя отправка синтетические.

Внешняя неизменная разметка содержит 200 диалогов / 210 выбранных ходов. Все они
учтены, но **полное историческое поведение всех 210 ходов unavailable**: нет
надёжного исходного состояния CRM, оригинальных карточек/referral/media и
ответов провайдера. Только 11 явно назначенных structural companions проходят
real qualifier / merge / reply chain; отдельные stand companions используют
объявленные синтетические карточки/контакты. Число assertions и число исходных
диалогов — разные знаменатели. Отчёт хранит их раздельно.

## Запуск

Из корня managed worktree, Node 24.16.0 (проверенный Windows runtime):

```powershell
$env:TEST_ENV_PIN='1'
node scripts/replay-customer-agent.mjs --mode offline `
  --dataset D:/CRM/bot-review-2026-10-13/golden-set `
  --artifact D:/CRM/bot-review-2026-10-13/replay/unique-offline-report.json
```

Нужны четыре исходных файла с закреплёнными SHA256 (`dataset.ts`); они читаются,
не копируются в git и не перезаписываются. Обязателен новый абсолютный private
artifact path вне корпуса и вне неигнорируемого git-кода. Junction/symlink
проверяется через canonical parent. CLI публикует финальный отчёт только после
успешного child exit, полного Vitest JSON, чистого ledger и проверки case report.
Рядом `.run.json` содержит runId, фактический child exit, completion и report hash;
старый/неполный `.pending-*` не является успешным результатом.

Перед child и перед публикацией CLI проверяет чистоту API/shared runtime source,
Prisma schema/migrations и package/lock manifests, включая untracked файлы.
Harness/docs WIP допускается; HEAD и fingerprint исполняемых graders обязаны
сохраниться между проверками. Fingerprint включает также загруженные
runParallelVerdict.ts и testEnvPin.ts вне replay directory.
Изменение источников делает manifest failed и не
публикует final artifact; actual child exit/counters сохраняются. Ignored shared
dist/generated client этой проверкой не удостоверяются: их сборка/генерация —
явные prerequisites stand, а не обещание полного герметичного snapshot.

Stand дополнительно требует явный `DATABASE_URL` и `REPLAY_STAND_MARKER`.
Маркер содержит `{version:1,database,host:"127.0.0.1",port:15500,worktree,nonce}`;
имя — выделенная `agent_<port>` база, canonical worktree должен совпасть.
Database COMMENT должен точно совпадать с `p04-replay:<nonce>`.
Это подготовка собственного isolated stand ответственным за окружение, а не
разрешение harness подключаться к любой базе с похожим именем. Проверка COMMENT
выполняется до импорта Prisma. Исторический P04 baseline использовал agent_4748;
повтор на foundation требует собственного маркера именно его worktree/базы,
актуальных миграций и повторного bounded gate. Старый результат не переносится.
Нужны заранее сгенерированный client / актуальный shared dist / миграции и seed.
Установить явные фиктивные JWT/encryption секреты согласно стандартам stand;
не загружать настоящие provider credentials. Команда с `--mode stand` использует
тот же обязательный dataset / новый artifact path.

## Границы и защита от ложного green

- No-DB setup не исполняет loadEnv / real DB и не зависит от стандартного setup.
  Явный `TEST_ENV_PIN=0` запрещён до любых overrides.
- Positive AI fixtures предварительно проверяются реальным shared
  `submitReplySchema` с объявленными capabilities. Намеренно malformed outputs
  помечены отдельно; они проверяют отказ boundary, а не полезный ответ модели.
  `aiUnavailable=false`, содержательный reply и actual OUT проверяются там,
  где заявлена успешная обработка.
- Sticky ledger запрещает original fetch/HTTP/TCP/TLS/HTTP2/DNS (включая Resolver
  instances)/UDP/subprocess и все неразрешённые DB/model calls. Это перехват
  известных Node API внутри одного worker, **не OS security sandbox** и не
  защита от произвольного native addon. Stand допускает только marker-owned PG
  endpoint и зарегистрированные конкретные loopback HTTP listener ports.
- Fake Graph разрешён только для graph.facebook.com / graph.instagram.com;
  сценарий отдельно проверяет метод/путь/форму synthetic POST. Original fetch
  никогда не вызывается. Реальные parser, HMAC verify, focus, output fence,
  Meta acceptance hook и exact MID storage остаются исполняемыми.
- Registered `trackBackgroundTask` отслеживается до settled. Timeout drain
  остаётся red. Это не универсальный учёт всех raw timers / void promises;
  provider deny hooks остаются до выхода worker, поздняя перехваченная попытка
  пишет private sticky marker и запрещает финальную публикацию.
- `--negative-probe late-caught-network|unfinished-drain|extra-model|wrong-oracle`
  с `--mode offline` — намеренные отрицательные контроли. Stand с этим флагом
  отклоняется до запуска child. Ожидаются exit 1, failed manifest и
  отсутствие финального отчёта, даже если отдельный Vitest test passed.

Missing/ambiguous facts, TJS/USD и private-address sentinel — синтетические
fixtures, не восстановленные исторические карточки. OFF/ON comparison относится
к одной выпущенной версии runtime, одинаковым IN/public card/logical contact и
объявленному scripted model; отдельные aliases исключают перенос истории между
контактами. Receipt unknown/held/accepted-with-stamp-failure различаются:
наблюдение fake provider acceptance при неудачной DB записи не считается
восстановленным durable receipt. Fence препятствует full-turn повтору;
Reconciliation/outbox относятся к следующим шагам.

`seed:null`: номера stand — идентификаторы окружения, не RNG seed. Physical
UUID/contact aliases случайны; scripted outputs/card/clock фиксированы.
Повтор no-DB и два card companion runs сравнивают объявленные semantic fields,
не полную seeded историю всей CRM.

Telegram, live voice, paid model quality, полноценный replay 924 разговоров,
human RU/TG review и метрики реальной конверсии этим harness не проверены.
Private отчёты могут содержать исходный обезличенный текст выбранных сообщений;
их не печатать в stdout и не отправлять третьим сторонам.

## Интеграция FOUNDATION

P04 включён в общий foundation release; самостоятельный draft1156 будет заменён
после подтверждённого общего merge. На новом исходном коде bounded offline,
negative controls и собственный PG stand должны пройти заново после clean
runtime commit. Старые результаты ниже — baseline другой версии, не новый gate.
Cleanup использует captured native IDs/account, scopes/inquiries и только
неиспользуемые досье с исключительно fixture identities. Settings восстанавливаются
даже при ошибке cleanup. Golden200/210 не меняется.

## Исторический baseline b130

P04 ещё не завершён. После фактического merge precursor #1154 ветка безопасно
обновлена до `b13074d4b4eb738f97596d7541ddbffb2f6e7afe`. Повтор no-DB:
11 evaluated companions / 34 passed structural assertions / 210 full historical
obligations unavailable; helper tests 30/30. Own-PG stand на той же версии:
14 synthetic companions / 71 passed assertions, включая строгий known-phone
и одинаковую пару OFF/ON; historical behavior 0 evaluated / 210 unavailable.
Четыре negative CLI probes повторно
подтвердили red и отсутствие final artifact; исходный corpus неизменён.
Stand12 выявил реальный no-reask defect: schema-valid «Назовите номер телефона»
проходит старый lexical guard при linked Client с известным номером. Assertion
сохранён; precursor #1154 merged, новый строгий stand прошёл. Semantic builds и
подготовительный gate `--no-tests` прошли; обязательный полный API root ship
остаётся до merge. Подготовительный gate не является full API результатом.
Предыдущие stand7 положительные model claims отозваны:
fixture `topic:'property'` отклонялся whole-result schema и не доказывал полезный
valid model path. Signed ON / fault companions без модели от этого не менялись.
