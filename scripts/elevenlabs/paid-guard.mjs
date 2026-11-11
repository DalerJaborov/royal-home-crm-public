// Замок на платные проверки ElevenLabs (11.11.2026). Владелец: «сделай так чтобы автотестов
// не было … надо полностью контролировать это» — в тот день тесты агента (agent-testing)
// съели 98% израсходованных кредитов аккаунта, а не звонки.
//
// Правило: скрипт, который тратит кредиты, НЕ делает ни одного платного запроса, пока не
// заданы ОБА ключа:
//   --budget-credits=N                  — сколько кредитов можно потратить на этот запуск;
//   ELEVENLABS_PAID_TESTS_APPROVED=<сегодняшняя дата ГГГГ-ММ-ДД по Душанбе> — окружение, ставит только владелец, на один день.
// Перед стартом — остаток подписки (GET /v1/user/subscription, бесплатно) и отказ, если
// бюджет больше остатка; во время — стоп, как только потрачено ≥ бюджета; после — итог.
// Сторож (unguardedPaidScripts ниже, тест в elevenlabs-scripts.test.mjs) не пропустит
// скрипт с платным адресом без этого замка — в scripts/ и apps/api/scripts целиком.
// Разрешение НЕ читается из apps/api/.env (load-env.mjs его пропускает): постоянная «1»
// в файле превратила бы замок в открытую дверь. Только оболочка, на один запуск.
//
// ФАКТ (справочник ElevenLabs, GET /v1/user/subscription): character_count — израсходовано
// за период, character_limit — лимит периода; кредиты считаются в этих единицах.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

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

/** Сегодняшняя дата по Душанбе (UTC+5), «ГГГГ-ММ-ДД». */
export function dushanbeDate(now = Date.now()) {
  return new Date(now + 5 * 3600_000).toISOString().slice(0, 10);
}

/**
 * Решение «можно ли платить». Без сети. Возвращает { allowed, budget, reason }.
 * values — разобранные флаги (`--budget-credits=N` → values["budget-credits"]).
 *
 * Разрешение — на ОДИН день (ревью 12.11.2026): значение — сегодняшняя дата по Душанбе,
 * `ELEVENLABS_PAID_TESTS_APPROVED=2026-11-12`. «1» больше не открывает: на Windows переменная,
 * однажды заданная навсегда (setx) или строкой в .env с другим регистром букв, держала бы
 * замок открытым для каждого следующего запуска. Имя ищется без учёта регистра.
 */
export function paidRunGate({ env = {}, values = {}, now = Date.now() } = {}) {
  const raw = values["budget-credits"];
  const budget = raw === undefined || raw === true || raw === "" ? NaN : Number(raw);
  const today = dushanbeDate(now);
  const approvals = Object.entries(env).filter(([k]) => k.toUpperCase() === APPROVAL_ENV).map(([, v]) => String(v ?? "").trim());
  const approved = approvals.length > 0 && approvals.every((v) => v === today);
  if (!Number.isInteger(budget) || budget <= 0) {
    return { allowed: false, budget: null, reason: "платный запуск закрыт: нужен --budget-credits=N (целое число больше нуля)" };
  }
  if (!approved) {
    return { allowed: false, budget, reason: `платный запуск закрыт: ${APPROVAL_ENV}=${today} (сегодняшняя дата) ставит только владелец` };
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

/** Файлы, которые сторож смотрит: исходники скриптов, без тестов и без самого замка. */
const SCRIPT_FILE = /\.(?:mjs|cjs|js|mts|ts)$/;
const SKIP_FILE = /(?:\.test\.|\.spec\.)|^paid-guard\.mjs$/;
const SKIP_DIR = new Set(["node_modules", "dist", ".git", "generated"]);

function* walkScripts(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name)) yield* walkScripts(path.join(dir, e.name));
    } else if (SCRIPT_FILE.test(e.name) && !SKIP_FILE.test(e.name)) {
      yield path.join(dir, e.name);
    }
  }
}

/**
 * СТОРОЖ ЗАМКА: скрипты под `roots`, в исходнике которых есть платный адрес
 * (PAID_ENDPOINT_PATTERNS — даже в комментарии: защита по умолчанию), но нет вызова
 * `openPaidBudget(`. Возвращает пути таких файлов; пусто — все под замком.
 * Ограничение (ОЦЕНКА): косвенный платный вызов — через функцию продукта или адрес,
 * собранный из кусков, — статически не виден; его держит только поведенческий тест.
 */
export function unguardedPaidScripts(roots) {
  const out = [];
  for (const root of roots) {
    for (const file of walkScripts(root)) {
      const src = readFileSync(file, "utf8");
      if (!PAID_ENDPOINT_PATTERNS.some((re) => re.test(src))) continue;
      if (!/\bopenPaidBudget\s*\(/.test(src)) out.push(file);
    }
  }
  return out;
}
