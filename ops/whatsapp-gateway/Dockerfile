# Шлюз звонков WhatsApp -> АТС Royal Home (Asterisk из пакетов Debian).
#
# ПОЧЕМУ debian:sid. Asterisk есть только в Debian unstable (sid): в trixie (13),
# forky (testing) и bookworm пакета нет (проверено `apt-cache policy asterisk`
# 17.11.2026). Чтобы «unstable» не означал «каждая сборка разная», и образ, и
# список пакетов прибиты к одной дате архива snapshot.debian.org, а версия
# Asterisk — точной строкой. Пересборка через месяц даёт тот же Asterisk.
# Сменить дату/версию — осознанной правкой этого файла.
#
# Сторонних готовых образов Asterisk здесь нет намеренно: только официальный
# образ Debian и пакеты дистрибутива (решение 17.11.2026).
#
# certbot + плагин Cloudflare лежат в этом же образе: сертификат выпускает
# `wa-cert.sh` одноразовым контейнером из него же (отдельный образ не нужен).
FROM debian:sid-slim

ARG DEBIAN_SNAPSHOT=20261115T000000Z
ARG ASTERISK_VERSION=1:22.10.1+dfsg+~cs6.17.60671434-1

# Источник пакетов — снимок архива на фиксированную дату. Check-Valid-Until
# выключен только потому, что Release-файлы снимка формально «устаревают»;
# подписи пакетов при этом проверяются как обычно (Signed-By ниже).
RUN set -eux; \
    rm -f /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list; \
    printf 'Types: deb\nURIs: http://snapshot.debian.org/archive/debian/%s/\nSuites: sid\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' \
      "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list.d/snapshot.sources; \
    apt-get -o Acquire::Check-Valid-Until=false update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      "asterisk=${ASTERISK_VERSION}" "asterisk-modules=${ASTERISK_VERSION}" \
      gettext-base iproute2 ca-certificates openssl \
      certbot python3-certbot-dns-cloudflare; \
    apt-get clean; rm -rf /var/lib/apt/lists/*; \
    # Своя конфигурация целиком: примеры Debian (iax, manager, http, ari…)
    # убираются, чтобы ни один лишний модуль не открыл порт на хосте.
    rm -rf /etc/asterisk; \
    mkdir -p /etc/asterisk /etc/wa-gateway /var/lib/asterisk/keys /var/run/asterisk /var/log/asterisk /var/spool/asterisk; \
    chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk /var/spool/asterisk /var/log/asterisk /var/run/asterisk

COPY config/ /etc/wa-gateway/
COPY entrypoint.sh /usr/local/bin/wa-entrypoint
RUN chmod 0755 /usr/local/bin/wa-entrypoint

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD asterisk -rx "pjsip show transports" | grep -q "transport-tls" || exit 1

ENTRYPOINT ["/usr/local/bin/wa-entrypoint"]
