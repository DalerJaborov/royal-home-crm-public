# Шлюз звонков WhatsApp → АТС

Принимает звонки клиентов из WhatsApp от Meta (SIP по TLS, SRTP/SDES) и передаёт их станции FreePBX по VPN
как обычный входящий на городской номер. Порядок включения, «да» владельца, откат — только по
[docs/whatsapp-calling-runbook.md](../../docs/whatsapp-calling-runbook.md).

**Выкат CRM этот каталог не запускает**: отдельный `docker-compose.yml`, нет в `docker-compose.prod.yml` и
`ops/deploy.sh`; `ops/auto-deploy.sh` правки `ops/*` не выкатывает.

| Файл | Что |
|---|---|
| `Dockerfile`, `entrypoint.sh`, `config/` | образ (Debian sid по снимку архива, Asterisk из пакетов), сборка конфигурации из шаблонов |
| `docker-compose.yml` | сеть хоста (иначе docker обходит ufw), права урезаны |
| `gateway.env.example` | настройки без секретов → `/opt/royalhome-wa-gateway/gateway.env` |
| `bin/wa-install.sh` | копия в `/opt/royalhome-wa-gateway` |
| `bin/wa-cert.sh` | сертификат Let's Encrypt через DNS Cloudflare + продление |
| `bin/wa-firewall.sh` | ufw: 5061/tcp и звук только сетям Meta |
| `bin/wa-calling.sh` | звонки у Meta: включить (кнопка скрыта) / выключить / кнопка |
| `bin/wa-sip-password.sh` | пароль SIP Meta сразу в файл 600 |
| `bin/wa-health.sh` | готовность: шлюз, сертификат, станция, `can_receive_call_sip` |
| `bin/wa-cron.sh` | расписание: продление, сети Meta, проверка |
| `bin/wa-test-call-button.sh` | одно проверочное сообщение с кнопкой звонка владельцу |
| `bin/graph-call.mjs` | единственная дверь к Graph API (внутри контейнера CRM) |
| `test/run-e2e.sh` | локальная проверка «Meta» → шлюз → «станция», только Docker |

**Несколько номеров (26.11.2026).** Основной — `WA_BUSINESS_NUMBER`, дополнительные — `WA_EXTRA_NUMBERS`
(`номер:phone_number_id[:метка]` через запятую). У каждого номера свой пароль Meta
(`secrets/meta/meta_sip_password.<номер>`; у основного годится и прежний `meta_sip_password`).
`wa-calling.sh`, `wa-sip-password.sh`, `wa-test-call-button.sh` работают с номером из `--number=<цифры>`,
без него — с основным; `wa-health.sh` проверяет готовность у Meta каждого номера. Станция получает звонок
на дополнительный номер его phone_number_id — по нему CRM узнаёт бренд.

Каждый скрипт понимает `--dry-run`. Секреты (пароль Meta, ключ Cloudflare) — только в
`/opt/royalhome-wa-gateway/secrets/` (700/600), в git их нет.
