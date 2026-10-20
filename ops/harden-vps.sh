#!/usr/bin/env bash
# Базовое усиление VPS Royal Home CRM (Ubuntu 22.04+). ИДЕМПОТЕНТЕН: повторный
# запуск ничего не ломает — каждый шаг сам проверяет, применён ли уже.
#
# НЕ ЗАПУСКАТЬ БЕЗ ЧТЕНИЯ. Правит ufw, sshd, sysctl — ошибка в allowlist SSH
# может отрезать доступ к серверу без прямого доступа к консоли провайдера.
# Перед первым запуском обязательно:
#   1. Убедиться, что есть доступ к серверу НЕ через SSH (консоль провайдера/VNC)
#      на случай, если правило ufw отрежет текущую сессию.
#   2. Заполнить SSH_ALLOW_CIDRS ниже (или передать через переменную окружения) —
#      пустой список = 22/tcp открыт всем, что бессмысленно для «усиления».
#   3. Прогнать на тестовом сервере/снапшоте, если он есть.
#
# Запуск на сервере (не в CI, не из worktree):
#   sudo SSH_ALLOW_CIDRS="1.2.3.4/32,5.6.7.8/32" ./ops/harden-vps.sh
#
# Если используется Tailscale — SSH держим ТОЛЬКО на tailscale0, публичный 22
# закрываем вовсе (см. блок ufw ниже, переменная SSH_VIA_TAILSCALE_ONLY=1).
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "[harden] запускать через sudo/root" >&2
  exit 1
fi

SSH_ALLOW_CIDRS="${SSH_ALLOW_CIDRS:-}"
SSH_VIA_TAILSCALE_ONLY="${SSH_VIA_TAILSCALE_ONLY:-0}"
SSH_PORT="${SSH_PORT:-22}"

log() { echo "[harden] $*"; }

# ── 1. Автообновления безопасности ──────────────────────────────────────────
log "unattended-upgrades"
apt-get update -qq
apt-get install -y -qq unattended-upgrades apt-listchanges >/dev/null
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
log "unattended-upgrades: готово"

# ── 2. ufw ───────────────────────────────────────────────────────────────────
log "ufw"
apt-get install -y -qq ufw >/dev/null
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing

if [ "$SSH_VIA_TAILSCALE_ONLY" = "1" ]; then
  log "SSH только через tailscale0 (публичный $SSH_PORT/tcp закрыт)"
  ufw allow in on tailscale0 to any port "$SSH_PORT" proto tcp
else
  if [ -z "$SSH_ALLOW_CIDRS" ]; then
    log "ВНИМАНИЕ: SSH_ALLOW_CIDRS пуст — $SSH_PORT/tcp открывается ВСЕМ (0.0.0.0/0)."
    log "Это временно и небезопасно — заполните allowlist и перезапустите скрипт."
    ufw allow "$SSH_PORT"/tcp
  else
    IFS=',' read -ra CIDRS <<< "$SSH_ALLOW_CIDRS"
    for cidr in "${CIDRS[@]}"; do
      cidr="$(echo "$cidr" | xargs)"
      [ -z "$cidr" ] && continue
      log "SSH разрешён с $cidr"
      ufw allow from "$cidr" to any port "$SSH_PORT" proto tcp
    done
  fi
fi

ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status verbose || true
log "ufw: готово"

# ── 3. fail2ban ──────────────────────────────────────────────────────────────
log "fail2ban"
apt-get install -y -qq fail2ban >/dev/null

mkdir -p /etc/fail2ban/filter.d
# Фильтр под Caddy JSON-логи (см. ops/Caddyfile.example: формат json общий лог) —
# ищет 401/429 на /api/v1/auth в течение окна времени.
cat > /etc/fail2ban/filter.d/caddy-crm-auth.conf <<'EOF'
[Definition]
failregex = ^.*"remote_ip":"<HOST>".*"uri":"/api/v1/auth.*"status":(401|429).*$
ignoreregex =
EOF

cat > /etc/fail2ban/jail.d/crm.local <<EOF
[sshd]
enabled = true
port = $SSH_PORT
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h

[caddy-crm-auth]
enabled = true
filter = caddy-crm-auth
port = http,https
logpath = /var/log/caddy/access.log
maxretry = 10
findtime = 15m
bantime = 30m
EOF

systemctl enable fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban
log "fail2ban: готово (sshd + Caddy 4xx/429 на /api/v1/auth; требует, чтобы Caddyfile писал json-лог в /var/log/caddy/access.log — см. ops/Caddyfile.example)"

# ── 4. sysctl ────────────────────────────────────────────────────────────────
log "sysctl"
cat > /etc/sysctl.d/99-crm-harden.conf <<'EOF'
# SYN-флуд: печенье вместо очереди половинных соединений.
net.ipv4.tcp_syncookies = 1
# Анти-спуфинг: обратный путь пакета обязан существовать в таблице маршрутизации.
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
# ICMP-редиректы — источник MITM на L3, серверу они не нужны.
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
# Source routing — та же причина, что redirects.
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
# Логировать пакеты с фальшивым (martian) адресом источника.
net.ipv4.conf.all.log_martians = 1
EOF
sysctl -p /etc/sysctl.d/99-crm-harden.conf >/dev/null
log "sysctl: готово"

# ── 5. SSH: запретить root-логин по паролю ───────────────────────────────────
log "sshd_config"
SSHD_DROPIN=/etc/ssh/sshd_config.d/99-crm-harden.conf
cat > "$SSHD_DROPIN" <<EOF
PermitRootLogin prohibit-password
PasswordAuthentication no
EOF
# Синтаксис перед перезапуском — ошибка здесь не должна обрывать SSH-сессию.
if sshd -t 2>/dev/null; then
  systemctl reload sshd || systemctl reload ssh || true
  log "sshd: root по паролю запрещён, PasswordAuthentication no"
else
  log "ВНИМАНИЕ: sshd -t не прошла проверку синтаксиса — $SSHD_DROPIN НЕ применён, чинить руками"
  rm -f "$SSHD_DROPIN"
fi

# ── 6. Docker: логи с ротацией по умолчанию для демона ──────────────────────
# docker-compose.prod.yml уже задаёт json-file/20m/5 на каждый сервис — это
# дублирующая страховка на уровне демона для контейнеров БЕЗ явной секции
# logging (например, будущих одноразовых `docker run`).
log "docker daemon.json (ротация логов по умолчанию)"
mkdir -p /etc/docker
DAEMON_JSON=/etc/docker/daemon.json
if [ -f "$DAEMON_JSON" ] && grep -q '"log-driver"' "$DAEMON_JSON" 2>/dev/null; then
  log "daemon.json уже настраивает log-driver — не трогаю (проверь вручную)"
else
  cat > "$DAEMON_JSON" <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" }
}
EOF
  systemctl restart docker || true
  log "daemon.json: готово (потребовался restart docker — уже выполнен)"
fi

log "ГОТОВО. Оставшееся вручную: docker-compose.prod.yml (no-new-privileges/pids_limit — внесены отдельным PR, см. docs/security-hardening-plan-11-09.md), Caddy (ops/Caddyfile.example), Cloudflare (раздел 3 плана)."
