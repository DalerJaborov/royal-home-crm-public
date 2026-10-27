/**
 * Эталон окружения для тестов сервера (09.10.2026).
 *
 * ЗАЧЕМ. `tests/setup.ts` первым делом грузит `apps/api/.env` (через `src/loadEnv.ts`) —
 * и на машине человека этот файл заполнен под его стенд: `SITE_SYNC_URL` смотрит на
 * сайт, `CRM_PUBLIC_URL` — на `http://localhost:4000`. В CI этих переменных НЕТ
 * (`.github/workflows/ci.yml`, блок `env` задания тестов), и десятки тестов написаны
 * под это: «сайт не настроен → ответ „не настроена“», «ссылка на картинку начинается с
 * `https://crm-test.royalhome.tj`» (тесты сами ставят её через `??`, то есть только
 * когда переменной нет). 08–09.10.2026 из-за этого `npm run ship` — единственная дверь
 * на сайт — дважды останавливался красным на четырёх тестах при зелёном коде, по
 * двадцать минут за заход (`docs/journal/2026-10-09-etalon-okruzheniya-testov.md`).
 *
 * ЧТО ДЕЛАЕТ. После загрузки `.env` снимает адреса сайта и внешние credentials:
 * немокированный вызов не должен использовать личный ключ разработчика или
 * отправлять настоящий push/сообщение. База, JWT, шифрование и порты сохраняются.
 *
 * Тест, которому нужна одна из этих переменных, ставит её САМ в своём файле — так уже
 * делают `bot-photos.test.ts`, `buyer-guide.test.ts` и соседи. Файл подготовки
 * выполняется раньше тела теста, поэтому такое присваивание побеждает.
 *
 * ВЫКЛЮЧИТЬ (чтобы прогнать тесты против своего стенда с сайтом): `TEST_ENV_PIN=0`.
 * Применяется в `tests/setup.ts`; чистая функция вынесена отдельно, чтобы её можно было
 * проверить тестом на любом объекте окружения.
 */

/** External service credentials are absent by default; tests supply their own fakes. */
export const CI_UNSET_VARS = [
  "SITE_SYNC_URL",
  "SITE_SYNC_API_KEY",
  "SITE_SYNC_ADMIN_RESET_KEY",
  "SITE_PUBLIC_URL",
  "CRM_PUBLIC_URL",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GEMINI_API_KEY_2",
  "OPENAI_API_KEY",
  "ELEVENLABS_API_KEY",
  "SALEBOT_API_KEY",
  "GEMINI_PROXY_KEY",
  "IG_PROXY_KEY",
  "TELEGRAM_BOT_TOKEN",
  "META_WA_TOKEN",
  "META_IG_TOKEN",
  "META_PAGE_TOKEN",
  "META_ADS_TOKEN",
  "META_APP_SECRET",
  "META_IG_APP_SECRET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "PBX_RECORDINGS_TOKEN",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
  "CRM_NARRATION_EXECUTION_MODE",
  "CRM_OWNER_REPORT_EXECUTION_MODE",
  "CRM_OWNER_VERIFICATION_EXECUTION_MODE",
  "PUBLICATION_METADATA_EXECUTION",
  "SELLER_CONTROL_INTERNAL_LIVE",
  "SELLER_CONTROL_LIVE_FROM",
  "BUYER_CANDIDATE_INTERNAL_LIVE",
  "BUYER_CANDIDATE_LIVE_FROM",
  "MANUAL_DATA_CORRECTIONS_LIVE",
] as const;

export type EnvLike = Record<string, string | undefined>;

/** Снимает переменные эталона с объекта окружения; возвращает имена снятых. */
export function pinTestEnv(env: EnvLike, vars: readonly string[] = CI_UNSET_VARS): string[] {
  if (env.TEST_ENV_PIN === "0") return [];
  const removed: string[] = [];
  for (const name of vars) {
    if (name in env) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}
