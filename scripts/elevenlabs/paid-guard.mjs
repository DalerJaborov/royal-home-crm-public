// Замок на платные проверки ElevenLabs (11.11.2026). Владелец: «сделай так чтобы автотестов
// не было … надо полностью контролировать это» — в тот день тесты агента (agent-testing)
// съели 98% израсходованных кредитов аккаунта, а не звонки.
//
// Правило: скрипт, который тратит кредиты, НЕ делает ни одного платного запроса, пока не
// заданы ОБА ключа:
//   --budget-credits=N                  — сколько кредитов можно потратить на этот запуск;
//   ELEVENLABS_PAID_TESTS_APPROVED=1    — окружение, ставит только владелец.
// Перед стартом — остаток подписки (GET /v1/user/subscription, бесплатно) и отказ, если
// бюджет больше остатка; во время — стоп, как только потрачено ≥ бюджета; после — итог.
// Сторож в elevenlabs-scripts.test.mjs не пропустит файл с платным адресом без этого замка.
//
// ФАКТ (справочник ElevenLabs, GET /v1/user/subscription): character_count — израсходовано
// за период, character_limit — лимит периода; кредиты считаются в этих единицах.

/** Адреса API, вызов которых тратит кредиты. Сторож ищет их в скриптах. */
export const PAID_ENDPOINT_PATTERNS = [
  /\/v1\/convai\/agent-testing\b/,
  /\/run-tests\b/,
  /\/simulate-conversation\b/,
  /\/v1\/text-to-speech\b/,
  /\/v1\/text-to-dialogue\b/,
  /\/v1\/speech-to-text\b/,
  /\/v1\/speech-to-speech\b/,
  /\/v1\/sound-generation\b/,
  /\/v1\/music\b/,
  /\/v1\/dubbing\b/,
];

export const APPROVAL_ENV = "ELEVENLABS_PAID_TESTS_APPROVED";

/**
 * Решение «можно ли платить». Без сети. Возвращает { allowed, budget, reason }.
 * values — разобранные флаги (`--budget-credits=N` → values["budget-credits"]).
 */
export function paidRunGate({ env = {}, values = {} } = {}) {
  const raw = values["budget-credits"];
  const budget = raw === undefined || raw === true || raw === "" ? NaN : Number(raw);
  const approved = String(env[APPROVAL_ENV] ?? "").trim() === "1";
  if (!Number.isInteger(budget) || budget <= 0) {
    return { allowed: false, budget: null, reason: "платный запуск закрыт: нужен --budget-credits=N (целое число больше нуля)" };
  }
  if (!approved) {
    return { allowed: false, budget, reason: `платный запуск закрыт: ${APPROVAL_ENV}=1 ставит только владелец` };
  }
  return { allowed: true, budget, reason: null };
}

/** Остаток подписки: { used, limit, left } или null, если прочитать не вышло. */
export async function readCredits(request) {
  const r = await request("GET", "/v1/user/subscription");
  const used = Number(r?.json?.character_count);
  const limit = Number(r?.json?.character_limit);
  if (!r?.ok || !Number.isFinite(used) || !Number.isFinite(limit)) return null;
  return { used, limit, left: limit - used };
}

/**
 * Открыть платный запуск: решение замка + остаток. Возвращает счётчик
 * { budget, exhausted(), finish() } или { refused: строка } — тогда скрипт выходит
 * ДО первого платного запроса.
 */
export async function openPaidBudget({ env, values, request, say }) {
  const gate = paidRunGate({ env, values });
  if (!gate.allowed) return { refused: gate.reason };
  const start = await readCredits(request);
  if (!start) return { refused: "платный запуск закрыт: не удалось прочитать остаток подписки ElevenLabs" };
  if (gate.budget > start.left) {
    return { refused: `платный запуск закрыт: бюджет ${gate.budget} больше остатка ${start.left} из ${start.limit}` };
  }
  say(`Бюджет запуска: ${gate.budget} кредитов; остаток до старта ${start.left} из ${start.limit}.`);
  let spent = 0;
  return {
    budget: gate.budget,
    /** Перечитать расход; true — бюджет исчерпан или счётчик недоступен, дальше платить нельзя. */
    async exhausted() {
      const now = await readCredits(request);
      if (!now) return true;
      spent = Math.max(0, now.used - start.used);
      return spent >= gate.budget;
    },
    async finish() {
      const now = await readCredits(request);
      if (now) spent = Math.max(0, now.used - start.used);
      say(`Потрачено за запуск: ${spent} кредитов из бюджета ${gate.budget}${now ? `; остаток ${now.left} из ${now.limit}` : "; остаток прочитать не удалось"}.`);
      return spent;
    },
  };
}
