#!/usr/bin/env bash
# УСТАНОВКА АВТОВЫКАТА НА СЕРВЕРЕ (19.09.2026). Запускать НА VPS, один раз:
#
#   cd /opt/royalhome-crm && sudo ./ops/install-auto-deploy.sh
#
# Что делает: кладёт systemd-юниты royalhome-auto-deploy.service/.timer, включает
# таймер (тик раз в минуту) и сразу прогоняет одну проверку. После этого любой
# коммит в origin/main доезжает до прода сам, без GitHub Actions.
#
# Зачем именно systemd, а не cron: выкат идёт 1,5-3 минуты, а тик раз в минуту —
# systemd сам не запустит второй экземпляр сервиса поверх работающего, и вся
# история выкатов ложится в journalctl одной командой. Замок в самом скрипте
# всё равно стоит — на случай ручного запуска параллельно с таймером.
#
# Снять:  sudo systemctl disable --now royalhome-auto-deploy.timer
set -eu

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR=/etc/systemd/system

[ "$(id -u)" = "0" ] || { echo "нужен root: sudo $0" >&2; exit 1; }
[ -x "$REPO_DIR/ops/deploy.sh" ] || { echo "не вижу $REPO_DIR/ops/deploy.sh" >&2; exit 1; }

chmod +x "$REPO_DIR/ops/auto-deploy.sh"
mkdir -p /var/lib/royalhome-auto-deploy

# Домашний каталог root — именно его получит сервис (он работает от root).
SERVICE_HOME="$(getent passwd root | cut -d: -f6)"
[ -n "$SERVICE_HOME" ] || SERVICE_HOME=/root

# «dubious ownership»: каталог репозитория принадлежит не root, и без этой
# записи git из сервиса откажется читать даже имя ветки. У живого root она,
# скорее всего, уже есть — тогда ничего не меняем, чтобы не плодить дубли.
if ! git config --global --get-all safe.directory 2>/dev/null | grep -qx "$REPO_DIR"; then
  git config --global --add safe.directory "$REPO_DIR"
  echo "добавлено safe.directory=$REPO_DIR в $SERVICE_HOME/.gitconfig"
fi

cat > "$UNIT_DIR/royalhome-auto-deploy.service" <<UNIT
[Unit]
Description=Royal Home CRM — выкат origin/main на прод без GitHub Actions
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$REPO_DIR
ExecStart=$REPO_DIR/ops/auto-deploy.sh
# HOME ОБЯЗАТЕЛЕН (19.09.2026, поймано на первой же установке).
#
# systemd не задаёт HOME сервису, запущенному от root, а без HOME git не видит
# ни \$HOME/.gitconfig, ни \$HOME/.ssh/config. На этом сервере ломается и то, и
# другое: репозиторий принадлежит не root, и доступ ему открыт записью
# safe.directory в /root/.gitconfig (без неё git отказывается работать с
# «dubious ownership»), а адрес origin — это ssh-псевдоним github-crm из
# /root/.ssh/config, которого без HOME просто не существует.
#
# Как это выглядело: первый тик написал «на сервере ветка '?', а не 'main'» и
# вышел, ничего не сделав. Из-под живого root те же команды работают, потому что
# у него HOME есть — и разница видна только отсюда.
Environment=HOME=$SERVICE_HOME
# Выкат со сборкой образов по замеру занимает 1,5-3 минуты. 15 минут — запас на
# медленную сборку; дольше этого выкат считается зависшим и снимается, иначе он
# держал бы таймер и следующие коммиты не доехали бы вовсе.
TimeoutStartSec=900
# Прод на этой же машине. Выкат всегда уступает живой CRM — тот же принцип, что
# у раннера CI (см. комментарий к runs-on в .github/workflows/ci.yml).
Nice=10
IOSchedulingClass=idle
UNIT

cat > "$UNIT_DIR/royalhome-auto-deploy.timer" <<'UNIT'
[Unit]
Description=Royal Home CRM — смотреть origin/main раз в минуту

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
# Тик по завершении предыдущего, а не по расписанию: пока идёт выкат, очередь не
# копится.
AccuracySec=10s
Unit=royalhome-auto-deploy.service

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now royalhome-auto-deploy.timer

echo
echo "Готово. Таймер включён:"
systemctl status royalhome-auto-deploy.timer --no-pager | head -5
echo
echo "Первая проверка прямо сейчас:"
systemctl start royalhome-auto-deploy.service || true
journalctl -u royalhome-auto-deploy -n 30 --no-pager
