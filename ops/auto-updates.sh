#!/usr/bin/env bash
# Обновления Ubuntu на сервере Royal Home CRM: включить автоматические
# ОБНОВЛЕНИЯ БЕЗОПАСНОСТИ и честно показать, что ещё ждёт руки.
# ИДЕМПОТЕНТЕН: повторный запуск ничего не ломает.
#
# ЗАЧЕМ ОТДЕЛЬНЫЙ СКРИПТ, КОГДА ЕСТЬ harden-vps.sh (владелец 19.09.2026: «пусть
# обновления сразу будут уходить, почему такое»). Тот же блок есть внутри
# `ops/harden-vps.sh`, но запускать его ради обновлений НЕЛЬЗЯ: он там идёт
# вместе с ufw, sshd и sysctl, и запуск без заполненного `SSH_ALLOW_CIDRS`
# способен отрезать доступ к серверу. Здесь — только обновления, без единого
# правила firewall.
#
# Запуск на сервере:
#   cd /opt/royalhome-crm && sudo ./ops/auto-updates.sh          # включить и показать состояние
#   cd /opt/royalhome-crm && sudo APPLY_ALL=1 ./ops/auto-updates.sh   # доустановить остальное сейчас
#
# ПОЧЕМУ «39 обновлений ждут», хотя автообновления включены. Ubuntu по
# умолчанию ставит сам ТОЛЬКО security-обновления (источники `-security` в
# `/etc/apt/apt.conf.d/50unattended-upgrades`). Обычные версии пакетов —
# docker, postgres, ядро, библиотеки — ждут решения человека, и это не
# недоработка, а защита: на сервере одна копия CRM, промежуточного стенда нет,
# и неудачный автоматический bump докера или ядра уронил бы прод ночью, когда
# никто не смотрит. Поэтому security ставим сами, остальное — одной командой,
# когда есть кому проверить (APPLY_ALL=1 выше).
#
# ПОЧЕМУ НЕТ АВТОМАТИЧЕСКОЙ ПЕРЕЗАГРУЗКИ. `Unattended-Upgrade::Automatic-Reboot`
# намеренно НЕ включается. Перезагрузка гасит CRM на минуту-две; агенты в это
# время теряют звонки и переписку. Момент выбирает владелец, а скрипт только
# говорит, что перезагрузка нужна. Душанбе UTC+5, тихое окно — 03:00-04:00
# местного, то есть 22:00-23:00 UTC.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "[updates] запускать через sudo/root" >&2
  exit 1
fi

APPLY_ALL="${APPLY_ALL:-0}"
log() { echo "[updates] $*"; }

# ── 1. Автоматические обновления безопасности ───────────────────────────────
log "включаю автоматические обновления безопасности"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq unattended-upgrades >/dev/null
# `dpkg-reconfigure` пишет свой 20auto-upgrades; наш файл кладём ПОСЛЕ него,
# чтобы значения были ровно те, что здесь написаны, а не те, что он выбрал.
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now unattended-upgrades.service >/dev/null 2>&1 || true
log "готово: security-обновления ставятся сами, перезагрузка — вручную"

# ── 2. Остальные обновления — только по явной просьбе ───────────────────────
if [ "$APPLY_ALL" = "1" ]; then
  log "APPLY_ALL=1 — доустанавливаю ВСЁ остальное"
  # `--with-new-pkgs`: без него held back остаются пакеты, которым нужен новый
  # зависимый пакет (обычное дело у ядра), и «39 обновлений» не кончаются.
  apt-get -y -o Dpkg::Options::=--force-confold upgrade --with-new-pkgs
  apt-get -y autoremove
  log "доустановлено"
fi

# ── 3. Состояние — честными числами, а не «вроде включено» ──────────────────
echo
log "СОСТОЯНИЕ"
if systemctl is-enabled unattended-upgrades.service >/dev/null 2>&1; then
  log "  автообновления безопасности: включены"
else
  log "  автообновления безопасности: ВЫКЛЮЧЕНЫ (неожиданно — смотри вывод выше)"
fi

apt-get update -qq
# `apt list --upgradable` печатает первой строкой «Listing...» — её не считаем.
pending="$(apt-get -s upgrade 2>/dev/null | grep -c '^Inst ' || true)"
log "  ждут установки: ${pending}"
if [ "${pending:-0}" -gt 0 ] && [ "$APPLY_ALL" != "1" ]; then
  log "  поставить их сейчас: sudo APPLY_ALL=1 ./ops/auto-updates.sh"
fi

if [ -f /var/run/reboot-required ]; then
  log "  ПЕРЕЗАГРУЗКА НУЖНА — уже установленные обновления вступят в силу после неё"
  if [ -f /var/run/reboot-required.pkgs ]; then
    log "  из-за пакетов: $(tr '\n' ' ' < /var/run/reboot-required.pkgs)"
  fi
  log "  перезагрузка гасит CRM на 1-2 минуты; тихое окно — 22:00-23:00 UTC (03:00-04:00 Душанбе)"
else
  log "  перезагрузка не нужна"
fi

last_run="$(ls -l --time-style=+%Y-%m-%d\ %H:%M /var/log/unattended-upgrades/unattended-upgrades.log 2>/dev/null | awk '{print $6, $7}')"
[ -n "$last_run" ] && log "  последняя работа автообновлений: $last_run UTC"
