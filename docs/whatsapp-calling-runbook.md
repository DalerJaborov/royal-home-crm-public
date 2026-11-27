# Звонки клиентов из WhatsApp на нашу АТС через шлюз — runbook

Подготовлено 17.11.2026. Владелец на вопрос «Делаем приём звонков WhatsApp через шлюз на сервере?» ответил
«Да, делай» — это одобрение схемы и подготовки. **Каждая операция ниже меняет прод (сервер, АТС, Cloudflare
или настройки номера у Meta) и требует отдельного «да» владельца с её точным названием.** Общее «да» не
переносится. Метки: ФАКТ (откуда) / ОЦЕНКА / НЕТ ДАННЫХ.

Разведка и обоснование схемы: `D:/TASKS-2026-11-14/reports/whatsapp-calling-2026-11-18.md` (вне репозитория).
Код шлюза: `ops/whatsapp-gateway/`, фрагмент станции: `ops/asterisk/pjsip.endpoint_custom_post.conf` и блок
`[from-trunk-whatsapp]` в конце `ops/asterisk/extensions_custom.conf`.

## Схема

```
Клиент WhatsApp → Meta (TLS 5061, SRTP/SDES, Opus + PCMA)
  → шлюз на сервере CRM: Asterisk 22 в Docker (сеть хоста), имя wa-sip.royalhome.tj,
    сертификат Let's Encrypt; 5061/tcp и звук 41000–41199/udp открыты только сетям Meta
  → VPN 10.9.0.1 → 10.9.0.2: SIP/UDP 5062, G.711 a-law
  → станция: конечная точка whatsapp-gw → контекст from-trunk-whatsapp → входящий маршрут 6501414
    (ровно как звонок на городской номер: вердикт CRM, свой агент, офисный аппарат, очередь, ночь)
```

**Вливание этой правки в `main` ничего не запускает на сервере** (ФАКТ: `ops/auto-deploy.sh` относит `ops/*` и
`docs/*` к «ничего не пересобирать»; шлюз в отдельном `ops/whatsapp-gateway/docker-compose.yml`, его нет ни в
`docker-compose.prod.yml`, ни в `ops/deploy.sh`). После вливания файлы просто лежат в `/opt/royalhome-crm`.

## Решения владельца 17.11.2026 (дословно)

- «24 часа пусть стоит» — часы приёма у Meta не ставим (`call_hours` в запросе нет).
- «свой клиент — своему агенту, незнакомый — оператору нашему, у нас номер телефона и оператора нет,
  телефон в офисе +992446501414» — см. раздел «Незнакомый звонок и офисный телефон».
- «разговор записывается не надо» — фразу о записи не добавляем.

## Требования Meta, по которым собран шлюз (первоисточник, прочитано 17.11.2026)

| Параметр | Как у нас | Источник |
|---|---|---|
| TLS обязателен, порт по умолчанию 5061; сертификат публичный, имя = настроенному хосту | `transport-tls` на `${WA_PUBLIC_IP}:5061`, Let's Encrypt на `wa-sip.royalhome.tj` | [SIP → Security](https://developers.facebook.com/docs/whatsapp/cloud-api/calling/sip) |
| Проверка: `openssl s_client -verify_hostname <хост> -connect <хост>:5061` → «Verify return code: 0 (ok)» (без `-quiet`: он включает `-ign_eof`, и против Asterisk команда висит до таймаута) | так проверяют `wa-calling.sh enable` и `wa-health.sh` | там же, «How to test if you have a valid TLS certificate» |
| SRTP; ключи DTLS (по умолч.) или SDES | SDES (`media_encryption=sdes`, у Meta `srtp_key_exchange_protocol=SDES`) | [SIP → Configure SDES](https://developers.facebook.com/docs/whatsapp/cloud-api/calling/sip); FAQ: 488 без ICE лечится SDES |
| Кодеки: Opus всегда, можно добавить PCMA/PCMU | просим PCMA → без перекодирования до станции; запас — Opus-перекодер в шлюзе | [call-settings → audio](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings) |
| Digest для входящих «настоятельно рекомендуется»; имя — номер бизнеса без «+», пароль — от Meta, только через API `include_sip_credentials=true` | `auth=meta-inbound`, пароль из файла 600 | [SIP → User-initiated calls with digest auth](https://developers.facebook.com/docs/whatsapp/cloud-api/calling/sip) |
| Сети Meta = сети вебхуков, `whois … AS32934`, меняются; фильтр по адресу источника | `wa-firewall.sh` раз в сутки; 22 сети после свёртки (замер 17.11) | [SIP → IP addresses](https://developers.facebook.com/docs/whatsapp/cloud-api/calling/sip), [webhooks → IP addresses](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview) |
| Опознание INVITE Meta — заголовок `X-FB-External-Domain: wa.meta.vc` | `match_header` | [integration-examples → Asterisk](https://developers.facebook.com/docs/whatsapp/cloud-api/calling/integration-examples) |
| Не менять Record-Route в 200 OK (иначе звук рвётся ~32–33 с) | `rewrite_contact=no` | там же, Troubleshooting; FAQ |
| re-INVITE не поддерживается (500); REGISTER не нужен (403) | `timers=no`, регистрации нет | [FAQ → SIP](https://developers.facebook.com/docs/whatsapp/cloud-api/calling/faq) |
| Номер звонящего: `+<код><номер>` в From, может прийти BSUID вместо номера; заголовки `x-wa-meta-wacid`, `x-wa-meta-user-id` | шлюз пропускает только цифры, `+992…` → 9 цифр, заголовки → станции как `X-WA-Call-Id`, `X-WA-User-Id` | [SIP → Custom SIP headers, Sample requests](https://developers.facebook.com/docs/whatsapp/cloud-api/calling/sip) |
| Ожидание ответа ~30–60 с, потом у клиента «Не отвечено» | `WA_ANSWER_MODE=early`: шлюз сразу снимает трубку и сам играет гудки | [user-initiated-calls](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/user-initiated-calls) (для Graph API; для SIP — ОЦЕНКА, что так же) |
| Первый пакет SRTP шлёт бизнес | в режиме early шлюз сразу шлёт гудки | [SIP → SDES, примечание](https://developers.facebook.com/docs/whatsapp/cloud-api/calling/sip) |
| `call_icon_visibility`: `DEFAULT` / `DISABLE_ALL`; изменения доходят до клиентов до 7 дней | включаем со скрытой кнопкой | [call-settings](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings) |
| Health Status: `GET /<номер>?fields=health_status` → `can_receive_call_sip` | `wa-health.sh` | [health-status](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/health-status) |

## Что видно на нашей стороне (только чтение, 17.11.2026 ~22:40 по Душанбе)

| Что | Состояние | Откуда |
|---|---|---|
| Сервер | Debian 13, Docker 29.9, ufw активен (политика DROP), 80/443 только Cloudflare, `tun0` 10.9.0.1 | ФАКТ, `ssh rh-new` |
| Порты 5061, 5070, 41000–41199 | свободны (занят только 10.9.0.1:40800/udp — робот CRM) | ФАКТ, `ss -lntu` |
| Сертификаты | Caddy 2.11.7, HTTP-проверка; DNS-модулей нет; certbot/acme.sh нет; ключа Cloudflare на сервере нет | ФАКТ, `caddy list-modules`, поиск имён в env-файлах |
| Сети Meta | 824 записи route → 445 уникальных → 22 после свёртки | ФАКТ, whois с сервера |
| Станция | Asterisk 16.17.0; PJSIP tls :5061, **udp :5062**, ws :5060; `res_srtp`, `codec_opus` загружены; `pjsip.endpoint_custom_post.conf` пустой и подключён из `pjsip.conf` | ФАКТ, `ssh rh-pbx` |
| Файрвол станции | INPUT ACCEPT, свои цепочки только на eth0/eth1; tun0 не фильтруется | ФАКТ, `iptables -L INPUT` |
| Диалплан станции | совпадает с `ops/asterisk/extensions_custom.conf` (расхождение — одна строка комментария) | ФАКТ, `diff` |
| Правила приёма (AstDB) | `office_first/ext=2020` (Grandstream WP810, сейчас не зарегистрирован), `failover/action=none`, `nightaction=none`, `aimode` пусто, `seconds=40` | ФАКТ, `database show ROYALHOME` |
| Очередь 1000 | один участник — 1001 (Нурмухаммад), на паузе «статус в CRM» | ФАКТ, `queue show 1000` |
| Debian и Asterisk | Asterisk есть только в Debian sid (22.10.1); в trixie/forky/bookworm пакета нет | ФАКТ, `apt-cache policy` |

## Незнакомый звонок и «офисный телефон +992 44 650 1414»

**ФАКТ:** 446501414 — это не отдельный аппарат, а городской номер самой станции: входящий маршрут FreePBX
`6501414` (`dialplan show 6501414@ext-did`) ведёт в `royalhome-inbound`. Когда на него звонят, сейчас:

1. CRM за ≤ 12 с решает, чей клиент. Свой — уводит его агенту на мобильный (до 150 с, потом автоответчик).
2. Незнакомый: 20 с звонит **офисный аппарат 2020** (Grandstream WP810, Wi-Fi трубка; `office_first/ext`),
   затем очередь 1000 (сейчас в ней один человек, на паузе).
3. «Если не ответили» = `none` → звонок висит с гудками, пока звонящий не положит трубку; ночью то же самое
   (`nightaction=none`).

**Как сделано для WhatsApp:** вход WhatsApp идёт в тот же маршрут `Goto(ext-did,6501414,1)` — то есть «как
будто клиент позвонил на офисный номер». Набирать 446501414 со станции нельзя: это выход через платный транк
и вход обратно тем же транком — два платных плеча, а при сбое — петля. Общее правило «незнакомые → оператор»
для WhatsApp не меняется отдельно: оно уже ведёт на офисный аппарат 2020 первым. Если владелец захочет, чтобы
WhatsApp-незнакомые шли **только** на 2020 (без очереди), — это одна строка в блоке станции
(`Dial(SIP/2020,…)` вместо `Goto`), отдельное «да» и отдельное решение «что после 2020».

**Чего не хватает до показа кнопки клиентам (решение владельца, НЕ технический шаг):**
- Аппарат 2020 сейчас не на связи (ФАКТ, `sip show peer 2020`: Status UNKNOWN). Если он выключен, незнакомый
  WhatsApp-звонок сразу уходит в очередь.
- Очередь 1000 на паузе, а «если не ответили» = `none` → клиент слышит гудки, пока не положит трубку. Шлюз в
  режиме early снимает трубку сразу (Meta не засчитает «не отвечено»), но через `WA_RING_MAX=180` с без ответа
  кладёт трубку — клиент ничего не оставит.

**Ночь при режиме 24 часа — нужно решение владельца до показа кнопки.** Варианты (всё — штатные настройки CRM,
Настройки → Каналы связи; они действуют на ВСЕ входящие, не только на WhatsApp):

| Вариант | Что слышит клиент ночью | Плюсы | Минусы |
|---|---|---|---|
| А. Ночное правило «автоответчик» (`nightaction=voicemail`, окно 23:00–10:00 уже задано) | приветствие + запись сообщения; CRM заводит карточку и задачу «перезвонить» | уже построено и проверено, бесплатно, детерминировано | клиент говорит с автоответчиком |
| Б. Консультант-робот ночью (`aimode=no_answer`, день 10:00–22:30 уже задан) | робот отвечает, при нужде соединяет с агентом | живой разговор | платный голос ElevenLabs; робот на клиентах агента не говорит (решение 11.10); качество на WhatsApp-звонках не проверено |
| В. Дежурный на мобильном (`nightaction=forward`) | звонит мобильный дежурного | человек | кто-то должен брать трубку ночью; платное плечо через транк |

Рекомендация (ОЦЕНКА): **А** до первой недели статистики — дёшево и клиент не теряется; днём «если не
ответили» тоже поставить «автоответчик» вместо `none`. Без этого кнопку показывать не стоит: Meta скрывает
кнопку за низкий процент ответов (ФАКТ, call-settings → «low pickup rate»).

## Операции по порядку

Общее: команды сервера — `ssh rh-new`, станции — `ssh rh-pbx`. Секреты не печатаются никогда. После каждой
операции — проверка; красная проверка = откат этой операции и стоп.

### Операция 0. Влить правку в main (не прод)
- **Где:** ПК, `npm run ship` из основной папки.
- **Что на сервере:** файлы появятся в `/opt/royalhome-crm/ops/whatsapp-gateway/`; ничего не пересобирается и не запускается (см. выше).

### Операция 1 — «Cloudflare: добавить DNS-запись wa-sip.royalhome.tj без прокси»
- **Где:** панель Cloudflare (делает владелец, см. «Что владелец делает сам», п. 1).
- **Запись:** тип `A`, имя `wa-sip`, адрес `62.83.97.196`, **Proxy status: DNS only (серое облако)**, TTL Auto. Записи `AAAA` не делать.
- **Копия перед правкой:** не нужна (новая запись, старые не трогаются).
- **Откат:** удалить запись `wa-sip`.
- **Проверка:** `nslookup wa-sip.royalhome.tj 1.1.1.1` → `62.83.97.196` (не адреса Cloudflare 104.x/172.6x).
- **Клиент видит:** ничего.
- **Риск (ОЦЕНКА):** имя без облака раскрывает адрес сервера, где за Cloudflare живёт CRM. Сайт CRM от этого
  не открывается напрямую (80/443 пускают только Cloudflare), но атака «завалить сервер трафиком» станет
  возможна в обход Cloudflare. Убрать риск можно только вторым адресом у netcup (платно) — решение владельца.

### Операция 2 — «Сервер: установить файлы шлюза в /opt/royalhome-wa-gateway»
- **Команды:**
  ```bash
  sudo /opt/royalhome-crm/ops/whatsapp-gateway/bin/wa-install.sh --dry-run
  sudo /opt/royalhome-crm/ops/whatsapp-gateway/bin/wa-install.sh
  sudo sed -i 's/^WA_BUSINESS_NUMBER=.*/WA_BUSINESS_NUMBER=<номер WhatsApp агентства цифрами>/; s/^WA_ACME_EMAIL=.*/WA_ACME_EMAIL=<почта владельца>/' /opt/royalhome-wa-gateway/gateway.env
  ```
- **Копия:** при повторной установке прежние файлы — в `/opt/royalhome-wa-gateway/backup-<время>/` (делает скрипт).
- **Откат:** `sudo rm -rf /opt/royalhome-wa-gateway` (пока шлюз не запускался).
- **Проверка:** `sudo ls -la /opt/royalhome-wa-gateway /opt/royalhome-wa-gateway/secrets` — `secrets` 700, `gateway.env` 600.
- **Клиент видит:** ничего.

### Операция 3 — «Сервер: записать ключ Cloudflare (только DNS зоны royalhome.tj) в файл 600»
- **Где:** сервер. Ключ создаёт владелец (п. 2 ниже), присылает в чат; чат кладёт в файл, не печатая. Или владелец вводит сам:
  ```bash
  sudo bash -c 'umask 077; read -rsp "Ключ Cloudflare: " k; echo; printf "dns_cloudflare_api_token = %s\n" "$k" > /opt/royalhome-wa-gateway/secrets/cloudflare.ini; unset k'
  ```
- **Откат:** `sudo rm /opt/royalhome-wa-gateway/secrets/cloudflare.ini` + удалить ключ в Cloudflare.
- **Проверка:** `sudo stat -c '%a %s' /opt/royalhome-wa-gateway/secrets/cloudflare.ini` → `600` и размер > 30.
- **Клиент видит:** ничего.

### Операция 4 — «Сервер: собрать образ шлюза (без запуска)»
- **Команды:** `cd /opt/royalhome-wa-gateway && sudo docker compose build` (3–6 мин, ~500 МБ; CRM не трогает).
- **Откат:** `sudo docker image rm royalhome-wa-gateway:local`.
- **Проверка:** `sudo docker image ls royalhome-wa-gateway`.
- **Клиент видит:** ничего.

### Операция 5 — «Сервер: выпустить сертификат Let's Encrypt для wa-sip.royalhome.tj (DNS-проверка Cloudflare)»
- **Что происходит:** certbot принимает условия Let's Encrypt (`--agree-tos`, это часть «да»), ставит и сам
  убирает TXT-запись `_acme-challenge.wa-sip` в Cloudflare, кладёт сертификат в `/opt/royalhome-wa-gateway/certs/`.
- **Команды:**
  ```bash
  sudo /opt/royalhome-wa-gateway/bin/wa-cert.sh issue --dry-run
  sudo /opt/royalhome-wa-gateway/bin/wa-cert.sh issue
  ```
- **Откат:** `sudo rm -rf /opt/royalhome-wa-gateway/letsencrypt /opt/royalhome-wa-gateway/certs/*` (сертификат останется в публичных журналах CT — это безвредно).
- **Проверка:** `sudo /opt/royalhome-wa-gateway/bin/wa-cert.sh status` → `subject=CN = wa-sip.royalhome.tj`, издатель Let's Encrypt, срок ~90 дней.
- **Клиент видит:** ничего.

### Операция 6 — «Сервер: открыть 5061/tcp и звук 41000–41199/udp только сетям Meta»
- **Копия:** `sudo bash -c 'ufw status numbered > /root/ufw-before-wa-$(date -u +%Y%m%dT%H%M%SZ).txt; cp -p /etc/ufw/user.rules /root/ufw-user.rules.bak-$(date -u +%Y%m%dT%H%M%SZ)'`
- **Команды:**
  ```bash
  sudo /opt/royalhome-wa-gateway/bin/wa-firewall.sh apply --dry-run
  sudo /opt/royalhome-wa-gateway/bin/wa-firewall.sh apply
  ```
- **Откат:** `sudo /opt/royalhome-wa-gateway/bin/wa-firewall.sh remove`
- **Проверка:** `sudo /opt/royalhome-wa-gateway/bin/wa-firewall.sh show` (≈44 правила `rh-wa-sip`); правила
  Cloudflare/SSH/VPN на месте (`ufw status | grep -c Cloudflare` = 22 как до). С ПК (не Meta) `5061` закрыт:
  `Test-NetConnection wa-sip.royalhome.tj -Port 5061` → `TcpTestSucceeded: False`.
- **Клиент видит:** ничего.

### Операция 7 — «Сервер: запустить шлюз WhatsApp (контейнер royalhome-wa-gateway)»
- **Перед:** `sudo ss -lntup | grep -E ':5061 |:5070 |:41[01][0-9][0-9] '` — пусто.
- **Команды:** `cd /opt/royalhome-wa-gateway && sudo docker compose up -d`
- **Откат:** `cd /opt/royalhome-wa-gateway && sudo docker compose down`
- **Проверка:**
  ```bash
  sudo docker ps --filter name=royalhome-wa-gateway --format '{{.Status}}'      # (healthy)
  sudo docker exec royalhome-wa-gateway asterisk -rx "pjsip show transports"   # tls 62.83.97.196:5061, udp 10.9.0.1:5070
  echo | timeout 10 openssl s_client -verify_hostname wa-sip.royalhome.tj -connect wa-sip.royalhome.tj:5061 2>&1 | grep "Verify return code"   # Verify return code: 0 (ok)
  sudo /opt/royalhome-wa-gateway/bin/wa-health.sh --local
  ```
  В журнале шлюза строка «проверка пароля Meta ВЫКЛЮЧЕНА» — это норма до операции 10.
  `station` в `pjsip show contacts` будет недоступна до операции 8.
- **Клиент видит:** ничего (Meta про шлюз ещё не знает).

### Операция 8 — «АТС: добавить вход WhatsApp (конечная точка whatsapp-gw и контекст from-trunk-whatsapp)»
- **Копия (станция не под git):**
  ```bash
  ssh rh-pbx 'cd /etc/asterisk && s=$(date +%Y%m%d-%H%M%S) && cp -p extensions_custom.conf extensions_custom.conf.bak-$s && cp -p pjsip.endpoint_custom_post.conf pjsip.endpoint_custom_post.conf.bak-$s && ls -la *.bak-$s'
  ```
- **Команды (с ПК, из папки репозитория):**
  ```bash
  # станция = репозиторий без нового блока? (17.11 отличалась одна строка комментария; иначе — стоп и разбор)
  ssh rh-pbx 'cat /etc/asterisk/extensions_custom.conf' | diff - <(sed '/^; === Royal Home: звонки клиентов из WhatsApp/,$d' ops/asterisk/extensions_custom.conf) | head
  scp ops/asterisk/pjsip.endpoint_custom_post.conf rh-pbx:/etc/asterisk/pjsip.endpoint_custom_post.conf
  { echo; sed -n '/^; === Royal Home: звонки клиентов из WhatsApp/,$p' ops/asterisk/extensions_custom.conf; } | ssh rh-pbx 'cat >> /etc/asterisk/extensions_custom.conf'
  ssh rh-pbx 'chown asterisk:asterisk /etc/asterisk/pjsip.endpoint_custom_post.conf; asterisk -rx "module reload res_pjsip.so"; asterisk -rx "dialplan reload"'
  ```
  `module reload res_pjsip.so`, а не `pjsip reload`: конечную точку с опознанием по адресу Asterisk 16 подхватывает
  только так (память 24.10). Перезапуск станции не нужен: транспорт 5062 уже есть.
- **Откат одной строкой:** `ssh rh-pbx 'cd /etc/asterisk && cp -p extensions_custom.conf.bak-<время> extensions_custom.conf && : > pjsip.endpoint_custom_post.conf && asterisk -rx "module reload res_pjsip.so" && asterisk -rx "dialplan reload"'`
- **Проверка (никому не звонит):**
  ```bash
  ssh rh-pbx 'asterisk -rx "pjsip show endpoint whatsapp-gw" | grep -E "Endpoint|context|Identify|Contact"; asterisk -rx "dialplan show from-trunk-whatsapp"; asterisk -rx "dialplan show royalhome-inbound" | head -3'
  ssh rh-new 'sudo docker exec royalhome-wa-gateway asterisk -rx "pjsip show contacts"'      # station … Avail
  # Путь шлюз → станция без звонка людям: на номер «selftest» станция отвечает отбоем (404),
  # без номера звонящего CRM такой вызов не учитывает (short-number).
  ssh rh-new 'sudo docker exec royalhome-wa-gateway asterisk -rx "channel originate PJSIP/selftest@station application Wait 1"; sleep 2; sudo docker logs --since 10s royalhome-wa-gateway 2>&1 | grep -iE "404|selftest" | head'
  ```
- **Клиент видит:** ничего. Обычные звонки на 6501414 не затрагиваются (новый контекст и новая конечная точка, старые строки не меняются).

### Операция 9 — «Meta: включить звонки и SIP на номере WhatsApp, кнопка «Позвонить» скрыта»
- **Перед:** операции 1–8 зелёные; `sudo /opt/royalhome-wa-gateway/bin/wa-health.sh --local` — всё зелёное.
- **Копия:** `sudo /opt/royalhome-wa-gateway/bin/wa-calling.sh status > /root/wa-settings-before-$(date -u +%Y%m%dT%H%M%SZ).json` (пароль в выводе не бывает).
- **Команды:**
  ```bash
  sudo /opt/royalhome-wa-gateway/bin/wa-calling.sh enable --dry-run   # покажет тело запроса
  sudo /opt/royalhome-wa-gateway/bin/wa-calling.sh enable
  ```
  Тело: `calling.status=ENABLED`, `call_icon_visibility=DISABLE_ALL` (`callback_permission_status` enable не трогает
  с 27.11.2026 — обратные звонки отдельно: `wa-calling.sh callback-on|callback-off [--number=…]`),
  `srtp_key_exchange_protocol=SDES`, `audio.additional_codecs=["PCMA"]`, `sip.status=ENABLED`,
  `sip.webhook_delivery=ENABLED`, `sip.servers=[{hostname: wa-sip.royalhome.tj, port: 5061}]`. Ключ WhatsApp берётся
  внутри контейнера CRM её же загрузчиком (`loadCredentials`) и наружу не выходит.
- **Откат:** `sudo /opt/royalhome-wa-gateway/bin/wa-calling.sh disable` (или переключатель «Включите аудиозвонки» в WhatsApp Manager).
- **Проверка:** `wa-calling.sh status` (calling ENABLED, DISABLE_ALL, sip ENABLED, наш хост); `wa-health.sh` → `can_receive_call_sip: AVAILABLE`.
- **Клиент видит:** кнопки нет. **Оговорка (ФАКТ, call-settings):** в документации Meta два противоречащих
  места — `DISABLE_ALL` «запрещает незапрошенные звонки», а общий абзац говорит, что скрытие значка «не
  отключает возможность звонить». Поэтому шлюз и станция к этому шагу уже готовы принять звонок.
- **Побочное:** вебхук `calls` начнёт получать события `call_created`/`terminate`; CRM их пока молча пропускает
  (ФАКТ, `messengers/meta.ts`: нет `value.messages` → `continue`).

### Операция 10 — «Сервер: получить SIP-пароль Meta в файл и включить проверку пароля на шлюзе»
- **Команды:**
  ```bash
  sudo /opt/royalhome-wa-gateway/bin/wa-sip-password.sh --dry-run
  sudo /opt/royalhome-wa-gateway/bin/wa-sip-password.sh
  sudo sed -i 's/^WA_REQUIRE_AUTH=.*/WA_REQUIRE_AUTH=yes/' /opt/royalhome-wa-gateway/gateway.env
  cd /opt/royalhome-wa-gateway && sudo docker compose up -d --force-recreate
  ```
- **Откат:** `sudo rm /opt/royalhome-wa-gateway/secrets/meta/meta_sip_password; sudo sed -i 's/^WA_REQUIRE_AUTH=.*/WA_REQUIRE_AUTH=auto/' /opt/royalhome-wa-gateway/gateway.env; cd /opt/royalhome-wa-gateway && sudo docker compose up -d --force-recreate`
- **Проверка:** `sudo docker logs royalhome-wa-gateway 2>&1 | grep "пароля Meta"` → «ВКЛЮЧЕНА»; `sudo docker exec royalhome-wa-gateway asterisk -rx "pjsip show endpoint whatsapp" | grep -i "auth"` → `meta-inbound`; `stat -c %a …/meta_sip_password` → 600.
- **Клиент видит:** ничего (перезапуск шлюза рвёт только идущие WhatsApp-звонки — их ещё нет).

### Операция 11 — «WhatsApp: одно проверочное сообщение с кнопкой звонка на номер владельца»
- **Перед:** владелец сам пишет любое сообщение в WhatsApp агентства (открывается окно 24 ч).
- **Текст (на «да» — дословно):** «Проверка звонка WhatsApp Royal Home. Нажмите кнопку, чтобы позвонить.», кнопка «Позвонить», действует 60 мин.
- **Команды:** `sudo /opt/royalhome-wa-gateway/bin/wa-test-call-button.sh <номер владельца цифрами> --dry-run`, затем без `--dry-run`.
- **Откат:** не нужен (одно сообщение).
- **Что проверить звонком владельца** (днём, когда в офисе есть люди):
  1. Звонок дошёл до того, до кого должен (свой клиент → агент; номер владельца в CRM, скорее всего, «свой» — ОЦЕНКА; для пути незнакомого нужен второй телефон).
  2. Звук в обе стороны **дольше 60 с** (ловим обрыв на 33 с из-за Record-Route).
  3. В журнале входящих CRM появилась строка с номером владельца (9 цифр).
  4. На станции: `ssh rh-pbx 'mysql -e "select calldate,src,dst,dcontext,disposition,billsec from asteriskcdrdb.cdr order by calldate desc limit 5"'` — `src` 9 цифр, `dcontext` `from-trunk-whatsapp`/`royalhome-inbound`.
  5. Запись разговора `in-<9 цифр>-…` на станции (раз владелец решил «запись не объявлять» — запись при этом идёт, как у всех звонков).
  6. В WhatsApp Manager → «Журналы звонков» звонок виден.
  7. Положить трубку с обеих сторон по очереди — у второй стороны звонок завершается.
- **Клиент видит:** ничего (сообщение только владельцу).

### Операция 12 — «CRM: ночное правило и «если не ответили» для входящих» (решение владельца, см. раздел «Ночь»)
- **Где:** Настройки CRM → Каналы связи (владелец сам или чат по его выбору). Действует на все входящие.
- **Откат:** вернуть прежние значения (сейчас: `action=none`, `nightaction=none`).
- **Проверка:** второй проверочный звонок «вне часов» — клиент слышит автоответчик/робота, а не бесконечные гудки.

### Операция 13 — «Сервер: включить расписание шлюза (продление сертификата, сети Meta, проверка готовности)»
- **Команды:** `sudo /opt/royalhome-wa-gateway/bin/wa-cron.sh install --dry-run`, затем без `--dry-run`.
- **Откат:** `sudo /opt/royalhome-wa-gateway/bin/wa-cron.sh remove`
- **Проверка:** `cat /etc/cron.d/royalhome-wa-gateway`; утром — `tail /var/log/royalhome-wa-gateway.log`.
- **Клиент видит:** ничего. Тревога в Telegram — только при смене состояния (красное впервые / снова зелёное).

### Операция 14 — «Meta: показать кнопку «Позвонить» клиентам WhatsApp»
- **Перед:** операции 11–13 зелёные, решение по ночи принято и проверено.
- **Команды:** `sudo /opt/royalhome-wa-gateway/bin/wa-calling.sh show-button --dry-run`, затем без `--dry-run`
  (вариант `show-button-tj` — только клиентам из Таджикистана).
- **Откат:** `sudo /opt/royalhome-wa-gateway/bin/wa-calling.sh hide-button`
- **Проверка:** WhatsApp Manager → «Статистика звонка»; через неделю — доля отвеченных.
- **Клиент видит:** значок звонка в чате и в профиле агентства (у части клиентов — до 7 дней, ФАКТ call-settings).

### Операция 15 — «Второй номер WhatsApp «Арван» (+992 87 791 4444) на том же шлюзе» (26.11.2026)

Что поменялось в коде (ветка `feat/wa-gateway-second-number-26-11`, журнал
`docs/journal/2026-11-26-wa-gateway-second-number.md`): шлюз принимает список номеров (`WA_EXTRA_NUMBERS`),
у каждого номера свой SIP-пароль Meta (`secrets/meta/meta_sip_password.<номер>`; основной — прежний файл
`meta_sip_password`), звонок на второй номер уходит на станцию его phone_number_id, станция ставит метку
линии и оставляет имя «WhatsApp Arvan», CRM пишет `IncomingCall.waPhoneNumberId` и показывает «WhatsApp · Арван».
Строка канала WhatsApp «Арван» в CRM уже есть (26.11, id 74555485-…) — без неё `graph-call.mjs` откажет.

**Порядок важен:** станция → шлюз → Meta. Пока шлюз не знает номер, звонок на него шлюз отбивает («чужой
номер»), поэтому Meta включается последней. Каждый шаг — отдельное «да» владельца.

**15.1 «АТС: обновить блок from-trunk-whatsapp (вторая линия WhatsApp)»** — обычные звонки и звонки на
основной номер не меняются (имя «WhatsApp» сохраняется, новая строка только для 13+ цифр).
```bash
# копия
ssh rh-pbx 'cd /etc/asterisk && s=$(date +%Y%m%d-%H%M%S) && cp -p extensions_custom.conf extensions_custom.conf.bak-$s && ls -la extensions_custom.conf.bak-$s'
# сверка: блок WhatsApp на станции = прежний блок из main до этой правки (иначе — стоп и разбор)
ssh rh-pbx "sed -n '/^; === Royal Home: звонки клиентов из WhatsApp/,\$p' /etc/asterisk/extensions_custom.conf" \
  | diff - <(git show ce58e6219:ops/asterisk/extensions_custom.conf | sed -n '/^; === Royal Home: звонки клиентов из WhatsApp/,$p')
# замена блока (он последний в файле) на новый из репозитория
{ ssh rh-pbx "sed '/^; === Royal Home: звонки клиентов из WhatsApp/,\$d' /etc/asterisk/extensions_custom.conf"; \
  sed -n '/^; === Royal Home: звонки клиентов из WhatsApp/,$p' ops/asterisk/extensions_custom.conf; } > /tmp/ext_custom.new
ssh rh-pbx 'cat > /etc/asterisk/extensions_custom.conf.new' < /tmp/ext_custom.new
ssh rh-pbx 'cd /etc/asterisk && chown asterisk:asterisk extensions_custom.conf.new && mv extensions_custom.conf.new extensions_custom.conf && asterisk -rx "dialplan reload"'
```
- Проверка: `ssh rh-pbx 'asterisk -rx "dialplan show from-trunk-whatsapp"'` — есть `_XXXXXXXXXXXX.` и метка `common`.
- Откат: `ssh rh-pbx 'cd /etc/asterisk && cp -p extensions_custom.conf.bak-<время> extensions_custom.conf && asterisk -rx "dialplan reload"'`.

**15.2 «Сервер: обновить шлюз и добавить номер Арван (без пароля, звонки на него пока отбиваются)»**
```bash
ssh rh-new
sudo cp -p /opt/royalhome-wa-gateway/gateway.env /opt/royalhome-wa-gateway/gateway.env.bak-$(date -u +%Y%m%dT%H%M%SZ)
sudo /opt/royalhome-crm/ops/whatsapp-gateway/bin/wa-install.sh            # копия прежних файлов — backup-<время>/
grep -q '^WA_EXTRA_NUMBERS=' /opt/royalhome-wa-gateway/gateway.env \
  && sudo sed -i 's/^WA_EXTRA_NUMBERS=.*/WA_EXTRA_NUMBERS=992877914444:1476112588909838:Arvan/' /opt/royalhome-wa-gateway/gateway.env \
  || echo 'WA_EXTRA_NUMBERS=992877914444:1476112588909838:Arvan' | sudo tee -a /opt/royalhome-wa-gateway/gateway.env
# yes требовал бы пароль и у Арван, которого ещё нет, — шлюз бы не встал. auto: проверка пароля
# остаётся ВКЛЮЧЁННОЙ (у основного он есть), звонки на Арван без пароля отбиваются.
sudo sed -i 's/^WA_REQUIRE_AUTH=.*/WA_REQUIRE_AUTH=auto/' /opt/royalhome-wa-gateway/gateway.env
cd /opt/royalhome-wa-gateway && sudo docker compose build && sudo docker compose up -d --force-recreate
```
- Пересборка тянет базовый образ `debian:sid-20261104-slim` (теперь прибит к дате) и тот же Asterisk.
  Перезапуск рвёт идущие WhatsApp-звонки (несколько секунд) — делать, когда звонка нет:
  `sudo docker exec royalhome-wa-gateway asterisk -rx "core show channels count"`.
- Проверка: `sudo docker logs royalhome-wa-gateway 2>&1 | grep -E "номера бизнеса|пароля Meta|нет пароля"` →
  «номера бизнеса: <основной> 992877914444», «ВКЛЮЧЕНА: meta-inbound», «у номера 992877914444 нет пароля»;
  `sudo docker exec royalhome-wa-gateway asterisk -rx "dialplan show from-whatsapp" | grep 992877914444`;
  `sudo /opt/royalhome-wa-gateway/bin/wa-health.sh --local`; живой звонок на основной номер — как раньше.
- Откат: `sudo cp -p /opt/royalhome-wa-gateway/gateway.env.bak-<время> /opt/royalhome-wa-gateway/gateway.env;
  sudo cp -a /opt/royalhome-wa-gateway/backup-<время>/* /opt/royalhome-wa-gateway/; cd /opt/royalhome-wa-gateway &&
  sudo docker compose build && sudo docker compose up -d --force-recreate`.

**15.3 «Meta: включить звонки и SIP на номере Арван, кнопка скрыта»**
```bash
sudo /opt/royalhome-wa-gateway/bin/wa-calling.sh status --number=992877914444 > /root/wa-settings-arvan-before-$(date -u +%Y%m%dT%H%M%SZ).json
sudo /opt/royalhome-wa-gateway/bin/wa-calling.sh enable --number=992877914444 --dry-run
sudo /opt/royalhome-wa-gateway/bin/wa-calling.sh enable --number=992877914444
```
- Откат: `wa-calling.sh disable --number=992877914444`.

**15.4 «Сервер: SIP-пароль Arvan в файл, проверка пароля у обоих номеров»**
```bash
sudo /opt/royalhome-wa-gateway/bin/wa-sip-password.sh --number=992877914444
sudo sed -i 's/^WA_REQUIRE_AUTH=.*/WA_REQUIRE_AUTH=yes/' /opt/royalhome-wa-gateway/gateway.env
cd /opt/royalhome-wa-gateway && sudo docker compose up -d --force-recreate
```
- Проверка: в журнале «ВКЛЮЧЕНА: meta-inbound,meta-inbound-992877914444»; `stat -c %a
  /opt/royalhome-wa-gateway/secrets/meta/meta_sip_password.992877914444` → 600; `wa-health.sh` (теперь
  проверяет `can_receive_call_sip` у каждого номера).
- Откат: `sudo rm /opt/royalhome-wa-gateway/secrets/meta/meta_sip_password.992877914444`, `WA_REQUIRE_AUTH=auto`,
  `docker compose up -d --force-recreate` (Арван снова отбивается, основной номер не затронут).

**15.5 «Проверочный звонок на Арван»** — `wa-test-call-button.sh <номер владельца> --number=992877914444`
(текст сообщения зашит в `graph-call.mjs` и говорит «Royal Home» — на «да» владельца на этот текст) либо звонок
из WhatsApp, если кнопка видна. Ждём: агент видит «WhatsApp Arvan» на телефоне, в CRM строка «WhatsApp · Арван»,
в хронологии «Входящий звонок … из WhatsApp (Арван)».

**15.6 «Meta: показать кнопку звонка у номера Арван»** — `wa-calling.sh show-button --number=992877914444`
(откат `hide-button --number=992877914444`).

## Что владелец делает сам

1. **DNS-запись (операция 1).** Откройте dash.cloudflare.com → сайт `royalhome.tj` → DNS → Records → «Add record».
   Type: `A`; Name: `wa-sip`; IPv4 address: `62.83.97.196`; **Proxy status — выключите оранжевое облако, чтобы
   стало серым «DNS only»**; TTL: Auto → Save.
2. **Ключ Cloudflare только на DNS (для операций 3 и 5).** dash.cloudflare.com → значок профиля справа вверху →
   «My Profile» → «API Tokens» → «Create Token» → шаблон **«Edit zone DNS»** → «Use template». В «Zone
   Resources» выберите `Include` → `Specific zone` → `royalhome.tj`. Остальное не трогайте → «Continue to
   summary» → «Create Token». Скопируйте ключ (он показывается один раз) и пришлите в чат — я положу его в файл
   на сервере, не печатая; после запуска ключ стоит перевыпустить (он побывал в чате). Ключ даёт право только
   менять DNS-записи этой зоны: ни сайт, ни почту, ни оплату он не трогает.
3. **Почта для Let's Encrypt** (уведомления о сертификате) — назовите адрес.
4. **Решение по ночи и «если не ответили»** (раздел «Ночь») — до операции 14.
5. **Проверочный звонок** (операция 11) — со своего телефона, днём; для пути «незнакомый» — со второго номера, которого нет в CRM.

**Как сделано на сервере (18.11.2026) — HTTP-01 без ключа Cloudflare.** В `gateway.env`:
`WA_ACME_METHOD=http`, `WA_ACME_EMAIL=none` (письма об истечении Let's Encrypt больше не шлёт, за сроком следит
`wa-health.sh`; адрес владельца наружу не уходит). В `/etc/caddy/Caddyfile` — блок `http://wa-sip.royalhome.tj`,
который отдаёт `/.well-known/acme-challenge/*` из `/opt/royalhome-wa-gateway/acme-webroot`. Порт 80 открывается
всему интернету только на время certbot правилом ufw с комментарием `rh-wa-acme` (`wa-cert.sh`: снимает его по
номеру при выходе и остатки прошлого запуска в начале; чужое правило на 80 не трогает); `wa-health.sh` краснеет,
если такое правило висит вне работы `wa-cert.sh`. Сертификат — настоящий Let's Encrypt, `wa-health.sh --local`
→ «всё зелёное».

**Звонки у номера 18.11.2026:** обнаружены уже ВКЛЮЧЁННЫМИ и с видимой кнопкой звонка (кто-то включил их в
WhatsApp Manager вручную, мимо этого порядка) — выключены, затем включены правильно, по операциям этого runbook.

**Вариант HTTP-проверки, как он описывался до 18.11** (тогда не рекомендовался): HTTP-проверка через Caddy — добавить сайт
`wa-sip.royalhome.tj` в Caddyfile и **открыть порт 80 всему интернету** (сейчас — только Cloudflare). Минусы:
шире файрвол сервера CRM, правка живого Caddyfile, а сертификат шлюзу пришлось бы копировать из хранилища Caddy
своим скриптом. Ещё вариант — ручная TXT-запись раз в 60–90 дней: без автоматики сертификат однажды истечёт,
и звонки молча перестанут доходить. Поэтому — ключ с правом только на DNS.

## Чего не хватает CRM

Сделано 18.11.2026 (ветка `feat/whatsapp-calls-crm`, журнал `docs/journal/2026-11-18-whatsapp-calls-crm.md`):

1. ~~Пометка канала~~ — `IncomingCall.source = "whatsapp"` по имени канала `PJSIP/whatsapp-gw-…`
   (`lib/telephony/callSource.ts`; переменную `RH_SOURCE` через ARI не читаем — имя канала надёжнее и
   бесплатно), метка «WhatsApp» в журнале входящих на ПК и телефоне, «Входящий звонок клиента из WhatsApp» в
   хронологии, карточка незнакомого — с источником WHATSAPP, СМС после пропущенного не уходит.
2. ~~Поле `calls` в вебхуке~~ — строка в журнале контейнера (`messengers/whatsappCalls.ts`); ответ на запрос
   разрешения звонить и прочие служебные события до бота не доходят. Связки с каналом станции по
   `RH_WA_CALL_ID` пока нет.
5. ~~Тест на путь `from-trunk-whatsapp → isInboundContext`~~ — `tests/whatsapp-call-source.test.ts`; сторожа
   `can_receive_call_sip` раз в час — `lib/whatsappCallingHealth.ts`. Строки в `telephonyBaseline.ts` нет.

Осталось:

3. BSUID вместо номера: шлюз пропускает только номер; при BSUID CRM звонок не опознает (short-number) и станция
   пойдёт по общему правилу через 12 с. Нужна связка BSUID ↔ клиент по WhatsApp-диалогам.
4. Иностранные номера: на станцию идут с «+» → имя записи `in-+7…`; проверить `findRecording` на таком имени.
6. Сообщение с кнопкой звонка (`voice_call`) через дверь отправки CRM — после этого убрать операцию
   `test-call-button` из `graph-call.mjs`.
7. Связать событие вебхука (`id` = WACID) с каналом станции (`RH_WA_CALL_ID`): длительность и статус Meta рядом
   со строкой журнала входящих.

## Риски и что проверить нельзя до прода

- Задержка звука Meta → Германия → Душанбе (~106 мс по VPN, ОЦЕНКА) и качество — только живым звонком.
- Тайм-аут ответа Meta для SIP документацией не указан (для Graph API — 30–60 с). Режим early его обходит.
- Asterisk из Debian sid: ветка «unstable». Образ прибит к снимку архива 15.11.2026 и точной версии — сборка
  повторяема, но обновления безопасности приходят только сменой даты в Dockerfile (раз в квартал — ОЦЕНКА).
- Порт `port` в `sip.servers` документация описывает то строкой, то числом; шлёт число 5061 (ОЦЕНКА). Ошибка
  Meta вернёт 400 — ничего не изменится, скрипт покажет текст ошибки.
- Сети Meta меняются: без ежедневного `wa-firewall.sh` звонки однажды молча перестанут доходить; сторож —
  `wa-health.sh --alert` (операция 13).
- Шлюз в сети хоста: Asterisk слушает 5061 на публичном адресе; от чужих закрывает только ufw. Модули загружаются
  списком (`modules.conf`, `autoload=no`) — AMI, ARI, HTTP, IAX не грузятся.

## Проверено локально (17.11.2026)

`ops/whatsapp-gateway/test/run-e2e.sh`: образ собран, три контейнера («Meta» → шлюз → «станция» с настоящими
файлами `ops/asterisk/`), сценарии ok / без заголовка / чужой номер / без пароля. Результат — в журнале
`docs/journal/2026-11-17-whatsapp-sip-gateway.md`.
