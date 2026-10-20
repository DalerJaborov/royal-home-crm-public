/**
 * СОЗДАНИЕ БАЗ ПРОЦЕССОВ.
 *
 * Зовёт отсюда один `runParallel.ts` — до того, как поднимет шарды. Отдельным
 * модулем, а не строчками внутри раннера, по двум причинам: DDL и логика «кому
 * какая база» тут собраны в одном месте, и их видно, не читая раннера целиком.
 *
 * Почему это НЕ `globalSetup` vitest, куда просится по смыслу: globalSetup
 * выполняется в КАЖДОМ процессе vitest, а их N — значит N одновременных
 * `CREATE DATABASE ... TEMPLATE` из одного шаблона, то есть гонка. Базы готовит
 * тот, кто процессы порождает, один раз и последовательно.
 *
 * Зачем всё это и почему шаблон — база из `DATABASE_URL`: см. `dbPerWorker.ts`.
 */
import { PrismaClient } from "../src/generated/prisma/client.js";
import { makePrismaAdapter } from "../src/lib/prismaAdapter.js";
import {
  maintenanceUrl,
  quoteIdent,
  redact,
  templateDatabaseName,
  workerDatabaseName,
} from "./dbPerWorker.js";

/**
 * Postgres отказывается копировать базу, к которой кто-то подключён. Своих
 * подключений на этот момент нет, а чужие — это либо dev-сервер разработчика
 * на той же базе, либо соседняя сессия. Гасить их насильно нельзя:
 * `pg_terminate_backend` по базе-шаблону оборвал бы работающий сервер. Поэтому
 * ждём пять секунд и объясняем, что делать.
 */
async function waitForTemplateToBeFree(db: PrismaClient, template: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const rows = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
      "SELECT count(*)::bigint AS count FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      template
    );
    if (Number(rows[0]?.count ?? 0) === 0) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `к базе «${template}» подключён кто-то ещё, скопировать её нельзя.\n` +
      `Обычно это свой же dev-сервер API на той же базе. Останови его — или запусти\n` +
      `прогон по-старому: VITEST_DB_PARALLEL=0`
  );
}

/**
 * Создаёт базы с указанными номерами копией шаблона, начисто. Возвращает время
 * в миллисекундах — чтобы вызывающий мог честно сказать, во что это обошлось.
 */
export async function prepareWorkerDatabases(baseUrl: string, indices: number[]): Promise<number> {
  const started = Date.now();
  const template = templateDatabaseName(baseUrl);
  const db = new PrismaClient({ adapter: makePrismaAdapter(maintenanceUrl(baseUrl)) });
  try {
    await waitForTemplateToBeFree(db, template);
    for (const i of indices) {
      const name = workerDatabaseName(baseUrl, i);
      // FORCE — потому что обрываем подключения только к СВОИМ базам: они
      // остались от прошлого прогона (базы по умолчанию не удаляются) и никому,
      // кроме тестов, не принадлежат. К базе-шаблону это не применяется никогда.
      await db.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
      await db.$executeRawUnsafe(`CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(template)}`);
    }
  } catch (err) {
    throw new Error(
      `не удалось подготовить базы для прогона (шаблон «${template}», сервер ` +
        `${redact(maintenanceUrl(baseUrl))}): ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    await db.$disconnect();
  }
  return Date.now() - started;
}

/**
 * Удаление баз. По умолчанию их НЕ удаляют (`VITEST_DB_KEEP=0` включает):
 * удаление ничего не ускоряет — при старте базы всё равно пересоздаются
 * начисто, — зато добавляет секунды к концу прогона, то есть ровно к тому
 * времени, которое человек ждёт у экрана. Оставленные базы к тому же можно
 * осмотреть после красного прогона.
 */
export async function dropWorkerDatabases(baseUrl: string, indices: number[]): Promise<void> {
  const db = new PrismaClient({ adapter: makePrismaAdapter(maintenanceUrl(baseUrl)) });
  try {
    for (const i of indices) {
      await db.$executeRawUnsafe(
        `DROP DATABASE IF EXISTS ${quoteIdent(workerDatabaseName(baseUrl, i))} WITH (FORCE)`
      );
    }
  } catch (err) {
    // Уборка не имеет права красить прогон: базы переживут до следующего
    // старта, где их всё равно пересоздают. Но и молчать нельзя.
    console.warn("[тесты] базы процессов не удалились:", err instanceof Error ? err.message : err);
  } finally {
    await db.$disconnect();
  }
}
