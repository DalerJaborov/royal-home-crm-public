# 24.11.2026 — ship: повтор при обрыве Wi-Fi и снятие брошенного своей машиной замка

**Что изменилось.** `scripts/ship.mjs`: ENOTFOUND/ENETUNREACH/ENETDOWN/EHOSTUNREACH считаются отказом
связи (раньше ship падал сырым TypeError); запись к GitHub, не дошедшая до соединения
(ENOTFOUND, EAI_AGAIN, ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT …), повторяется до 3 раз с паузой
5/10/20 с; обрыв ПОСЛЕ отправки по-прежнему не повторяется. SIGINT/SIGTERM/SIGHUP/SIGBREAK
отпускают замок. `scripts/ship-lock.mjs`: в коммите замка — host и pid; замок умершего процесса
той же машины снимается сразу, а не через 45 минут.

**Почему.** Ночь 23→24.11: 28 запусков ship #400, ни одного вливания. Главная причина —
планировщик `mem-guard` (каждые 10 мин) убивал `bash npm run ship` как «сироту» (журнал
`~/.claude/tools/mem-guard/mem-guard.log`, 34 записи); taskkill /F не даёт отпустить замок, и
следующий запуск ждал собственный замок. Вторая — сеть: 3 из 80 TCP-соединений к 140.82.121.x:443
не установились за 15 с, Wi-Fi переподключался 07:00:15–07:01:29.

**Проверено.** `node --test scripts/ship.test.mjs scripts/ship-lock.test.mjs` — 61 pass, 0 fail.

**Осталось.** mem-guard: не трогать ship (решение владельца); `npm run precheck` на ветке не гонялся.
