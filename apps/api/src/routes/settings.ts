import { canViewInvestigations } from "@royal-home/shared";
import { investigationCallChannelIds, mayReadLiveVoiceSession } from "../lib/investigationCallChannels.js";
import { customerAgentSettingsRouter } from "./customerAgentSettings.js";
import { settingsInstagramAppBindingRouter } from "./settingsInstagramAppBinding.js";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import sharp from "sharp";
import { z } from "zod";
import { prisma } from "../db.js";
import { can, requireAuth, requirePermission } from "../auth/middleware.js";
import { verifyAccessToken } from "../auth/jwt.js";
import { audioUpload, upload, uploadsDir } from "../upload.js";
import { encryptSecret, decryptSecretSafe } from "../crypto.js";
import { DEFAULT_BOT_PERSONA } from "../ai/leadQualifier.js";
import { DEFAULT_LIVE_VOICE_PROMPT, buildLiveVoiceSystemPrompt } from "../ai/liveVoicePersona.js";
import { withSelfGenderReminder, withSelfGenderRule } from "../ai/liveVoiceSelfGender.js";
import { DEFAULT_COMMENT_PROMPT } from "../messengers/comments.js";
import { logAudit } from "../lib/audit.js";
import { clientNamePhoneSafe, maskClientPhone } from "../lib/clientPhone.js";
import { liveVoicePromptToolRulesError } from "../lib/liveVoicePromptGuard.js";
import { manualRobotCallLimitReached, MANUAL_ROBOT_CALL_LIMIT_ERROR } from "../lib/telephony/manualRobotCalls.js";
import { effectiveGeminiModels, resolveGeminiRuntime, type GeminiModelSettings } from "../ai/geminiSettings.js";
import { checkGeminiModel } from "../ai/geminiCheck.js";
import { upgradeStoredAdsToken } from "../lib/ads/metaAdsToken.js";
import { upgradeStoredMetaUserToken } from "../lib/metaUserTokenRefresh.js";
import { requireElevation } from "../lib/stepUp.js";
import { secretFormatError, type SecretKind } from "../lib/secretFormat.js";
import { refreshUsdToTjsRateFromAlif } from "../lib/exchangeRate.js";
import { crmPublicBase } from "../lib/crmPublicUrl.js";
import {
  instagramTokenIdentity,
  loadCredentials,
  loadMetaReadiness,
  resetMetaAccountCredsCache,
  type MetaReadiness,
} from "../messengers/meta.js";
import { DEFAULT_KPI_WEIGHTS, type KpiMetricKey } from "../kpi.js";
import {
  COVER_SELECTION_MODES,
  EDITABLE_SCORE_EVENT_KEYS,
  daysOffSchema,
  dealStageWinProbabilitySchema,
  mergeTranscriptFragments,
} from "@royal-home/shared";
import { DEFAULT_REELS_CAPTION_TEMPLATES } from "../lib/reelsCaptionTemplate.js";
import { coverTemplatesRouter } from "./settingsCoverTemplates.js";
import { coverOpenAiRouter } from "./settingsCoverOpenAi.js";
import { maskKey } from "../lib/maskSecret.js";
import { collectInstagramOnlineFollowers, fetchOnlineFollowers } from "../lib/instagramInsights.js";
import { isDialableTajikNumber, loadAriCredentials, testAriConnection } from "../lib/telephony/ariClient.js";
import { originateLiveVoiceTestCall, LIVE_VOICE_GREETING_TRIGGER } from "../lib/telephony/liveVoiceBridge.js";
import { liveVoiceRtpProblem, configuredRtpHost } from "../lib/telephony/liveVoiceRtpConfig.js";
import { liveVoiceErrorForPerson } from "../lib/telephony/liveVoiceUserError.js";
import { previewLiveVoiceGreeting } from "../ai/liveVoiceClient.js";
import { resolveElevenLabsKey } from "../ai/liveVoiceProvider.js";
import { elevenLabsRequest, syncElevenLabsAgent } from "../ai/elevenLabsAgentSync.js";
import { CONSULTANT_TOOLS } from "../lib/telephony/liveVoiceConsultant.js";
import { r2PresignDownloadUrl } from "../lib/r2Client.js";
import { phoneSafeText } from "../lib/clientPhone.js";
import { loadAmiCredentials, testAmiConnection } from "../lib/telephony/amiClient.js";
import { syncFailoverToStation, consultantInboundReadiness } from "../lib/telephony/failoverSync.js";
import { CONSULTANT_DIALPLAN_CHECK } from "../lib/telephony/stationHealth.js";
import { getStationTrafficUsageCached } from "../lib/telephony/stationTraffic.js";
import type { Settings as SettingsRow } from "../generated/prisma/client.js";
import { applySettingsSideEffects } from "../lib/settingsSideEffects.js";
import { captureSettingsSnapshot } from "../lib/settingsSnapshots.js";
import { AudioTranscodeError, transcodeForAsterisk } from "../lib/telephony/audioTranscode.js";
import { buildWhisperText, WHISPER_PARTS } from "../lib/telephony/whisperText.js";
import { previewWhisperSpeech } from "../lib/telephony/whisperAudio.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { deleteAccount, listAccounts, saveAccount, resetAccountsCache } from "../messengers/accounts.js";
import { dispatchInBackground, EDITOR_HOLDER_WHERE } from "../lib/videoHandoff.js";
import { sendToMontajer } from "../lib/montageObservers.js";

/** Ключи весов — из реестра метрик, а не строками: новая метрика в kpi.ts сразу
 *  принимается и здесь, без второй правки. */
const KPI_WEIGHT_KEYS = Object.keys(DEFAULT_KPI_WEIGHTS) as [KpiMetricKey, ...KpiMetricKey[]];

/** Цены событий Royal Score, которые можно менять из Настроек — из ОБЩЕГО
 *  каталога (`@royal-home/shared`, royalScoreEvents.ts), тем же полем
 *  `editable`, по которому те же события рисует экран Настроек. Устаревшие
 *  виды (kpi_override, lead_missed) помечены там неправимыми: они больше
 *  ничего не начисляют, и поле для правки было бы кнопкой в никуда. */
const SCORE_EVENT_KEYS = EDITABLE_SCORE_EVENT_KEYS;

export const settingsRouter = Router();
settingsRouter.use("/customer-agent", customerAgentSettingsRouter);
settingsRouter.use("/messenger-accounts", settingsInstagramAppBindingRouter);

/** Маска ключа: из Настроек (расшифровав) или из окружения. null — не задан нигде. */
function maskOrNull(encrypted: string | null | undefined, fromEnv: string | undefined): string | null {
  const value = decryptSecretSafe(encrypted ?? null) || fromEnv;
  return value ? maskKey(value) : null;
}

/** Откуда взято действующее значение ключа: из Настроек, из окружения или ниоткуда.
 * Без этого признака интерфейс писал «из .env сервера» даже для только что
 * сохранённого ключа, и владелец решал, что сохранение не сработало. */
function keySource(encrypted: string | null | undefined, fromEnv: string | undefined): "settings" | "env" | null {
  if (decryptSecretSafe(encrypted ?? null)) return "settings";
  return fromEnv ? "env" : null;
}


/**
 * Ссылка на УЖЕ СОХРАНЁННЫЙ дополнительный ключ Gemini: `keep:<номер>` — номер
 * места в действующем списке geminiApiKeysExtra.
 *
 * Зачем она вообще. Наружу мы отдаём только маску (••••1234), и вернуть её обратно
 * нельзя: в базу вместо ключа легла бы строка «••••1234», а ИИ замолчал бы молча —
 * ровно тот тихий отказ, от которого дополнительные ключи и должны страховать.
 * Поэтому сохранённый ключ не покидает сервер вовсе: браузер присылает ссылку на
 * его место, шифротекст берётся из базы.
 *
 * Именно с номером, а не просто меткой «оставить»: список приходит целиком, и без
 * номера нельзя выразить удаление третьего ключа из пяти — оставшиеся сдвигаются.
 */
const KEEP_EXISTING_GEMINI_KEY = /^keep:(\d+)$/;

/**
 * Допустимая ФОРМА имени модели, а не список допустимых имён.
 *
 * Перечень моделей у Google меняется чаще, чем выкатывается наш код: за один август
 * закрылись две и появилось несколько новых. Захардкоженный список означал бы, что
 * свежую модель нельзя выбрать до следующего релиза — ровно та беда, ради которой
 * настройка и заводится. Здесь мы защищаемся только от мусора в поле (пробелы,
 * кавычки, вставленный целиком URL), а ошибку в самом имени ловит кнопка «Проверить»:
 * она покажет живой HTTP 404 от Google, который честнее любого нашего словаря.
 */
const MODEL_NAME = /^[a-z0-9][a-z0-9.\-]{2,79}$/;
const MODEL_NAME_HINT = "Имя модели — латиница, цифры, точка и дефис (например gemini-3.7-flash)";

/** Откуда взято значение: из Настроек, из .env или из дефолта в коде. Экран без
 *  этого не отличит выбор владельца от совпавшего с ним заводского значения. */
function sourceOf(stored: unknown, envValue: string | undefined): "settings" | "env" | "default" {
  if (typeof stored === "string" && stored.trim()) return "settings";
  return envValue?.trim() ? "env" : "default";
}

/** То же для списков: пустой список — «не заполнено». */
function listSourceOf(stored: unknown, envValue: string | undefined): "settings" | "env" | "default" {
  if (Array.isArray(stored) && stored.some((item) => typeof item === "string" && item.trim())) return "settings";
  return envValue?.trim() ? "env" : "default";
}

/**
 * «БОТ НА ПАУЗЕ И ЗАБЫЛИ» (Пачка 17, 12.09.2026): три поля Settings добавлены
 * миграцией руками (см. lib/botPauseWatch.ts, prisma/migrations/
 * 20260912100000_bot_pause_watch) — типизированный клиент их не отдаёт, пока
 * сборщик не прогонит `prisma generate`. До тех пор читаем и домешиваем в ответ
 * отдельным `$queryRaw`, иначе форма в Настройках → Помощник открывалась бы с
 * пустыми полями каждый раз.
 */
async function withBotPauseWatchFields<T extends Record<string, unknown>>(settings: T): Promise<T> {
  try {
    const rows = await prisma.$queryRaw<
      { botPauseWatchEnabled: boolean; botPauseAlertHours: number; botPauseEscalateHours: number }[]
    >`SELECT "botPauseWatchEnabled", "botPauseAlertHours", "botPauseEscalateHours" FROM "Settings" WHERE id = 'singleton'`;
    const row = rows[0];
    return row ? { ...settings, ...row } : settings;
  } catch (err) {
    // Миграция ещё не применена к этой базе (worktree сборщика применит её
    // перед мержем) — не роняем весь экран настроек из-за трёх новых полей.
    console.error("[settings] бот на паузе: колонки ещё не в базе:", err instanceof Error ? err.message : err);
    return settings;
  }
}

/** Никогда не отдаём сырой/расшифрованный ключ клиенту — только маску и флаг "настроен ли".
 * anthropicApiKey хранится в БД зашифрованным (AES-256-GCM) — расшифровываем только для маски. */
function toPublicSettings(settings: {
  anthropicApiKey: string | null;
  geminiApiKey?: string | null;
  geminiApiKey2?: string | null;
  geminiApiKeysExtra?: string[] | null;
  botSystemPrompt?: string | null;
  botCommentPrompt?: string | null;
  reelsCaptionTemplates?: string | null;
  liveVoicePrompt?: string | null;
  [k: string]: unknown;
}, metaReadiness: MetaReadiness) {
  const {
    anthropicApiKey: encrypted,
    geminiApiKey: geminiEncrypted,
    geminiApiKey2: gemini2Encrypted,
    // Дополнительные ключи — тоже секреты: наружу уходят только маски (ниже).
    geminiApiKeysExtra: geminiExtraEncrypted,
    botSystemPrompt,
    botCommentPrompt,
    reelsCaptionTemplates,
    liveVoicePrompt,
    // Ключи Meta наружу не отдаём — только маску и признак «задан».
    metaAppSecret: metaAppSecretEnc,
    metaVerifyToken: metaVerifyTokenEnc,
    metaWaToken: metaWaTokenEnc,
    metaIgToken: metaIgTokenEnc,
    metaIgManageToken: metaIgManageTokenEnc,
    metaIgAppSecret: metaIgAppSecretEnc,
    metaPageToken: metaPageTokenEnc,
    metaAdsToken: metaAdsTokenEnc,
    asteriskAriPassword: asteriskAriPasswordEnc,
    asteriskAmiPassword: asteriskAmiPasswordEnc,
    // ЭТИ ДВА ТОЖЕ СЕКРЕТЫ (аудит №4, 27.08). Они оставались в ...rest и
    // уезжали в ответ GET /settings: googleBudgetToken — вообще открытым
    // текстом (он не шифруется), а им подписан вебхук бюджетных оповещений
    // /webhooks/google-budget: зная его, можно слать директору фейковые
    // уведомления о расходах. Наружу — только признак «задан», как у остальных.
    googleBudgetToken: googleBudgetTokenRaw,
    // Ключ фида каталога Meta (28.09.2026) — та же категория, что googleBudgetToken
    // выше: не шифруется (не пароль от системы, параметр публичной ссылки на CSV),
    // но целиком наружу не идёт — только маска, как у остальных ключей.
    metaCatalogFeedKey: metaCatalogFeedKeyRaw,
    callWhisperStationToken: callWhisperStationTokenEnc,
    youtubeClientSecret: youtubeClientSecretEnc,
    youtubeRefreshToken: youtubeRefreshTokenEnc,
    tiktokClientSecret: tiktokClientSecretEnc,
    tiktokRefreshToken: tiktokRefreshTokenEnc,
    threadsAppSecret: threadsAppSecretEnc,
    threadsAccessToken: threadsAccessTokenEnc,
    // Search Console (24.09.2026) — подключение и его признак живут в своём
    // разделе (routes/searchConsole.ts); здесь не отдаём даже шифротекст.
    searchConsoleRefreshToken: _searchConsoleRefreshTokenEnc,
    yandexWebmasterClientSecret: _yandexWebmasterClientSecretEnc,
    yandexWebmasterRefreshToken: _yandexWebmasterRefreshTokenEnc,
    // Ключ СМС-провайдера (23.09.2026) — его показывает только свой раздел
    // (routes/sms.ts), маской. Здесь не отдаём вовсе, даже шифротекстом.
    smsApiToken: _smsApiTokenEnc,
    // Ключ OpenAI (25.09.2026) — маской в своём разделе (routes/settingsCoverOpenAi.ts).
    openaiApiKey: _openaiApiKeyEnc,
    // Ключ ElevenLabs (02.10.2026) — наружу только маска и признак, как у Gemini.
    elevenLabsApiKey: elevenLabsApiKeyEnc,
    leadPoolAfterMinutes: _leadPoolAfterMinutes,
    ownPropertyReleaseMode: _ownPropertyReleaseMode,
    autoRouteRefusedLeads: _autoRouteRefusedLeads,
    // Rollout allowlists are exposed only through /ui-shell/config with its role gate.
    uiShellRollout: _uiShellRollout,
    ...rest
  } = settings as Record<string, unknown> & {
    googleBudgetToken?: string | null;
    metaCatalogFeedKey?: string | null;
    callWhisperStationToken?: string | null;
    youtubeClientSecret?: string | null;
    youtubeRefreshToken?: string | null;
    tiktokClientSecret?: string | null;
    tiktokRefreshToken?: string | null;
    threadsAppSecret?: string | null;
    threadsAccessToken?: string | null;
    searchConsoleRefreshToken?: string | null;
    yandexWebmasterClientSecret?: string | null;
    yandexWebmasterRefreshToken?: string | null;
    anthropicApiKey: string | null;
    geminiApiKey?: string | null;
    geminiApiKey2?: string | null;
    geminiApiKeysExtra?: string[] | null;
    botSystemPrompt?: string | null;
    botCommentPrompt?: string | null;
    reelsCaptionTemplates?: string | null;
    liveVoicePrompt?: string | null;
    metaAppSecret?: string | null;
    metaVerifyToken?: string | null;
    metaWaToken?: string | null;
    metaIgToken?: string | null;
    metaIgManageToken?: string | null;
    metaIgAppSecret?: string | null;
    metaPageToken?: string | null;
    metaAdsToken?: string | null;
    asteriskAriPassword?: string | null;
    asteriskAmiPassword?: string | null;
    elevenLabsApiKey?: string | null;
  };
  // `anthropicApiKey` (`encrypted` выше) больше не расшифровывается и не маскируется
  // (аудит мёртвого кода 13.09.2026): единственным потребителем ключа Anthropic
  // был отдельный `router.js` в корне репозитория (убран 28.09.2026), а
  // запись поля убрана из схемы правки ещё 26.08.2026. Значение по-прежнему
  // исключается из `rest`, чтобы шифротекст не утёк наружу — просто больше не читаем
  // его. Колонка в БД не тронута.
  const geminiApiKey = decryptSecretSafe(geminiEncrypted ?? null);
  // Готовность каналов считает сам модуль Meta (loadMetaReadiness) — там же, где
  // эти ключи потом читаются, ВМЕСТЕ с маркерами списка «Аккаунты Instagram».
  // Своя копия условия здесь (до 28.09.2026 — только по одиночным полям) говорила
  // «ключи не заполнены», когда Instagram работал маркером основного аккаунта.
  const metaChannelsConfigured = metaReadiness.channelsConfigured;
  // Те же правила, по которым модели выбирает сам бот (ai/geminiSettings.ts):
  // считать их здесь заново нельзя — экран разошёлся бы с поведением.
  const geminiModels = effectiveGeminiModels(settings as GeminiModelSettings);
  return {
    ...rest,
    // Признаки вместо самих секретов (см. деструктуризацию выше).
    googleBudgetTokenConfigured: !!googleBudgetTokenRaw,
    // Ключ фида каталога Meta — маска, не значение (см. деструктуризацию выше).
    metaCatalogFeedKeyMasked: metaCatalogFeedKeyRaw ? maskKey(metaCatalogFeedKeyRaw) : null,
    callWhisperStationTokenConfigured: !!callWhisperStationTokenEnc,
    geminiApiKeyConfigured: !!geminiApiKey || !!process.env.GEMINI_API_KEY,
    geminiApiKeyMasked: geminiApiKey ? maskKey(geminiApiKey) : null,
    geminiApiKeySource: geminiApiKey ? "settings" : process.env.GEMINI_API_KEY ? "env" : null,
    // Резервный ключ отдаём тем же набором признаков, что и основной: без «настроен
    // ли он вообще» интерфейс не сможет честно сказать, что резерва нет, — а именно
    // это и было незаметно, пока ключ жил только в переменной окружения.
    geminiApiKey2Configured: !!decryptSecretSafe(gemini2Encrypted ?? null) || !!process.env.GEMINI_API_KEY_2,
    geminiApiKey2Masked: maskOrNull(gemini2Encrypted, process.env.GEMINI_API_KEY_2),
    geminiApiKey2Source: keySource(gemini2Encrypted, process.env.GEMINI_API_KEY_2),
    // Ключ ElevenLabs для живого голоса (02.10.2026) — тем же набором признаков.
    elevenLabsApiKeyConfigured: !!decryptSecretSafe(elevenLabsApiKeyEnc ?? null) || !!process.env.ELEVENLABS_API_KEY,
    elevenLabsApiKeyMasked: maskOrNull(elevenLabsApiKeyEnc, process.env.ELEVENLABS_API_KEY),
    elevenLabsApiKeySource: keySource(elevenLabsApiKeyEnc, process.env.ELEVENLABS_API_KEY),
    // Дополнительные ключи — ТОЛЬКО маски, и ни одна не выбрасывается: их порядок
    // обязан совпадать с порядком в базе один в один, потому что именно на место в
    // этом списке ссылается сохранение (см. KEEP_EXISTING_GEMINI_KEY). Пропусти мы
    // хоть один элемент — «удалить третий» удалило бы четвёртый.
    geminiExtraKeysMasked: (geminiExtraEncrypted ?? []).map((enc) => maskKey(decryptSecretSafe(enc) ?? "")),
    // Имена моделей отдаём вместе с ИСТОЧНИКОМ. Без него экран не отличит «владелец
    // выбрал gemini-3.7-flash» от «поле пустое, работает дефолт, который случайно
    // выглядит так же», — а это разные вещи: первое переживёт смену дефолта в коде,
    // второе изменится вместе с ним. Ровно тот же приём, что уже применён к ключам.
    geminiModelEffective: geminiModels.model,
    geminiModelSource: sourceOf(settings.geminiModel, process.env.GEMINI_MODEL),
    geminiFallbackModelsEffective: geminiModels.fallbackModels,
    geminiFallbackModelsSource: listSourceOf(settings.geminiFallbackModels, process.env.GEMINI_FALLBACK_MODEL),
    geminiTranscribeModelsEffective: geminiModels.transcribeModels,
    geminiTranscribeModelsSource: listSourceOf(
      settings.geminiTranscribeModels,
      process.env.GEMINI_TRANSCRIBE_MODELS
    ),
    geminiImageModelEffective: geminiModels.imageModel,
    geminiImageModelSource: sourceOf(settings.geminiImageModel, process.env.GEMINI_IMAGE_MODEL),
    // Дешёвая ступень: пустая строка значит «не настроена» — экран показывает это
    // как «выключено», а не как пустое поле неизвестного назначения.
    geminiLiteModelEffective: geminiModels.liteModel,
    geminiLiteModelSource: sourceOf(settings.geminiLiteModel, process.env.GEMINI_LITE_MODEL),
    // Маркер бота Telegram живёт только в окружении. Без этого признака
    // рубильник бота в Telegram выглядел бы рабочим на канале, которого нет.
    telegramConfigured: !!process.env.TELEGRAM_BOT_TOKEN,
    // Три ключа Meta живут только в окружении. Признак нужен, чтобы интерфейс мог
    // объяснить, почему включённый рубильник ничего не даёт.
    // Значение из Настроек приоритетнее переменной окружения — как у ключей ИИ.
    metaAppSecretMasked: maskOrNull(metaAppSecretEnc, process.env.META_APP_SECRET),
    metaAppSecretSource: keySource(metaAppSecretEnc, process.env.META_APP_SECRET),
    metaVerifyTokenMasked: maskOrNull(metaVerifyTokenEnc, process.env.META_VERIFY_TOKEN),
    metaVerifyTokenSource: keySource(metaVerifyTokenEnc, process.env.META_VERIFY_TOKEN),
    metaWaTokenMasked: maskOrNull(metaWaTokenEnc, process.env.META_WA_TOKEN),
    metaWaTokenSource: keySource(metaWaTokenEnc, process.env.META_WA_TOKEN),
    metaIgTokenMasked: maskOrNull(metaIgTokenEnc, process.env.META_IG_TOKEN),
    metaIgTokenSource: keySource(metaIgTokenEnc, process.env.META_IG_TOKEN),
    // Маркер удаления Instagram (20.09.2026) — своего .env-резерва нет (см.
    // Settings.metaIgManageToken в schema.prisma), вводится только через интерфейс.
    metaIgManageTokenMasked: maskOrNull(metaIgManageTokenEnc, undefined),
    metaIgManageTokenSource: keySource(metaIgManageTokenEnc, undefined),
    metaIgAppSecretMasked: maskOrNull(metaIgAppSecretEnc, process.env.META_IG_APP_SECRET),
    metaIgAppSecretSource: keySource(metaIgAppSecretEnc, process.env.META_IG_APP_SECRET),
    metaPageTokenMasked: maskOrNull(metaPageTokenEnc, process.env.META_PAGE_TOKEN),
    metaPageTokenSource: keySource(metaPageTokenEnc, process.env.META_PAGE_TOKEN),
    // Рекламный кабинет: маркер с правом ads_read. Отдельный от маркеров переписки —
    // у тех этого права нет, и подставить один вместо другого нельзя.
    metaAdsTokenMasked: maskOrNull(metaAdsTokenEnc, process.env.META_ADS_TOKEN),
    metaAdsTokenSource: keySource(metaAdsTokenEnc, process.env.META_ADS_TOKEN),
    metaAdsConfigured: !!(
      (decryptSecretSafe(metaAdsTokenEnc ?? null) || process.env.META_ADS_TOKEN) && rest.metaAdAccountId
    ),
    // YouTube Shorts (31.08.2026) — своих переменных окружения нет намеренно
    // (см. схему): OAuth-ключи Google вводятся только через интерфейс.
    youtubeClientSecretMasked: youtubeClientSecretEnc ? maskKey(decryptSecretSafe(youtubeClientSecretEnc) ?? "") : null,
    // Нет .env-резерва (см. комментарий выше) — но пропуск Source здесь означал бы
    // "из .env сервера" для только что сохранённого ключа (см. дефолт в
    // SecretKeyEditor.tsx), ровно баг 17.09.2026, пойманный на TikTok рядом.
    youtubeClientSecretSource: keySource(youtubeClientSecretEnc, undefined),
    youtubeRefreshTokenMasked: youtubeRefreshTokenEnc ? maskKey(decryptSecretSafe(youtubeRefreshTokenEnc) ?? "") : null,
    youtubeRefreshTokenSource: keySource(youtubeRefreshTokenEnc, undefined),
    youtubeConfigured: !!(rest.youtubeClientId && youtubeClientSecretEnc && youtubeRefreshTokenEnc),
    // TikTok (17.09.2026) — clientKey не секрет (как youtubeClientId). refreshToken
    // сюда попадает маской для симметрии с youtube* (диагностика/дебаг), хотя
    // форма настроек его руками не редактирует — он выдаётся только consent-flow
    // (кнопка «Подключить»/«Отключить», routes/tiktok.ts), а «подключено ли»
    // экран показывает по tiktokConnectedAt/tiktokCreatorUsername.
    tiktokClientSecretMasked: tiktokClientSecretEnc ? maskKey(decryptSecretSafe(tiktokClientSecretEnc) ?? "") : null,
    // Баг 17.09.2026: без этого признака SecretKeyEditor (source=null жёстко в
    // ChannelsTab) показывал "из .env сервера" для ключа, только что сохранённого
    // из формы, — хотя у TikTok .env-резерва нет вовсе. См. keySource выше.
    tiktokClientSecretSource: keySource(tiktokClientSecretEnc, undefined),
    tiktokRefreshTokenMasked: tiktokRefreshTokenEnc ? maskKey(decryptSecretSafe(tiktokRefreshTokenEnc) ?? "") : null,
    tiktokConfigured: !!(rest.tiktokClientKey && tiktokClientSecretEnc && tiktokRefreshTokenEnc),
    // Threads (23.09.2026) — тот же приём, что TikTok: appId не секрет (идёт через
    // ...rest как есть), appSecret шифруется, accessToken — только маска (форма его
    // не редактирует, пишет только OAuth callback). configured — введены ключи
    // приложения; connected — есть живой токен И userId (профиль подключён).
    threadsAppSecretMasked: threadsAppSecretEnc ? maskKey(decryptSecretSafe(threadsAppSecretEnc) ?? "") : null,
    threadsAppSecretSource: keySource(threadsAppSecretEnc, undefined),
    threadsAccessTokenMasked: threadsAccessTokenEnc ? maskKey(decryptSecretSafe(threadsAccessTokenEnc) ?? "") : null,
    threadsConfigured: !!(rest.threadsAppId && threadsAppSecretEnc),
    threadsConnected: !!(rest.threadsUserId && threadsAccessTokenEnc),
    // Этап 4: пароль ARI живёт только в Настройках (env не предусмотрен — сервер
    // телефонии не общий для сред, как ANTHROPIC/GEMINI, а один физический аппарат).
    asteriskAriPasswordMasked: asteriskAriPasswordEnc ? maskKey(decryptSecretSafe(asteriskAriPasswordEnc) ?? "") : null,
    asteriskConfigured: !!(rest.asteriskAriUrl && rest.asteriskAriUsername && asteriskAriPasswordEnc),
    // Управление станцией (AMI) — отдельный доступ и отдельный признак: телефония
    // работает и без него, а вот кнопки «отошёл», «спам» и запасной путь очереди
    // без AMI не работают вовсе, и интерфейс обязан объяснить почему.
    asteriskAmiPasswordMasked: asteriskAmiPasswordEnc ? maskKey(decryptSecretSafe(asteriskAmiPasswordEnc) ?? "") : null,
    asteriskAmiConfigured: !!(rest.asteriskAriUrl && rest.asteriskAmiUsername && asteriskAmiPasswordEnc),
    /** Какие каналы Meta реально готовы к работе — интерфейс подсвечивает недостающие ключи. */
    metaChannelsConfigured,
    metaConfigured: metaChannelsConfigured.length > 0,
    /** Есть ли маркер Instagram, которым пойдут публикация, лента и проверка
     *  статистики: основной аккаунт списка, поле «Маркер Instagram» или окружение. */
    metaIgTokenAvailable: metaReadiness.igTokenAvailable,
    /** Маркер берётся у основного аккаунта списка — поле сейчас запасное. */
    metaIgTokenFromAccount: metaReadiness.igTokenFromAccount,
    // Отдаём ДЕЙСТВУЮЩУЮ «личность» (текст владельца из БД или дефолт из кода).
    // Обязательные правила бота сюда НЕ входят и в это поле не показываются: они
    // приклеиваются к промту всегда (ai/leadQualifier.ts → BOT_CORE_RULES), и владелец
    // не должен ни повторять их у себя, ни бояться случайно отменить.
    botSystemPrompt: botSystemPrompt || DEFAULT_BOT_PERSONA,
    botSystemPromptIsCustom: !!botSystemPrompt,
    // То же и для промта комментариев: наружу уходит ДЕЙСТВУЮЩИЙ текст, пустая
    // настройка означает «работает зашитый по умолчанию», а не «промта нет».
    botCommentPrompt: botCommentPrompt || DEFAULT_COMMENT_PROMPT,
    botCommentPromptIsCustom: !!botCommentPrompt,
    // Шаблоны подписи Reels — так же: наружу уходит ДЕЙСТВУЮЩИЙ набор (кастомный
    // или зашитые четыре), чтобы форма не была пустой, пока никто её не открывал.
    reelsCaptionTemplates: reelsCaptionTemplates || DEFAULT_REELS_CAPTION_TEMPLATES,
    reelsCaptionTemplatesIsCustom: !!reelsCaptionTemplates,
    // Личность живого голоса (13.09.2026) — тот же приём: действующий текст
    // (свой или зашитый по умолчанию), плюс флаг для бейджа «изменён» в интерфейсе.
    liveVoicePrompt: liveVoicePrompt || DEFAULT_LIVE_VOICE_PROMPT,
    liveVoicePromptIsCustom: !!liveVoicePrompt,
    // Звук живого голоса на сервере не настроен (LIVE_VOICE_RTP_HOST/PORT, аудит
    // 02.10.2026, Д27): режим консультанта молча не работает, а тумблер показывал
    // «включено». null — всё задано; иначе текст для предупреждения в Настройках.
    liveVoiceRtpProblem: liveVoiceRtpProblem(),
  };
}

/**
 * Что из Настроек видит РЯДОВОЙ сотрудник. Полный объект отдавать нельзя: там
 * структура комиссии, месячный план, порог KPI, стратегия распределения лидов,
 * хвосты боевых API-ключей и весь системный промт бота (~9 КБ «личности»). Раньше
 * весь этот объект уходил любому авторизованному, а после появления конвертации
 * валют — ещё и в браузер каждого агента на экране Сделок.
 * Здесь остаётся только то, без чего интерфейс не работает: брендинг и курс,
 * по которому фронт сводит суммы разных валют в один итог.
 */
function toStaffSettings(settings: {
  companyName: string;
  companySlogan: string;
  companyLogoUrl: string | null;
  coverTemplateMode: string;
  coverTemplateId: string | null;
  coverTemplateEnabledIds: string[];
  usdToTjsRate: unknown;
  usdToTjsRateUpdatedAt: Date | null;
  usdToTjsRateSource: string | null;
  aiAssistantEnabled: boolean;
  propertyPhotoEnhanceEnabled: boolean;
  passkeyLoginEnabled: boolean;
  leadAcceptMinutes: number;
  leadCallMinutes: number;
  leadCallMinSeconds: number;
  royalScoreEnabled: boolean;
  liveVoiceEnabled: boolean;
}) {
  return {
    companyName: settings.companyName,
    companySlogan: settings.companySlogan,
    companyLogoUrl: settings.companyLogoUrl,
    coverTemplateMode: settings.coverTemplateMode,
    coverTemplateId: settings.coverTemplateId,
    coverTemplateEnabledIds: settings.coverTemplateEnabledIds,
    usdToTjsRate: settings.usdToTjsRate,
    usdToTjsRateUpdatedAt: settings.usdToTjsRateUpdatedAt,
    usdToTjsRateSource: settings.usdToTjsRateSource,
    // Решает, показывать ли карточку/кнопку входа по отпечатку каждому сотруднику;
    // сам вход/привязка проверяются на сервере отдельно (routes/auth.ts, routes/me.ts).
    passkeyLoginEnabled: settings.passkeyLoginEnabled,
    // Рядовому сотруднику нужен ровно один факт про ассистента: показывать кнопку
    // или нет. Без этого поля кнопка не появлялась бы у агентов ДАЖЕ при включённом
    // рубильнике — ассистент остался бы виден одному директору. Коммерческой тайны в
    // булеве нет, а решает всё равно сервер: сам запрос к ассистенту проверяет
    // рубильник отдельно (routes/ai.ts).
    aiAssistantEnabled: settings.aiAssistantEnabled,
    // Та же логика: рядовой агент — это и есть тот, кто ведёт объект и жмёт
    // «Улучшить»/«Одобрить» на его карточке (canManageProperty), поэтому кнопка
    // обязана появляться и у него, не только у директора. Сам вызов и решение
    // всё равно проверяются на сервере отдельно (routes/properties.ts).
    propertyPhotoEnhanceEnabled: settings.propertyPhotoEnhanceEnabled,
    // Срок принятия лида нужен именно агенту: окно входящего лида на телефоне
    // (IncomingLeadWindow) показывает обратный отсчёт «не ответите за N минут,
    // заявка уйдёт другому». Без поля агент видел лишь «сколько уже ждёт».
    // Коммерческой тайны в числе минут нет; сам таймер передачи считает сервер.
    leadAcceptMinutes: settings.leadAcceptMinutes,
    /**
     * Срок первого звонка после принятия и порог его длительности (задание
     * 17.09.2026, «клиент теряется, если вовремя не позвонить»): без этих двух
     * чисел агент не мог узнать дедлайн на своём же экране — окно приёма после
     * «Принять» уводит в карточку и на этом всё, а крон (services/leads/firstCall.ts,
     * penalizeMissedFirstCalls) снимает лид молча. Коммерческой тайны в минутах и
     * секундах нет — то же обоснование, что у leadAcceptMinutes выше.
     */
    leadCallMinutes: settings.leadCallMinutes,
    leadCallMinSeconds: settings.leadCallMinSeconds,
    // Рубильник модуля целиком (владелец 15.09.2026) — фронт по нему прячет
    // карточку Royal Score в профиле и сам не дёргает /me/royal-score.
    royalScoreEnabled: settings.royalScoreEnabled,
    // Рубильник «живого голоса» (28.09.2026): по нему карточка клиента
    // показывает строку «Робот позвонит клиенту». Тот же довод, что у
    // aiAssistantEnabled выше: звонит агент со своей карточки, тайны в булеве
    // нет, а сам звонок сервер всё равно проверяет отдельно (409 при выключенном).
    liveVoiceEnabled: settings.liveVoiceEnabled,
  };
}

/**
 * КОНСУЛЬТАНТ НА ВХОДЯЩИХ: ВЫБРАН ЛИ И МОЖЕТ ЛИ РАБОТАТЬ (28.09.2026).
 *
 * Выбор в «Бот → Живой голос» исполняют три стороны, и каждая могла молча не
 * исполнить его: сервер без LIVE_VOICE_RTP_HOST кладёт станции пустой режим
 * (failoverSync.ts::consultantStationMode), станция со старым диалпланом не зовёт
 * консультанта вовсе (stationHealth.ts::probeConsultantDialplan). Экран показывал
 * «консультант берёт трубку» в обоих случаях. Здесь — правда для предупреждений:
 * готовность сервера и последний снимок сводной проверки станции (раз в 15 минут).
 */
async function withLiveVoiceInboundStatus<T extends Record<string, unknown>>(payload: T) {
  const readiness = consultantInboundReadiness({
    enabled: payload.liveVoiceEnabled as boolean | undefined,
    mode: payload.liveVoiceInboundMode as string | undefined,
    rtpHost: configuredRtpHost(),
  });
  const snapshot = await prisma.integrationHealthSnapshot
    .findUnique({ where: { name: `Телефония: ${CONSULTANT_DIALPLAN_CHECK}` } })
    .catch(() => null);
  return {
    ...payload,
    liveVoiceInbound: {
      wanted: readiness.wanted,
      rtpHostConfigured: readiness.rtpHostConfigured,
      stationDialplan: snapshot
        ? { ok: snapshot.ok, detail: snapshot.detail, checkedAt: snapshot.checkedAt.toISOString() }
        : null,
    },
  };
}

/** Полный ответ настроек для администратора — один путь для GET и PATCH, чтобы
 *  ответ сохранения не терял поля, которые экран держит в кэше. */
async function publicSettingsResponse(settings: SettingsRow) {
  return withLiveVoiceInboundStatus(toPublicSettings(await withBotPauseWatchFields(settings), await loadMetaReadiness()));
}

settingsRouter.get("/", requireAuth, async (req, res) => {
  /**
   * ЧТЕНИЕ НАСТРОЕК — ЭТО ЧТЕНИЕ (19.09.2026, жалоба владельца на скорость).
   *
   * Здесь стоял `upsert` с пустым `update: {}`. Prisma выполняет его как
   * запись в транзакции, и она била по ОДНОЙ И ТОЙ ЖЕ строке `singleton`.
   * А этот роут — самый частый в системе после счётчиков: `useSettings()`
   * висит в нижней навигации телефона (components/BottomNav.tsx), то есть
   * на каждом мобильном экране, и обновляется по общему таймеру раз в минуту.
   * Десяток работающих сотрудников давал постоянную очередь за блокировкой
   * одной строки — на ровном месте, ради записи, которая ничего не меняет.
   *
   * Теперь обычный путь — `findUnique`, а `upsert` остаётся только для
   * единственного случая, когда строки ещё нет вовсе (свежая база, первый
   * запуск). Второй раз он не выполнится никогда.
   */
  const settings =
    (await prisma.settings.findUnique({ where: { id: "singleton" } })) ??
    (await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } }));
  // Настройки на запись доступны только ADMIN/DIRECTOR (PATCH ниже) — на чтение
  // полный объект получает тот же круг. Остальным — усечённая версия.
  const isAdmin = can(req, "settings.view");
  const response = isAdmin ? await publicSettingsResponse(settings) : toStaffSettings(settings);
  if (!canViewInvestigations(req.agent?.role)) {
    delete (response as Record<string, unknown>).postShowingCallEnabled;
    delete (response as Record<string, unknown>).investigationCaseConfig;
    delete (response as Record<string, unknown>).buyerSellerAutomationMode;
  }
  res.json(response);
});

/**
 * Публично (без токена) — только безопасное для показа на экране входа: имя/слоган/лого
 * компании (white-label). Никогда не отдавать сюда ключи или коммерческие настройки.
 *
 * Лимитер как у publicFeed: маршрут открыт всему интернету, а за ним обращение к базе.
 * Раньше здесь был ещё и `upsert` — то есть НЕаутентифицированный путь ЗАПИСИ: любой
 * запрос без ключа мог создать строку настроек (аудит 12.08.2026, пункт И). Чтение
 * теперь только читает, а отсутствующую строку показывает дефолтами схемы; заводит её
 * первый же GET /settings, который требует входа.
 */
// Ночная проверка 24.09.2026 (находка P1, «у половины офиса CRM не работает»):
// лимитер считал по req.ip без keyGenerator, а на проде за nginx это один
// внешний адрес на весь офис (trust proxy + X-Forwarded-For). Причина, ради
// которой ставили лимитер, — незащищённый upsert — давно устранена, ниже
// остался только findUnique. Ключ теперь как у apiLimiter (app.ts): по агенту
// из Bearer-токена, если он есть, иначе по IP. Лимит читает ту же переменную
// API_RATE_LIMIT вне прода, что и apiLimiter, — иначе e2e-стенд с
// API_RATE_LIMIT=1000000 всё равно упирался бы в зашитые здесь 120.
const brandingRateLimit =
  process.env.NODE_ENV !== "production" && Number(process.env.API_RATE_LIMIT) > 0
    ? Number(process.env.API_RATE_LIMIT)
    : 1500;

const brandingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: brandingRateLimit,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Слишком много запросов, попробуйте позже" },
  keyGenerator: (req) => {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      try {
        return `agent:${verifyAccessToken(header.slice("Bearer ".length)).sub}`;
      } catch {
        // Просроченный или поддельный токен — считаем по адресу, как аноним.
      }
    }
    return `ip:${ipKeyGenerator(req.ip ?? "unknown")}`;
  },
});

/** Что показывает экран входа, пока строку настроек никто не создавал. Совпадает
 *  с @default в prisma/schema.prisma — иначе «до первого входа» и «после» бренд
 *  выглядел бы по-разному. */
const DEFAULT_BRANDING = {
  companyName: "Royal Home",
  companySlogan: "Агентство недвижимости",
  companyLogoUrl: null as string | null,
  passkeyLoginEnabled: true,
};

settingsRouter.get("/branding", brandingLimiter, async (_req, res) => {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { companyName: true, companySlogan: true, companyLogoUrl: true, passkeyLoginEnabled: true },
  });
  res.json(settings ?? DEFAULT_BRANDING);
});

/**
 * Поле ключа/маркера с проверкой формата (lib/secretFormat.ts). Пустая строка —
 * «очистить и вернуться на переменную окружения», она проходит как и раньше.
 *
 * Зачем отдельный помощник, а не общий `superRefine` на всю схему: ошибка
 * привязывается к своему полю, и интерфейс показывает её у нужной строки, а не
 * общим «что-то не так в настройках».
 */
const secretField = (max: number, kind: SecretKind = "generic") =>
  z
    .string()
    .trim()
    .max(max)
    // superRefine, а не refine: в zod 4 второй аргумент refine — объект, а не
    // функция, и текст ошибки перестал бы зависеть от значения («Invalid input»
    // вместо подсказки, куда вставить этот маркер).
    .superRefine((v, ctx) => {
      const problem = secretFormatError(v, kind);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    })
    .optional();

const settingsUpdateSchema = z.object({
  /** ОБЛОЖКИ ДЛЯ СОЦСЕТЕЙ (23.09.2026): как выбирается шаблон на публикацию.
   *  FIXED — всегда `coverTemplateId`, RANDOM — случайный из отмеченных. */
  coverTemplateMode: z.enum(COVER_SELECTION_MODES).optional(),
  /** Шаблон режима FIXED. Пусто/встроенный — «Royal Gold». */
  coverTemplateId: z.string().max(64).optional(),
  /** Кто участвует в случайном выборе — список целиком, как у geminiFallbackModels. */
  coverTemplateEnabledIds: z.array(z.string().max(64)).max(50).optional(),
  monthlyCommissionPlan: z.number().positive().optional(),
  /** Структура комиссии сделки, % от цены объекта: риелтор + компания. 0,5% «за
   * приём объекта» отменены 11.09.2026 — Settings.commissionIntakePercent
   * остаётся в схеме БД как история старых сделок, но больше не редактируется
   * (доля, которую оно отводило, теперь всегда уходит компании). */
  commissionRealtorPercent: z.number().min(0).max(10).optional(),
  commissionCompanyPercent: z.number().min(0).max(10).optional(),
  // anthropicApiKey УБРАН из схемы (26.08.2026): потребителя в apps/api нет
  // (был только отдельный router.js в корне, убран 28.09.2026), а поле
  // не выдёргивалось из ...rest перед prisma.update — присланный ключ записался
  // бы в зашифрованную колонку ОТКРЫТЫМ ТЕКСТОМ. Сохранённое значение остаётся
  // лежать зашифрованным как архив; веб это поле давно не шлёт (grep пуст).
  /** Ключ Google Gemini. Пустая строка — очистить (вернуться на .env). */
  geminiApiKey: z.string().trim().optional(),
  /** Резервный ключ Gemini. Пустая строка — очистить (вернуться на .env GEMINI_API_KEY_2). */
  geminiApiKey2: z.string().trim().optional(),
  /**
   * Дополнительные ключи Gemini сверх основного и резервного — ПОЛНЫЙ новый список.
   * Элемент — либо новый ключ открытым текстом, либо ссылка `keep:<номер>` на уже
   * сохранённый (см. KEEP_EXISTING_GEMINI_KEY): маску обратно принимать нельзя.
   * Полный список выбран нарочно: удаление и порядок выражаются им самим, без
   * отдельных ручек «удалить»/«переставить» и без вопроса, что делать с расхождением.
   *
   * Потолок 10 — защита от случайной вставки мусора (весь буфер обмена одним полем),
   * а не техническое ограничение: перебор выдержит и больше, просто столько ключей
   * ни один живой сценарий не требует.
   */
  geminiApiKeysExtra: z.array(z.string().trim()).max(10).optional(),
  /**
   * ИМЕНА МОДЕЛЕЙ GEMINI. Пустая строка и пустой список — «очистить»: вернуться на
   * .env, а следом на дефолт из кода (см. ai/geminiSettings.ts). Именно поэтому здесь
   * нет `.min(1)` — запрет пустого значения отнял бы у владельца единственный способ
   * откатиться к заводскому поведению, не заходя в базу.
   *
   * Имя проверяется формой, а не списком допустимых: перечень моделей у Google
   * меняется чаще, чем выкатывается код, и захардкоженный список означал бы, что
   * новую модель нельзя выбрать до следующего релиза — ровно та беда, ради которой
   * настройка и заводится. Ошибку в имени ловит кнопка «Проверить»: она честно
   * покажет HTTP 404 от Google, а не наше «неизвестная модель».
   */
  geminiModel: z.string().max(80).regex(MODEL_NAME, MODEL_NAME_HINT).or(z.literal("")).optional(),
  geminiFallbackModels: z.array(z.string().max(80).regex(MODEL_NAME, MODEL_NAME_HINT)).max(5).optional(),
  geminiTranscribeModels: z.array(z.string().max(80).regex(MODEL_NAME, MODEL_NAME_HINT)).max(5).optional(),
  geminiImageModel: z.string().max(80).regex(MODEL_NAME, MODEL_NAME_HINT).or(z.literal("")).optional(),
  geminiLiteModel: z.string().max(80).regex(MODEL_NAME, MODEL_NAME_HINT).or(z.literal("")).optional(),
  companyName: z.string().min(1).max(80).optional(),
  companySlogan: z.string().max(120).optional(),
  /** Через сколько минут непринятый лид переназначается следующему агенту. */
  leadAcceptMinutes: z.number().int().min(3).max(1440).optional(),
  /** Через сколько минут после принятия агент обязан поговорить с клиентом. */
  leadCallMinutes: z.number().int().min(3).max(1440).optional(),
  // leadEscalationEnabled («режим обучения») УДАЛЕНО ИЗ ЗОД-СХЕМЫ 25.09.2026
  // решением владельца — код больше не читает это поле (карусель всегда не
  // эскалирует, пока есть кому предложить, см. services/leads/reassignment.ts).
  // Колонка в БД осталась (см. её комментарий в schema.prisma).
  /** Забирать лид у агента, который принял его, но не позвонил за
   *  leadCallMinutes: лид снимается и сразу уходит следующему агенту вместо
   *  того, чтобы просто оштрафовать держателя (см. services/leads/firstCall.ts). */
  leadReassignOnMissedCallEnabled: z.boolean().optional(),
  /** Спрашивать ли клиента подтверждение показа (lib/meetingReminders.ts). До 26.08.2026
   *  ключа в схеме не было, и PATCH из веб-клиента молча терялся — тумблер откатывался. */
  askClientsToConfirmShowings: z.boolean().optional(),
  // autoRouteRefusedLeads: убран из PATCH и из формы Настроек 17.09.2026 (Р-6,
  // `docs/audit/lead-ownership-17-09.md` §4) — кнопочный отказ агента
  // (lib/clientRefuse.ts) продолжает читать значение, уже сохранённое в БД,
  // без изменений; менять его через API/UI больше нельзя. Поле в схеме БД
  // осталось, миграции не делалось.
  /** Щиток занятости (21.08.2026): агент на показе или в живом звонке через CRM
   *  новых лидов не получает. См. lib/agentOccupancyShield.ts. */
  agentOccupancyShieldEnabled: z.boolean().optional(),
  agentOccupancyShieldAfterMinutes: z.number().int().min(1).max(240).optional(),
  // leadPoolAfterMinutes УБРАН ИЗ ПРИЁМА (17.09.2026, закон о владении клиентом
  // П-4/Р-3) — пул «ничьих» удалён целиком (services/leads/firstCall.ts,
  // routes/clients/lifecycle.ts). Колонка остаётся в схеме, PATCH её больше не
  // принимает.
  /** Реактивация старых клиентов пачкой (Пачка 12, 11.09.2026) — понедельник
   *  10:00 Душанбе, см. lib/reactivationCampaign.ts и cron.ts. */
  reactivationEnabled: z.boolean().optional(),
  reactivationAfterDays: z.number().int().min(1).max(720).optional(),
  reactivationBatchSize: z.number().int().min(1).max(200).optional(),
  reactivationMessageTemplate: z.string().min(1).max(1000).optional(),
  /** «Бот на паузе и забыли» (Пачка 17, 12.09.2026) — см. lib/botPauseWatch.ts. */
  botPauseWatchEnabled: z.boolean().optional(),
  botPauseAlertHours: z.number().int().min(1).max(720).optional(),
  botPauseEscalateHours: z.number().int().min(1).max(720).optional(),
  /** Сколько секунд разговора считаются состоявшимся звонком. 0 = порога нет. */
  leadCallMinSeconds: z.number().int().min(0).max(600).optional(),
  /** Максимум активных лидов у агента одновременно («лимит 5»). 0 = без лимита. */
  leadActiveLimit: z.number().int().min(0).max(100).optional(),
  /** Максимум объектов у агента одновременно в конвейере подготовки. 0 = без лимита. */
  propertyActiveLimit: z.number().int().min(0).max(100).optional(),
  /** Веса шкалы совпадения «клиент ↔ объект» (Путь покупателя, п.5.1: должны
   *  быть настраиваемыми). Сумма база+район+комнаты+бюджет по умолчанию 100 —
   *  не проверяем строго, владелец может осознанно сдвинуть шкалу выше/ниже. */
  matchScoreBase: z.number().int().min(0).max(100).optional(),
  matchScoreDistrict: z.number().int().min(0).max(100).optional(),
  matchScoreRooms: z.number().int().min(0).max(100).optional(),
  matchScoreBudget: z.number().int().min(0).max(100).optional(),
  matchScoreHotBonus: z.number().int().min(0).max(100).optional(),
  /** Расстояние до желаемого места клиента (ClientDesiredPlace) — отдельный вес
   *  (12.09.2026, блок D3): matchScoreDistrict НЕ трогаем, порог 90 остаётся как
   *  был, изменение аддитивное. */
  matchScoreDistance: z.number().int().min(0).max(100).optional(),
  /** Единая политика подбора (решение владельца 17.09.2026, docs/match-policy-plan-17-09.md)
   *  — вкладка «Подбор объектов». lib/matchPolicy.ts::loadMatchPolicy() читает те же поля. */
  autoMatchEnabled: z.boolean().optional(),
  matchIncludeInactive: z.boolean().optional(),
  matchIncludeDeferred: z.boolean().optional(),
  matchNotifyPropertyOwner: z.boolean().optional(),
  /** 0 = без срока. */
  matchRequirementTtlDays: z.number().int().min(0).max(365).optional(),
  matchPriceDropRenotifyPct: z.number().int().min(1).max(50).optional(),
  matchBudgetTolerancePct: z.number().int().min(0).max(50).optional(),
  matchAreaTolerancePct: z.number().int().min(0).max(50).optional(),
  matchRoomsTolerance: z.number().int().min(0).max(3).optional(),
  matchDefaultRadiusM: z.number().int().min(100).max(10000).optional(),
  matchRadiusMaxMultiplier: z.number().int().min(1).max(5).optional(),
  matchMinCandidates: z.number().int().min(1).max(10).optional(),
  /** Приоритет «свой объект» (решение владельца 11.08.2026): агент, принявший
   *  объект, получает клиента по нему вне очереди по KPI. Порог — по шкале
   *  подбора «клиент ↔ объект» из routes/matching.ts. */
  ownPropertyPriorityEnabled: z.boolean().optional(),
  ownPropertyMatchThreshold: z.number().int().min(0).max(100).optional(),
  /** Жёсткое исключение без порога: бот уже показал клиенту этот объект. */
  ownPropertyShownExceptionEnabled: z.boolean().optional(),
  ownPropertyShownWindowDays: z.number().int().min(1).max(365).optional(),
  /** Лимит активных лидов — предел смешанного портфеля; свои объекты за него
   *  выходят через освобождение места, а без обычных лидов — просто сверх. */
  ownPropertyOverLimitEnabled: z.boolean().optional(),
  ownPropertyReleaseEnabled: z.boolean().optional(),
  // ownPropertyReleaseMode: режим "random" убран по закону владения (П-4/П-6,
  // 17.09.2026, `docs/audit/lead-ownership-17-09.md` §4) — система больше не
  // выбирает жертву сама. Поле нарочно НЕ принимается: сохранено в схеме БД
  // (без миграции), но из формы Настроек и из PATCH исключено намеренно.
  /** Надбавка к leadActiveLimit для лидов по своим объектам (не абсолютное
   *  число) — по умолчанию 1, то есть потолок activeLimit+1. 0 = буквально
   *  без предела. См. leads.ts::canTakeOwnPropertyLead. */
  ownPropertyLeadCap: z.number().int().min(0).max(100).optional(),
  /** «Взвешенные слоты» лимита (план владельца 20-21.08.2026): свежий лид
   *  занимает целое место, доведённый до показа — половину, «думающий» —
   *  четверть, и сливать почти доработанного клиента ради нового становится
   *  незачем. Веса — в процентах слота. Потолок 1000 % оставлен намеренно:
   *  владелец вправе сделать какую-то ступень дороже целого места, если решит
   *  наоборот придерживать портфель. См. lib/leadLimits.ts. */
  weightedLeadSlotsEnabled: z.boolean().optional(),
  leadSlotWeightFreshPercent: z.number().int().min(0).max(1000).optional(),
  leadSlotWeightAfterShowingPercent: z.number().int().min(0).max(1000).optional(),
  leadSlotWeightThinkingPercent: z.number().int().min(0).max(1000).optional(),
  /** Раздача портфеля уволенного: клиенты — сильным по KPI, объекты — слабым. */
  handoverClientsToHighKpi: z.boolean().optional(),
  handoverPropertiesToLowKpi: z.boolean().optional(),
  /** Кнопки «Принять/Отклонить» прямо в шторке уведомлений и срок жизни
   *  одноразового маркера действия. Потолок часом: маркер, живущий сутки,
   *  превращается в постоянный ключ, а он вкладывается в уведомление. */
  pushLeadActionsEnabled: z.boolean().optional(),
  pushActionTtlMinutes: z.number().int().min(5).max(60).optional(),
  /** Что ещё присылать (решение владельца 11.08.2026). Пороги частоты — в минутах,
   *  0 у сообщений = уведомлять о каждом. Дубли показов руководству закрывают
   *  дыру, из-за которой владелец не получал напоминаний о показах вовсе. */
  // `pushOnScoreChange`/`pushScoreThrottleMinutes` убраны из схемы 28.09.2026:
  // уведомлений о смене Royal Score в коде нет вовсе, ни одна строка сервера эти
  // поля не читает, тумблер снят с экрана ещё 23.09. Колонки в БД остаются.
  pushMessageThrottleMinutes: z.number().int().min(0).max(120).optional(),
  pushShowingsToSupervisors: z.boolean().optional(),
  /** Обязательное окно после исчерпания переносов блокирует работу во всей CRM,
   *  а не только выдачу новых лидов (решение владельца 11.08.2026). */
  // Главный рубильник обязательных окон. Колонка приехала 10.09.2026 выключенной
  // (миграция pause_mandatory_summary_windows ставит false существующей строке
  // Settings), а в схему правки не попала — механизм можно было погасить, но не
  // вернуть иначе как SQL. Тот же класс, что «право год существовало без UI».
  /** Бот возвращает клиента к последнему незакрытому вопросу. */
  botTopicLockEnabled: z.boolean().optional(),
  botTopicDriftTurns: z.number().int().min(0).max(10).optional(),
  // `refusalCommentMinLength` убран из схемы 13.09.2026 (аудит мёртвого кода):
  // ни одна UI-форма его не выставляла, а lib/clientRefuse.ts:~172 всегда
  // использовал литерал 20 вместо чтения этого поля. Колонка в БД остаётся
  // (orphaned pending future migration) — здесь только перестали её
  // читать/принимать через API.
  /** Порог ИИ-скоринга для автопередачи перспективного клиента сильному агенту. 0 = выключено. */
  hotScoreThreshold: z.number().int().min(0).max(100).optional(),
  /** Веса показателей KPI (решение владельца 01.08.2026: числа не в коде).
   *  Ключи фиксированы реестром метрик; сумма положительная — иначе рейтинг
   *  не из чего собирать. Вес 0 выключает метрику целиком. */
  kpiWeights: z
    .record(z.enum(KPI_WEIGHT_KEYS), z.number().int().min(0).max(100))
    .refine((w) => Object.values(w).some((v) => v > 0), {
      message: "Хотя бы один показатель должен иметь вес больше нуля",
    })
    .optional(),
  /** Вероятность закрытия по стадии сделки — веса прогноза денег к концу месяца
   *  (lib/financeForecast.ts). Ключи и значения по умолчанию — в
   *  @royal-home/shared. Правится целиком: частичный объект дополняется
   *  умолчаниями на чтении, поэтому пустой объект тоже допустим. */
  dealStageWinProbability: dealStageWinProbabilitySchema.optional(),
  /** «Что бот умеет» — ползунки возможностей (см. messengers/botCapabilities.ts).
   *  Выключенная возможность убирает И действие, И кусок промта: флаг, который
   *  гасит действие, но оставляет обещание, хуже отсутствия флага. */
  botCanSendPhotos: z.boolean().optional(),
  /** Сколько снимков уходит клиенту за один показ. Потолок 10, а не «сколько есть»:
   *  каждая фотография — отдельное сообщение, и пачка из двадцати читается как
   *  рассылка и клиентом, и Meta. */
  botPhotosPerOffer: z.number().int().min(1).max(10).optional(),
  botCanBookShowings: z.boolean().optional(),
  botCanConfirmShowings: z.boolean().optional(),
  botCanFollowUp: z.boolean().optional(),
  botCanAnswerComments: z.boolean().optional(),
  /** «Соедините с оператором»: бот записывает запрос звонка и зовёт агентов. */
  botCanRequestCallback: z.boolean().optional(),
  /** Дежурный оператор обратных звонков (сейчас Нурмухаммад, потом сменится —
   *  потому настройка). null — авто-соединения нет, очередь видна всем. */
  callbackOperatorAgentId: z.string().max(64).nullable().optional(),
  /** «Уточню у собственника»: выключено — отвечает агент по звонку. */
  botCanAskOwner: z.boolean().optional(),
  /** Разговор с кандидатом на вакансию и карточка в разделе «Вакансии». */
  botCanHandleVacancies: z.boolean().optional(),
  /** Публикации вакансии (коды или ссылки Instagram), по одной в строке. Пусто —
   *  действует список по умолчанию из кода (lib/vacancyPosts.ts). */
  botVacancyPostCodes: z.string().max(4000).nullable().optional(),
  /** Ссылки на объекты в переписке; выключено — параметры словами, ссылку даст агент. */
  botCanSendLinks: z.boolean().optional(),
  /** Режим запуска: бот отвечает ровно на спрошенное и ничего не предлагает сверх. */
  botCautiousMode: z.boolean().optional(),
  /** Экономия промта по намерению: подробности сценария — только тому разговору,
   *  которому они нужны. Выключено — промт собирается как раньше, побайтово. */
  botPromptIntentEconomy: z.boolean().optional(),
  contactLinkSweepEnabled: z.boolean().optional(),
  /** Явный кэш системного промта Gemini: стабильная часть кэшируется у Google со
   *  скидкой 90% вместо случайного неявного кэша. Выключено — запросы как раньше. */
  geminiExplicitCachingEnabled: z.boolean().optional(),
  /** Экран «Тренировка» (23.08.2026): доступен владельцу, только пока включено.
   *  Не влияет на то, участвуют ли уже накопленные StyleExample в промте бота —
   *  это решает поле `enabled` у самого примера. */
  botTrainingScreenEnabled: z.boolean().optional(),
  /** Сколько минут живёт подтверждение личности в защищённых разделах. Потолок
   *  продублирован в lib/stepUp.ts и обходу отсюда не поддаётся: это последнее,
   *  что отделяет открытый ноутбук администратора от ключей WhatsApp и Anthropic. */
  stepUpMinutes: z.number().int().min(5).max(240).optional(),
  /** Глобальный рубильник входа по отпечатку/лицу — false отключает вход и
   *  привязку новых устройств на сервере для всех сотрудников сразу. */
  passkeyLoginEnabled: z.boolean().optional(),
  /** Системный промт чат-бота. Пустая строка — сбросить на дефолт из кода. */
  botSystemPrompt: z.string().max(30000).optional(),
  /** Промт ответов на комментарии Instagram. Пустая строка — сбросить на дефолт из кода. */
  botCommentPrompt: z.string().max(30000).optional(),
  // aiTextProvider УБРАН из схемы (26.08.2026): поставщик текста один — Google
  // (ai/client.ts, Anthropic-ветка удалена 20.08), поле не читает ни одна строка
  // кода, а его приём создавал ложное впечатление работающего переключателя.
  // Колонка в БД остаётся как исторический архив — удаление необратимо.
  /** Глобальный рубильник бота — false выключает ответы на всех каналах сразу. */
  botEnabled: z.boolean().optional(),
  /** Рубильники бота по каналам: false — бот молчит в этом канале, но входящие
   *  по-прежнему попадают в переписку CRM и сотрудник отвечает вручную.
   *  Подключение канала это не трогает (за него отвечают metaEnabled и ключи). */
  botWhatsappEnabled: z.boolean().optional(),
  botInstagramEnabled: z.boolean().optional(),
  botFacebookEnabled: z.boolean().optional(),
  botTelegramEnabled: z.boolean().optional(),
  botWebsiteChatEnabled: z.boolean().optional(),
  /** Рубильник прямой интеграции с Meta (WhatsApp, Instagram, Messenger). */
  metaEnabled: z.boolean().optional(),
  /** Ключи Meta. Пустая строка — очистить и вернуться на переменную окружения. */
  metaAppSecret: secretField(500),
  /** Номер приложения Meta — нужен, чтобы обменять маркер рекламы на 60-дневный. */
  metaAppId: z.string().trim().max(100).optional(),
  metaVerifyToken: secretField(500),
  metaWaToken: secretField(1000),
  metaWaPhoneId: z.string().trim().max(100).optional(),
  metaIgToken: secretField(1000, "instagram-messaging"),
  /** Маркер удаления Instagram (20.09.2026) — Facebook Login, graph.facebook.com,
   *  НЕ то же самое, что metaIgToken выше (переписка, graph.instagram.com через
   *  прокси). См. Settings.metaIgManageToken в schema.prisma. */
  metaIgManageToken: secretField(1000, "instagram-manage"),
  metaIgAppSecret: secretField(500),
  metaPageToken: secretField(1000),
  metaPageId: z.string().trim().max(100).optional(),
  /** Группы Facebook для ручной раздачи объекта (28.09.2026) — строка = «Название |
   *  ссылка», по одной в строке (lib/facebookGroupShare.ts::parseShareGroups). Не
   *  секрет, идёт как обычное поле через ...rest, как incomingInboundContexts выше. */
  facebookShareGroups: z.array(z.string().trim().min(3).max(300)).max(50).optional(),
  /** Рекламный кабинет (Marketing API): рубильник, маркер с ads_read и номер кабинета. */
  metaAdsEnabled: z.boolean().optional(),
  metaAdsToken: secretField(1000),
  metaAdAccountId: z.string().trim().max(100).optional(),
  /** Секрет для приёма бюджетных оповещений Google Cloud (не ключ доступа — просто
   *  строка в адресе подписки Pub/Sub, поэтому не шифруется). Пустая строка —
   *  «секрет не задан», а не короткий секрет, и должна проходить как раньше.
   *  Ночная проверка 24.09.2026: без минимальной длины владелец мог вписать
   *  сюда однозначное значение («1», «token») — вебхук угадывался бы почти
   *  сразу, лимитер на POST /google-budget только замедляет перебор, а не
   *  делает короткий секрет надёжным. 24 символа — тот же порядок энтропии,
   *  что у токена ссылок объекта (`propertyShareLink`, 24 случайных байта). */
  googleBudgetToken: z
    .string()
    .trim()
    .max(200)
    .refine((v) => v === "" || v.length >= 24, {
      message: "Секрет короче 24 символов — его легко подобрать перебором. Вставьте более длинное значение.",
    })
    .optional(),
  /** Публикации — кросспостинг готового ролика от монтажёра
   *  (docs/video-pipeline-handoff-only-04-09-2026.md). */
  autoPublishEnabled: z.boolean().optional(),
  /** Истории Instagram (21.09.2026) — отдельный рубильник, гейтит только
   *  автоматическую публикацию вслед за Reels (lib/instagramStories.ts). */
  instagramStoriesEnabled: z.boolean().optional(),
  /** Истории Facebook (28.09.2026, Page Stories API) — своя площадка ПОВЕРХ
   *  Instagram, свой рубильник, всегда проверяемый (см. lib/instagramStories.ts). */
  facebookStoriesEnabled: z.boolean().optional(),
  /** Ежедневная подборка сторис (26.09.2026, решение владельца) —
   *  lib/dailyStories.ts::runDailyStoriesTick. */
  dailyStoriesEnabled: z.boolean().optional(),
  dailyStoriesCount: z.number().int().min(1).max(20).optional(),
  /** Час запуска по Душанбе, 0-23. */
  dailyStoriesHourDushanbe: z.number().int().min(0).max(23).optional(),
  /** Фото-посты для объектов без ролика (28.09.2026, agent-brief.md) — карусель
   *  Instagram/фото-пост Facebook/альбом Telegram из уже загруженных фото,
   *  когда ролика ещё нет. Своя таблица (PropertyPhotoPost), см. lib/photoPosts.ts. */
  photoPostsEnabled: z.boolean().optional(),
  photoPostAfterHours: z.number().int().min(1).max(720).optional(),
  /** Повторные показы (28.09.2026, agent-brief.md reposts-digests) —
   *  lib/socialReposts.ts::scheduleRepostsTick. */
  repostsEnabled: z.boolean().optional(),
  repostAfterDays: z.number().int().min(1).max(180).optional(),
  repostMaxRounds: z.number().int().min(1).max(20).optional(),
  /** Подборки объектов (28.09.2026, agent-brief.md reposts-digests) —
   *  lib/socialDigests.ts::runSocialDigestsTick. */
  digestsEnabled: z.boolean().optional(),
  digestWeekday: z.number().int().min(0).max(6).optional(),
  digestHourDushanbe: z.number().int().min(0).max(23).optional(),
  /** Агенту его готовый пост в Telegram (28.09.2026, lib/agentSharePost.ts) —
   *  общий рубильник; личный у самого агента — Agent.sharePostTelegram. */
  agentSharePostTelegram: z.boolean().optional(),
  /**
   * РАСПИСАНИЕ ВЫХОДА РОЛИКОВ (23.09.2026) — см. lib/publishSchedule.ts и
   * lib/publishScheduleRules.ts. Границы здесь не косметика: окно задаётся
   * минутами от полуночи, и «начало позже конца» превратило бы расстановку в
   * бесконечный перенос на завтра, а нулевой промежуток вернул бы залп, ради
   * которого расписание и появилось. Порядок «начало < конец» проверяется ниже
   * по схеме, где видны оба поля сразу.
   */
  publishScheduleEnabled: z.boolean().optional(),
  publishScheduleUseHeatmap: z.boolean().optional(),
  publishScheduleUseInstagramOnline: z.boolean().optional(),
  publishScheduleWindowStartMin: z.number().int().min(0).max(24 * 60).optional(),
  publishScheduleWindowEndMin: z.number().int().min(0).max(24 * 60).optional(),
  publishScheduleMinGapMin: z.number().int().min(5).max(24 * 60).optional(),
  /**
   * Плоский список пар «начало-конец», минуты от полуночи. Нечётная длина или
   * перевёрнутая пара — не косметика: загрузчик правил такую пару молча
   * отбрасывает (lib/publishScheduleRules.ts), и владелец получил бы
   * «сохранено» на настройку, которая ни на что не влияет.
   */
  publishSchedulePriorityWindows: z
    .array(z.number().int().min(0).max(24 * 60))
    .max(12)
    .refine((v) => v.length % 2 === 0, { message: "Часы публикации задаются парами «начало-конец»" })
    .refine(
      (v) => v.every((_, i) => i % 2 === 1 || v[i] < v[i + 1]),
      { message: "В каждой паре часов публикации конец должен быть позже начала" }
    )
    .optional(),
  publishScheduleHeatmapDays: z.number().int().min(7).max(365).optional(),
  publishScheduleLeadHours: z.number().int().min(0).max(6).optional(),
  telegramChannelId: z.string().max(100).optional(),
  /** Дополнительные чаты Telegram (26.09.2026) — chat_id/@username через запятую,
   *  пробел или перевод строки, разбирает lib/telegramChats.ts::parseTelegramChatIds.
   *  `nullable`, не только `optional`: пустое поле шлёт `null`, чтобы очистить
   *  список (CLAUDE.md — undefined в PATCH ничего не стирает). */
  telegramExtraChatIds: z.string().trim().max(2000).nullable().optional(),
  telegramDiscussionGroupId: z.string().max(100).optional(),
  telegramDirectMessagesEnabled: z.boolean().optional(),
  /** Ручная передача видео монтажёру через Telegram (01.09.2026, lib/videoHandoff.ts) —
   *  единственный путь подготовки ролика после удаления автомонтажа 04.09.2026. */
  videoHandoffEnabled: z.boolean().optional(),
  /** Проверка фото и видео агента перед монтажом (25.09.2026). false — CRM
   *  одобряет сама (lib/propertyReview.ts::autoApproveIfRawReviewOff). */
  rawReviewRequired: z.boolean().optional(),
  /** Готовый ролик проверяет модератор перед публикацией (25.09.2026, lib/clipReview.ts). */
  clipReviewEnabled: z.boolean().optional(),
  /** «Модератор видео по умолчанию» убран из интерфейса 23.09.2026 (пуш «Объект
   *  ждёт проверки» никому по этому полю не уходит — ни одна строка сервера его
   *  не читает). Поле и колонка в базе остаются как исторический архив.
   *  Существование/активность id при сохранении всё равно проверяются (ночная
   *  проверка 24.09.2026, М12-в, и разбор класса 25.09.2026) — мёртвое для
   *  бота поле не повод оставлять его без защиты от опечатки/уволенного. */
  videoModeratorAgentId: z.string().max(64).nullable().optional(),
  videoMontajerAgentId: z.string().max(64).nullable().optional(),
  /** YouTube Shorts (31.08.2026) — OAuth2 Google, отдельно от Meta. clientId не
   *  секрет (хранится как есть), clientSecret/refreshToken — зашифрованы. */
  youtubeClientId: z.string().trim().max(200).optional(),
  youtubeClientSecret: secretField(500),
  youtubeRefreshToken: secretField(1000),
  /** TikTok Content Posting API (17.09.2026) — clientKey не секрет, clientSecret
   *  шифруется. refreshToken/openId/creator* сюда НЕ входят — их пишет только
   *  OAuth callback (routes/tiktok.ts), форма их не редактирует. */
  tiktokClientKey: z.string().trim().max(200).optional(),
  tiktokClientSecret: secretField(500),
  /** null = владелец ещё не выбрал (см. схему) — enum из четырёх значений API. */
  tiktokPrivacyLevel: z
    .enum(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"])
    .nullable()
    .optional(),
  tiktokAllowComments: z.boolean().optional(),
  tiktokAllowDuet: z.boolean().optional(),
  tiktokAllowStitch: z.boolean().optional(),
  tiktokBrandMode: z.enum(["NONE", "ORGANIC", "BRANDED"]).optional(),
  /** Threads (Meta), 23.09.2026 — appId не секрет, appSecret шифруется.
   *  accessToken/userId/username* сюда НЕ входят — их пишет только OAuth
   *  callback (routes/threads.ts), форма их не редактирует (тот же приём,
   *  что у tiktokClientKey/tiktokClientSecret выше). */
  threadsAppId: z.string().trim().max(200).optional(),
  threadsAppSecret: secretField(500),
  /** Этап 4 (телефония): подключение к Asterisk ARI. URL/логин не секрет,
   *  пароль — да (пустая строка очищает, как у ключей Meta выше). */
  asteriskAriUrl: z.string().trim().max(300).optional(),
  asteriskAriUsername: z.string().trim().max(200).optional(),
  asteriskAriPassword: z.string().trim().max(500).optional(),
  /** Куда станция звонит сотруднику перед соединением с клиентом: "mobile" — на его
   *  мобильный из карточки (софтфон не нужен, платных плеча два), "extension" — на
   *  внутренний номер. Список закрытый: произвольная строка тут означала бы звонки
   *  «в никуда», о которых узнали бы только по молчащей трубке. */
  asteriskAgentDialMode: z.enum(["mobile", "extension", "auto"]).optional(),
  /** Управление станцией (AMI): порт, логин и пароль. Адрес не спрашивается — он
   *  берётся из asteriskAriUrl, станция одна. Пароль шифруется, пустая строка
   *  очищает — как у ключей выше. */
  asteriskAmiPort: z.number().int().min(1).max(65535).optional(),
  asteriskAmiUsername: z.string().trim().max(200).optional(),
  asteriskAmiPassword: z.string().trim().max(500).optional(),
  /** ЖИВОЙ ГОЛОС (эксперимент, пункт 5 очереди ИИ 23.08.2026) — бот отвечает по
   *  телефону через Gemini Live, а не текстом. Выключено по умолчанию, живым
   *  звонком не проверено (см. lib/telephony/liveVoiceBridge.ts). Номер — `null`
   *  очищает поле (как договорено в CLAUDE.md: `undefined` не сериализуется в
   *  JSON, для очистки нужен именно `null`). */
  liveVoiceEnabled: z.boolean().optional(),
  liveVoiceTestExtension: z.string().trim().max(20).nullable().optional(),
  /** Управление ботом из интерфейса (13.09.2026) — тот же приём очистки, что у
   *  botSystemPrompt: пустая строка сбрасывает на зашитый по умолчанию текст. */
  liveVoicePrompt: z.string().max(30000).optional(),
  liveVoiceVoiceName: z.string().trim().max(40).nullable().optional(),
  /** Голос для таджикского (см. liveVoiceBridge.ts::resolveLiveVoiceVoiceName) —
   *  выбирается вместо liveVoiceVoiceName, когда замок "Только русский" выключен. */
  liveVoiceVoiceNameTajik: z.string().trim().max(40).nullable().optional(),
  interviewInviteAddress: z.string().trim().max(300).nullable().optional(),
  /** Замок на русский (диагностика акцента, см. liveVoicePersona.ts) — раньше
   *  только .env, теперь тумблер владельца. */
  liveVoiceForceRussianOnly: z.boolean().optional(),
  liveVoiceBreathEnabled: z.boolean().optional(),
  /** Настоящий офисный амбиент (см. liveVoiceBridge.ts:
   *  loadOfficeAmbienceTrack) — тумблер и множитель громкости 0..1 поверх уже
   *  приглушённого при конвертации трека. */
  liveVoiceOfficeAmbienceEnabled: z.boolean().optional(),
  liveVoiceOfficeAmbienceVolume: z.number().min(0).max(1).optional(),
  /** Консультант на телефоне (24.09.2026, робозвонок): кому переводить звонок без
   *  агента объекта и своего агента, и когда брать настоящие входящие вместо
   *  автоответчика (см. schema.prisma и lib/telephony/failoverSync.ts).
   *  Существование/активность проверяются при сохранении (25.09.2026, разбор
   *  класса из ночной проверки 24.09.2026, М12-в) — lib/telephony/liveCallTransfer.ts
   *  и до этого пропускал уволенного/замороженного на момент ПЕРЕВОДА (откатывался
   *  на callbackOperatorAgentId), но сама настройка могла на него указывать. */
  liveVoiceTransferAgentId: z.string().max(64).nullable().optional(),
  liveVoiceInboundMode: z.enum(["off", "no_answer", "always"]).optional(),
  liveVoiceInboundWaitSeconds: z.number().int().min(10).max(90).optional(),
  /** Кто слышит и говорит за робота на телефоне (02.10.2026, ai/liveVoiceProvider.ts):
   *  Google Gemini Live или агент ElevenLabs. Поля ElevenLabs — `null` очищает. */
  liveVoiceProvider: z.enum(["google", "elevenlabs"]).optional(),
  elevenLabsAgentId: z.string().trim().max(100).nullable().optional(),
  elevenLabsVoiceIdRu: z.string().trim().max(100).nullable().optional(),
  elevenLabsVoiceIdTg: z.string().trim().max(100).nullable().optional(),
  /** Пол русского голоса — от него род, в котором робот говорит о себе. */
  elevenLabsVoiceGender: z.enum(["female", "male"]).nullable().optional(),
  /** Ключ ElevenLabs. Пустая строка — очистить (вернуться на .env ELEVENLABS_API_KEY). */
  elevenLabsApiKey: z.string().trim().max(500).optional(),
  /** ГОЛОСОВЫЕ ОТВЕТЫ БОТА В ПЕРЕПИСКЕ (13.09.2026) — озвучивает свой текстовый
   *  ответ, только если клиент сам прислал голосовое в этом же ходе (см.
   *  messengers/botCapabilities.ts::voiceReplies). Выключено по умолчанию —
   *  владелец: «создай, но выключи, сам протестирую сначала». До 14.09 у этого
   *  поля не было тумблера в интерфейсе вовсе (только в схеме и в проверке
   *  способностей бота) — включить можно было только прямым запросом к базе.
   *  Добавлен сюда явно, а не забыт вторым по счёту разом с liveVoiceEnabled.*/
  botCanSendVoiceReplies: z.boolean().optional(),
  /** Робозвонок покупателю после показа (13.09.2026, см. lib/postShowingCalls.ts и
   *  docs/buyer-antifraud-funnel-13-09-2026.md). Работает только поверх включённого
   *  живого голоса выше: свой канал звонка он не заводит, а пользуется тем же мостом. */
  postShowingCallEnabled: z.boolean().optional(),
  /** Звонки прямо в браузере: адрес соединения со станцией и передатчик звука.
   *  Адрес — всегда защищённый (wss://): браузер запрещает микрофон и незащищённые
   *  соединения на обычных страницах, поэтому ws:// здесь означал бы настройку,
   *  которая сохранилась и молча не работает. */
  /** ВХОДЯЩИЕ ЗВОНКИ — рабочее место оператора (решение владельца 10.08.2026).
   *  Кто принимает входящие — списком сотрудников, а не ролью: роль это права в
   *  CRM, а не то, у кого звонит телефон. Потолок 50 — не ограничение смысла,
   *  а защита от массива на десять тысяч строк в теле запроса. */
  /** Контексты диалплана АТС, из которых звонок считается входящим. Пустой список —
   *  встроенный набор (см. lib/telephony/incomingCalls.ts). Настройкой, а не
   *  константой, потому что контекст транка живёт в чужой системе и меняется без
   *  выката CRM — один такой случай уже стоил недели потерянных входящих. При своём
   *  списке не забыть `ext-queues`: переопределение полное. */
  incomingInboundContexts: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  /** Id партнёрских Страниц Facebook для кросспостинга (28.09.2026, см.
   *  lib/facebookCrosspost.ts) — числовая строка, как отдают все id объектов
   *  Graph API (Page ID, video ID и т. п.), 5-20 знаков с запасом. */
  facebookCrosspostPageIds: z
    .array(z.string().trim().regex(/^\d{5,20}$/, "Id Страницы — только цифры"))
    .max(20)
    .optional(),
  incomingAutoCreateClient: z.boolean().optional(),
  // `incomingDefaultKind` убран из схемы 13.09.2026 (аудит мёртвого кода): ни
  // одна UI-форма никогда не предлагала другого значения — карточка звонком
  // ДО квалификации всегда заводится как «прочее» (разбор 30.08.2026), тип
  // карточке даёт квалификация разговора (lib/telephony/qualifyIncoming.ts), а
  // не эта настройка. Чтение поля по-прежнему намеренно отдаёт литерал "OTHER"
  // независимо от содержимого колонки БД — см. lib/telephony/incomingSettings.ts.
  incomingAssignOnQualify: z.boolean().optional(),
  /** Номер, куда станция уводит непринятый звонок. Саму переадресацию по-прежнему
   *  делает АТС — CRM лишь кладёт значение в её внутреннюю базу (пустая строка
   *  очищает, как у ключей выше). */
  incomingForwardPhone: z.string().max(30).optional(),
  /** Что делать со звонком, которого никто не взял. Список закрытый: произвольная
   *  строка означала бы диалплан, который не знает, что ему делать, — то есть
   *  брошенный звонок вместо настроенного. */
  incomingNoAnswerAction: z.enum(["none", "forward", "voicemail", "both"]).optional(),
  /** Сколько секунд звонок ждёт оператора. Потолок в пять минут — не смысл, а
   *  защита: ожидание дольше означает клиента, который давно положил трубку. */
  incomingNoAnswerSeconds: z.number().int().min(5).max(300).optional(),
  /** Ночной режим: вне рабочих часов очередь пропускается — сразу дежурному или
   *  на автоответчик. Границы "HH:MM"; окно через полночь поддержано станцией. */
  incomingNightAction: z.enum(["none", "forward", "voicemail"]).optional(),
  incomingNightStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Время в виде ЧЧ:ММ").optional(),
  incomingNightEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Время в виде ЧЧ:ММ").optional(),
  /** Куда идёт входящий в первую очередь: очередь операторов или прямо на аппарат.
   *  Список закрытый по той же причине, что и у правила выше. */
  incomingPrimaryTarget: z.enum(["queue", "extension"]).optional(),
  /** Внутренний номер аппарата для режима "extension". Только цифры: значение
   *  подставляется в набор станции, и мусор в нём — не кривой номер, а чужое
   *  выражение в диалплане. Пустая строка очищает. */
  incomingPrimaryExtension: z
    .string()
    .regex(/^\d{2,8}$/, "Внутренний номер — от 2 до 8 цифр")
    .or(z.literal(""))
    .optional(),
  incomingPanelEnabled: z.boolean().optional(),
  /** Уведомление о звонке на телефон оператора — единственный способ узнать о
   *  звонке при закрытой CRM (решение владельца 11.08.2026). */
  incomingPushEnabled: z.boolean().optional(),
  /** Часы приёма входящих. Тот же формат "HH:MM", что у рабочих часов ниже, но
   *  настройка отдельная: смена оператора и рабочий день агентства — разное. */
  incomingHoursEnabled: z.boolean().optional(),
  incomingHoursStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  incomingHoursEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  /** Звонок известного клиента сначала уходит ЕГО агенту (владелец 16.08.2026,
   *  отмена правила «входящие только оператору» от 08.08.2026). Не взял — станция
   *  пишет голосовую почту (не возвращает в очередь, решение владельца 29.08.2026,
   *  см. lib/telephony/inboundRouting.ts). */
  incomingRouteToAssignedAgent: z.boolean().optional(),
  /** Сколько секунд станция звонит агенту, прежде чем перейти на голосовую почту.
   *  Нижняя граница пяти секунд — защита: меньше трубку не берут, и такой перевод
   *  стоил бы клиенту лишнего гудка без единого шанса на ответ. Верхняя — 300
   *  (5 минут); по умолчанию 150 (2.5 минуты, владелец 29.08.2026: «пусть ждёт
   *  много, 2-3 минуты, а потом уже голосовая почта»).
   *
   *  0 — ОСОБОЕ ЗНАЧЕНИЕ, «без ограничения» (владелец 20.08.2026): звонить агенту,
   *  пока клиент сам не положит трубку, без перехода на голосовую почту.
   *  Верхнего предела с нашей стороны в этом случае нет — реальный потолок всё
   *  равно ставит оператор связи (обычно 60–180 секунд до сброса неотвеченного
   *  звонка), а не Asterisk и не CRM; станция передаёт станции пустой таймаут
   *  Dial(), что на её языке и означает «без ограничения» (см. диалплан на АТС,
   *  контекст royalhome-agent-route в extensions_custom.conf). */
  incomingRouteRingSeconds: z.number().int().refine((v) => v === 0 || (v >= 5 && v <= 300), {
    message: "0 (без ограничения) либо от 5 до 300 секунд",
  }).optional(),
  /** Заготовка на будущий способ маршрутизации незнакомых звонков — список
   *  закрытый по той же причине, что и incomingNoAnswerAction: произвольная
   *  строка означала бы значение, которое ни один диалплан никогда не поймёт.
   *  "ring_all_agents" исключён 20.08.2026 (владелец передумал: агенты путают
   *  такие звонки со своими клиентами) — см. lib/telephony/routingModeSync.ts. */
  // "ivr_menu" больше не принимается (23.09.2026): станция его не исполняет, а
  // сохранённый режим уезжал в неё через AMI как рабочий. Кнопка на экране
  // выключена той же правкой (ChannelsTab.tsx, «скоро»).
  incomingRoutingMode: z.enum(["assigned_then_forward", "kpi_queue", "dedicated_operator"]).optional(),
  /** Дежурная ротация для "dedicated_operator" — порядок в массиве и есть порядок
   *  очереди (см. Settings.incomingDutyAgentIds в schema.prisma). Существование и
   *  активность id-агентов ПРОВЕРЯЮТСЯ при сохранении (ночная проверка 24.09.2026,
   *  М12-в, решение владельца) — см. проверку сразу после разбора схемы ниже.
   *  "agent_not_found" в журнале входящих остаётся страховкой на случай, если
   *  сотрудника уволят уже ПОСЛЕ сохранения настройки (см. lib/agentSettingsCleanup.ts,
   *  который в этот момент саму настройку и подчищает). */
  incomingDutyAgentIds: z.array(z.string().max(64)).max(50).optional(),
  /** ПОДСКАЗКА АГЕНТУ О ЗВОНЯЩЕМ (владелец 20.08.2026). Станция играет её в ухо
   *  агенту, пока клиент слушает гудки — см. docs/telephony-whisper.md. */
  callWhisperEnabled: z.boolean().optional(),
  callWhisperIncoming: z.boolean().optional(),
  callWhisperOutgoing: z.boolean().optional(),
  /** Состав фразы. Список закрытый: значение не из него означало бы блок, который
   *  сборщик не знает, — то есть настройку, молча не делающую ничего. */
  callWhisperIncomingParts: z.array(z.enum(WHISPER_PARTS)).max(WHISPER_PARTS.length).optional(),
  callWhisperOutgoingParts: z.array(z.enum(WHISPER_PARTS)).max(WHISPER_PARTS.length).optional(),
  callWhisperLanguage: z.enum(["tg", "ru"]).optional(),
  /** Голос из каталога Gemini TTS. Ограничения по списку здесь нет намеренно: каталог
   *  голосов у Google меняется, и «неизвестный голос» — это отказ синтеза с записью в
   *  журнал, а не сломанная настройка. */
  callWhisperVoice: z.string().min(1).max(40).optional(),
  callWhisperAiHint: z.boolean().optional(),

  /** РАЗБОР ПРОБЛЕМНЫХ МЕСТ (решение владельца 11.08.2026) — два отчёта, два
   *  выключателя. Выключенный не собирается вовсе: ни кроном, ни кнопкой «Собрать
   *  сейчас» (см. lib/problemReport.ts). Получатели — директора, как у остальных
   *  сводок; отдельного списка не заводим, пока владелец не попросит. */
  problemReportWeeklyEnabled: z.boolean().optional(),
  problemReportMonthlyEnabled: z.boolean().optional(),
  /** Пауза перед ответом бота, секунды: сколько тишины ждать, пока клиент дописывает.
   *  0 — отвечать сразу; верхний предел — минута, дальше клиент решит, что его не читают. */
  botReplyDelaySec: z.number().int().min(0).max(60).optional(),
  /** Потолок ожидания от первого сообщения пачки, секунды. Обязан быть не меньше паузы —
   *  иначе бот отвечал бы раньше, чем истечёт сама пауза (проверка ниже, после разбора). */
  botReplyMaxWaitSec: z.number().int().min(5).max(600).optional(),
  /** Сравнение манер продажи бота (см. ai/salesScenarios.ts). false — все НОВЫЕ
   *  диалоги идут на сценарии по умолчанию; уже начатые доживают на своём. */
  salesScenarioTestEnabled: z.boolean().optional(),
  /** Сроки этапов конвейера подготовки объекта, дни. Потолок 30: этап, который
   *  тянется месяц, это не срок, а отсутствие срока. */
  propertyReviewDays: z.number().int().min(1).max(30).optional(),
  propertyPhotoDays: z.number().int().min(1).max(30).optional(),
  propertyVideoDays: z.number().int().min(1).max(30).optional(),
  propertyEditingDays: z.number().int().min(1).max(30).optional(),
  /** Предел передач лида между агентами; дальше карточка становится «Потерянной».
   *  0 выключает правило — «передавать сколько угодно» это осмысленный выбор. */
  leadMaxTransfers: z.number().int().min(0).max(20).optional(),
  /** Слова-признаки конфликта в обязательном комментарии причины передачи OTHER
   *  (см. lib/clientTransfer.ts::looksLikeConflict). Пустой массив — осознанно
   *  выключить распознавание, не «взять дефолт из кода». */
  transferConflictKeywords: z.array(z.string().trim().min(2).max(40)).max(40).optional(),
  /** Режим «не принимаю лиды»: потолок длительности и пауза до следующего включения. */
  agentPauseMaxHours: z.number().int().min(1).max(168).optional(),
  agentPauseCooldownHours: z.number().int().min(0).max(168).optional(),
  /** Штраф за бездействие: сроки предупреждения и штрафа, цена штрафа в баллах.
   *  Штраф раньше предупреждения не имеет смысла — проверка пары ниже. */
  /** Обязательные окна: сроки требований, отсрочка и её предел, дневное окно. */
  propertySummaryWindowStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  propertySummaryWindowEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  // `waitingCheckAfterMinutes`/`waitingCheckMaxRepeats` («Ждёт варианты»/«Ждёт
  // показ», 04.08.2026) убраны из схемы 28.09.2026: поле с экрана снято раньше
  // (DisciplineTab), и ни сервер, ни скрипты, ни тесты их не читают. Колонки в
  // БД остаются.
  /** Резерв объекта на сделке (Путь покупателя) — сколько рабочих дней держим,
   *  прежде чем автоматически вернуть в продажу. */
  dealReservationBusinessDays: z.number().int().min(1).max(30).optional(),
  inactivityWarnAfterDays: z.number().int().min(1).max(60).optional(),
  inactivityPenaltyAfterDays: z.number().int().min(1).max(90).optional(),
  inactivityPenaltyPoints: z.number().int().min(0).max(50).optional(),
  /** «Застой сделки» (владелец 30.08.2026, lib/dealStalePipeline.ts): продавец без
   *  единого объекта в CRM дольше стольких дней, или покупатель без единой сделки —
   *  застой. Потолки — тот же порядок, что и дефолт в схеме (10/21 дней), с запасом. */
  dealStaleSellerDays: z.number().int().min(1).max(60).optional(),
  dealStaleBuyerDays: z.number().int().min(1).max(90).optional(),
  /** Светофор неактивных (владелец 20-21.08.2026, lib/inactiveTrafficLight.ts): цвет
   *  ставит система, эти числа настраивают только темп — как часто напоминать агенту
   *  и после скольких попыток карточка уходит в Потерянные. Потолок часов 240 (10 суток) —
   *  порог, за которым «напоминание» уже не отличить от «забыли». */
  inactiveGreenPingHours: z.number().int().min(1).max(240).optional(),
  inactiveGreenMaxAttempts: z.number().int().min(1).max(10).optional(),
  inactiveYellowPingHours: z.number().int().min(1).max(240).optional(),
  inactiveYellowMaxAttempts: z.number().int().min(1).max(10).optional(),
  inactiveRedPingHours: z.number().int().min(1).max(240).optional(),
  inactiveRedMaxAttempts: z.number().int().min(1).max(10).optional(),
  /** Сколько реальных попыток контакта нужно накопить, чтобы разрешить перевод в
   *  Неактивные с причиной «перестал отвечать»/«другое» — закрывает лазейку слива
   *  клиента без единой попытки связаться. */
  inactivateMinAttempts: z.number().int().min(1).max(10).optional(),
  /** Перевёл клиента в Неактивные — следующий лид не раньше чем через это время.
   *  0 — защиты нет (осознанный выбор владельца, не «забыли поставить»). */
  inactivateCooldownHours: z.number().int().min(0).max(72).optional(),
  /** Потерянный/Неактивный клиент, написавший сам, ждёт прежнего агента это время,
   *  прежде чем уйти в общую очередь по KPI. */
  lostReturnAcceptMinutes: z.number().int().min(5).max(1440).optional(),
  /** Приёмка от продавца принята, объекта в CRM всё ещё нет — внутреннее напоминание
   *  агенту переносится на этот срок. */
  sellerPropertyMissingWarnDays: z.number().int().min(1).max(30).optional(),
  /** Тот же случай, дольше — попадает в «Контроль руководителя» как красная метка. */
  sellerPropertyMissingCriticalDays: z.number().int().min(1).max(60).optional(),
  /** Покупатель попросил время подумать — первое напоминание агенту. */
  buyerThinkingFirstPingHours: z.number().int().min(1).max(240).optional(),
  /** Второе напоминание, если клиент снова не ответил. */
  buyerThinkingSecondPingHours: z.number().int().min(1).max(480).optional(),
  /** После второго — переход на редкий темп, раз в столько дней. */
  buyerThinkingSlowTrackDays: z.number().int().min(1).max(30).optional(),
  /** Бот сам напоминает о себе клиенту, который перестал отвечать. */
  followUpEnabled: z.boolean().optional(),
  /** Сколько вопросов бот имеет право задать до оформления заявки. */
  sellerMaxQuestions: z.number().int().min(0).max(10).optional(),
  /** Чем агентство НЕ занимается, построчно. */
  sellerNotSelling: z.string().max(2000).optional(),
  /** Чем агентство лучше других — две-три фразы. */
  sellerAdvantages: z.string().max(2000).optional(),
  /** Шаблоны подписи под Reels (решение владельца 04.08.2026: шаблоны вместо ИИ) —
   *  несколько текстов одним полем, разделены строкой из трёх дефисов `---`.
   *  Пустая строка — сброс на зашитые по умолчанию четыре шаблона. */
  reelsCaptionTemplates: z.string().max(8000).optional(),
  /** Соавторы Instagram Reels по умолчанию (26.09.2026) — до 3 ников через запятую/
   *  пробел/перевод строки, разбирает instagramCollaboratorsFor (lib/instagramCollaborators.ts).
   *  null — очистить поле (см. правило PATCH: undefined не сериализуется в JSON,
   *  сброс шлют явным null). */
  instagramCollaborators: z.string().trim().max(200).nullable().optional(),
  /** ИИ-ассистент внутри CRM. Выключен по умолчанию. */
  aiAssistantEnabled: z.boolean().optional(),
  /** Улучшение фото объекта ИИ (пункт 7 очереди, 23.08.2026). Выключено по
   *  умолчанию — живой тест показал, что модель может исказить помещение
   *  вопреки промту; см. schema.prisma у PropertyPhoto для полного контекста. */
  propertyPhotoEnhanceEnabled: z.boolean().optional(),
  /** Google Search grounding для справочных вопросов ассистента (рынок/законы/
   *  налоги/ипотека Таджикистана вне данных CRM, см. ai/assistant.ts). Выключен
   *  по умолчанию — тумблер на каждую новую функцию. */
  groundedSearchEnabled: z.boolean().optional(),
  /** Семантический подбор объектов в ИИ-ассистенте (эмбеддинги, ai/assistant.ts).
   *  До 26.08.2026 ключа не было ни здесь, ни в UI — включить фичу можно было
   *  только SQL-ом (тот же класс бага, что у askClientsToConfirmShowings). */
  semanticSearchEnabled: z.boolean().optional(),
  /** Сколько напоминаний подряд слать молчащему клиенту. 0 — не напоминать вовсе. */
  followUpMaxAttempts: z.number().int().min(0).max(3).optional(),
  /** Окно инициативных сообщений бота, "HH:MM" по Душанбе. На ответы клиенту не влияет. */
  followUpWindowStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  followUpWindowEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  /** Рабочие часы распределения лидов, "HH:MM" по Душанбе. */
  workHoursStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  workHoursEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  /** Общие выходные компании (владелец 11.10.2026), 0 — воскресенье … 6 — суббота.
   *  Пусто — выходных нет. Правило — packages/shared/src/daysOff.ts. */
  companyDaysOff: daysOffSchema.optional(),
  /** Часы алармов руководителю (владелец 07.09.2026) — ОТДЕЛЬНО от workHours* выше:
   *  то поле про лиды агентам, это — когда директору можно слать пуши/алармы. */
  alarmHoursStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  alarmHoursEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  /** Ответ бота клиенту вне рабочих часов. */
  /** Алгоритм назначения нового лида агенту. */
  leadDistributionStrategy: z.enum(["fair", "round_robin", "random", "manual", "kpi"]).optional(),
  /** Порог KPI (0-100) для допуска к распределению в режиме "kpi". */
  kpiMinThreshold: z.number().int().min(0).max(100).optional(),
  /** Курс USD→TJS для конвертации цен объектов в долларах при публикации на сайт. */
  usdToTjsRate: z.number().min(5).max(15).optional(),
  /** Royal Score (решение владельца 03.08.2026: «настройки, чтобы я менял всё, что
   *  хочу, и чтобы не было никакого риска») — цена каждого события, длина скользящего
   *  окна и стартовый счёт нового агента. Баллы не .int(): «объект исправлен после
   *  возврата» по таблице владельца даёт дробные 2.7. */
  // partialRecord, а не record: в zod 4 `z.record` с ключом-перечислением стал
  // ИСЧЕРПЫВАЮЩИМ (требует все ключи разом), а экран настроек шлёт только те
  // события, которым владелец поменял цену.
  /** Настоящий рубильник модуля целиком (владелец 15.09.2026) — выключен: новые
   *  события не пишутся (recordScoreEvent), push о счёте не уходит, кабинет и
   *  карточка в профиле агента не показываются. Журнал не стирается. */
  royalScoreEnabled: z.boolean().optional(),
  royalScoreEventPoints: z.partialRecord(z.enum(SCORE_EVENT_KEYS), z.number().min(-100).max(100)).optional(),
  /** Скользящее окно, за которое считается счёт, дней. Меньше суток бессмысленно —
   *  событие выпадало бы из расчёта в день начисления. */
  royalScoreWindowDays: z.number().int().min(1).max(365).optional(),
  /** Стартовый счёт нового агента — тот же диапазон, в который зажат сам Royal Score. */
  royalScoreStartingScore: z.number().int().min(0).max(100).optional(),
  /** Фид каталога Meta для рекламы (28.09.2026, docs/agent-briefs/meta-catalog-feed-28-09.md).
   *  Ключ сюда не входит — он не правится вручную, только ротируется отдельной
   *  кнопкой (POST /settings/meta-catalog-feed/rotate). */
  metaCatalogFeedEnabled: z.boolean().optional(),
});

settingsRouter.patch("/", requireAuth, requirePermission("settings.manage"), requireElevation, async (req, res) => {
  if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "postShowingCallEnabled") && !canViewInvestigations(req.agent?.role)) return res.status(403).json({ error: "Недостаточно прав" });
  const parsed = settingsUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    /**
     * СВОЙ ТЕКСТ ОШИБКИ ВЫНОСИМ В `error`, А НЕ ПРЯЧЕМ В `details` (22.09.2026).
     *
     * Веб показывает человеку только поле `error` (lib/api.ts), а `details`
     * никто не читает. Общее «Неверные данные» вместо подсказки «этот маркер
     * от Facebook Login, ему место в поле удаления» обесценивает саму проверку
     * формата (lib/secretFormat.ts): владелец узнаёт, что сохранить нельзя, но
     * не узнаёт почему. Берём первое ОСМЫСЛЕННОЕ сообщение — стандартные
     * zod-овские («Invalid input», «Too big») человеку ничего не говорят, для
     * них прежний общий текст честнее.
     */
    const custom = parsed.error.issues.find((i) => i.code === "custom" && i.message);
    return res
      .status(400)
      .json({ error: custom?.message ?? "Неверные данные", details: parsed.error.flatten() });
  }
  const pair = parsed.data;

  // Своя личность живого голоса не должна стирать правила вызова инструментов
  // (lib/liveVoicePromptGuard.ts). Пустая строка и копия стандартного текста — это
  // «вернуть стандартный», их не проверяем: стандартный текст правила несёт сам.
  if (
    pair.liveVoicePrompt !== undefined &&
    pair.liveVoicePrompt.trim() &&
    pair.liveVoicePrompt.trim() !== DEFAULT_LIVE_VOICE_PROMPT.trim()
  ) {
    const toolRulesError = liveVoicePromptToolRulesError(pair.liveVoicePrompt);
    if (toolRulesError) return res.status(400).json({ error: toolRulesError });
  }

  /**
   * СОТРУДНИК В ПОЛЯХ «ДЕЖУРНЫЙ ОПЕРАТОР / МОНТАЖЁР / ДЕЖУРНЫЕ ПО ВХОДЯЩИМ /
   * МОДЕРАТОР ВИДЕО / КОНСУЛЬТАНТ НА ТЕЛЕФОНЕ» ОБЯЗАН ЕЩЁ РАБОТАТЬ (ночная
   * проверка 24.09.2026, М12-в, решение владельца: проверять — раньше
   * комментарий у incomingDutyAgentIds прямо говорил, что несуществующий/
   * уволенный id это «agent_not_found» в журнале входящих, а не отказ здесь;
   * тем же путём молча принимались и остальные четыре поля).
   *
   * Найден целый класс («нашёл баг — ищи весь класс», CLAUDE.md), а не только
   * первые три поля: videoModeratorAgentId и liveVoiceTransferAgentId — та же
   * ссылка на сотрудника той же формы (`z.string().max(64).nullable()`), без
   * своей защиты от сохранения id уволенного/замороженного. Добавлены той же
   * правкой (25.09.2026), отдельным коммитом.
   *
   * Один запрос на все пять полей разом (класс «N+1», CLAUDE.md) — id может
   * повторяться (например, монтажёр и дежурный по входящим — один человек).
   */
  const agentIdsToCheck = new Set<string>();
  if (pair.callbackOperatorAgentId) agentIdsToCheck.add(pair.callbackOperatorAgentId);
  if (pair.videoMontajerAgentId) agentIdsToCheck.add(pair.videoMontajerAgentId);
  if (pair.videoModeratorAgentId) agentIdsToCheck.add(pair.videoModeratorAgentId);
  if (pair.liveVoiceTransferAgentId) agentIdsToCheck.add(pair.liveVoiceTransferAgentId);
  for (const id of pair.incomingDutyAgentIds ?? []) agentIdsToCheck.add(id);
  if (agentIdsToCheck.size > 0) {
    const found = await prisma.agent.findMany({
      where: { id: { in: [...agentIdsToCheck] } },
      select: { id: true, fullName: true, isActive: true, frozenAt: true, telegramChatId: true },
    });
    const byId = new Map(found.map((a) => [a.id, a]));
    const agentProblem = (id: string): string | null => {
      const agent = byId.get(id);
      if (!agent) return "Сотрудник не найден — выберите другого";
      if (!agent.isActive) return `Сотрудник «${agent.fullName}» уволен — выберите другого`;
      if (agent.frozenAt) return `Сотрудник «${agent.fullName}» заморожен — выберите другого`;
      return null;
    };
    if (pair.callbackOperatorAgentId) {
      const problem = agentProblem(pair.callbackOperatorAgentId);
      if (problem) return res.status(400).json({ error: problem });
    }
    if (pair.videoMontajerAgentId) {
      const problem = agentProblem(pair.videoMontajerAgentId);
      if (problem) return res.status(400).json({ error: problem });
      // Монтажёр ещё и обязан иметь привязанный Telegram (25.09.2026, А5, с main):
      // без личного чата очередь роликов копится молча — dispatchToEditor честно
      // логирует «нет Telegram», но в Настройках об этом никто не узнаёт заранее.
      if (!byId.get(pair.videoMontajerAgentId)?.telegramChatId) {
        return res
          .status(400)
          .json({ error: "У сотрудника не привязан Telegram — монтажёр не сможет получать ролики." });
      }
    }
    if (pair.videoModeratorAgentId) {
      const problem = agentProblem(pair.videoModeratorAgentId);
      if (problem) return res.status(400).json({ error: problem });
    }
    if (pair.liveVoiceTransferAgentId) {
      const problem = agentProblem(pair.liveVoiceTransferAgentId);
      if (problem) return res.status(400).json({ error: problem });
    }
    for (const id of pair.incomingDutyAgentIds ?? []) {
      const problem = agentProblem(id);
      if (problem) return res.status(400).json({ error: problem });
    }
  }

  // Пауза и окно напоминаний — пары полей, и приходить они могут по одному.
  // Проверять их поштучно бессмысленно: сломанной оказывается сама пара
  // (потолок ниже паузы — бот отвечает раньше, чем дождался; конец окна раньше
  // начала — напоминание не уходит никогда). Поэтому сверяем с тем, что уже в базе.
  if (
    pair.botReplyDelaySec !== undefined ||
    pair.botReplyMaxWaitSec !== undefined ||
    pair.followUpWindowStart !== undefined ||
    pair.followUpWindowEnd !== undefined
  ) {
    const current = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: {
        botReplyDelaySec: true,
        botReplyMaxWaitSec: true,
        followUpWindowStart: true,
        followUpWindowEnd: true,
      },
    });
    const delay = pair.botReplyDelaySec ?? current?.botReplyDelaySec ?? 25;
    const maxWait = pair.botReplyMaxWaitSec ?? current?.botReplyMaxWaitSec ?? 90;
    if (maxWait < delay) {
      return res.status(400).json({ error: "Потолок ожидания не может быть меньше паузы перед ответом" });
    }
    const windowStart = pair.followUpWindowStart ?? current?.followUpWindowStart ?? "08:00";
    const windowEnd = pair.followUpWindowEnd ?? current?.followUpWindowEnd ?? "20:00";
    if (windowEnd <= windowStart) {
      return res.status(400).json({ error: "Конец окна напоминаний должен быть позже начала" });
    }
  }

  // Окно публикаций — та же пара, и «с 21:00 до 09:00» выглядит как опечатка, а
  // ведёт себя как поломка: расстановка переносила бы каждый ролик на завтра, и
  // так по кругу. В самой схеме это не проверить — форма шлёт только изменённое
  // поле, и по одному числу разницы не видно. Умолчания здесь — те же, что у
  // колонок в схеме (540 и 1260, см. lib/publishSchedule.ts).
  if (pair.publishScheduleWindowStartMin !== undefined || pair.publishScheduleWindowEndMin !== undefined) {
    const currentPublish = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { publishScheduleWindowStartMin: true, publishScheduleWindowEndMin: true },
    });
    const startMin = pair.publishScheduleWindowStartMin ?? currentPublish?.publishScheduleWindowStartMin ?? 540;
    const endMin = pair.publishScheduleWindowEndMin ?? currentPublish?.publishScheduleWindowEndMin ?? 1260;
    if (endMin <= startMin) {
      return res.status(400).json({ error: "Конец окна публикаций должен быть позже начала" });
    }
  }

  // Сроки бездействия — тоже пара, и сломанной оказывается именно она: штраф раньше
  // предупреждения означает, что предупреждать уже некогда, а вся суть правила была
  // в том, чтобы не наказывать за то, о чём человека не предупредили. Сверяем с тем,
  // что уже в базе: поля могут прийти по одному.
  if (pair.inactivityWarnAfterDays !== undefined || pair.inactivityPenaltyAfterDays !== undefined) {
    const currentDays = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { inactivityWarnAfterDays: true, inactivityPenaltyAfterDays: true },
    });
    const warnDays = pair.inactivityWarnAfterDays ?? currentDays?.inactivityWarnAfterDays ?? 3;
    const penaltyDays = pair.inactivityPenaltyAfterDays ?? currentDays?.inactivityPenaltyAfterDays ?? 5;
    if (penaltyDays <= warnDays) {
      return res.status(400).json({ error: "Штраф должен наступать позже предупреждения — иначе предупреждать некогда" });
    }
  }

  // Дневное окно «Итога объекта»: конец позже начала. Иначе окно не наступает
  // никогда, и требование тихо копится, ни разу не показавшись человеку.
  if (pair.propertySummaryWindowStart !== undefined || pair.propertySummaryWindowEnd !== undefined) {
    const currentWindow = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { propertySummaryWindowStart: true, propertySummaryWindowEnd: true },
    });
    const start = pair.propertySummaryWindowStart ?? currentWindow?.propertySummaryWindowStart ?? "10:00";
    const end = pair.propertySummaryWindowEnd ?? currentWindow?.propertySummaryWindowEnd ?? "15:00";
    if (end <= start) {
      return res.status(400).json({ error: "Конец окна «Итога объекта» должен быть позже начала" });
    }
  }

  // «Бот на паузе и забыли»: автоснятие обязано быть позже предупреждения,
  // иначе бот снял бы паузу раньше, чем агент вообще узнал о ней. Колонки не в
  // типизированном клиенте (миграция руками, см. destructure ниже) — читаем
  // через $queryRaw, как и всё остальное про эти два поля.
  if (pair.botPauseAlertHours !== undefined || pair.botPauseEscalateHours !== undefined) {
    const rows = await prisma.$queryRaw<{ botPauseAlertHours: number; botPauseEscalateHours: number }[]>`
      SELECT "botPauseAlertHours", "botPauseEscalateHours" FROM "Settings" WHERE id = 'singleton'
    `;
    const alertH = pair.botPauseAlertHours ?? rows[0]?.botPauseAlertHours ?? 24;
    const escalateH = pair.botPauseEscalateHours ?? rows[0]?.botPauseEscalateHours ?? 72;
    if (escalateH <= alertH) {
      return res.status(400).json({ error: "Автоснятие паузы должно наступать позже предупреждения агенту" });
    }
  }

  // Рабочие часы и часы тревог: начало = конец — окно нулевой длины, и
  // isWithinDushanbeWindow читает его как «никогда» (G8, 02.10.2026). Директор,
  // поставивший «00:00–00:00» ради «круглосуточно», молча останавливал раздачу
  // лидов: заявки ложились в очередь без агента, утренняя волна не наступала.
  // Окно через полночь («22:00–08:00») — законное и проходит. Пороги «продавец
  // без объекта» — та же пара: красная метка раньше напоминания бессмысленна.
  if (
    pair.workHoursStart !== undefined ||
    pair.workHoursEnd !== undefined ||
    pair.alarmHoursStart !== undefined ||
    pair.alarmHoursEnd !== undefined ||
    pair.incomingNightStart !== undefined ||
    pair.incomingNightEnd !== undefined ||
    pair.sellerPropertyMissingWarnDays !== undefined ||
    pair.sellerPropertyMissingCriticalDays !== undefined
  ) {
    const currentHours = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: {
        workHoursStart: true,
        workHoursEnd: true,
        alarmHoursStart: true,
        alarmHoursEnd: true,
        incomingNightStart: true,
        incomingNightEnd: true,
        sellerPropertyMissingWarnDays: true,
        sellerPropertyMissingCriticalDays: true,
      },
    });
    const workStart = pair.workHoursStart ?? currentHours?.workHoursStart ?? "09:30";
    const workEnd = pair.workHoursEnd ?? currentHours?.workHoursEnd ?? "18:00";
    if (workStart === workEnd) {
      return res.status(400).json({ error: "Начало и конец рабочих часов совпадают — раздача заявок не начнётся никогда" });
    }
    const alarmStart = pair.alarmHoursStart ?? currentHours?.alarmHoursStart;
    const alarmEnd = pair.alarmHoursEnd ?? currentHours?.alarmHoursEnd;
    if (alarmStart !== undefined && alarmStart === alarmEnd) {
      return res.status(400).json({ error: "Начало и конец часов тревог совпадают — тревоги не будут приходить никогда" });
    }
    // Ночное окно входящих (03.10.2026): станция читает «начало = конец» как сутки
    // целиком, CRM — как «никогда»; семантику не меняем, такую пару просто не принимаем.
    const nightStart = pair.incomingNightStart ?? currentHours?.incomingNightStart;
    const nightEnd = pair.incomingNightEnd ?? currentHours?.incomingNightEnd;
    if (nightStart !== undefined && nightStart === nightEnd) {
      return res.status(400).json({ error: "Начало и конец ночного окна совпадают — станция и CRM читают такое окно по-разному, задайте разные время начала и конца" });
    }
    const warnDays = pair.sellerPropertyMissingWarnDays ?? currentHours?.sellerPropertyMissingWarnDays ?? 3;
    const criticalDays = pair.sellerPropertyMissingCriticalDays ?? currentHours?.sellerPropertyMissingCriticalDays ?? 5;
    if (criticalDays <= warnDays) {
      return res.status(400).json({ error: "Красная метка «объекта нет» должна наступать позже напоминания агенту" });
    }
  }

  const {
    geminiApiKey,
    geminiApiKey2,
    geminiApiKeysExtra,
    botSystemPrompt,
    botCommentPrompt,
    reelsCaptionTemplates,
    instagramCollaborators,
    liveVoicePrompt,
    usdToTjsRate,
    metaAppSecret,
    metaVerifyToken,
    metaWaToken,
    metaIgToken,
    metaIgManageToken,
    metaIgAppSecret,
    metaPageToken,
    metaAdsToken,
    asteriskAriPassword,
    asteriskAmiPassword,
    youtubeClientSecret,
    youtubeRefreshToken,
    tiktokClientSecret,
    threadsAppSecret,
    elevenLabsApiKey,
    // Пачка 17 (12.09.2026): «бот на паузе и забыли». Вынесены из ...rest
    // нарочно — колонки добавлены миграцией руками (см. prisma/migrations/
    // 20260912100000_bot_pause_watch), а типизированный клиент их не знает,
    // пока сборщик не прогонит `prisma generate`. Пишутся отдельным
    // $executeRaw ниже, чтобы не тянуть в prisma.settings.upsert поля,
    // которых текущий клиент не видит.
    botPauseWatchEnabled,
    botPauseAlertHours,
    botPauseEscalateHours,
    ...rest
  } = parsed.data;

  /**
   * ДОПОЛНИТЕЛЬНЫЕ КЛЮЧИ GEMINI: пришёл полный новый список, собираем из него список
   * шифротекстов для базы.
   *
   * Уже сохранённый ключ приходит ссылкой `keep:<номер>` — его шифротекст берётся из
   * действующей строки настроек и не переживает круг «сервер → браузер → сервер»
   * вовсе. Всё остальное считается новым ключом и шифруется здесь же, ровно как
   * geminiApiKey строчкой ниже.
   */
  let geminiExtraKeysData: string[] | undefined;
  if (geminiApiKeysExtra !== undefined) {
    const currentExtra = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { geminiApiKeysExtra: true },
    });
    const stored = currentExtra?.geminiApiKeysExtra ?? [];
    const next: string[] = [];
    for (const item of geminiApiKeysExtra) {
      const value = item.trim();
      if (!value) continue; // пустое поле в форме — не ошибка, просто нечего сохранять
      const keep = KEEP_EXISTING_GEMINI_KEY.exec(value);
      if (keep) {
        const kept = stored[Number(keep[1])];
        if (kept) next.push(kept);
        continue;
      }
      // Маска вместо ключа — отказ, а не тихая запись и не тихий пропуск: записать
      // её значит убить ИИ незаметно, а молча выбросить — потерять рабочий ключ,
      // о чём владелец узнал бы только в день отказа основного.
      if (value.startsWith("••••")) {
        return res.status(400).json({ error: "В списке дополнительных ключей пришла маска вместо самого ключа" });
      }
      next.push(encryptSecret(value));
    }
    geminiExtraKeysData = next;
  }

  const data = {
    ...rest,
    // Ключа Claude здесь больше нет (владелец 20.08.2026): второго поставщика в CRM
    // не осталось. Сама колонка в базе не удаляется — удаление необратимо, а
    // хранящееся в ней значение никому не мешает и никем не читается.
    ...(geminiApiKey !== undefined ? { geminiApiKey: geminiApiKey ? encryptSecret(geminiApiKey) : null } : {}),
    ...(geminiApiKey2 !== undefined ? { geminiApiKey2: geminiApiKey2 ? encryptSecret(geminiApiKey2) : null } : {}),
    ...(geminiExtraKeysData !== undefined ? { geminiApiKeysExtra: geminiExtraKeysData } : {}),
    // Ключи Meta шифруются так же, как ключи ИИ: в базе они не должны лежать открыто.
    ...(metaAppSecret !== undefined ? { metaAppSecret: metaAppSecret ? encryptSecret(metaAppSecret) : null } : {}),
    ...(metaVerifyToken !== undefined ? { metaVerifyToken: metaVerifyToken ? encryptSecret(metaVerifyToken) : null } : {}),
    ...(metaWaToken !== undefined ? { metaWaToken: metaWaToken ? encryptSecret(metaWaToken) : null } : {}),
    ...(metaIgToken !== undefined ? { metaIgToken: metaIgToken ? encryptSecret(metaIgToken) : null } : {}),
    ...(metaIgManageToken !== undefined ? { metaIgManageToken: metaIgManageToken ? encryptSecret(metaIgManageToken) : null } : {}),
    ...(metaIgAppSecret !== undefined ? { metaIgAppSecret: metaIgAppSecret ? encryptSecret(metaIgAppSecret) : null } : {}),
    ...(metaPageToken !== undefined ? { metaPageToken: metaPageToken ? encryptSecret(metaPageToken) : null } : {}),
    // Маркер рекламного кабинета. Смена маркера обнуляет отметку продления: иначе
    // фоновое продление считало бы свежий маркер старым и полезло бы менять его в
    // первый же час.
    ...(metaAdsToken !== undefined
      ? {
          metaAdsToken: metaAdsToken ? encryptSecret(metaAdsToken) : null,
          metaAdsTokenRefreshedAt: metaAdsToken ? new Date() : null,
        }
      : {}),
    // YouTube Shorts (31.08.2026) — тем же приёмом: секреты шифруются, clientId
    // не секрет и уходит через ...rest как есть.
    ...(youtubeClientSecret !== undefined
      ? { youtubeClientSecret: youtubeClientSecret ? encryptSecret(youtubeClientSecret) : null }
      : {}),
    ...(youtubeRefreshToken !== undefined
      ? { youtubeRefreshToken: youtubeRefreshToken ? encryptSecret(youtubeRefreshToken) : null }
      : {}),
    // TikTok — тем же приёмом. refreshToken сюда не попадает (см. Zod-схему выше).
    ...(tiktokClientSecret !== undefined
      ? { tiktokClientSecret: tiktokClientSecret ? encryptSecret(tiktokClientSecret) : null }
      : {}),
    // Threads — тем же приёмом. accessToken сюда не попадает (см. Zod-схему
    // выше — его пишет только OAuth callback).
    ...(threadsAppSecret !== undefined
      ? { threadsAppSecret: threadsAppSecret ? encryptSecret(threadsAppSecret) : null }
      : {}),
    ...(asteriskAriPassword !== undefined
      ? { asteriskAriPassword: asteriskAriPassword ? encryptSecret(asteriskAriPassword) : null }
      : {}),
    ...(asteriskAmiPassword !== undefined
      ? { asteriskAmiPassword: asteriskAmiPassword ? encryptSecret(asteriskAmiPassword) : null }
      : {}),
    // Ключ ElevenLabs (02.10.2026) — шифруется так же, как ключи Gemini.
    ...(elevenLabsApiKey !== undefined
      ? { elevenLabsApiKey: elevenLabsApiKey ? encryptSecret(elevenLabsApiKey) : null }
      : {}),
    // Пустая строка → null: возвращаемся на дефолтную «личность» из кода.
    // Текст, СОВПАДАЮЩИЙ с дефолтом, — тоже null, и это не мелочь. Форма показывает
    // действующий текст, поэтому «открыл вкладку и нажал Сохранить, ничего не меняя»
    // записывало дефолт копией и замораживало его навсегда: все последующие правки в
    // коде переставали действовать молча, а по бейджу «изменён» отличить это от
    // настоящей правки было нельзя. Ровно так прод две недели работал по тексту от
    // 1 августа. Копия — не выбор владельца, а промах мимо кнопки.
    ...(botSystemPrompt !== undefined
      ? {
          botSystemPrompt:
            botSystemPrompt.trim() && botSystemPrompt.trim() !== DEFAULT_BOT_PERSONA.trim() ? botSystemPrompt : null,
        }
      : {}),
    // И у промта комментариев: пусто → null → бот берёт зашитый по умолчанию.
    // Хранить пустую строку нельзя — она означала бы «отвечай без инструкций».
    // Копия стандартного текста — тоже null (24.09.2026): та же ловушка, что у
    // личности бота выше, и защиты от неё у этого поля не было.
    ...(botCommentPrompt !== undefined
      ? {
          botCommentPrompt:
            botCommentPrompt.trim() && botCommentPrompt.trim() !== DEFAULT_COMMENT_PROMPT.trim()
              ? botCommentPrompt
              : null,
        }
      : {}),
    // И у личности живого голоса — та же защита от «сохранил копию дефолта и
    // заморозил его навсегда» (см. комментарий у botSystemPrompt выше).
    ...(liveVoicePrompt !== undefined
      ? {
          liveVoicePrompt:
            liveVoicePrompt.trim() && liveVoicePrompt.trim() !== DEFAULT_LIVE_VOICE_PROMPT.trim()
              ? liveVoicePrompt
              : null,
        }
      : {}),
    // Пусто → null → зашитые по умолчанию четыре шаблона (см. lib/reelsCaptionTemplate.ts).
    ...(reelsCaptionTemplates !== undefined
      ? { reelsCaptionTemplates: reelsCaptionTemplates.trim() ? reelsCaptionTemplates : null }
      : {}),
    // Соавторы Instagram (26.09.2026) — пусто/null → без соавторов по умолчанию,
    // как было до этого поля (см. lib/instagramCollaborators.ts).
    ...(instagramCollaborators !== undefined
      ? { instagramCollaborators: instagramCollaborators && instagramCollaborators.length > 0 ? instagramCollaborators : null }
      : {}),
    // Ручная правка курса — помечаем источник, чтобы в интерфейсе было видно,
    // что это не официальный курс с alif.tj (тот перезапишет её следующим циклом cron).
    ...(usdToTjsRate !== undefined
      ? { usdToTjsRate, usdToTjsRateUpdatedAt: new Date(), usdToTjsRateSource: "manual" }
      : {}),
  };

  /**
   * ТОЧКА ВОЗВРАТА СНИМАЕТСЯ ДО ЗАПИСИ, А НЕ ПОСЛЕ.
   *
   * Журнал действий для отката не годится: он пишет только ИМЕНА изменённых полей
   * и намеренно не пишет значения (там секреты) — прежнего состояния в системе не
   * было нигде. Поэтому перед каждым сохранением сюда кладётся полная копия строки
   * Settings, как она выглядела ДО правки (секреты — в том же зашифрованном виде).
   * Подробности и срок хранения — в lib/settingsSnapshots.ts.
   *
   * Сбой снимка не отменяет сохранение: владелец просил изменить настройку, и
   * отказ ради страховочной копии был бы отказом в самой работе. Но и молча
   * пропасть он не может — уходит в журнал ошибок.
   */
  const actor = await prisma.agent.findUnique({
    where: { id: req.agent?.id ?? "" },
    select: { fullName: true },
  });
  try {
    await captureSettingsSnapshot({
      agentId: req.agent?.id ?? null,
      agentName: actor?.fullName ?? "Неизвестно",
      reason: "update",
      nextData: data,
    });
  } catch (err) {
    await logSystemError(
      "api",
      `Точка возврата настроек не снялась: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Смена монтажёра (B4, 23.09.2026) — старое значение нужно ДО upsert: после
  // него в базе уже новое, а сравнивать не с чем.
  const previousMontajerAgentId =
    pair.videoMontajerAgentId !== undefined
      ? (
          await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } })
        )?.videoMontajerAgentId ?? null
      : undefined;

  const settings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: data,
    create: { id: "singleton", ...data },
  });

  /**
   * СМЕНА МОНТАЖЁРА ПРИ ОБЪЕКТЕ НА РУКАХ (23.09.2026, находка B4; переписано
   * 25.09.2026, А1). До 23.09 смена монтажёра, пока объект уже отправлен
   * старому (EDITOR_HOLDER_WHERE), никому ничего не доставляла. 23.09 это
   * починили, но `await dispatchToEditor(...)` стоял прямо в PATCH — запрос
   * висел МИНУТЫ на тяжёлых исходниках (владелец ждал «сохранено» до конца
   * пересылки), а пауза очереди никак не учитывалась.
   *
   * Теперь PATCH: (1) сообщает старому монтажёру «передан другому» — короткое
   * текстовое сообщение, дожидаемся (это быстро, отказ Telegram не должен
   * ломать сохранение — try/catch); (2) запускает передачу держателя новому
   * монтажёру через dispatchInBackground — тот же путь, что у
   * releaseQueueIfClear, отвечает сразу, тяжёлые файлы идут ПОСЛЕ ответа.
   * Пауза очереди НЕ мешает именно этой передаче: держатель места уже в
   * работе, его не заново выдают из очереди — пауза останавливает только
   * выдачу СЛЕДУЮЩЕГО.
   */
  if (previousMontajerAgentId !== undefined && pair.videoMontajerAgentId !== previousMontajerAgentId) {
    const holder = await prisma.property.findFirst({
      where: EDITOR_HOLDER_WHERE,
      select: { id: true, shortId: true },
    });
    if (holder) {
      const newMontajerId = pair.videoMontajerAgentId ?? null;
      if (newMontajerId) {
        // Старому — короткое сообщение, дожидаемся (это быстро). Только когда
        // РЕАЛЬНО передаём новому: снятие (null) старого не уведомляет — тем же
        // поведением, что было до 25.09.2026 (нет адресата, которому «передан»).
        if (previousMontajerAgentId) {
          try {
            const oldMontajer = await prisma.agent.findUnique({
              where: { id: previousMontajerAgentId },
              select: { telegramChatId: true },
            });
            if (oldMontajer?.telegramChatId) {
              await sendToMontajer(oldMontajer.telegramChatId, `Объект №${holder.shortId} передан другому монтажёру.`, {
                copy: true,
                propertyShortId: holder.shortId,
              });
            }
          } catch {
            // best effort — молчание старого монтажёра не должно ломать сохранение настройки.
          }
        }
        dispatchInBackground(holder.id, newMontajerId);
      } else {
        // Монтажёра сняли (null) — слать некому, только след в журнале: объект
        // держит место монтажёра и ждёт назначения (владелец увидит в тревогах).
        void logSystemError("video-handoff", `Монтажёра сняли в Настройках — объект №${holder.shortId} ждёт назначения нового`);
      }
    }
  }

  /**
   * ОДИН ИСТОЧНИК ТОКЕНА INSTAGRAM (ОБ-000113, решение владельца 21.09.2026) —
   * пишущая половина, см. messengers/meta.ts::loadDefaultInstagramAccountToken
   * для читающей. Если аккаунт Instagram по умолчанию уже заведён в Настройки →
   * Каналы, публикация читает ЕГО маркер, а этот экран правил бы только запасной
   * (`Settings.metaIgToken`) — владелец вписал бы новый токен сюда и решил бы,
   * что починил публикацию, а она продолжала бы ходить старым. Держим оба поля
   * в одном значении: сюда же уходит то, что владелец только что ввёл.
   *
   * Не создаём аккаунт заново — только обновляем СУЩЕСТВУЮЩИЙ по умолчанию: без
   * заведённого accountId (externalId, промт) свежая запись была бы неполной и
   * не нашлась бы по входящему. Нет аккаунта — прежнее поведение (только Settings).
   */
  if (metaIgToken !== undefined && metaIgToken.trim()) {
    try {
      const defaultAccount = await prisma.messengerAccount.findFirst({
        where: { channel: "INSTAGRAM", isDefault: true },
      });
      if (defaultAccount) {
        await prisma.messengerAccount.update({
          where: { id: defaultAccount.id },
          data: { token: encryptSecret(metaIgToken.trim()) },
        });
        resetAccountsCache();
        resetMetaAccountCredsCache();
      }
    } catch (err) {
      await logSystemError(
        "meta",
        `Маркер Instagram сохранён в Настройках, но не продублирован в аккаунт по умолчанию (Настройки → Каналы) — публикация может продолжить работать старым токеном: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  // «Бот на паузе и забыли»: та же причина, что у деструктуризации выше — колонки
  // не в типизированном клиенте, пишем раздельным $executeRaw. COALESCE оставляет
  // нетронутым то, что не прислали в этом PATCH.
  if (botPauseWatchEnabled !== undefined || botPauseAlertHours !== undefined || botPauseEscalateHours !== undefined) {
    await prisma.$executeRaw`
      UPDATE "Settings" SET
        "botPauseWatchEnabled" = COALESCE(${botPauseWatchEnabled ?? null}, "botPauseWatchEnabled"),
        "botPauseAlertHours" = COALESCE(${botPauseAlertHours ?? null}, "botPauseAlertHours"),
        "botPauseEscalateHours" = COALESCE(${botPauseEscalateHours ?? null}, "botPauseEscalateHours")
      WHERE id = 'singleton'
    `;
  }

  /**
   * Телефония подхватывает настройки сразу, а не «когда-нибудь», и правило «если
   * оператор не ответил» уезжает на станцию — оба действия описаны и выполняются
   * в lib/settingsSideEffects.ts. Вынесены туда потому, что путей сохранения стало
   * два: этот и возврат к точке восстановления, и откат обязан делать то же самое.
   */
  applySettingsSideEffects(Object.keys(parsed.data));
  // В журнал — какие ключи меняли, без значений секретов.
  logAudit(req, "SETTINGS_UPDATE", "Settings", "singleton", {
    fields: Object.keys(parsed.data),
    ...(rest.leadDistributionStrategy !== undefined ? { leadDistributionStrategy: rest.leadDistributionStrategy } : {}),
    ...(rest.botEnabled !== undefined ? { botEnabled: rest.botEnabled } : {}),
    ...(rest.passkeyLoginEnabled !== undefined ? { passkeyLoginEnabled: rest.passkeyLoginEnabled } : {}),
    // Замолчавший канал выглядит как поломка («бот не отвечает в Instagram»), и
    // первым делом надо видеть, что его просто выключили — и кто именно.
    ...(rest.botWhatsappEnabled !== undefined ? { botWhatsappEnabled: rest.botWhatsappEnabled } : {}),
    ...(rest.botInstagramEnabled !== undefined ? { botInstagramEnabled: rest.botInstagramEnabled } : {}),
    ...(rest.botFacebookEnabled !== undefined ? { botFacebookEnabled: rest.botFacebookEnabled } : {}),
    ...(rest.botTelegramEnabled !== undefined ? { botTelegramEnabled: rest.botTelegramEnabled } : {}),
    ...(rest.botWebsiteChatEnabled !== undefined ? { botWebsiteChatEnabled: rest.botWebsiteChatEnabled } : {}),
    // Момент включения и выключения сравнения — граница, за которой поведение бота
    // с клиентами меняется. Без отметки в журнале потом не понять, почему часть
    // диалогов шла на одной манере, а часть на другой.
    ...(rest.salesScenarioTestEnabled !== undefined
      ? { salesScenarioTestEnabled: rest.salesScenarioTestEnabled }
      : {}),
    // Отключение транспорта обрывает связь с клиентами в Instagram и WhatsApp —
    // в журнале действий должно быть видно, кто и когда это сделал.
    ...(rest.metaEnabled !== undefined ? { metaEnabled: rest.metaEnabled } : {}),
    // Смена весов KPI меняет и рейтинг, и распределение лидов — в журнале
    // должно быть видно, кто и когда её сделал.
    ...(rest.kpiWeights !== undefined ? { kpiWeights: rest.kpiWeights } : {}),
    // Веса стадий меняют прогноз денег, который видит руководство, — в журнале
    // должно быть видно, кто и когда их правил.
    ...(rest.dealStageWinProbability !== undefined
      ? { dealStageWinProbability: rest.dealStageWinProbability }
      : {}),
    // Правка цены события, окна или стартового счёта меняет Royal Score всех
    // агентов задним числом (пересчёт берёт настройки на момент расчёта, не
    // на момент события) — кто и когда это сделал, обязано быть в журнале.
    // Рубильник модуля целиком — событие уровня «остановили начисления и показ
    // счёта всем агентам», обязано быть видно поимённо в журнале.
    ...(rest.royalScoreEnabled !== undefined ? { royalScoreEnabled: rest.royalScoreEnabled } : {}),
    ...(rest.royalScoreEventPoints !== undefined ? { royalScoreEventPoints: rest.royalScoreEventPoints } : {}),
    ...(rest.royalScoreWindowDays !== undefined ? { royalScoreWindowDays: rest.royalScoreWindowDays } : {}),
    ...(rest.royalScoreStartingScore !== undefined ? { royalScoreStartingScore: rest.royalScoreStartingScore } : {}),
    // Ослабление защиты ключей обязано быть видно поимённо: удлинение окна
    // подтверждения — единственная настройка здесь, которая делает систему менее
    // защищённой, а не более удобной.
    ...(rest.stepUpMinutes !== undefined ? { stepUpMinutes: rest.stepUpMinutes } : {}),
    // Общие выходные меняют тревоги, штрафы и обещания ботов всей компании — в журнале
    // должно быть видно, кто и какие дни поставил (11.10.2026).
    ...(rest.companyDaysOff !== undefined ? { companyDaysOff: rest.companyDaysOff } : {}),
  });

  // Маркер рекламного кабинета из Graph API Explorer живёт час-два — меняем его на
  // 60-дневный прямо здесь, пока владелец ещё на экране. Молча: провал обмена не
  // отменяет сохранение (см. upgradeStoredAdsToken), а сам факт уходит в журнал.
  if (metaAdsToken) {
    const upgraded = await upgradeStoredAdsToken(metaAdsToken);
    if (upgraded) {
      const refreshed = await prisma.settings.findUnique({ where: { id: "singleton" } });
      if (refreshed) return res.json(privateSettingsResponse(await publicSettingsResponse(refreshed), req.agent?.role));
    }
  }

  // Маркер удаления Instagram и маркер Страницы из Graph API Explorer тоже живут час-два:
  // меняем на 60-дневный сразу (бессрочные маркеры не трогаем - решает lib/metaUserTokenRefresh.ts).
  let upgradedMetaToken = false;
  if (metaIgManageToken) upgradedMetaToken = (await upgradeStoredMetaUserToken("metaIgManageToken")) || upgradedMetaToken;
  if (metaPageToken) upgradedMetaToken = (await upgradeStoredMetaUserToken("metaPageToken")) || upgradedMetaToken;
  if (upgradedMetaToken) {
    const refreshed = await prisma.settings.findUnique({ where: { id: "singleton" } });
    if (refreshed) return res.json(privateSettingsResponse(await publicSettingsResponse(refreshed), req.agent?.role));
  }

  res.json(privateSettingsResponse(await publicSettingsResponse(settings), req.agent?.role));
});

/** Ручное обновление курса USD→TJS с alif.tj по кнопке в Настройках — та же логика,
 * что и ночной cron (см. lib/exchangeRate.ts), просто по требованию. Код ответа при
 * сбое — 400, не 502/503: Cloudflare подменяет тело таких статусов своей типовой
 * страницей, и понятная причина ошибки до интерфейса не доходила (см. bulk-sync). */
settingsRouter.post("/exchange-rate/refresh", requireAuth, requirePermission("settings.manage"), requireElevation, async (req, res) => {
  const result = await refreshUsdToTjsRateFromAlif();
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }
  logAudit(req, "SETTINGS_UPDATE", "Settings", "singleton", { usdToTjsRate: result.rate, source: "alif-auto" });
  res.json({ rate: result.rate });
});

/** Проверка связи с Asterisk ARI (Этап 4) — сохранённые в Настройках креды, без
 *  сохранения новых: форма сперва сохраняет через PATCH, потом проверяет тут. */
/**
 * ЖИВАЯ ПРОВЕРКА МОДЕЛИ GEMINI — один настоящий вызов и честный HTTP-код обратно.
 *
 * Зачем отдельная кнопка. 22.08.2026 разбор одной строки журнала «основная модель
 * недоступна» занял полдня: за ней могли стоять перегрузка Google (503), кончившаяся
 * квота (429), закрытая модель (404) или мёртвый ключ (401) — четыре разные беды с
 * четырьмя разными лечениями, и ни одну нельзя было отличить, не написав скрипт и
 * не зайдя по SSH на прод. Владелец такого сделать не может в принципе.
 *
 * ОТДАЁМ КОД И ТЕКСТ GOOGLE, А НЕ СВОЙ ВЕРДИКТ. Наше «модель недоступна» — это ровно
 * та потеря сведений, из-за которой мёртвая модель прожила трое суток. Пусть на
 * экране будет `404: no longer available to new users`: эта фраза сама говорит,
 * что делать, и не устареет вместе с нашим словарём ошибок.
 *
 * ПРОВЕРЯЕМ ТЕМ ЖЕ ПУТЁМ, ЧТО И БОТ, — через прокси и теми же ключами по очереди.
 * Проверка, которая ходит другим маршрутом, отвечает на другой вопрос: у нас VPS
 * геоблокирован Google, и прямой вызов провалился бы там, где бот прекрасно работает.
 */
settingsRouter.post("/gemini-test", requireAuth, requirePermission("settings.manage"), requireElevation, async (req, res) => {
  const parsed = z
    .object({ model: z.string().max(80).regex(MODEL_NAME, MODEL_NAME_HINT) })
    .safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message ?? MODEL_NAME_HINT });
  }
  const runtime = await resolveGeminiRuntime();
  if (runtime.keys.length === 0) {
    return res.status(400).json({ ok: false, error: "Ключ Gemini не задан — сначала сохраните ключ" });
  }
  const result = await checkGeminiModel(parsed.data.model, runtime.keys);
  if (!result.ok) {
    // Кнопка ручной проверки показывает причину в самом ответе (result.detail),
    // но до 22.09.2026 она там и оставалась — в журнал ничего не попадало, и
    // «модель третий день не отвечает» видел только тот, кто догадался нажать
    // кнопку сам (тот же класс поломки, что чинили в checkGeminiHealth).
    void logSystemError(
      "ai",
      `Ручная проверка модели Gemini не прошла: модель ${parsed.data.model}, ответ Google ${result.status ?? "нет ответа"} — ${result.detail}`
    );
  }
  res.json(result);
});

/**
 * ПРОВЕРКА И ПОДГОТОВКА АГЕНТА ELEVENLABS (02.10.2026, живой голос через
 * ElevenLabs). Тем же путём, что и звонок: ключ из Настроек, тот же REST API.
 * Заводит у агента функции консультанта (поиск квартир, СМС, перевод агенту,
 * итог) и включает разрешения на подмену промта, первой фразы, языка и голоса —
 * чтобы первый настоящий звонок не тратил на это секунды. Ответ — имя агента и
 * сколько функций заведено; ключа в ответе нет.
 */
settingsRouter.post("/live-voice/elevenlabs-check", requireAuth, requirePermission("settings.manage"), requireElevation, async (_req, res) => {
  const row = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { elevenLabsApiKey: true, elevenLabsAgentId: true },
  });
  const apiKey = resolveElevenLabsKey(row?.elevenLabsApiKey);
  const agentId = row?.elevenLabsAgentId?.trim();
  if (!apiKey) return res.status(400).json({ ok: false, error: "Ключ ElevenLabs не задан — сначала сохраните ключ" });
  if (!agentId) return res.status(400).json({ ok: false, error: "Не указан id агента ElevenLabs" });
  try {
    const agent = await elevenLabsRequest<{ name?: string }>(apiKey, "GET", `/v1/convai/agents/${encodeURIComponent(agentId)}`);
    const tools = await syncElevenLabsAgent(apiKey, agentId, CONSULTANT_TOOLS);
    res.json({ ok: true, agentName: agent.name ?? null, toolsSynced: tools.size });
  } catch (err) {
    const detail = describeError(err);
    void logSystemError("telephony", `Проверка агента ElevenLabs не прошла: ${detail}`);
    res.json({ ok: false, error: detail });
  }
});

/**
 * ПРОВЕРКА СТАТИСТИКИ INSTAGRAM (21.09.2026). Владелец выпустил новый маркер с
 * правами на статистику, и единственный способ узнать, работают ли они, —
 * живой запрос ИЗ СЕРВЕРА: маркер лежит в базе зашифрованным, а с рабочего
 * места никто его не видит.
 *
 * Проверяется по очереди то, что ломается отдельно: сначала сам маркер
 * (`/me` — чей аккаунт), потом права на статистику (`online_followers`).
 * Иначе «не работает» одинаково выглядело бы и у чужого маркера, и у нехватки
 * прав. Возвращаются только имя аккаунта и числа по часам — самого маркера в
 * ответе нет.
 */
settingsRouter.post("/instagram-insights-test", requireAuth, requirePermission("settings.manage"), requireElevation, async (_req, res) => {
  const creds = await loadCredentials();
  if (!creds.igToken) {
    return res.status(400).json({ ok: false, error: "Маркер Instagram не сохранён в Настройках" });
  }

  /**
   * Чей это маркер, надо сказать вслух. `loadCredentials` берёт маркер ОСНОВНОГО
   * аккаунта из списка «Аккаунты Instagram», и только если такого нет — поле
   * «Маркер Instagram». Человек, вписавший новый маркер в поле при живом
   * основном аккаунте, проверяет не то, что вписал, и без этой строки решил бы,
   * что права не дошли.
   */
  const defaultAccount = await prisma.messengerAccount.findFirst({
    where: { channel: "INSTAGRAM", isDefault: true, enabled: true, token: { not: "" } },
    select: { title: true },
  });

  const identity = await instagramTokenIdentity(creds.igToken);
  if (!identity.ok) {
    return res.json({
      ok: false,
      stage: "token",
      source: defaultAccount?.title ?? null,
      error: `Маркер не читается: ${identity.error}`,
    });
  }

  const insights = await fetchOnlineFollowers(creds.igToken);
  const hours = Object.keys(insights.byHour).length;
  // Доступ есть — сразу забираем месяц часов в тепловую карту, не дожидаясь
  // ночного сбора: иначе после починки маркера карта пустовала бы до завтра.
  // Ответ кнопке не ждёт сбора; отказ сбора уходит в журнал ошибок.
  if (insights.ok) {
    void collectInstagramOnlineFollowers({ token: creds.igToken })
      .then((r) => {
        if (!r.ok) void logSystemError("meta", `Сбор «подписчики Instagram в сети» не удался: ${r.error}`);
      })
      .catch((err) =>
        logSystemError("meta", `Сбор «подписчики Instagram в сети» упал: ${err instanceof Error ? err.message : String(err)}`)
      );
  }
  res.json({
    ok: insights.ok,
    stage: insights.ok ? "insights" : "permissions",
    username: identity.username ?? null,
    source: defaultAccount?.title ?? null,
    hours,
    error: insights.error,
  });
});

settingsRouter.post("/asterisk-test", requireAuth, requirePermission("settings.manage"), requireElevation, async (_req, res) => {
  const creds = await loadAriCredentials();
  if (!creds) return res.status(400).json({ ok: false, error: "Сначала сохраните URL, логин и пароль ARI" });
  const result = await testAriConnection(creds);
  res.json(result);
});

/**
 * Проверка управления станцией (AMI) — и сразу перекладывание туда правила «если
 * оператор не ответил».
 *
 * Проверка и применение вместе намеренно: человек нажимает эту кнопку ровно затем,
 * чтобы убедиться, что настроенное работает. Разделять их означало бы «связь есть»
 * зелёной галочкой при правиле, которое до станции так и не доехало.
 */
settingsRouter.post("/asterisk-ami-test", requireAuth, requirePermission("settings.manage"), requireElevation, async (_req, res) => {
  const creds = await loadAmiCredentials();
  if (!creds) {
    return res.status(400).json({ ok: false, error: "Сначала сохраните адрес ARI, логин и пароль AMI" });
  }
  const connection = await testAmiConnection(creds);
  if (!connection.ok) return res.json({ ok: false, error: connection.error });

  const sync = await syncFailoverToStation(creds);
  if (!sync.ok) return res.json({ ok: false, error: `Связь есть, но настройка не записалась: ${sync.error}` });
  res.json({ ok: true, applied: sync.config });
});

/**
 * Исходящий тестовый звонок живого голоса (12.09.2026) — «бот сам звонит на
 * указанный номер», а не «дозвонись сам до тестового внутреннего номера».
 * Реализация — lib/telephony/liveVoiceBridge.ts:originateLiveVoiceTestCall.
 * За тем же step-up, что и остальная телефония: звонок реальный и платный.
 */
const liveVoiceTestCallSchema = z.object({ phone: z.string().trim().max(30) });

settingsRouter.post(
  "/live-voice-test-call",
  requireAuth,
  requirePermission("settings.manage"),
  requireElevation,
  async (req, res) => {
    const parsed = liveVoiceTestCallSchema.safeParse(req.body ?? {});
    const phone = parsed.success ? parsed.data.phone : "";
    if (!phone || !isDialableTajikNumber(phone)) {
      return res.status(400).json({ ok: false, error: "Не похоже на таджикский номер" });
    }
    // Проверочный звонок идёт на ЛЮБОЙ номер — поэтому след в журнале с самим
    // номером и суточный предел на сотрудника (02.10.2026, manualRobotCalls.ts).
    if (await manualRobotCallLimitReached(req.agent!.id)) {
      return res.status(429).json({ ok: false, error: MANUAL_ROBOT_CALL_LIMIT_ERROR });
    }
    const result = await originateLiveVoiceTestCall(phone);
    logAudit(req, "LIVE_VOICE_TEST_CALL", "Settings", "singleton", {
      // Маска, как у звонка по карточке (аудит роботов №16): журнал читают шире, чем
      // право на телефоны клиентов, а номер здесь может быть чей угодно.
      phone: maskClientPhone(phone),
      ok: result.ok,
      channelId: result.channelId ?? null,
      error: result.error?.slice(0, 300) ?? null,
    });
    res.json(result.error ? { ...result, error: liveVoiceErrorForPerson(result.error) } : result);
  }
);

/**
 * Прослушка голоса — живой платный сеанс Live API на каждое нажатие (02.10.2026).
 * Десять в минуту на сотрудника — с запасом для «послушать все голоса подряд»,
 * но не для зависшей вкладки или скрипта. Ключ — сотрудник, а не адрес: весь
 * офис выходит в сеть одним адресом (тот же приём, что в routes/ai.ts).
 */
const liveVoicePreviewLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `agent:${req.agent!.id}`,
  message: { error: "Слишком часто: прослушать голос можно не больше 10 раз в минуту, подождите" },
});

const liveVoicePreviewSchema = z.object({
  voice: z.string().min(1).max(40),
  language: z.enum(["ru", "tg"]).default("ru"),
});

/**
 * ПРОСЛУШАТЬ ГОЛОС ДО ЗВОНКА (13.09.2026, «полный контроль из админки»;
 * ПЕРЕДЕЛАНО 14.09.2026 — см. ниже). Разовый ответ в браузер, на диск станции
 * ничего не кладём.
 *
 * ДО 14.09.2026 здесь стоял обычный generateContent TTS (synthesizeSpeech,
 * ai/tts.ts) — ДРУГАЯ модель Gemini с ДРУГИМ, более коротким списком языков,
 * куда таджикский не входит вовсе (проверено вживую по документации Google,
 * ai.google.dev/gemini-api/docs/speech-generation). Итог: прослушка на
 * таджикском падала с ошибкой всегда, ключ был ни при чём, а подпись в
 * интерфейсе «звучит РОВНО тем же приветствием, с которого бот начинает
 * настоящий звонок» была неточной — движок был другой.
 *
 * Теперь — previewLiveVoiceGreeting (ai/liveVoiceClient.ts), та же связка
 * Live API, что у настоящего звонка (liveVoiceBridge.ts): та же системная
 * инструкция (buildLiveVoiceSystemPrompt), тот же приём "поздоровайся первым"
 * через LIVE_VOICE_GREETING_TRIGGER, тот же выбор голоса. Live API (в отличие
 * от generateContent TTS) официально поддерживает таджикский с сентября 2026.
 * Реплика больше не жёстко зашитая строка — это то, что модель реально
 * ответит на приветственный триггер, тем же образом, что в настоящем звонке.
 */
settingsRouter.post("/live-voice/preview-voice", requireAuth, requirePermission("settings.manage"), liveVoicePreviewLimiter, async (req, res) => {
  const parsed = liveVoicePreviewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверные параметры предпросмотра" });
  const { voice, language } = parsed.data;

  // Своя личность из Настроек (аудит роботов №5, 02.10.2026): на звонке по карточке
  // и на проверочном звонке её и слышат, а превью брало зашитый текст — владелец
  // менял тон, нажимал «Прослушать» и слышал прежнее. Консультант на входящих и
  // сценарные звонки её не берут (см. подпись в Настройках), превью их не заменяет.
  const stored = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { liveVoicePrompt: true } });
  const systemInstruction = buildLiveVoiceSystemPrompt(undefined, {
    roleOverride: stored?.liveVoicePrompt ?? null,
    forceRussianOnly: language !== "tg",
  });
  // Как на настоящем звонке (liveVoiceBridge.ts): правило рода от выбранного голоса — в
  // конец инструкции и напоминание в первую реплику. Без этого мужской голос на
  // «Прослушать» говорил о себе как попало, а на звонке — по правилу, и владелец,
  // выбирающий голос на слух, слышал не то, что услышит клиент (аудит 02.10.2026).
  const speech = await previewLiveVoiceGreeting({
    systemInstruction: withSelfGenderRule(systemInstruction, voice),
    voiceName: voice,
    greetingTrigger: withSelfGenderReminder(LIVE_VOICE_GREETING_TRIGGER, voice),
  });
  if (!speech) return res.status(502).json({ error: "Живой голос не ответил — подробности в «Здоровье системы»" });
  res.json({ text: speech.transcript, audioBase64: speech.audioBase64, sampleRateHz: speech.sampleRateHz });
});

/**
 * ПОСЛЕДНИЕ ЗВОНКИ ЖИВОГО ГОЛОСА (13.09.2026, владелец: «своей страницы для
 * записи и расшифровки нет вовсе», найдено на первом тестовом звонке). До сих
 * пор расшифровка была видна только в «Здоровье системы» вперемешку с прочими
 * системными ошибками — здесь то же самое, но отдельным списком и с ссылкой
 * на запись, если она есть (см. saveLiveVoiceRecording, liveVoiceBridge.ts).
 */
/*
 * ПРАВА НА РАЗГОВОРЫ РОБОТА (02.10.2026). Список несёт начало расшифровки, а
 * ссылка — сам звук разговора с клиентом. До этого хватало settings.manage, то
 * есть права настраивать бота, — мимо прав на звонки, которыми закрыты ВСЕ
 * остальные разговоры CRM (lib/callTranscripts.ts). Теперь те же двери: текст —
 * calls.transcripts, звук — ещё и calls.hearRecording (как canHearCall).
 * requirePermission с несколькими правами пускает по ЛЮБОМУ из них, поэтому
 * обязательные права стоят отдельными звеньями.
 */
const LIVE_VOICE_SESSIONS_DEFAULT = 30;
const LIVE_VOICE_SESSIONS_MAX = 100;
const liveVoiceSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(LIVE_VOICE_SESSIONS_MAX).default(LIVE_VOICE_SESSIONS_DEFAULT),
});

settingsRouter.get("/live-voice/sessions", requireAuth, requirePermission("settings.manage"), requirePermission("calls.transcripts"), async (req, res) => {
  // Предел выборки по запросу, но не больше сотни (аудит роботов №25): список несёт
  // начало расшифровки каждого разговора, без потолка он вырос бы вместе с базой.
  const query = liveVoiceSessionsQuerySchema.safeParse(req.query);
  if (!query.success) return res.status(400).json({ error: `Предел списка — от 1 до ${LIVE_VOICE_SESSIONS_MAX}` });
  const sessions = await prisma.liveVoiceSession.findMany({
    where: canViewInvestigations(req.agent?.role) ? {} : { investigationOnly: false, channelId: { notIn: await investigationCallChannelIds() } },
    orderBy: { startedAt: "desc" },
    take: query.data.limit,
    select: {
      id: true,
      channelId: true,
      clientId: true,
      startedAt: true,
      endedAt: true,
      endedReason: true,
      transcript: true,
      recordingUrl: true,
      direction: true,
      provider: true,
    },
  });
  const clientIds = [...new Set(sessions.map((s) => s.clientId).filter((id): id is string => !!id))];
  const clients = clientIds.length
    ? await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, fullName: true, shortId: true } })
    : [];
  const clientById = new Map(clients.map((c) => [c.id, c]));

  // Стоимость ИИ за звонок (13.09.2026) — служебная финансовая цифра, отдельно
  // от settings.manage: тот, кто может настраивать бота, не обязательно должен
  // видеть деньги (тот же рубильник, что у /finance/* и мисс-контрола, см.
  // permissions.ts). conversationId в AiLog = channelId звонка (см. logAiCall
  // в lib/telephony/liveVoiceBridge.ts).
  const seesMoney = can(req, "finance.view");
  // Расшифровка — разговор с клиентом, номер в ней — тот же телефон, что и в
  // карточке: без права clients.viewPhone он закрыт (находка №225).
  const seesPhone = can(req, "clients.viewPhone");
  const costByChannel = new Map<string, number>();
  if (seesMoney) {
    const channelIds = sessions.map((s) => s.channelId);
    if (channelIds.length > 0) {
      const costRows = await prisma.aiLog.groupBy({
        by: ["conversationId"],
        where: { conversationId: { in: channelIds } },
        _sum: { costUsd: true },
      });
      for (const row of costRows) {
        if (row.conversationId && row._sum.costUsd != null) {
          costByChannel.set(row.conversationId, Number(row._sum.costUsd));
        }
      }
    }
  }

  const sessionClient = (clientId: string | null) => {
    const c = clientId ? clientById.get(clientId) : undefined;
    return c ? { ...c, fullName: clientNamePhoneSafe(c.fullName, seesPhone) } : null;
  };

  res.json({
    sessions: sessions.map((s) => ({
      id: s.id,
      channelId: s.channelId,
      // Имя без номера внутри, если нет права на телефон (аудит роботов №25): список
      // открывает calls.transcripts, а не clients.viewPhone.
      client: sessionClient(s.clientId),
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      // Причину ставит в том числе модель (end_call/escalate) — длина не ограничена
      // на входе, поэтому режем на выдаче, чтобы строка списка не раздувалась.
      endedReason: s.endedReason ? s.endedReason.slice(0, 200) : s.endedReason,
      // test / inbound / outbound; null — сессии до появления поля (24.09.2026).
      direction: s.direction,
      // Кто вёл звонок: google / elevenlabs; null — звонки до переключателя (они были
      // у Google). В списке подписывается словами.
      provider: s.provider === "google" || s.provider === "elevenlabs" ? s.provider : null,
      // Превью, а не весь текст — список из 30 звонков не должен весить мегабайт.
      // Номера в тексте закрываем ДО обрезки: обрезок посреди номера оставил бы
      // его хвост цифрами, которые маска уже не узнаёт (находка №225).
      transcriptPreview: s.transcript ? phoneSafeText(mergeTranscriptFragments(s.transcript), seesPhone).slice(0, 300) : null,
      hasRecording: !!s.recordingUrl,
      // null — либо не видит деньги, либо usageMetadata от Google не пришло
      // (⚠️ живой голос без проверки — см. докстринг ai/liveVoiceClient.ts):
      // и то, и другое честно «нет данных», не ноль.
      costUsd: seesMoney ? (costByChannel.get(s.channelId) ?? null) : null,
    })),
  });
});

/** Presigned-ссылка на запись одного звонка — 10 минут (см. r2PresignDownloadUrl),
 *  запрашивается заново при каждом клике «Прослушать», не кэшируется на клиенте. */
settingsRouter.get(
  "/live-voice/sessions/:id/recording",
  requireAuth,
  requirePermission("settings.manage"),
  // Запись разговора — то же право, что у обычных записей звонков (находка №225):
  // настройка бота не даёт права слушать клиентов.
  requirePermission("calls.transcripts"),
  requirePermission("calls.hearRecording"),
  async (req, res) => {
    const session = await prisma.liveVoiceSession.findUnique({
      where: { id: req.params.id },
      select: { recordingUrl: true, channelId: true, investigationOnly: true },
    });
    if (session && !(await mayReadLiveVoiceSession(req.agent?.role, session))) return res.status(404).json({ error: "Записи нет" });
    if (!session?.recordingUrl) return res.status(404).json({ error: "Записи нет" });
    const url = await r2PresignDownloadUrl(session.recordingUrl);
    if (!url) return res.status(502).json({ error: "R2 не настроен или не ответил" });
    // Кто и какой разговор слушал (аудит роботов №29): запись — голос клиента.
    // Пишем после выдачи ссылки, чтобы отказ R2 не оставлял след «слушал».
    logAudit(req, "LIVE_VOICE_RECORDING_LISTEN", "LiveVoiceSession", req.params.id);
    res.json({ url });
  }
);

/**
 * ЗВУКИ ТЕЛЕФОНИИ — музыка ожидания и приветствие автоответчика — загружаются
 * здесь, а СТАНЦИЯ ЗАБИРАЕТ ИХ САМА (cron royalhome-audio-sync.sh, раз в 5 минут).
 *
 * Почему так, а не «CRM кладёт файл на станцию»: у CRM нет и не должно быть
 * записи на диск АТС — станция сама ходит наружу (как её туннель) и забирает файл
 * по постоянному адресу /uploads/telephony/(moh|greeting).wav. Имя постоянное
 * намеренно: станция проверяет «изменился ли файл», а не ищет новый.
 *
 * ФОРМАТ ПЕРЕСЖИМАЕТСЯ ЗДЕСЬ, А НЕ СОХРАНЯЕТСЯ КАК ПРИСЛАЛ БРАУЗЕР (найдено
 * 15.08.2026: владелец грузил свою музыку и приветствие ещё 13-14.08, станция
 * играла штатную мелодию FreePBX — файл лежал байт-в-байт, каким его прислал
 * телефон, обычно 44.1/48 кГц. Asterisk ждёт 8 кГц моно, и на другом семпл-рейте
 * либо не грузит файл, либо коверкает скорость — внешне неотличимо от «не
 * применилось»). См. lib/telephony/audioTranscode.ts. Расширение больше не
 * зависит от того, что прислал браузер — на выходе всегда `.wav`.
 */
// Третий тип — приветствие ОЧЕРЕДИ: то, что человек слышит перед соединением с
// оператором («оставайтесь на линии»). Отдельно от автоответчика: там «оставьте
// сообщение», здесь «соединяем». Станция забирает файлы по этим же именам
// (royalhome-audio-sync.sh на АТС).
//
// Четвёртый — «агент отказал» (владелец 20.08.2026): играется звонящему клиенту,
// когда его закреплённый агент явно отклонил звонок или занят (DIALSTATUS=BUSY
// в royalhome-agent-route на станции) — «Ваш агент вам перезвонит» — и ТОЛЬКО
// ПОСЛЕ этого звонок всё равно уходит в общую очередь операторов, как раньше.
// Без этого «и всё равно очередь» решение по мотивам разбора владельца и веб-
// исследования было бы «сказал и бросил трубку без подстраховки» — ровно та
// ошибка, из-за которой в колл-центрах лид теряется молча (не туда ушёл пуш,
// не увидел уведомление, телефон разрядился): единственная страховка была бы
// «агент вспомнит перезвонить», а очередь — уже проверенный запасной путь.
const TELEPHONY_AUDIO_KINDS = {
  moh: "музыка ожидания",
  greeting: "приветствие автоответчика",
  queue: "приветствие очереди",
  agentDeclined: "«агент вам перезвонит»",
} as const;

settingsRouter.post(
  "/telephony-audio/:kind",
  requireAuth,
  requirePermission("settings.manage"),
  requireElevation,
  audioUpload.single("audio"),
  async (req, res) => {
    const kind = req.params.kind as keyof typeof TELEPHONY_AUDIO_KINDS;
    // Object.hasOwn, а не обращение по ключу: «constructor»/«__proto__» есть у любого
    // объекта, проходили проверку вида и клали лишний файл в каталог (находка №165).
    if (!Object.hasOwn(TELEPHONY_AUDIO_KINDS, kind)) return res.status(404).json({ error: "Неизвестный тип звука" });
    if (!req.file) return res.status(400).json({ error: "Файл не передан" });

    let wav: Buffer;
    try {
      wav = await transcodeForAsterisk(req.file.buffer);
    } catch (err) {
      const message = err instanceof AudioTranscodeError ? err.message : "Не удалось обработать файл";
      await logSystemError("telephony", `Загрузка звука телефонии (${kind}) не обработалась: ${message}`);
      return res.status(400).json({ error: `Файл не подошёл: ${message}. Загрузите обычный mp3 или wav.` });
    }

    const dir = path.join(uploadsDir, "telephony");
    const target = path.join(dir, `${kind}.wav`);
    const tempPath = `${target}.new`;
    /**
     * ЧЕРЕЗ ВРЕМЕННЫЙ ФАЙЛ И ПЕРЕИМЕНОВАНИЕ, А НЕ ПОВЕРХ РАБОЧЕГО.
     *
     * `writeFile` открывает файл с обрезанием: на полпути (кончилось место, том
     * только на чтение) на диске остаётся ОБРЕЗАННЫЙ `moh.wav` — и станция
     * честно синхронизирует его себе и играет обрезок каждому звонящему.
     * Прежний порядок делал это ещё вернее: старый `.mp3` удалялся ДО записи,
     * так что сорвавшаяся запись не оставляла вообще ничего игрываемого.
     * Переименование в пределах одного каталога атомарно: либо старый файл,
     * либо целиком новый, промежуточного состояния не бывает.
     *
     * Временное имя каталогу не мешает: экран состояния (`GET
     * /telephony-audio`) спрашивает точные имена через `stat`, а не перебирает
     * каталог, и станция забирает файл по точному адресу.
     */
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(tempPath, wav);
      await fs.promises.rename(tempPath, target);
    } catch (err) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
      await logSystemError(
        "telephony",
        `Звук телефонии (${kind}) не записался на диск (${dir}): ${describeError(err)}`
      );
      // 503, а не 500: отказало наше хранилище, отказ временный и повтор осмыслен.
      // Прежний звук при этом цел — станция продолжает играть его, а не тишину.
      return res.status(503).json({ error: "Файл не сохранился на диске CRM — попробуйте ещё раз" });
    }
    // Старый mp3, оставшийся с версии до пересжатия — иначе оба адреса отвечали бы,
    // и станция могла бы подхватить именно устаревший. Убираем ПОСЛЕ успешной
    // записи wav: до неё удалять нечего страховать, а сорвись запись — мы бы
    // вдобавок к обрезку снесли единственный оставшийся playable-файл.
    await fs.promises.rm(path.join(dir, `${kind}.mp3`), { force: true }).catch(() => {});

    logAudit(req, "SETTINGS_UPDATE", "Settings", "singleton", { telephonyAudio: kind, format: "wav" });
    res.json({ ok: true, kind, format: "wav", appliesInMinutes: 5 });
  }
);

/**
 * Что из звуков телефонии уже загружено — интерфейс показывает состояние честно.
 *
 * ПОЧЕМУ ЕСТЬ ПРИЗНАК `stale` (найдено 16.08.2026). Станция забирает файл строго
 * по адресу `(moh|greeting|queue).wav` — другого имени её скрипт не знает. До
 * пересжатия (15.08) CRM сохраняла файл с тем расширением, какое прислал браузер,
 * поэтому от старых загрузок на диске остались `.mp3`. Такой файл станции
 * НЕДОСТУПЕН: `/uploads/telephony/moh.wav` отвечает 404, каталог музыки на АТС
 * остаётся пустым, и клиент в очереди слышит тишину.
 *
 * А экран при этом писал «файл загружен» — то есть единственный признак поломки
 * был не виден именно там, куда владелец и шёл проверять. Ровно поэтому «мелодия
 * всё ещё не работает» продержалась двое суток: и человек, и код считали, что всё
 * на месте. Теперь состояние называется своим именем и просит перезалить.
 */
const STATION_AUDIO_EXT = "wav";

settingsRouter.get("/telephony-audio", requireAuth, requirePermission("settings.manage"), async (_req, res) => {
  const dir = path.join(uploadsDir, "telephony");
  const result: Record<string, { format: string; uploadedAt: string; stale: boolean } | null> = {
    moh: null,
    greeting: null,
    queue: null,
  };
  for (const kind of Object.keys(TELEPHONY_AUDIO_KINDS)) {
    // Порядок важен: `.wav` — рабочее состояние, и если рядом лежит устаревший
    // `.mp3`, побеждать должен именно wav, а не тот, кто оказался последним.
    for (const ext of ["mp3", STATION_AUDIO_EXT]) {
      try {
        const stat = await fs.promises.stat(path.join(dir, `${kind}.${ext}`));
        result[kind] = { format: ext, uploadedAt: stat.mtime.toISOString(), stale: ext !== STATION_AUDIO_EXT };
      } catch {
        /* файла нет — это состояние, а не ошибка */
      }
    }
  }
  res.json(result);
});

/**
 * Трафик платного канала станции за месяц (08.10.2026) — строка в Настройки →
 * Телефония. Отдельный путь, а не поле общих настроек: данные берутся с
 * самой станции по сети, и настройки всего приложения не должны ждать её ответа.
 * `stationTraffic: null` — станция не подключена или не ответила («нет данных»).
 * Ответ кэшируется на 10 минут (lib/telephony/stationTraffic.ts).
 */
settingsRouter.get("/telephony-traffic", requireAuth, requirePermission("settings.manage"), async (_req, res) => {
  res.json({ stationTraffic: await getStationTrafficUsageCached() });
});

/**
 * ПОДСКАЗКА АГЕНТУ О ЗВОНЯЩЕМ — состояние, ключ для станции и прослушивание.
 *
 * Экран настройки обязан отвечать на три вопроса живыми данными, а не обещаниями:
 * что именно услышит агент, сколько это секунд и доходит ли всё это до станции.
 * Иначе получается настройка, про которую нельзя понять, работает она или нет, —
 * ровно та история, из-за которой музыка ожидания двое суток «была загружена», а
 * клиенты слушали тишину (15.08.2026).
 */
settingsRouter.get("/call-whisper", requireAuth, requirePermission("settings.manage"), async (_req, res) => {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { callWhisperStationToken: true, callWhisperFetchedAt: true },
  });

  const [total, incoming, outgoing, longest, sample] = await Promise.all([
    prisma.callWhisper.count(),
    prisma.callWhisper.count({ where: { direction: "in" } }),
    prisma.callWhisper.count({ where: { direction: "out" } }),
    prisma.callWhisper.findFirst({ orderBy: { durationMs: "desc" }, select: { durationMs: true } }),
    // Живой пример — самая свежая подсказка: владелец видит НАСТОЯЩУЮ фразу о
    // настоящем клиенте, а не выдуманный образец.
    prisma.callWhisper.findFirst({
      orderBy: { updatedAt: "desc" },
      select: { text: true, durationMs: true, direction: true, language: true },
    }),
  ]);

  res.json({
    // Сам ключ наружу не отдаём никогда — только признак, что он задан.
    hasStationToken: Boolean(decryptSecretSafe(settings?.callWhisperStationToken ?? null)),
    stationFetchedAt: settings?.callWhisperFetchedAt?.toISOString() ?? null,
    ready: total,
    readyIncoming: incoming,
    readyOutgoing: outgoing,
    longestMs: longest?.durationMs ?? null,
    sample,
  });
});

/**
 * Выдать станции новый ключ. Показывается ОДИН РАЗ: дальше он лежит зашифрованным, и
 * «посмотреть ещё раз» невозможно — можно только выпустить новый, что сразу отключает
 * старый. Так ключ не утечёт из интерфейса, оставленного открытым.
 */
settingsRouter.post(
  "/call-whisper/token",
  requireAuth,
  requirePermission("settings.manage"),
  requireElevation,
  async (req, res) => {
    const token = randomBytes(24).toString("base64url");
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { callWhisperStationToken: encryptSecret(token) },
    });
    logAudit(req, "SETTINGS_UPDATE", "Settings", "singleton", { callWhisperStationToken: "выдан новый" });
    res.json({ token });
  }
);

/**
 * ФИД КАТАЛОГА META (28.09.2026) — новый ключ ссылки на CSV. Тем же приёмом, что
 * и ключ станции выше («показывается один раз»), но БЕЗ шифрования: это не
 * секрет доступа к CRM, а параметр публичного адреса, который владелец сам же
 * вставляет в Commerce Manager (см. Settings.metaCatalogFeedKey в schema.prisma).
 * Старый ключ сразу перестаёт работать — прежняя ссылка, вставленная в Meta,
 * начнёт отвечать 404 до того, как туда впишут новую.
 */
settingsRouter.post(
  "/meta-catalog-feed/rotate",
  requireAuth,
  requirePermission("settings.manage"),
  requireElevation,
  async (req, res) => {
    const key = randomBytes(16).toString("hex");
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaCatalogFeedKey: key } });
    logAudit(req, "SETTINGS_UPDATE", "Settings", "singleton", { metaCatalogFeedKey: "выдан новый" });
    const base = crmPublicBase();
    res.json({ key, url: base ? `${base}/api/v1/public/meta-catalog/home-listings.csv?key=${key}` : null });
  }
);

/**
 * Прослушать, как это звучит, НЕ ДОЖИДАЯСЬ ЗВОНКА.
 *
 * Берём настоящего клиента (самого свежего из тех, кого озвучиваем) и собираем фразу
 * тем составом, который человек сейчас выбирает на экране, — то есть до сохранения
 * настройки. Клиента в базе нет — отвечаем честно, а не подсовываем выдуманного:
 * «Фаррух, харидор» на пустой базе создавало бы ложное впечатление готовности.
 */
const whisperPreviewSchema = z.object({
  direction: z.enum(["in", "out"]),
  language: z.enum(["tg", "ru"]),
  parts: z.array(z.enum(WHISPER_PARTS)).max(WHISPER_PARTS.length),
  voice: z.string().min(1).max(40),
  /**
   * Озвучивать ли. По умолчанию нет: текст фразы обновляется на КАЖДОЕ переключение
   * блока в настройках, и синтезировать речь на каждый клик значило бы платить за
   * то, чего человек не просил слушать. Звук — только по кнопке «Прослушать».
   */
  speak: z.boolean().optional(),
});

settingsRouter.post(
  "/call-whisper/preview",
  requireAuth,
  requirePermission("settings.manage"),
  async (req, res) => {
    const parsed = whisperPreviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Неверные параметры предпросмотра" });
    const { direction, language, parts, voice } = parsed.data;

    const client = await prisma.client.findFirst({
      where: { deletedAt: null, assignedAgentId: { not: null }, status: { notIn: ["DEAL_CLOSED", "LOST", "ARCHIVED"] } },
      orderBy: { lastContactAt: "desc" },
      select: {
        id: true,
        fullName: true,
        kind: true,
        desiredType: true,
        desiredDistrict: { select: { name: true } },
        budgetMin: true,
        budgetMax: true,
        currency: true,
        lastContactAt: true,
      },
    });
    if (!client) return res.status(409).json({ error: "Пока не на ком показать: нет ни одного клиента с ответственным" });

    const promise = await prisma.interaction.findFirst({
      where: { clientId: client.id, completedAt: null, nextActionDate: { not: null } },
      orderBy: { nextActionDate: "asc" },
      select: { nextActionDate: true },
    });

    const text = buildWhisperText(
      {
        fullName: client.fullName,
        kind: client.kind,
        propertyType: client.desiredType,
        districtName: client.desiredDistrict?.name ?? null,
        budgetMin: client.budgetMin ? Number(client.budgetMin) : null,
        budgetMax: client.budgetMax ? Number(client.budgetMax) : null,
        currency: client.currency,
        lastContactAt: client.lastContactAt,
        promisedAt: promise?.nextActionDate ?? null,
        aiHint: null,
      },
      { language, direction, parts }
    );
    if (!text) return res.status(409).json({ error: "При таком составе фразы озвучивать нечего" });
    if (!parsed.data.speak) return res.json({ text, clientName: client.fullName });

    // Озвучка предпросмотра идёт мимо файлов станции: это разовый ответ в браузер, и
    // класть его на диск АТС незачем — там должны лежать только настоящие подсказки.
    const speech = await previewWhisperSpeech(text, language, voice);
    if (!speech) return res.status(502).json({ error: "Синтез речи не ответил — подробности в «Здоровье системы»", text });

    res.json({ text, clientName: client.fullName, audioBase64: speech.audioBase64, sampleRateHz: speech.sampleRateHz });
  }
);

/**
 * ПОДКЛЮЧЁННЫЕ АККАУНТЫ МЕССЕНДЖЕРОВ (Instagram и остальные каналы Meta).
 *
 * Раньше маркер лежал одиночным полем и означал ровно один аккаунт на канал.
 * Теперь их список: у агентства появился второй Instagram (Royal Home Info —
 * советы, чек-листы, вакансии), и переписка обоих должна идти в одну CRM, но
 * отвечать каждый обязан от своего имени (см. messengers/accounts.ts).
 *
 * Маркер наружу не отдаём никогда — только признак, что он задан.
 */
settingsRouter.get("/messenger-accounts", requireAuth, requirePermission("settings.manage"), async (_req, res) => {
  res.json({ items: await listAccounts() });
});

const messengerAccountSchema = z.object({
  id: z.string().max(64).optional(),
  channel: z.string().max(32).optional(),
  externalId: z.string().max(200).optional(),
  title: z.string().max(200).optional(),
  token: z.string().max(4000).optional(),
  // Account signing keys require the dedicated verified binding operation.
  appSecret: z.never().optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  systemPrompt: z.string().max(30000).nullish(),
  /**
   * Идентификаторы получателя, которые Meta своим ответом не подтвердит
   * (см. schema.prisma, MessengerAccount.extraExternalIds) — владелец переписывает
   * их из текста ошибки «неизвестный получатель» (Health → журнал ошибок),
   * когда reconcileInstagramAccountIds сам починить запись не может.
   */
  extraExternalIds: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
});

settingsRouter.post(
  "/messenger-accounts",
  requireAuth,
  requirePermission("settings.manage"),
  requireElevation,
  async (req, res) => {
    const parsed = messengerAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Некорректные данные аккаунта" });
    }
    const body = parsed.data;

    const channel = (body.channel ?? "INSTAGRAM").toUpperCase();
    if (!["INSTAGRAM", "FACEBOOK", "WHATSAPP"].includes(channel)) {
      return res.status(400).json({ error: "Неизвестный канал" });
    }
    let externalId = body.externalId?.trim();
    const title = body.title?.trim();
    if (!title) return res.status(400).json({ error: "Укажите название аккаунта" });

    /**
     * ИДЕНТИФИКАТОР СПРАШИВАЕМ У МАРКЕРА, А НЕ У ЧЕЛОВЕКА.
     *
     * У Instagram два вида идентификатора, и панель Meta показывает НЕ ТОТ, что
     * приходит в вебхуке (см. instagramTokenIdentity). Номер, переписанный из
     * панели, выглядит правильным, но не совпадает ни с одним входящим — и ответы
     * молча уходят аккаунтом по умолчанию, то есть чужим маркером.
     *
     * Поэтому, когда маркер дан, идентификатор берём из ответа Meta и перекрываем
     * им поле формы. Заодно это проверка, что маркер вообще живой.
     */
    if (channel === "INSTAGRAM" && body.token?.trim()) {
      const identity = await instagramTokenIdentity(body.token.trim());
      if (!identity.ok) {
        return res.status(400).json({ error: `Маркер не принят: ${identity.error}` });
      }
      externalId = identity.id;
    }
    // Правка одного поля (промт, «сделать основным», выключить) не обязана
    // пересылать всю запись: недостающее берём из той, что уже есть.
    if (!externalId && body.id) {
      externalId = (await listAccounts()).find((a) => a.id === body.id)?.externalId;
    }
    if (!externalId) return res.status(400).json({ error: "Укажите идентификатор аккаунта" });
    // Маркер обязателен только при создании: при правке пустое поле означает
    // «не менять», иначе редактирование названия стирало бы доступ.
    if (!body.id && !body.token?.trim()) return res.status(400).json({ error: "Укажите маркер доступа" });
    // Тот же предел, что у общего промта в Настройках (botSystemPrompt).
    if (typeof body.systemPrompt === "string" && body.systemPrompt.length > 30000) {
      return res.status(400).json({ error: "Промт слишком длинный" });
    }

    try {
      const id = await saveAccount({
        id: body.id,
        channel,
        externalId,
        title,
        token: body.token,
        enabled: body.enabled,
        isDefault: body.isDefault,
        systemPrompt: body.systemPrompt,
        extraExternalIds: body.extraExternalIds,
      });
      logAudit(req, "SETTINGS_UPDATE", "MessengerAccount", id, { channel, title });
      res.json({ ok: true, id });
    } catch (err) {
      // Один и тот же аккаунт дважды — самая частая ошибка при подключении.
      if ((err as { code?: string }).code === "P2002") {
        return res.status(409).json({ error: "Такой аккаунт уже подключён" });
      }
      throw err;
    }
  }
);

settingsRouter.delete(
  "/messenger-accounts/:id",
  requireAuth,
  requirePermission("settings.manage"),
  requireElevation,
  async (req, res) => {
    await deleteAccount(req.params.id);
    logAudit(req, "SETTINGS_UPDATE", "MessengerAccount", req.params.id, { deleted: true });
    res.json({ ok: true });
  }
);

/** Шаблоны обложек для соцсетей — свой файл маршрутов (settingsCoverTemplates.ts). */
// Раньше шаблонов: пути /openai и /openai-test иначе поймал бы /:id шаблонов.
settingsRouter.use("/cover-templates", coverOpenAiRouter);
settingsRouter.use("/cover-templates", coverTemplatesRouter);

/** Логотип компании — только администратор, отображается в шапке сайдбара. */
settingsRouter.post("/logo", requireAuth, requirePermission("settings.manage"), requireElevation, upload.single("logo"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Файл не передан" });

  const filename = `logo-${Date.now()}.webp`;
  // До 512 px, а не 160 (28.09.2026): тот же файл идёт на обложки соцсетей, и
  // «Обложки» требуют исходник от LOGO_MIN_SOURCE_PX — при сжатии до 160 их
  // предупреждение «логотип мелкий» нельзя было убрать никакой загрузкой. В шапке
  // и на входе размер задаёт CSS. Меньшие картинки не растягиваются.
  await sharp(req.file.buffer)
    .resize(512, 512, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 90 })
    .toFile(path.join(uploadsDir, filename));

  const settings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { companyLogoUrl: `/uploads/${filename}` },
    create: { id: "singleton", companyLogoUrl: `/uploads/${filename}` },
  });
  res.json(privateSettingsResponse(await publicSettingsResponse(settings), req.agent?.role));
});

/**
 * Аварийный сброс пароля админки САЙТА (royalhome.tj/admin). Директор и админ
 * (siteAdmin.reset — с 14.09.2026 обычная ASSIGNABLE-галочка, раньше было
 * владельческим правом) и только за свежим step-up-подтверждением. Публичной
 * формы «забыли пароль» на сайте нет намеренно — этот канал и есть официальный
 * способ восстановления. Новый пароль показывается ровно один раз и нигде не
 * сохраняется.
 */
const siteAdminResetSchema = z.object({ resetTotp: z.boolean().optional() });

settingsRouter.post("/site-admin-reset", requireAuth, requirePermission("siteAdmin.reset"), requireElevation, async (req, res) => {
  const url = process.env.SITE_SYNC_URL;
  // Свой ключ, отдельный от SITE_SYNC_API_KEY (тот — для рутинной синхронизации
  // объектов/статусов лидов): этот эндпоинт отдаёт пароль администратора сайта
  // целиком и может снять 2FA, утечка общего ключа не должна открывать и это.
  const apiKey = process.env.SITE_SYNC_ADMIN_RESET_KEY;
  if (!url || !apiKey) {
    return res.status(503).json({ error: "Связь с сайтом не настроена (SITE_SYNC_URL/SITE_SYNC_ADMIN_RESET_KEY)" });
  }
  // Разбор схемой, а не `req.body?.x === true`: тело приходит с границы, и правило
  // проекта одно для всех входов. Пустое тело допустимо — сброс без TOTP.
  const parsed = siteAdminResetSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const resetTotp = parsed.data.resetTotp === true;
  try {
    const r = await fetch(`${url}/admin-reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
      body: JSON.stringify({ resetTotp }),
      signal: AbortSignal.timeout(8000),
    });
    const body = (await r.json().catch(() => ({}))) as { ok?: boolean; email?: string; password?: string; error?: string };
    if (!r.ok || !body.ok || !body.password) {
      void logSystemError(
        "site-sync",
        `Сброс пароля админки сайта не удался: сайт вернул ${body.error ?? `HTTP ${r.status}`}`
      );
      return res.status(502).json({ error: body.error ?? `Сайт вернул ошибку ${r.status}` });
    }
    // В аудит — факт сброса и кем, но НИКОГДА не сам пароль.
    logAudit(req, "SITE_ADMIN_PASSWORD_RESET", "Settings", "site-admin", { resetTotp });
    res.json({ email: body.email, password: body.password });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Сайт недоступен";
    void logSystemError("site-sync", `Сброс пароля админки сайта не удался: ${message}`);
    res.status(502).json({ error: message });
  }
});

function privateSettingsResponse<T extends object>(response: T, role: string | undefined): T {
  if (!canViewInvestigations(role)) {
    delete (response as Record<string, unknown>).postShowingCallEnabled;
    delete (response as Record<string, unknown>).investigationCaseConfig;
    delete (response as Record<string, unknown>).buyerSellerAutomationMode;
  }
  return response;
}
