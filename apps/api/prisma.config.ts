import "dotenv/config";
import type { PrismaConfig } from "prisma/config";

/**
 * КОНФИГУРАЦИЯ CLI PRISMA (переход на 7.x, 14.09.2026).
 *
 * В Prisma 7 адрес базы, путь к миграциям и команда сида уехали из
 * `schema.prisma` сюда: блок `datasource` в схеме оставляет только `provider`,
 * а заданный здесь `url` перекрывает схему.
 *
 * ФАЙЛ ЛЕЖИТ В `apps/api`, А НЕ В КОРНЕ РЕПОЗИТОРИЯ, И ЭТО НАМЕРЕННО. CLI ищет
 * конфиг от текущего каталога, а команды Prisma у нас запускались из двух
 * разных мест: сборка и CI — из корня, боевой контейнер — из `/repo/apps/api`
 * (`WORKDIR` в Dockerfile). Конфиг в корне второй случай бы не покрыл, поэтому
 * он лежит рядом со схемой, а все вызовы приведены к одному виду: рабочий
 * каталог `apps/api` (`npm run prisma:* --workspace=apps/api`).
 *
 * ИМПОРТ ИЗ `prisma/config` — ТОЛЬКО ТИПОМ, БЕЗ `defineConfig`. В боевом образе
 * `npm prune --omit=dev` выбрасывает пакет `prisma` (он в devDependencies), а
 * контейнер стартует с `npx prisma migrate deploy`. Значение, импортированное
 * из `prisma/config`, пришлось бы разрешать из `/repo/apps/api`, где пакета
 * нет; тип же стирается при загрузке конфига и требовать ничего не может.
 * `dotenv` — обычная зависимость сервера, она в образе остаётся, и загрузить
 * `.env` есть чем: Prisma 7 сама этого больше не делает.
 *
 * ЗДЕСЬ ИМЕННО `dotenv/config`, А НЕ ОБЩИЙ `src/loadEnv.ts`, хотя во всём
 * остальном apps/api точка загрузки одна. Причина простая: в боевом образе
 * лежит только `dist`, каталога `src` там нет, а этот конфиг читает CLI при
 * `migrate deploy` на старте контейнера — импорт из `src` его бы уронил.
 * Цена — одна строка «injecting env…» в журнале на старте (dotenv 17 печатает
 * её без `quiet`), и она того стоит.
 *
 * `datasource.url` берётся через `process.env`, а не через хелпер `env()`,
 * потому что `prisma generate` выполняется и там, где базы нет вовсе, — на
 * этапе сборки образа. Хелпер потребовал бы переменную немедленно и уронил бы
 * сборку; пустая строка доживает до `migrate deploy`, где переменная уже
 * задана, а если её и правда нет — падение случится там и будет честным.
 */
export default {
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
} satisfies PrismaConfig;
