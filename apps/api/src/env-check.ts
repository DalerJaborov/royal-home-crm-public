/**
 * Проверка окружения перед стартом. В production API отказывается запускаться
 * с дефолтными секретами из .env.example — молчаливый запуск с "change-me"
 * означал бы, что любой может подделать JWT и войти админом.
 * В dev только предупреждаем, чтобы не мешать локальной разработке.
 */
export function assertProductionEnv(): void {
  const isProd = process.env.NODE_ENV === "production";
  const problems: string[] = [];

  if (!process.env.DATABASE_URL) problems.push("DATABASE_URL не задан");

  for (const key of ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"] as const) {
    const value = process.env[key];
    if (!value || value.startsWith("change-me")) {
      problems.push(`${key} не задан или оставлен дефолтным ("change-me...")`);
    } else if (isProd && value.length < 32) {
      problems.push(`${key} слишком короткий (минимум 32 символа в production)`);
    }
  }

  if (!process.env.SETTINGS_ENCRYPTION_KEY || !/^[0-9a-f]{64}$/i.test(process.env.SETTINGS_ENCRYPTION_KEY)) {
    problems.push("SETTINGS_ENCRYPTION_KEY должен быть 64 hex-символа (32 байта)");
  }

  // Код входа в ответе сервера — только для стенда (lib/loginSmsCode.ts). На проде
  // это вход в любую учётку по номеру, поэтому сервер с ним не стартует.
  if (isProd && process.env.LOGIN_CODE_DEV_ECHO) {
    problems.push("LOGIN_CODE_DEV_ECHO задан в production — код входа ушёл бы в ответ сервера");
  }

  // Предупреждения, а не остановка. Это не секреты: без них система работает, но
  // тихо теряет целую способность, и заметить это можно только по жалобе клиента.
  const warnings: string[] = [];
  if (isProd && !process.env.CRM_PUBLIC_URL?.trim()) {
    warnings.push(
      "CRM_PUBLIC_URL не задан — бот не сможет отправить клиенту НИ ОДНОЙ фотографии объекта " +
        "(Meta забирает картинку по внешнему адресу CRM). Разговор при этом идёт как обычно, уходят только ссылки."
    );
  }
  if (warnings.length > 0) {
    console.warn(["[env] Предупреждения:", ...warnings.map((w) => `  • ${w}`)].join("\n"));
  }

  if (problems.length === 0) return;

  const message = ["Проблемы конфигурации окружения:", ...problems.map((p) => `  • ${p}`)].join("\n");
  if (isProd) {
    console.error(`[env] ЗАПУСК ОСТАНОВЛЕН.\n${message}\nСм. .env.example — как сгенерировать значения.`);
    process.exit(1);
  }
  console.warn(`[env] Предупреждение (dev-режим, в production запуск будет остановлен):\n${message}`);
}
