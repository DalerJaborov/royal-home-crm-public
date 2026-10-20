#!/usr/bin/env tsx
/**
 * ЧИСТАЯ ТЕСТОВАЯ БАЗА — ДЛЯ `npm run ship -- --clean-db`.
 *
 * Полный прогон берёт базу из `DATABASE_URL` шаблоном и раздаёт процессам её
 * копии (`prepareDatabases.ts`). Если шаблон засорён остатками прошлых прогонов
 * или чужих сессий, засорены и копии — и прогон краснеет «не у того». Лечить
 * это `prisma migrate reset` нельзя: защита окружения требует на него слова
 * владельца, а на машине разработчика та же база может быть его рабочей.
 *
 * Поэтому рядом создаётся НОВАЯ пустая база `rh_clean_<время>` на том же
 * сервере; миграции на неё накатывает вызывающий (`prisma migrate deploy`), и
 * прогон идёт с её адресом. Старая база не трогается вовсе.
 *
 * Печатает в stdout ровно одну строку — адрес новой базы; всё прочее в stderr.
 *
 *   cd apps/api && npx tsx tests/makeCleanDb.ts
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { makePrismaAdapter } from "../src/lib/prismaAdapter.js";
import { maintenanceUrl, quoteIdent, redact } from "./dbPerWorker.js";

/** Имя по времени UTC: `rh_clean_20260924_163012`. Чистая функция — для теста. */
export function cleanDatabaseName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `rh_clean_${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `_${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}

/** Тот же адрес, другая база; параметры запроса (`schema=` и пр.) сохраняются. */
export function withDatabase(rawUrl: string, database: string): string {
  const url = new URL(rawUrl);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

async function main(): Promise<void> {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error("DATABASE_URL не задан — не на каком сервере создавать базу");
  const name = cleanDatabaseName(new Date());
  const db = new PrismaClient({ adapter: makePrismaAdapter(maintenanceUrl(baseUrl)) });
  try {
    await db.$executeRawUnsafe(`CREATE DATABASE ${quoteIdent(name)}`);
  } catch (err) {
    throw new Error(
      `не удалось создать базу «${name}» на ${redact(maintenanceUrl(baseUrl))}: ` +
        (err instanceof Error ? err.message : String(err))
    );
  } finally {
    await db.$disconnect();
  }
  console.error(`[чистая база] создана «${name}»`);
  process.stdout.write(`${withDatabase(baseUrl, name)}\n`);
}

// Запуск как скрипта, а не импорт из теста.
if (process.argv[1] && /makeCleanDb\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(`[чистая база] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
