// Загрузка ELEVENLABS_* из apps/api/.env для командных скриптов проверки.
// В отличие от scripts/_env.cjs, значения из .env ПЕРЕКРЫВАЮТ уже заданные в оболочке: устаревший
// ключ, оставшийся в переменных окружения Windows, молча давал «401 Invalid API key» при свежем ключе в .env
// (живой прогон 11.11). Ключ не печатается; печатается только откуда взяты имена.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Возвращает список имён, значение которых заменено значением из .env (без самих значений). */
export function loadElevenLabsEnv(env = process.env, file = path.join(ROOT, "apps", "api", ".env")) {
  if (!existsSync(file)) return [];
  const parsed = parse(readFileSync(file, "utf8"));
  const overridden = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (!name.startsWith("ELEVENLABS_") || !value) continue;
    if (env[name] !== undefined && env[name] !== value) overridden.push(name);
    env[name] = value;
  }
  return overridden;
}
