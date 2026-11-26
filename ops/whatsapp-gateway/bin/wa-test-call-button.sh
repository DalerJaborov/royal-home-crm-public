#!/usr/bin/env bash
# Проверочное сообщение с кнопкой «Позвонить» — ОДНО, на номер владельца.
# Нужно, пока кнопка у клиентов скрыта (DISABLE_ALL): кнопки в сообщениях
# скрытие не отключает [call-settings: «You can still send interactive
# messages»]. Сообщение уходит только в открытое окно 24 ч: владелец сначала
# сам пишет в WhatsApp агентства.
#
#   wa-test-call-button.sh <номер владельца цифрами, 992…> [--number=<номер бизнеса>] [--dry-run]
#
# Это СООБЩЕНИЕ человеку — только с «да» владельца на номер и текст
# (текст зашит в graph-call.mjs, TEST_TEXT; --dry-run его показывает).
set -euo pipefail
# shellcheck source=ops/whatsapp-gateway/bin/wa-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wa-lib.sh"
wa_parse_common "$@"; set -- "${WA_ARGS[@]}"
to="${1:-}"
[[ "$to" =~ ^[0-9]{9,15}$ ]] || wa_die "использование: wa-test-call-button.sh <номер цифрами с кодом страны> [--dry-run]"
wa_require_root
wa_load_env
# --number=<номер бизнеса> — сообщение уходит с этого номера (WA_EXTRA_NUMBERS, 26.11.2026).
wa_select_number
export WA_TEST_TO="$to"
wa_graph test-call-button
