/**
 * Загрузка .env для корневых разовых скриптов (scripts/*.ts|mjs), которым нужна база.
 *
 * ПОДКЛЮЧАТЬ ПЕРВЫМ ИМПОРТОМ: `import "./_env.cjs";` — раньше любого импорта,
 * который тянет apps/api/src/db.js. Импорты вычисляются раньше тела файла, и
 * `loadEnv({ path: ... })` строкой между импортами выполнялся ПОСЛЕ db.js: тот на
 * верхнем уровне создаёт `new PrismaClient({ adapter })` с DATABASE_URL, каким он
 * был на тот момент (prismaAdapter подгружает только .env из cwd). Скрипт мог
 * уйти в базу из корневого .env или отказать, хотя нужный адрес лежит в
 * apps/api/.env (аудит Codex 04.10, OPS05). Так же устроен apps/api/src/loadEnv.ts.
 *
 * Порядок прежний: сначала apps/api/.env, потом .env из cwd; dotenv уже заданное
 * не перекрывает, так что экспортированный заранее DATABASE_URL по-прежнему главный.
 * Путь к apps/api/.env считается от самого файла, а не от cwd.
 *
 * .cjs, чтобы подключаться и из ESM (.mjs), и из .ts, которые tsx собирает как CJS.
 */
const path = require("node:path");
const { config } = require("dotenv");

config({ path: path.resolve(__dirname, "..", "apps", "api", ".env"), quiet: true });
config({ quiet: true });
