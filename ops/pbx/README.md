# Станция FreePBX ↔ сервер CRM: защита, копии, сторожа (с 08.10.2026)

Файлы в этой папке — копии того, что стоит на станции (`10.155.0.95`, FreePBX 15 / Asterisk 16,
виртуалка у Вавилона) и на сервере CRM (`85.198.70.182`). Как и `ops/asterisk/`, это **источник
правды для сравнения и восстановления**, а не автоматический выкат: выкат CRM эти файлы на
станцию не ставит. Схема связи и решение владельца — `docs/handoff-2026-10-08-station-real-ip.md`.

## Что стоит на станции (`station/`)

| Файл в репозитории | Куда ставится | Зачем |
|---|---|---|
| `royalhome-eth1.sh`, `royalhome-eth1.service` | `/usr/local/sbin/`, `/etc/systemd/system/` | Маршрут только до сервера CRM через платный `eth1` + файрвол на `eth1` (входящее — только ответы и SSH/ping с сервера; исходящее — только на сервер). Стояло с 08.10 днём. |
| `royalhome-eth0-guard.sh`, `royalhome-eth0-guard.service` | то же | Закрывает на `eth0` (общая сеть оператора) MySQL 3306, AMI 5038, ARI 8088/8089, rpcbind, UCP-чат 5000/5222, IAX 4569, PnP 60000, mDNS, TLS-транспорты мёртвого софтфона. SIP 5060, RTP, SSH, панель 80/443 не трогает. Откат: `systemctl disable --now royalhome-eth0-guard`. |
| `royalhome-watchdog.sh`, `cron.d-royalhome-watchdog` | `/usr/local/sbin/`, `/etc/cron.d/royalhome-watchdog` | Раз в 2 минуты: маршрут через `eth1` на месте; у туннеля есть TCP-сессия к серверу; VPN `10.9.0.1` пингуется. Три промаха подряд — перезапуск службы (не чаще раза в 10 мин). Журнал `/var/log/royalhome-watchdog.log`. |
| `royalhome-backup.sh`, `cron.d-royalhome-backup` | `/usr/local/sbin/`, `/etc/cron.d/royalhome-backup` | Копия станции каждую ночь 03:20: база FreePBX, astdb, `/etc/asterisk`, наши службы/скрипты/cron/iptables, ключи туннеля и VPN, пароли SIP/AMI/ARI, звуки, CSV трафика. По воскресеньям — ещё и `asteriskcdrdb`. Архив шифруется gpg (пароль `/root/.royalhome-backup-pass`), хранится 8 последних в `/var/spool/asterisk/backup/royalhome/`. |
| `royalhome-backup-serve.sh` | `/usr/local/sbin/` | Forced command ключа `royalhome-pbx-pull` в `/root/.ssh/authorized_keys`: по этому ключу сервер может только забрать последнюю копию (`latest`/`name`/`list`), ничего больше. |
| `tunnel-dropin-zz-slow-retry.conf` | `/etc/systemd/system/royalhome-tunnel.service.d/zz-slow-retry.conf` | Повтор туннеля раз в 15 с, без предела попыток, после `royalhome-eth1`. |
| `openvpn-dropin-royalhome.conf` | `/etc/systemd/system/openvpn@rh-vps.service.d/royalhome.conf` | VPN звука робота: всегда перезапускать, после `royalhome-eth1`. |
| `logrotate-royalhome` | `/etc/logrotate.d/royalhome` | Журналы, которые FreePBX сам не ограничивал (до правила лежал один файл на 3,6 ГБ). |
| `royalhome-eth1-usage.sh`, `royalhome-eth1-usage` | `/usr/local/sbin/`, `/etc/cron.d/` | Учёт трафика `eth1` раз в час → `/var/log/royalhome-eth1-usage.csv`. С 08.10 файл отдаётся CRM по тому же каналу, что записи разговоров: `GET http://127.0.0.1:8090/royalhome-eth1-usage.csv` с заголовком `X-Recordings-Token` (alias в `/etc/httpd/conf.d/royalhome-recordings.conf`). |
| `royalhome-tunnel.service` | `/etc/systemd/system/` | Сам обратный туннель (ARI 8088, AMI 5038, записи 8090, SSH 2222 на сервере). Стоял с 07.08. |

Ещё на станции с 08.10: время берётся с сервера CRM через VPN (`server 10.9.0.1 iburst prefer`
в **`/etc/sangoma_chrony.conf`** — Sangoma запускает chronyd с этим файлом, `/etc/chrony.conf`
он не читает; до правки часы ушли вперёд на 26 с); `timedatectl set-local-rtc 0`; в строках
набора `DEVICE/1001|1003|1006/dial` (astdb и `asterisk.devices`) убраны мёртвые плечи
`PJSIP/rh-web-*`, `PJSIP/rh-mobile-1003`.

## Что стоит на сервере (`vps/`)

| Файл | Куда | Зачем |
|---|---|---|
| `pull-pbx-backup.sh` | `/opt/royalhome-pbx/pull-pbx-backup.sh`, cron `/etc/cron.d/royalhome-pbx-backup` (03:40) | Забирает копию станции через туннель ключом `/root/.ssh/royalhome_pbx_pull`, проверяет расшифровкой (пароль `/root/.royalhome-pbx-backup-pass`) и чтением оглавления, кладёт в `/backups/pbx/` (30 дней) и в `r2:royalhome-backups/pbx/`. Сбой — Telegram-алерт тем же путём, что у бэкапов CRM. |

Намеренно вне `/opt/royalhome-crm`: автовыкат встаёт, если в каталоге репозитория изменён
отслеживаемый файл, а cron должен работать независимо от выкатов.

Ещё на сервере с 08.10: `ufw` пускает OpenVPN 1194/udp только с реального адреса станции
`217.11.176.134` (было — отовсюду); chrony поставлен как сервер времени для станции
(`allow 10.9.0.2`, правило `ufw` на `tun0`); в `sshd_config.d/50-cloud-init.conf`
`PasswordAuthentication no` (действовало и раньше через `00-royalhome-hardening.conf`, теперь
нет противоречащей строки).

## Cron и PATH — обязательное правило для любого скрипта здесь

Cron на станции даёт `PATH=/usr/bin:/bin`; `ip`, `ss`, `iptables`, `asterisk` лежат в `/usr/sbin`.
09.10.2026 сторож без явного PATH принял «команда не найдена» за «туннель лежит» и перезапускал
здоровый туннель каждые 10 минут всю ночь (68 раз), а ночная копия не снялась вовсе. Поэтому:
каждый скрипт начинается с `export PATH=…/usr/sbin…`, каждый cron-файл — со строки `PATH=…`, сторож
при отсутствии приборов выходит молча (`command -v`), и **новый скрипт перед включением гоняется под
`env -i PATH=/usr/bin:/bin bash скрипт`** — тишина в журнале обязательна.

## Проверка (всё должно быть зелёным)

```bash
# сервер
ssh rh-vps 'ss -tlnp | grep -E ":2222|:8088|:5038|:8090" | wc -l; ping -c2 10.9.0.2 | tail -1; curl -s -o /dev/null -w "ari=%{http_code}\n" http://127.0.0.1:8088/ari/asterisk/info; chronyc clients | grep 10.9.0.2; ls -la /backups/pbx | tail -2; rclone ls r2:royalhome-backups/pbx/ | tail -2'
# станция
ssh rh-pbx 'systemctl is-active royalhome-eth1 royalhome-eth0-guard royalhome-tunnel openvpn@rh-vps chronyd | paste -sd" "; chronyc tracking | grep -E "Reference|System time"; iptables -S RH_ETH0_GUARD | wc -l; royalhome-eth1-usage.sh report; tail -3 /var/log/royalhome-watchdog.log; ls -la /var/spool/asterisk/backup/royalhome | tail -3'
```

Ожидаемо: 4 порта; ping 0 % потерь; `ari=401` (отвечает, пароль не передан — так и должно быть);
клиент `10.9.0.2` у chrony сервера; на станции `Reference ID … (10.9.0.1)`, 16 правил guard;
журнал сторожа пуст или без «перезапущен» в последних строках.

## Восстановление станции из копии

1. Взять `station-ГГГГ-ММ-ДД-*.tgz.gpg` из `/backups/pbx/` на сервере (или из R2).
2. `gpg --batch --passphrase-file /root/.royalhome-pbx-backup-pass -d station-….tgz.gpg | tar xz -C /tmp/pbx-restore`.
3. На новой станции: `mysql asterisk < asterisk.sql` (и `asteriskcdrdb.sql`, если есть),
   `/etc/asterisk` из `etc-asterisk/`, astdb — построчно `asterisk -rx "database put <семейство> <ключ> <значение>"`
   из `astdb.txt`, затем `fwconsole reload` ОДИН РАЗ (он перепишет `DEVICE/*/dial` из таблицы —
   поэтому строки набора ещё раз из `astdb.txt`), `dialplan reload`.
4. Службы и скрипты — из `system/`, ключи и пароли — из `secrets/`, VPN — из `system/openvpn/`.
5. Проверка — командами выше плюс живой звонок.

Пароль архива лежит в двух местах (станция и сервер). Потеряны оба — копии не прочитать;
владельцу стоит сохранить его в своём менеджере паролей (`cat /root/.royalhome-backup-pass`
на станции).
