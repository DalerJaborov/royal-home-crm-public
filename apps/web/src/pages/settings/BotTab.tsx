import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  Bot,
  Clock,
  Dumbbell,
  FlaskConical,
  GraduationCap,
  HelpCircle,
  KeyRound,
  MessageCircle,
  Mic,
  Power,
  Search,
  Sparkles,
  TrendingDown,
} from "lucide-react";
import { LOST_REASON_LABELS, LOST_STAGES, LOST_STAGE_LABELS, voiceGender } from "@royal-home/shared";
import {
  useSettings,
  useSettingsRestorePoints,
  useUpdateSettings,
  useLiveVoiceTestCall,
  useElevenLabsCheck,
  useLiveVoicePreviewVoice,
  type ModelSource,
} from "../../hooks/useSettings";
import { PlainSetting, GEMINI_VOICE_CATALOG } from "./ChannelsTab";
import { pcmBase64ToWavUrl } from "../../lib/pcmToWav";
import { useAgents } from "../../hooks/useAgents";
import { api, ApiError } from "../../lib/api";
import { pluralizeRu } from "../../lib/format";
import { dushanbeDate, dushanbeDayKey } from "../../lib/date";
import { areasOf as areasOfFields } from "./RestorePointsSection";
import { SecretKeyEditor } from "../../components/SecretKeyEditor";
import { SettingsSection, SettingsGroupLabel, SettingsSearchProvider } from "../../components/settings/SettingsSection";
import {
  groupIds,
  loadMoreBotLessons,
  useBotLearning,
  useBumpBotLesson,
  useDeleteBotLesson,
  useLostDigests,
  useResolveLostReview,
  useUpdateBotLesson,
  useUpdateBotLessonGroup,
  type BotLesson,
  type BotLessonGroup,
  type LostDigest,
  type LostReview,
  type LostVerdict,
} from "../../hooks/useBotLearning";
import { useAccumulatedPages } from "../../hooks/useAccumulatedPages";
import { useBotScenarios, type ScenarioComparison, type ScenarioStats } from "../../hooks/useBotScenarios";
import { useInstagramComments } from "../../hooks/useInstagramComments";
import { useCan } from "../../lib/permissions";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { StateWord, Switch, SwitchRow } from "../../components/Switch";
import { SHOWING_CONFIRM_ON_TEXT, followUpBlockedBy, showingConfirmBlockedBy } from "../../lib/settingsDependencies";
import { relativeTime } from "../../lib/format";

/**
 * Окно «Помощник» — всё про бота на одном экране.
 *
 * До него настройки бота были рассыпаны: промт во вкладке «ИИ», рубильник в
 * «Каналах связи», паузу и напоминания вообще нельзя было тронуть иначе как
 * правкой базы. Владелец каждый раз спрашивал «а где вот это» — значит разложено
 * было по устройству системы, а не по вопросу, с которым человек приходит.
 *
 * Порядок сверху вниз — от «работает ли вообще» к «что он говорит» и дальше к
 * «чему научился». Экран длинный, поэтому карточки самостоятельные: каждая
 * сохраняется отдельно и не ждёт остальных.
 *
 * Разметка — дословно эталон темы «Royal Home 2026»
 * (docs/pult/theme-2026/screens/settings-bot.html): четыре группы `.grp-lab`,
 * каждый раздел — складка `.acc` (SettingsSection), внутри строки `.mod` с
 * тумблером `.tgl` или полем `.nf`, ключи — строки `.key-row` с маской `.msk`,
 * тексты — поля `.fld`, пояснения и предупреждения — тихие строки `.quiet`.
 * Ни один раздел и ни одна настройка не удалены: полотно из четырнадцати
 * карточек подряд разложено по складкам, состав прежний.
 */
export function BotTab({ area }: { area?: "operation" | "answers" | "voice" | "learning" | "models" } = {}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [found, setFound] = useState<{ settings: number; sections: number } | null>(null);
  const { data: settings } = useSettings();
  const points = useSettingsRestorePoints();

  /**
   * «Найдено N настроек» (макет): считаем строки `.mod` в складках, которые не
   * спрятал поиск. По DOM после каждого рендера: складки решают о совпадении
   * сами (SettingsSection), а данные внутри приходят позже первого кадра.
   */
  useLayoutEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    const count = () => {
      // Свёрнутая складка тело не рисует, поэтому настройки считаются только в
      // поиске (он раскрывает все); без поиска честно считаем разделы.
      let n = 0;
      let sections = 0;
      for (const acc of root.querySelectorAll<HTMLElement>(".acc")) {
        sections += 1;
        if (acc.dataset.searchMiss !== undefined) continue;
        n += acc.querySelectorAll(".mod").length;
      }
      setFound((prev) => (prev && prev.settings === n && prev.sections === sections ? prev : { settings: n, sections }));
    };
    count();
    const observer = new MutationObserver(count);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-search-miss"] });
    return () => observer.disconnect();
  }, []);

  // «Сегодня изменено N настроек»: точки возврата за сегодня, по полям без повторов.
  const todayFields = new Set<string>();
  // День — по Душанбе, а не по часам устройства (F16, 02.10.2026).
  const today = dushanbeDayKey(new Date());
  for (const p of points.data?.items ?? []) {
    if (dushanbeDayKey(p.createdAt) !== today) continue;
    for (const f of p.changedFields) todayFields.add(f);
  }
  const todayAreas = areasOfFields([...todayFields]);

  return (
    <SettingsSearchProvider query={query}>
      <div className="card tight">
        <div className="filters">
          <input
            className="inp"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Что ищем: «пауза», «промт», «ключ»"
            aria-label="Поиск по настройке"
          />
          <span className="spacer" />
          <span className="note" style={{ fontSize: "var(--fs-13)", color: "var(--faint)" }}>
            {found === null
              ? ""
              : searching
                ? `Найдено ${found.settings} ${pluralizeRu(found.settings, ["настройка", "настройки", "настроек"])}`
                : `${found.sections} ${pluralizeRu(found.sections, ["раздел", "раздела", "разделов"])} в четырёх группах`}
          </span>
        </div>
        {todayFields.size > 0 && (
          <div className="quiet" style={{ marginTop: 4 }}>
            <span className="dot warn" />
            <span className="txt">
              Сегодня изменено {todayFields.size} {pluralizeRu(todayFields.size, ["настройка", "настройки", "настроек"])}
              : {todayAreas.join(", ").toLowerCase()}.
            </span>
            <button className="lnk" type="button" onClick={() => navigate(area ? "/settings?tab=system&task=data" : "/settings?tab=system", { replace: true })}>
              Что именно
            </button>
          </div>
        )}
        <div className="wrap" style={{ marginTop: 8 }}>
          <button
            className="pill ghost sm"
            type="button"
            onClick={() => area && area !== "learning" ? navigate("/settings?tab=bot&task=learning") : document.getElementById("bot-lessons")?.scrollIntoView({ behavior: "smooth", block: "start" })}
          >
            Чему научился
          </button>
          {settings?.botTrainingScreenEnabled && (
            <Link className="pill ghost sm" to="/ai-learning?tab=manner">
              Тренировка
            </Link>
          )}
        </div>
      </div>

      <div ref={bodyRef} style={{ display: "contents" }}>
        {(!area || area === "models") && <>
        {!searching && <SettingsGroupLabel>Ключи и модели</SettingsGroupLabel>}
        <AiKeysSection />
        <GeminiModelsSection />
        <AssistantAbilitiesSection />

        </>}
        {(!area || area === "operation") && <>
        {!searching && <SettingsGroupLabel>Как бот работает</SettingsGroupLabel>}
        <BotPowerSection />
        <BotTimingSection />
        <BotPauseWatchSection />

        </>}
        {(!area || area === "answers") && <>
        {!searching && <SettingsGroupLabel>Что бот говорит</SettingsGroupLabel>}
        <SellerRulesSection />
        <BotPromptSection />
        <BotCommentPromptSection />
        <ReelsCaptionTemplatesSection />
        <BotCommentsSection />

        </>}
        {(!area || area === "voice") && <>
        {!searching && <SettingsGroupLabel>Живой голос по телефону</SettingsGroupLabel>}
        <LiveVoiceSection />

        </>}
        {(!area || area === "learning") && <>
        {!searching && <SettingsGroupLabel>Учёба и проверки</SettingsGroupLabel>}
        <BotScenariosSection />
        <BotTrainingSection />
        <BotQuestionsSection />
        <LostClientsSection />
        <div id="bot-lessons" style={{ display: "contents" }}>
          <BotLessonsSection />
        </div>
        </>}
        {searching && found?.settings === 0 && (
          <div className="card tight">
            <p className="state">По запросу «{query.trim()}» настроек не нашлось. Попробуйте одно слово: «пауза», «ключ».</p>
          </div>
        )}
      </div>
    </SettingsSearchProvider>
  );
}

/**
 * Указатели на то, что про ИИ-ассистента настроено НЕ здесь.
 *
 * Объединено 18.08.2026 (просьба владельца «слишком много кнопок разбросано»):
 * вкладки «Бот» и «ИИ» слиты в одну — общий промт, способности и ключи моделей
 * теперь на одном экране. Осталось два места, которые сюда физически не входят
 * по осознанным причинам, и про них нужна не копия, а короткая дорога:
 *  - Воронка «комментарий → директ»: отдельная страница /funnel, а не вкладка
 *    Настроек, — решение владельца 16.08.2026 (на неё смотрят каждый час во
 *    время рекламы, лишний экран подтверждения личности мешал бы).
 *  - Промт конкретного канала (переопределяет общий промт для одного
 *    подключённого аккаунта Instagram/WhatsApp) — живёт в «Каналах связи»,
 *    потому что заводится там же, где сам аккаунт.
 */

/**
 * Ключи моделей и выбор той, что ведёт диалог с клиентом.
 *
 * Рубильники каналов живут во вкладке «Каналы связи»: их искали как «где включить
 * Instagram», а не «где настроить ИИ». Промт бота уехал во вкладку «Бот» — здесь
 * остаётся только то, ЧЕМ бот думает, а не то, ЧТО он говорит.
 *
 * Поставщик один — Google, и выбирать больше не из чего (владелец 12.08.2026 —
 * Gemini как единственный; 20.08.2026 — Claude убран из кода вместе с ключом:
 * неоплаченный ключ второго поставщика не запасной путь, а тихий отказ, который
 * выглядит как «ИИ ничего не нашёл»).
 *
 * Устойчивость теперь держится не вторым поставщиком, а НЕСКОЛЬКИМИ КЛЮЧАМИ Google:
 * они перебираются по очереди (ai/geminiClient.ts). Ключи из РАЗНЫХ проектов Google
 * дают и разные суточные квоты — из одного проекта квота общая, сколько ключей ни заводи.
 */
function AiKeysSection() {
  const { data: settings } = useSettings();
  // silent: обе SecretKeyEditor ниже уже показывают «Ключ сохранён»/ошибку
  // под своим полем — общий тост дублировал текст (найдено аудитом 22.08.2026).
  const updateSettings = useUpdateSettings({ silent: true });

  const extraCount = settings?.geminiExtraKeysMasked?.length ?? 0;
  const known = [settings?.geminiApiKeyConfigured, settings?.geminiApiKey2Configured].filter(Boolean).length;

  return (
    <SettingsSection
      icon={KeyRound}
      title="Ключи моделей"
      badge={settings ? `${known + extraCount} задано` : undefined}
      defaultOpen
    >
      {/* Ключа Claude здесь больше нет (владелец 20.08.2026): весь ИИ CRM работает
          на Google, а неоплаченный ключ второго поставщика только притворялся бы
          запасным путём — на деле он отвечал отказом, и это выглядело как «модель
          ничего не нашла». Один поставщик — одна понятная причина отказа. */}
      <SecretKeyEditor
        title="Ключ Gemini (Google)"
        description="«Мозг» CRM: бот отвечает клиентам в Instagram/WhatsApp/Facebook, расшифровывает голосовые и записи звонков, оценивает клиентов, подбирает объекты, пишет описания объявлений и озвучивает подсказку агенту о звонящем. Берётся в aistudio.google.com → Get API key."
        placeholder="Ключ начинается с AIza…"
        configured={settings?.geminiApiKeyConfigured}
        masked={settings?.geminiApiKeyMasked}
        source={settings?.geminiApiKeySource}
        onSave={(key) => updateSettings.mutateAsync({ geminiApiKey: key })}
        onClear={() => updateSettings.mutateAsync({ geminiApiKey: "" })}
      />

      <SecretKeyEditor
        title="Резервный ключ Gemini"
        description="Ключ из другого проекта Google AI Studio. Подключается сам, когда основной перестал отвечать или отклонён — голосовые и чат продолжают работать. Если пусто, при отказе основного ключа ИИ-функции встают."
        placeholder="Ключ начинается с AIza…"
        configured={settings?.geminiApiKey2Configured}
        masked={settings?.geminiApiKey2Masked}
        source={settings?.geminiApiKey2Source}
        onSave={(key) => updateSettings.mutateAsync({ geminiApiKey2: key })}
        onClear={() => updateSettings.mutateAsync({ geminiApiKey2: "" })}
      />
      {settings && !settings.geminiApiKey2Configured && (
        <div className="quiet warn">
          <span className="dot warn" />
          <span className="txt">
            Резервного ключа нет. Ключи Google иногда перевыпускают, и тогда старый перестаёт работать молча — со
            вторым ключом бот этого даже не заметит.
          </span>
        </div>
      )}

      <GeminiExtraKeysSection />

      <div className="quiet crit">
        <span className="dot crit" />
        <span className="txt">
          Ключи хранятся в базе зашифрованными, видны только администратору как маска.
        </span>
      </div>
    </SettingsSection>
  );
}

/**
 * ДОПОЛНИТЕЛЬНЫЕ КЛЮЧИ GEMINI — сколько угодно, сверх основного и резервного.
 *
 * ПОЧЕМУ ЗДЕСЬ НЕ SecretKeyEditor. Тот редактор про ОДНО поле: маска, новое значение,
 * очистить. Здесь же список переменной длины, и главная сложность в другом: уже
 * сохранённый ключ браузер видит только маской (••••1234). Отправить её обратно
 * нельзя — в базу вместо ключа легла бы строка «••••1234», а ИИ замолчал бы молча.
 *
 * Решение: на сервер уходит ПОЛНЫЙ новый список, но за каждый уже сохранённый ключ
 * в нём стоит не значение, а ссылка на его место в базе — `keep:<номер>`. Новый ключ
 * идёт открытым текстом. Так маска не покидает браузер вовсе, а удаление и порядок
 * выражаются самим списком, без отдельных запросов «удалить ключ №3».
 */
/** Ответ живой проверки модели (POST /settings/gemini-test). */
interface GeminiCheckResult {
  ok: boolean;
  status: number | null;
  detail: string;
  ms: number;
  keyIndex: number | null;
}

/** Понятная подпись под полем: чей это выбор. Владелец должен видеть разницу между
 *  «я так решил» и «так вышло по умолчанию» — иначе обновление кода однажды тихо
 *  сменит модель, и разбираться будут задним числом. */
const MODEL_SOURCE_LABEL: Record<ModelSource, string> = {
  settings: "выбрано здесь",
  env: "из настроек сервера",
  default: "заводское значение",
};

/**
 * Одна строка «модель + проверка».
 *
 * Кнопка «Проверить» — главное здесь, а не поле ввода. 22.08.2026 выяснение того,
 * почему бот отвечает на резервной модели, заняло полдня и потребовало входа на
 * сервер: за словом «недоступна» могли стоять 404 (модель закрыта), 429 (кончилась
 * квота), 401 (ключ мёртв) или 503 (Google перегружен) — четыре беды с четырьмя
 * разными лечениями. Теперь ответ Google виден на экране целиком и сразу.
 */
function ModelField({
  title,
  description,
  effective,
  source,
  onSave,
  multi,
}: {
  title: string;
  description: string;
  effective: string | string[] | undefined;
  source: ModelSource | undefined;
  onSave: (value: string[]) => Promise<unknown>;
  multi?: boolean;
}) {
  const current = Array.isArray(effective) ? effective.join(", ") : effective ?? "";
  const [value, setValue] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, GeminiCheckResult>>({});
  // null — поле не трогали: показываем действующее значение. Пустая строка —
  // владелец стёр текст намеренно, и это «вернуть заводское», а не «оставить как было».
  const shown = value ?? current;
  const models = current
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

  async function save() {
    setError(null);
    setSaving(true);
    try {
      await onSave(
        shown
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean)
      );
      setValue(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  }

  async function check(model: string) {
    setChecking(model);
    try {
      const result = await api<GeminiCheckResult>("/settings/gemini-test", { method: "POST", body: { model } });
      setChecks((prev) => ({ ...prev, [model]: result }));
    } catch (err) {
      setChecks((prev) => ({
        ...prev,
        [model]: {
          ok: false,
          status: null,
          detail: err instanceof Error ? err.message : "Проверка не удалась",
          ms: 0,
          keyIndex: null,
        },
      }));
    } finally {
      setChecking(null);
    }
  }

  return (
    <div className={error ? "fld bad" : "fld"} style={{ marginTop: "var(--s4)" }}>
      <span className="lab">
        {title}
        {source ? ` · ${MODEL_SOURCE_LABEL[source]}` : ""}
      </span>
      <input
        value={shown}
        onChange={(e) => setValue(e.target.value)}
        placeholder={multi ? "gemini-3.6-flash, gemini-3.5-flash" : "gemini-3.7-flash"}
        spellCheck={false}
        autoCapitalize="none"
        aria-label={title}
      />
      <span className="msg">
        {error ??
          (shown !== current
            ? shown.trim()
              ? "Не сохранено. Проверять имеет смысл после сохранения — проверяется то, чем работает бот."
              : "Пустое поле вернёт заводское значение."
            : description)}
      </span>
      <div className="wrap" style={{ marginTop: "var(--s2)" }}>
        <button className="pill" type="button" onClick={save} disabled={saving || shown === current}>
          {saving ? "Сохраняю…" : "Сохранить"}
        </button>
        {models.map((model) => (
          <button
            key={model}
            className="pill ghost sm"
            type="button"
            onClick={() => check(model)}
            disabled={checking === model}
          >
            {checking === model ? "Спрашиваю Google…" : `Проверить ${model}`}
          </button>
        ))}
      </div>
      {models.map((model) => {
        const result = checks[model];
        if (!result) return null;
        return (
          <div className={result.ok ? "quiet" : "quiet crit"} key={model}>
            <span className={result.ok ? "dot ok" : "dot crit"} />
            <span className="txt">
              {model}: {result.status !== null ? `HTTP ${result.status}` : "нет связи"} · {result.ms} мс
              {result.keyIndex && result.keyIndex > 1 ? ` · ответил ключ №${result.keyIndex}` : ""}
              {result.ok ? "" : ` · ${result.detail}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Секция «Модели»: какие именно модели Google спрашивает бот.
 *
 * ПОЧЕМУ ЭТО ВООБЩЕ НА ЭКРАНЕ. Имя модели жило в переменных сервера, и смена его
 * требовала входа по SSH. За август Google закрыл две модели без предупреждения
 * (02.08 и 22.08.2026), и оба раза бот работал на резервной — медленнее и дороже —
 * пока до сервера не доходили руки. Имя модели меняется чаще, чем выкатывается код,
 * значит его место здесь, рядом с ключами.
 */
function GeminiModelsSection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings({ silent: true });

  return (
    <SettingsSection icon={Sparkles} title="Какие модели работают" badge="5 настроек">
      <ModelField
        title="Модель диалогов"
        description="Отвечает клиентам, разбирает переписку, оценивает лидов и заполняет карточки — 99% всех обращений к ИИ."
        effective={settings?.geminiModelEffective}
        source={settings?.geminiModelSource}
        onSave={(models) => updateSettings.mutateAsync({ geminiModel: models[0] ?? "" })}
      />
      <ModelField
        title="Резервные модели диалогов"
        description="Подключаются по очереди, когда основная перегружена или закрыта. Пусто — при отказе основной бот замолчит."
        effective={settings?.geminiFallbackModelsEffective}
        source={settings?.geminiFallbackModelsSource}
        onSave={(models) => updateSettings.mutateAsync({ geminiFallbackModels: models })}
        multi
      />
      <ModelField
        title="Модели расшифровки голосовых"
        description="Голос требует модели умнее диалоговой: дешёвая не разбирает продиктованный номер телефона, и карточки клиентов не объединяются."
        effective={settings?.geminiTranscribeModelsEffective}
        source={settings?.geminiTranscribeModelsSource}
        onSave={(models) => updateSettings.mutateAsync({ geminiTranscribeModels: models })}
        multi
      />
      <ModelField
        title="Дешёвая модель для простых задач"
        description="Классификация, заполнение карточки, перевод расшифровки — около 1200 вызовов в неделю, где полноценная модель избыточна. Пусто — всё идёт обычной моделью. Если дешёвая откажет, вызов сам поднимется на обычную."
        effective={settings?.geminiLiteModelEffective}
        source={settings?.geminiLiteModelSource}
        onSave={(models) => updateSettings.mutateAsync({ geminiLiteModel: models[0] ?? "" })}
      />
      <ModelField
        title="Модель рисования"
        description="Обложки для статей блога. Рисующие модели работают только на платном проекте Google: на бесплатном ответ будет 429, хотя текстовые модели тем же ключом идут."
        effective={settings?.geminiImageModelEffective}
        source={settings?.geminiImageModelSource}
        onSave={(models) => updateSettings.mutateAsync({ geminiImageModel: models[0] ?? "" })}
      />
    </SettingsSection>
  );
}

function GeminiExtraKeysSection() {
  const { data: settings, isSuccess } = useSettings();
  // silent: список ключей ниже сам себя обновляет, ошибка — своим текстом (error state).
  const updateSettings = useUpdateSettings({ silent: true });
  const [newKey, setNewKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const masked = settings?.geminiExtraKeysMasked ?? [];
  /** Ссылки на все сохранённые ключи — основа любого нового списка. */
  const keepAll = masked.map((_, index) => `keep:${index}`);

  /**
   * БЕЗ ЗАГРУЖЕННЫХ НАСТРОЕК НИЧЕГО НЕ СОХРАНЯЕМ (аудит 22.08.2026, раунд 6).
   *
   * Протокол здесь — «на сервер уходит ПОЛНЫЙ новый список» (см. комментарий к
   * секции выше). Пока `/settings` не ответил, `masked` пуст, значит `keepAll`
   * пуст — и добавление одного ключа отправляло `[новый]`, то есть СТИРАЛО ВСЕ
   * ранее сохранённые запасные ключи. Молча и безвозвратно: экран в этот момент
   * ещё писал «Пока ни одного — хватает двух ключей выше».
   */
  const ready = isSuccess && !!settings;

  async function save(next: string[]) {
    if (!ready) {
      setError("Настройки ещё не загрузились — подождите, иначе список ключей перезапишется пустым");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await updateSettings.mutateAsync({ geminiApiKeysExtra: next });
      setNewKey("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить ключ");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="grp-lab">Дополнительные ключи</div>
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Ещё запасные ключи сверх двух верхних — их можно добавить сколько угодно. CRM пробует ключи по очереди: не
          ответил один — сам берётся следующий, клиент этого не замечает. Ключи из разных проектов Google дают и разные
          суточные лимиты, а из одного проекта лимит общий, сколько ключей ни заводи.
        </span>
      </div>

      {masked.length > 0 ? (
        masked.map((mask, index) => (
          <div className="key-row" key={`${mask}-${index}`}>
            {/* Нумерация с третьего: первые два места заняты основным и резервным
                ключами выше — так владельцу виден порядок перебора целиком. */}
            <div className="t">
              <b>Ключ №{index + 3}</b>
              <span>Пробуется по очереди после основного и резервного.</span>
            </div>
            <span className="msk">{mask}</span>
            <button
              className="pill ghost sm"
              type="button"
              disabled={saving || !ready}
              onClick={() => void save(keepAll.filter((_, i) => i !== index))}
            >
              Удалить
            </button>
          </div>
        ))
      ) : ready ? (
        <div className="quiet">
          <span className="dot" />
          <span className="txt">Пока ни одного — хватает двух ключей выше.</span>
        </div>
      ) : (
        /* Пока настройки не пришли, «ни одного» — утверждение, которого мы не
           знаем; здесь оно ещё и опасно, см. комментарий к `ready` выше. */
        <div className="state">
          <span className="sk w40" />
          <span className="sk w22" /> Загружаем список ключей
        </div>
      )}

      <form
        className="fld"
        style={{ marginTop: "var(--s3)" }}
        onSubmit={(e) => {
          e.preventDefault();
          void save([...keepAll, newKey.trim()]);
        }}
      >
        <span className="lab">Добавить ещё один ключ</span>
        <input
          type="password"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder="Ключ начинается с AIza…"
          aria-label="Дополнительный ключ Gemini"
        />
        <div className="wrap" style={{ marginTop: "var(--s2)" }}>
          <button className="pill" type="submit" disabled={saving || !ready || !newKey.trim()}>
            Добавить ключ
          </button>
        </div>
      </form>
      {error && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{error}</span>
        </div>
      )}
    </>
  );
}

/**
 * Способности ИИ внутри CRM — четыре рубильника, которые ничего не говорят
 * клиентам, а решают, что доступно сотрудникам и как дорого это обходится.
 *
 * Рубильник ИИ-ассистента (плавающая кнопка со звёздочкой) выключен по
 * умолчанию: разделом пока никто не пользуется, а каждый вызов — это и токены, и
 * доступ модели к данным CRM. Выключенный ассистент не показывает кнопку и
 * отвергает запрос на сервере: спрятанная кнопка защищает от случайного нажатия,
 * а не от запроса.
 *
 * Google Search grounding (23.08.2026, пункт 4 очереди ИИ): модель сама ищет в
 * живом вебе и отвечает с источниками — квота 1500 запросов/день, клиентов
 * агентства сильно меньше, экономить не на чем (решение владельца 23.08.2026).
 * Клиентского продающего бота (мессенджеры) эта настройка не касается.
 *
 * Семантический подбор существовал в коде и тестах с 23.08, но включить его было
 * НЕОТКУДА: ни в схеме PATCH, ни в интерфейсе (найдено аудитом 26.08.2026).
 *
 * Улучшение фото объекта ИИ (23.08.2026, пункт 7 очереди) — ВЫКЛЮЧЕНО по
 * умолчанию и намеренно после живого теста в тот же день: рисующая модель на
 * реальном фото из /app/uploads убрала с пола строительный мусор и заметно
 * исказила пропорции комнаты, хотя промт прямо запрещал именно это. Владелец
 * решил всё равно строить фичу («хочу протестировать»), но только при трёх
 * условиях, которые не тумблер, а код: результат никогда не подменяет фото
 * молча (PropertyPhotoManager хранит оригинал и кандидата рядом) и требует
 * ручного «Одобрить»/«Отклонить» на каждом снимке отдельно. Сам тумблер
 * решает только одно — есть ли у сотрудников кнопка «Улучшить» вообще.
 */
function AssistantAbilitiesSection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();

  const assistantOn = settings?.aiAssistantEnabled ?? false;
  const groundedOn = settings?.groundedSearchEnabled ?? false;
  const semanticOn = settings?.semanticSearchEnabled ?? false;
  const photoOn = settings?.propertyPhotoEnhanceEnabled ?? false;

  return (
    <SettingsSection icon={Search} title="Помощник внутри CRM" badge={assistantOn ? "включён" : "выключен"}>
      <SwitchRow
        title="Помощник внутри CRM"
        on={assistantOn}
        onToggle={() => updateSettings.mutate({ aiAssistantEnabled: !assistantOn })}
        hint={
          assistantOn
            ? "Плавающая кнопка со звёздочкой видна сотрудникам: диалог с доступом к базе — найти объект, посчитать статистику, посмотреть историю клиента. Каждый вопрос стоит токенов."
            : "Кнопки со звёздочкой нет, и запрос к помощнику сервер отвергает. Включите, когда понадобится — кнопка появится сразу, перезаход не нужен."
        }
      />

      <SwitchRow
        title="Поиск в вебе для справочных вопросов (Google Search grounding)"
        on={groundedOn}
        onToggle={() => updateSettings.mutate({ groundedSearchEnabled: !groundedOn })}
        hint={
          groundedOn
            ? "Помощник CRM отвечает на вопросы о рынке недвижимости, законах, налогах и ипотеке Таджикистана живым поиском Google — с источниками под ответом. На данные внутри CRM (клиенты, объекты, сделки) не влияет. Бота в мессенджерах не касается."
            : "Такие вопросы помощник CRM по-прежнему отклоняет как не относящиеся к работе в CRM. Включите, чтобы он отвечал по актуальным данным из веба."
        }
      />

      <SwitchRow
        title="Семантический подбор объектов в помощнике"
        on={semanticOn}
        onToggle={() => updateSettings.mutate({ semanticSearchEnabled: !semanticOn })}
        hint={
          semanticOn
            ? "Помощник CRM ищет объекты по смыслу запроса («тихая улица, рядом школа»), а не только по фильтрам: сравниваются векторные описания карточек. Индексация карточек идёт всегда — тумблер включает только использование в поиске."
            : "Помощник ищет объекты только по точным фильтрам (район, цена, комнаты). Включите, чтобы понимал запросы своими словами."
        }
      />

      <SwitchRow
        title="Улучшение фото объекта (свет, резкость)"
        on={photoOn}
        onToggle={() => updateSettings.mutate({ propertyPhotoEnhanceEnabled: !photoOn })}
        hint={
          photoOn
            ? "На каждом фото в галерее объекта — кнопка «Улучшить» (световая коррекция, резкость, шумоподавление). Результат никогда не заменяет фото сам: он ждёт рядом с оригиналом, пока сотрудник, который ведёт объект, не нажмёт «Одобрить» или «Отклонить». До одобрения его не видит ни каталог, ни сайт, ни клиент."
            : "Кнопки «Улучшить» в галерее объекта нет, и запрос сервер отвергает."
        }
        warning={
          photoOn
            ? "Рисующая модель может исказить помещение вопреки запрету в промте (проверено живым тестом 23.08.2026) — проверяйте каждый результат глазами перед одобрением."
            : null
        }
      />

      <div className="quiet">
        <span className="dot" />
        <span className="txt">Ещё про помощника настроено не здесь:</span>
        <Link className="lnk" to="/funnel">
          Воронка «комментарий в директ»
        </Link>
        <Link className="lnk" to="/settings?tab=channels">
          Свой промт для аккаунта
        </Link>
      </div>
    </SettingsSection>
  );
}

const CHANNEL_NAMES: Record<string, string> = {
  WHATSAPP: "WhatsApp",
  INSTAGRAM: "Instagram",
  FACEBOOK: "Messenger",
  TELEGRAM: "Telegram",
  // Предложение из недельной сводки выведено сразу из всех каналов, одного у него нет.
  ALL: "все каналы",
  // Заявки на звонок из живого голоса (originateLiveVoiceCallToClient, 13.09.2026) —
  // используют тот же CallbackRequest.channel, что и переписка, просто другое значение.
  LIVE_VOICE: "Живой голос",
};

/** Поле настроек под рубильник бота в каждом канале. Список один на весь экран:
 *  канал добавляется строкой здесь, а не правкой разметки в трёх местах. */
/**
 * «Что бот умеет» — ползунки способностей (решение владельца 01.08.2026 после
 * разговора с заказчиком: показы должен назначать живой агент, пока компанию мало
 * знают, но логику не удалять — вернётся).
 *
 * Список таблицей, а не разметкой: способность добавляется одной строкой здесь.
 *
 * У каждой способности ДВА пояснения, а не одно. Раньше было одно, написанное от
 * выключенного положения («Выключено — бот присылает только ссылку…»), и висело
 * оно и при включённой настройке тоже. Владелец 11.08.2026: «даже если я двигаю,
 * пишет, что выключено». Читалось это не как описание последствий, а как
 * состояние — и правильно читалось: рядом с зелёным тумблером слово «Выключено»
 * означает ровно одно.
 */
const BOT_ABILITIES = [
  {
    field: "botCanSendPhotos",
    title: "Отправлять фотографии объектов",
    onHint: "Бот присылает снимки объекта прямо в переписку — сколько именно, задано ниже.",
    offHint: "Бот присылает только ссылку на объект и снимков не обещает.",
  },
  {
    field: "botCanBookShowings",
    title: "Назначать показы",
    onHint: "Бот сам предлагает клиенту время и записывает его на просмотр.",
    offHint: "Время просмотра согласовывает агент по телефону. Бот берёт номер и передаёт заявку.",
  },
  {
    field: "botCanConfirmShowings",
    title: "Просить подтверждение встречи",
    // Текст один с вкладкой «Лиды» (lib/settingsDependencies.ts): до 28.09.2026 здесь
    // было «накануне… клиента и собственника», а код спрашивает за 4 часа и только клиента.
    onHint: SHOWING_CONFIRM_ON_TEXT,
    offHint: "Клиенту просьба подтвердить показ не уходит: придёт ли он, агент уточняет сам.",
  },
  {
    field: "botCanFollowUp",
    title: "Напоминать молчащим клиентам",
    onHint:
      "Клиенту, который перестал отвечать, бот напоминает о себе. Работает вместе с тумблером «Напоминать клиенту, который замолчал» в разделе «Когда бот пишет» — там же сколько раз и в какие часы.",
    offHint: "Бот не пишет первым. Отвечать на новые сообщения он продолжит.",
  },
  {
    field: "botCanAnswerComments",
    title: "Отвечать на комментарии Instagram",
    onHint: "Бот отвечает под публикациями от имени агентства и скрывает мат и рекламу чужих услуг.",
    offHint: "Комментарии по-прежнему собираются в раздел «Комментарии», но бот под постами молчит.",
  },
  {
    field: "botTopicLockEnabled",
    title: "Возвращать клиента к теме разговора",
    // Держится не просьбой в промте (она молча не срабатывает), а состоянием
    // разговора и проверкой ответа в коде — см. ai/topicLock.ts.
    onHint:
      "Клиент ушёл в сторону — бот отвечает коротко и возвращает свой незакрытый вопрос дословно, пока не получит ответ.",
    offHint: "Бот отвечает на последнюю реплику и свой прежний вопрос не возвращает — нить разговора теряется.",
  },
  {
    field: "botCanAskOwner",
    title: "Обещать «уточню у собственника»",
    // Выключено по умолчанию (решение владельца 16.08.2026): вопросы про торг,
    // мебель и даты закрывает живой агент по звонку.
    onHint:
      "Вопрос, который знает только собственник, бот записывает в очередь «Вопросы к собственнику» и обещает клиенту вернуться с ответом.",
    offHint: "Бот честно говорит, что на такой вопрос ответит агент по телефону, и берёт номер.",
  },
  {
    field: "botCanRequestCallback",
    title: "Соединять с оператором",
    // Смысл рубильника уточнён 23.08.2026: он означает «у нас есть дежурный
    // оператор или колл-центр», а не «бот слышит просьбу о звонке» — слышит он её
    // в обоих положениях (см. ai/callbackRequest.ts на стороне API).
    onHint:
      "Есть дежурный оператор: если клиент в разговоре с телефонным роботом просит живого человека, АТС в рабочее время сама набирает дежурного и соединяет с клиентом. Просьба о звонке из переписки уходит агенту клиента.",
    offHint:
      "Оператора нет — просьба о звонке идёт обычной заявкой: бот уточняет, по какому вопросу звонить, берёт номер, лид распределяется агенту, в карточке появляется «Просит перезвонить».",
  },
  {
    field: "botCanHandleVacancies",
    title: "Принимать кандидатов на вакансии",
    onHint:
      "Спросили про работу — бот вежливо собирает анкету (имя, опыт, языки, телефон) и передаёт её в раздел «Вакансии» для руководства.",
    offHint: "Бот просит прислать резюме на WhatsApp компании и анкету не собирает.",
  },
  {
    field: "botCanSendLinks",
    title: "Отправлять ссылки на объекты",
    onHint: "Бот присылает клиенту ссылку на страницу объекта (там фото и описание).",
    offHint: "Бот описывает объект словами: цена, место, метраж. Ссылку и фото пришлёт агент после звонка.",
  },
  {
    field: "botCanSendVoiceReplies",
    title: "Отвечать голосовым, если клиент прислал голосовое",
    // 13.09.2026, владелец: «создай, но выключи — сам протестирую сначала». До
    // 14.09 у этого поля не было тумблера в интерфейсе вовсе — включить можно
    // было только прямой записью в базу (см. messengers/botCapabilities.ts).
    onHint:
      "Клиент прислал голосовое сообщение — бот, помимо обычного текста, добавляет и голосовой ответ (Meta, Telegram-личка, Telegram Direct Messages). Голос синтезирует Gemini TTS; если синтез не удался, клиент всё равно получает текст.",
    offHint: "Бот всегда отвечает только текстом, даже если клиент прислал голосовое.",
  },
  {
    field: "botCautiousMode",
    title: "Режим запуска: отвечать строго по запросу",
    // Включается на время рекламной волны: в первые дни лучше недопродать, чем
    // оттолкнуть напором (решение владельца 16.08.2026).
    onHint:
      "Бот отвечает ровно на то, что спросили: ничего не предлагает сверх, не разгоняет разговор, номер просит не раньше, чем ответил по существу. Для первых дней рекламы.",
    offHint: "Обычный режим: бот сам предлагает подходящие варианты и ведёт разговор к передаче агенту.",
  },
  {
    field: "botPromptIntentEconomy",
    // НАЗВАНИЕ ПЕРЕИМЕНОВАНО 21.09.2026, поле в базе — нет (миграция ради имени
    // не стоит того). Прежнее название говорило только про экономию токенов, и
    // владелец держал тумблер выключенным: экономить на ответах клиентам он не
    // хотел. Речь же идёт о качестве — экономия лишь побочный эффект.
    title: "Бот-специалист по типу обращения",
    // Ни одно правило не удалено — меняется только то, КОГДА блок подаётся
    // (ai/leadQualifier.ts, buildStableSystem). Выключено = промт как раньше,
    // побайтово, поэтому тумблер безопасно вернуть в любой момент.
    onHint:
      "Сначала бот только разбирается, кто пишет и что нужно: покупатель, продавец, кандидат, аренда или нам предлагают услуги. Как только тип понятен, он получает правила именно этого специалиста — продавцу не предлагает объекты, кандидату не показывает квартиры, рекламному агенту не продаёт. Побочно каждый ответ обходится дешевле: лишние три набора правил не отправляются.",
    offHint:
      "Боту в каждом сообщении уходят правила всех четырёх направлений сразу, и отдельного разбора «кто это пишет» нет вовсе: на первое сообщение он отвечает так же, как на десятое.",
  },
  {
    field: "contactLinkSweepEnabled",
    title: "Ночной поиск двойных досье собеседника",
    // Точные признаки (один номер в разных каналах, названный в переписке номер
    // другого досье) код ловит сразу и без тумблера. Здесь только слабые, и
    // только предложением человеку — слить два досье эта проверка не может
    // вовсе (см. lib/contactLinkSweep.ts).
    onHint:
      "Раз в сутки CRM ищет пары, похожие на одного человека по слабым признакам: одинаковое имя вместе с похожим хвостом номера или один и тот же ник в разных мессенджерах. Найденные пары попадают в «Возможные дубликаты» предложением — объединять или нет, решает человек. Само ничего не сливает.",
    offHint:
      "CRM сводит досье только по точным признакам: один и тот же номер в разных каналах и номер, названный в переписке. Вернувшийся человек с новым номером остаётся для бота незнакомцем.",
  },
  {
    field: "geminiExplicitCachingEnabled",
    title: "Явный кэш правил бота у Google",
    // Меняет форму запроса к Gemini (cachedContent вместо systemInstruction/tools);
    // на любой сбой кэша вызов сам откатывается на обычный путь (ai/geminiCache.ts).
    onHint:
      "Свод правил бота сохраняется у Google на час, и каждый ответ ссылается на него вместо повторной отправки — за эту часть берётся 10% обычной цены, причём гарантированно, а не как повезёт. При любом сбое кэша ответ уходит обычным путём.",
    offHint:
      "Каждый ответ отправляет полный свод правил заново. Google иногда сам узнаёт повтор и даёт скидку, но примерно через раз — без гарантии.",
  },
] as const;

const BOT_CHANNEL_FIELD = {
  WHATSAPP: "botWhatsappEnabled",
  INSTAGRAM: "botInstagramEnabled",
  FACEBOOK: "botFacebookEnabled",
  TELEGRAM: "botTelegramEnabled",
} as const;

type BotChannel = keyof typeof BOT_CHANNEL_FIELD;

/** Что происходит в канале прямо сейчас — одной строкой, честно.
 *  `configured` — есть ли ключи, `transportOn` — подключён ли сам канал. */
function channelStatus(args: {
  configured: boolean;
  transportOn: boolean;
  botEnabled: boolean;
  channelOn: boolean;
}): { text: string; tone: string } {
  if (!args.configured) return { text: "ключи не заполнены", tone: "chip mute" };
  if (!args.transportOn) return { text: "канал выключен", tone: "chip crit" };
  if (!args.botEnabled) return { text: "бот выключен целиком", tone: "chip warn" };
  if (!args.channelOn) return { text: "сообщения идут, бот молчит", tone: "chip warn" };
  return { text: "бот отвечает", tone: "chip ok" };
}

/** Строка канала: название, состояние и собственный рубильник бота. */
function ChannelRow({
  channel,
  configured,
  transportOn,
  botEnabled,
  channelOn,
  onToggle,
}: {
  channel: BotChannel;
  configured: boolean;
  transportOn: boolean;
  botEnabled: boolean;
  channelOn: boolean;
  onToggle: () => void;
}) {
  const status = channelStatus({ configured, transportOn, botEnabled, channelOn });
  return (
    <div className="mod">
      <div className="t">
        <b>
          {CHANNEL_NAMES[channel]} <span className={status.tone}>{status.text}</span>
        </b>
      </div>
      <div className="acts">
        {/* Без ключей канала попросту нет, и переключать в нём нечего — рубильник
            выключен, чтобы владелец не решил, что он что-то настроил. */}
        <Switch
          on={channelOn}
          disabled={!configured}
          onToggle={onToggle}
          label={`Бот отвечает в ${CHANNEL_NAMES[channel]}`}
        />
      </div>
    </div>
  );
}

/**
 * Главный рубильник и рубильники бота по каналам.
 *
 * Рубильник ТРАНСПОРТА (подключён ли канал, есть ли ключи) остался в «Каналах
 * связи» — там же, где сами ключи. Здесь другое: говорит ли бот в этом канале.
 * Это разные вопросы, и раньше их не разделяли: единственным способом унять
 * бота в Instagram было выключить Meta целиком — вместе с WhatsApp, где всё
 * было в порядке, — а вместе с ним переставали приходить и входящие.
 *
 * Выключенный здесь канал ПРОДОЛЖАЕТ принимать сообщения в «Сообщения»: молчит
 * только бот, отвечает сотрудник руками.
 */
function BotPowerSection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const [, setSearchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const botEnabled = settings?.botEnabled ?? true;
  const metaEnabled = settings?.metaEnabled ?? false;
  const ready = settings?.metaChannelsConfigured ?? [];

  const channels: { channel: BotChannel; configured: boolean; transportOn: boolean }[] = [
    { channel: "WHATSAPP", configured: ready.includes("WHATSAPP"), transportOn: metaEnabled },
    { channel: "INSTAGRAM", configured: ready.includes("INSTAGRAM"), transportOn: metaEnabled },
    { channel: "FACEBOOK", configured: ready.includes("FACEBOOK"), transportOn: metaEnabled },
    // У Telegram отдельный бот со своим маркером в окружении сервера, рубильника
    // транспорта у него нет: есть маркер — канал работает.
    {
      channel: "TELEGRAM",
      configured: settings?.telegramConfigured ?? false,
      transportOn: settings?.telegramConfigured ?? false,
    },
  ];

  /** Переключить настройку. Отказ обязан быть виден: положение тумблера
   *  откатывается само (см. useUpdateSettings), и без надписи это выглядело бы
   *  как «нажал, а оно не переключилось». */
  function toggle(field: string, next: boolean) {
    setError(null);
    updateSettings.mutate(
      { [field]: next },
      { onError: (err) => setError(err instanceof Error ? err.message : "Не удалось сохранить настройку") }
    );
  }

  const websiteChatOn = settings?.botWebsiteChatEnabled ?? true;
  const websiteStatus = !botEnabled
    ? { text: "бот выключен целиком", tone: "chip warn" }
    : websiteChatOn
      ? { text: "бот отвечает", tone: "chip ok" }
      : { text: "сообщения идут, бот молчит", tone: "chip warn" };

  return (
    <SettingsSection
      icon={Power}
      title="Рубильник и каналы"
      badge={botEnabled ? "включён" : "выключен"}
      defaultOpen={!botEnabled}
    >
      <div className="mod">
        <div className="t">
          <b>
            Бот отвечает клиентам <StateWord on={botEnabled} />
          </b>
          <span style={{ whiteSpace: "normal" }}>
            {botEnabled
              ? "Отвечает на всех подключённых каналах, круглосуточно."
              : "Сообщения клиентов копятся в CRM, но бот молчит. Отвечайте вручную из «Сообщений»."}
          </span>
        </div>
        <div className="acts">
          <Switch on={botEnabled} onToggle={() => toggle("botEnabled", !botEnabled)} label="Бот отвечает клиентам" />
        </div>
      </div>

      <div className="grp-lab">Бот по каналам</div>
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Можно унять бота в одном канале, оставив остальные. Сообщения клиентов приходят в «Сообщения» в любом
          случае — молчит только бот, ответить руками по-прежнему можно.
        </span>
        <button className="lnk" type="button" onClick={() => setSearchParams({ tab: "channels" }, { replace: true })}>
          Каналы и ключи
        </button>
      </div>

      {channels.map(({ channel, configured, transportOn }) => {
        const field = BOT_CHANNEL_FIELD[channel];
        const channelOn = settings?.[field] ?? true;
        return (
          <ChannelRow
            key={channel}
            channel={channel}
            configured={configured}
            transportOn={transportOn}
            botEnabled={botEnabled}
            channelOn={channelOn}
            onToggle={() => toggle(field, !channelOn)}
          />
        );
      })}

      {/**
       * Чат на сайте — не мессенджер Meta, у него нет ключей и своего
       * рубильника транспорта (сайт либо есть, либо его нет): в ChannelRow
       * заведён формат «есть ключи / нет ключей», который здесь неуместен.
       * Отдельная строка проще, чем натягивать на неё чужую форму.
       */}
      <div className="mod">
        <div className="t">
          <b>
            Чат на сайте <span className={websiteStatus.tone}>{websiteStatus.text}</span>
          </b>
        </div>
        <div className="acts">
          <Switch
            on={websiteChatOn}
            onToggle={() => toggle("botWebsiteChatEnabled", !websiteChatOn)}
            label="Бот отвечает в чате на сайте"
          />
        </div>
      </div>

      <div className="grp-lab">Что бот умеет</div>
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Каждую способность можно выключить отдельно, не трогая остальное. Выключенное бот не только перестаёт
          делать, но и перестаёт обещать: например, без показов он не спрашивает «когда вам удобно приехать», а
          говорит, что агент позвонит и договорится.
        </span>
      </div>

      {BOT_ABILITIES.map(({ field, title, onHint, offHint }) => {
        const on = settings?.[field] ?? true;
        // Прежнее предупреждение «пока „Назначать показы“ выключено, подтверждать
        // нечего» было неправдой (аудит 28.09.2026): просьбу подтвердить шлёт крон
        // (lib/meetingReminders.ts::sendShowingConfirmationRequests) по ЛЮБОМУ
        // показу, в том числе назначенному агентом, и botCanBookShowings он не
        // читает. Настоящий напарник этого тумблера — «Просить клиента подтвердить
        // показ» во вкладке «Лиды»; без него просьбы не уходят.
        const showingBlock =
          field === "botCanConfirmShowings" && on && settings ? showingConfirmBlockedBy(settings, "bot") : null;
        // Напоминания молчащим держат два тумблера и число (cron.ts::sendFollowUps).
        const followUpBlock =
          field === "botCanFollowUp" && on && settings ? followUpBlockedBy(settings, "ability") : null;
        const idle = showingBlock ? (
          <>
            {showingBlock}{" "}
            <Link className="lnk" to="/settings?tab=leads">
              Открыть «Лиды»
            </Link>
          </>
        ) : followUpBlock ? (
          followUpBlock
        ) : // Включённый рубильник без назначенного дежурного = обещание звонка,
        // которое некому выполнить: клиенту сказано «сейчас позвоним», а АТС
        // не набирает никого.
        field === "botCanRequestCallback" && on && !settings?.callbackOperatorAgentId ? (
          "Дежурный оператор не назначен — АТС никого не наберёт. Выберите сотрудника ниже."
        ) : null;
        return (
          <SwitchRow
            key={field}
            title={title}
            on={on}
            hint={on ? onHint : offHint}
            onToggle={() => toggle(field, !on)}
            warning={idle}
          />
        );
      })}

      <PhotosPerOfferField />
      {/* Список постов вакансии нужен только когда бот вообще разговаривает с
          кандидатами: при выключенном рубильнике поле было бы мёртвым. */}
      {(settings?.botCanHandleVacancies ?? true) && <VacancyPostCodesField />}
      {/* Выбор дежурного нужен только там, где он есть: при выключенном рубильнике
          звонит обычный агент по заявке, и настройка была бы мёртвой. */}
      {(settings?.botCanRequestCallback ?? false) && <CallbackOperatorField />}

      {error && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{error}</span>
        </div>
      )}
    </SettingsSection>
  );
}

/**
 * Дежурный оператор обратных звонков — стоит под ползунком «Соединять с оператором»
 * как его продолжение. Владелец 16.08.2026: «сейчас Нурмухаммад, потом будет другой
 * человек» — потому выпадающий список сотрудников, а не имя в коде.
 *
 * В списке только сотрудники с внутренним номером (SIP): без него АТС физически
 * некому звонить, и выбор такого человека молча ломал бы авто-соединение.
 */
function CallbackOperatorField() {
  const { data: settings } = useSettings();
  const { data: agents } = useAgents();
  const updateSettings = useUpdateSettings();
  const [error, setError] = useState<string | null>(null);

  const withSip = (agents ?? []).filter((a) => a.sipExtension);
  const current = settings?.callbackOperatorAgentId ?? "";

  async function save(next: string) {
    setError(null);
    try {
      await updateSettings.mutateAsync({ callbackOperatorAgentId: next || null });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить дежурного");
    }
  }

  return (
    <>
      <div className="mod">
        <div className="t">
          <b>Дежурный оператор обратных звонков</b>
          <span style={{ whiteSpace: "normal" }}>
            Клиент попросил звонок — в рабочее время АТС сразу набирает этого сотрудника (на трубке имя клиента и
            тема), он снимает, и станция соединяет с клиентом. Ночные просьбы прозваниваются сами с началом рабочего
            дня. Ему же приходит уведомление, когда клиент в переписке прямо просит живого человека (у клиента со
            своим агентом — агенту). Пусто — авто-соединения нет.
          </span>
        </div>
        <div className="acts">
          <select
            className="inp"
            style={{ maxWidth: 220 }}
            id="callback-operator"
            aria-label="Дежурный оператор обратных звонков"
            value={current}
            onChange={(e) => void save(e.target.value)}
            disabled={updateSettings.isPending}
          >
            <option value="">Не назначен</option>
            {withSip.map((a) => (
              <option key={a.id} value={a.id}>
                {a.fullName} (вн. {a.sipExtension})
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{error}</span>
        </div>
      )}
    </>
  );
}

/**
 * Сколько снимков уходит за один показ.
 *
 * Стоит под ползунком «Отправлять фотографии» нарочно: это его продолжение, а не
 * отдельная тема. До 02.08.2026 число было зашито тройкой в коде — владелец просил
 * ровно обратного: любое число правится в Настройках.
 *
 * Про «каждая фотография — отдельное сообщение» написано прямо в подсказке: именно
 * из-за этого цена десятки не в трафике, а в том, что клиент получает десять
 * уведомлений подряд, а Meta считает это поводом ограничить отправку.
 */
/**
 * ПУБЛИКАЦИИ ВАКАНСИИ — чтобы пересланный рилс не получал ответ «видео не открылось».
 *
 * Сущности «пост вакансии» в CRM нет: код публикации ищется только среди объектов
 * (Property.instagramUrl), и ролик вакансии не находился нигде — бот отвечал
 * кандидату «Видео у меня не открылось. Вы такую квартиру ищете?». Список правится
 * здесь, потому что маркетинг меняет ролик чаще, чем мы выкатываем код.
 */
function VacancyPostCodesField() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // По самому полю, а не по объекту настроек: фоновое обновление любой соседней
  // настройки иначе сбрасывает набранное (тот же разбор, что у PhotosPerOfferField).
  const stored = settings?.botVacancyPostCodes;
  useEffect(() => {
    if (stored !== undefined) setValue(stored ?? "");
  }, [stored]);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setSaved(false);
        try {
          await updateSettings.mutateAsync({ botVacancyPostCodes: value.trim() || null });
          setSaved(true);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Не удалось сохранить");
        }
      }}
    >
      <div className="mod">
        <div className="t">
          <b>Посты вакансии (коды или ссылки)</b>
          <span style={{ whiteSpace: "normal" }}>
            Одна публикация в строке — либо ссылка целиком, либо её короткий код. Переслал такой ролик или написал
            прямо с него — бот сразу понимает, что разговор о работе, и не спрашивает про квартиры. Пусто — действует
            список по умолчанию из кода.
          </span>
        </div>
        <div className="fld">
          <span className="lab">Публикации</span>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
            rows={3}
            aria-label="Посты вакансии"
            placeholder={"DdXBttGMLXT\nhttps://www.instagram.com/reel/XXXXXXXXXXX/"}
            style={{ fontFamily: "var(--ff-mono, monospace)" }}
          />
        </div>
        <div className="acts">
          <button className="pill sm" type="submit" disabled={updateSettings.isPending}>
            {updateSettings.isPending ? "Сохранение..." : "Сохранить"}
          </button>
          {saved && <span className="saved on">Сохранено</span>}
        </div>
        {error && (
          <div className="quiet crit" role="alert">
            <span className="dot crit" />
            <span className="txt">{error}</span>
          </div>
        )}
      </div>
    </form>
  );
}

function PhotosPerOfferField() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const [value, setValue] = useState("3");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // По самому полю, а не по объекту настроек — иначе фоновое обновление любой
  // посторонней настройки сбрасывает набранное (см. разбор в SellerRulesSection).
  const botPhotosPerOffer = settings?.botPhotosPerOffer;
  useEffect(() => {
    if (botPhotosPerOffer !== undefined) setValue(String(botPhotosPerOffer));
  }, [botPhotosPerOffer]);

  const canSendPhotos = settings?.botCanSendPhotos ?? true;

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setSaved(false);
        try {
          await updateSettings.mutateAsync({ botPhotosPerOffer: Number(value) });
          setSaved(true);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Не удалось сохранить");
        }
      }}
    >
      <div className="mod">
        <div className="t">
          <b>Сколько фотографий отправлять за раз</b>
          <span style={{ whiteSpace: "normal" }}>
            Каждая фотография уходит отдельным сообщением. Три — столько присылает живой агент: общий вид, комната,
            кухня. Больше шести клиент читает как рассылку, а Meta — как повод придержать отправку.
          </span>
        </div>
        <div className="acts">
          <span className="nf">
            <input
              type="number"
              min={1}
              max={10}
              inputMode="numeric"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-label="Снимков за показ"
            />
            <span className="u">штук</span>
          </span>
          <button className="pill sm" type="submit" disabled={updateSettings.isPending}>
            Сохранить
          </button>
        </div>
        {/* Условный рендер, а не hidden: на flex-элементе hidden не срабатывает. */}
        {!canSendPhotos && (
          <p className="msg" style={{ color: "var(--warn)" }}>
            Отправка фотографий сейчас выключена ползунком выше — число начнёт действовать, когда включите её обратно.
          </p>
        )}
      </div>
      <div className="wrap">
        {saved && <span className="saved on">Сохранено</span>}
        {error && (
          <span className="saved" style={{ color: "var(--crit)" }}>
            {error}
          </span>
        )}
      </div>
    </form>
  );
}

/**
 * Пауза перед ответом и окно напоминаний — числа, которые до сих пор жили только
 * в базе. Оба поля пары сохраняются одной кнопкой: сервер проверяет их вместе
 * (потолок не может быть меньше паузы), и раздельные кнопки давали бы отказ на
 * половине правки.
 */
function BotTimingSection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();

  const [delay, setDelay] = useState("25");
  const [maxWait, setMaxWait] = useState("90");
  const [attempts, setAttempts] = useState("1");
  const [windowStart, setWindowStart] = useState("08:00");
  const [windowEnd, setWindowEnd] = useState("20:00");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<"timing" | "window" | "attempts" | null>(null);

  // По самим полям, а не по объекту настроек (см. разбор в SellerRulesSection).
  const botReplyDelaySec = settings?.botReplyDelaySec;
  const botReplyMaxWaitSec = settings?.botReplyMaxWaitSec;
  const followUpMaxAttempts = settings?.followUpMaxAttempts;
  const followUpWindowStart = settings?.followUpWindowStart;
  const followUpWindowEnd = settings?.followUpWindowEnd;
  useEffect(() => {
    if (!settings) return;
    setDelay(String(botReplyDelaySec));
    setMaxWait(String(botReplyMaxWaitSec));
    setAttempts(String(followUpMaxAttempts ?? 1));
    setWindowStart(followUpWindowStart!);
    setWindowEnd(followUpWindowEnd!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botReplyDelaySec, botReplyMaxWaitSec, followUpMaxAttempts, followUpWindowStart, followUpWindowEnd]);

  const followUpEnabled = settings?.followUpEnabled ?? true;
  // Второй тумблер той же функции живёт в «Что бот умеет» (botCanFollowUp), и крон
  // требует оба плюс число больше нуля (cron.ts::sendFollowUps) — показываем здесь.
  const followUpBlock = followUpEnabled && settings ? followUpBlockedBy(settings, "schedule") : null;

  async function save(what: "timing" | "window" | "attempts", body: Record<string, unknown>) {
    setError(null);
    setSaved(null);
    try {
      await updateSettings.mutateAsync(body);
      setSaved(what);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить");
    }
  }

  return (
    <SettingsSection icon={Clock} title="Когда бот пишет" badge="4 настройки">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save("timing", {
            botReplyDelaySec: Number(delay),
            botReplyMaxWaitSec: Number(maxWait),
          });
        }}
      >
        <div className="mod">
          <div className="t">
            <b>Пауза перед ответом</b>
            <span style={{ whiteSpace: "normal" }}>
              Люди пишут рвано, по три сообщения подряд. Бот ждёт тишины и отвечает на всю пачку сразу, а не на каждый
              обрывок. Пока клиент дописывает, ожидание продлевается — но не дольше потолка.
            </span>
          </div>
          <div className="acts">
            <span className="nf">
              <input
                type="number"
                min={0}
                max={60}
                inputMode="numeric"
                value={delay}
                onChange={(e) => setDelay(e.target.value)}
                aria-label="Ждать тишины, секунд"
              />
              <span className="u">секунд тишины</span>
            </span>
            <span className="nf">
              <input
                type="number"
                min={5}
                max={600}
                inputMode="numeric"
                value={maxWait}
                onChange={(e) => setMaxWait(e.target.value)}
                aria-label="Потолок ожидания, секунд"
              />
              <span className="u">потолок</span>
            </span>
          </div>
          {/* Ноль — разрешённое значение (min=0), и именно оно даёт то, на что жалуются:
              бот отвечает на каждое сообщение отдельно. Со стороны это выглядит поломкой
              бота, а не настройкой, поэтому цена объясняется прямо здесь. Условный
              рендер, а не hidden: на flex-элементе hidden не срабатывает. */}
          {Number(delay) === 0 && (
            <p className="msg" style={{ color: "var(--warn)" }}>
              Ноль отключает ожидание совсем: бот ответит на каждое сообщение отдельно, даже если клиент пишет три
              подряд с интервалом в пару секунд.
            </p>
          )}
        </div>
        <div className="wrap" style={{ marginTop: "var(--s3)" }}>
          <button className="pill ghost" type="submit" disabled={updateSettings.isPending}>
            Сохранить паузу
          </button>
          {saved === "timing" && <span className="saved on">Сохранено</span>}
        </div>
      </form>

      <div className="mod">
        <div className="t">
          <b>
            Напоминать клиенту, который замолчал <StateWord on={followUpEnabled} />
          </b>
          <span style={{ whiteSpace: "normal" }}>
            {followUpEnabled
              ? "Напоминания укладываются в сутки с последнего сообщения клиента: позже Meta просто не доставит письмо. Ответам клиенту это не мешает: написал в два ночи — бот ответит сразу. Работает вместе с «Напоминать молчащим клиентам» в «Что бот умеет» — нужны оба."
              : "Бот не напоминает о себе первым. На новые сообщения клиента он по-прежнему отвечает."}
          </span>
        </div>
        <div className="acts">
          <Switch
            on={followUpEnabled}
            onToggle={() =>
              updateSettings.mutate(
                { followUpEnabled: !followUpEnabled },
                { onError: (err) => setError(err instanceof Error ? err.message : "Не удалось сохранить настройку") }
              )
            }
            label="Напоминать клиенту, который замолчал"
          />
        </div>
        {followUpBlock && (
          <p className="msg" style={{ color: "var(--warn)" }}>
            {followUpBlock}
          </p>
        )}
      </div>

      {/* Окно прячем условным рендером, а не атрибутом hidden: на flex-элементе
          hidden не срабатывает — правило из base перебивается утилитой. */}
      {followUpEnabled && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save("attempts", { followUpMaxAttempts: Number(attempts) });
          }}
        >
          <div className="mod">
            <div className="t">
              <b>Сколько раз напоминать</b>
              <span style={{ whiteSpace: "normal" }}>
                Одно напоминание по умолчанию: кто не ответил на первое, на второе не отвечает чаще, а навязчивость
                запоминает. Больше трёх расписание не позволяет — цепочка обязана уложиться в сутки Meta.
              </span>
            </div>
            <div className="acts">
              <select
                className="inp"
                style={{ maxWidth: 160 }}
                aria-label="Сколько раз напомнить"
                value={attempts}
                onChange={(e) => setAttempts(e.target.value)}
              >
                {/* Ноль сервер принимает (равен выключенному тумблеру), но выбрать его
                    здесь нельзя: без этой строки сохранённый ноль показывался как «Одно». */}
                {attempts === "0" && <option value="0">Ни одного — не напоминать</option>}
                <option value="1">Одно</option>
                <option value="2">Два</option>
                <option value="3">Три</option>
              </select>
              <button className="pill sm" type="submit" disabled={updateSettings.isPending}>
                Сохранить
              </button>
            </div>
          </div>
          <div className="wrap">{saved === "attempts" && <span className="saved on">Сохранено</span>}</div>
        </form>
      )}

      {followUpEnabled && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save("window", { followUpWindowStart: windowStart, followUpWindowEnd: windowEnd });
          }}
        >
          <div className="mod">
            <div className="t">
              <b>Окно напоминаний</b>
              <span style={{ whiteSpace: "normal" }}>
                Часы по Душанбе, в которые боту разрешено писать первым. Напоминание, выпавшее на ночь, переносится на
                начало окна.
              </span>
            </div>
            <div className="acts">
              <span className="nf">
                <input
                  type="time"
                  value={windowStart}
                  onChange={(e) => setWindowStart(e.target.value)}
                  aria-label="Напоминать с"
                  style={{ width: 112 }}
                />
              </span>
              <span className="nf">
                <input
                  type="time"
                  value={windowEnd}
                  onChange={(e) => setWindowEnd(e.target.value)}
                  aria-label="Напоминать до"
                  style={{ width: 112 }}
                />
              </span>
            </div>
          </div>
          <div className="wrap" style={{ marginTop: "var(--s3)" }}>
            <button className="pill ghost" type="submit" disabled={updateSettings.isPending}>
              Сохранить окно
            </button>
            {saved === "window" && <span className="saved on">Сохранено</span>}
          </div>
        </form>
      )}

      {error && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{error}</span>
        </div>
      )}
    </SettingsSection>
  );
}

/**
 * Карточка промта: текст, «изменён/стандартный», сохранение и сброс.
 *
 * Один компонент на оба промта (диалог и комментарии) нарочно. Они ведут себя
 * одинаково во всём, что важно: действующий текст приходит с сервера, пустое
 * поле означает «вернуть зашитый по умолчанию», а не «промта нет». Две копии
 * этой формы разъехались бы на первой же правке — и разъехались бы молча.
 */
function PromptCard({
  title,
  field,
  value,
  isCustom,
  hint,
  rows = 16,
}: {
  title: string;
  /** Поле Настроек, куда сохранять. */
  field: "botSystemPrompt" | "botCommentPrompt" | "reelsCaptionTemplates" | "liveVoicePrompt";
  /** Действующий текст с сервера (свой или зашитый по умолчанию). */
  value: string | undefined;
  isCustom: boolean;
  hint: React.ReactNode;
  rows?: number;
}) {
  const updateSettings = useUpdateSettings();
  const [prompt, setPrompt] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (value !== undefined) setPrompt(value);
  }, [value]);

  async function save(next: string) {
    setError(null);
    setSaved(false);
    try {
      await updateSettings.mutateAsync({ [field]: next });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить промт");
    }
  }

  return (
    <SettingsSection
      icon={Sparkles}
      title={title}
      badge={isCustom ? `изменён · ${prompt.length} знаков` : `стандартный · ${prompt.length} знаков`}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(prompt);
        }}
      >
        <div className="fld">
          <span className="lab">Главные указания боту</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            spellCheck={false}
            rows={rows}
            aria-label={title}
            style={{ fontFamily: "var(--ff-mono, monospace)" }}
          />
          <span className="msg">{hint}</span>
        </div>
        <div className="wrap" style={{ marginTop: "var(--s3)" }}>
          <button className="pill ghost" type="submit" disabled={updateSettings.isPending || !prompt.trim()}>
            {updateSettings.isPending ? "Сохранение..." : "Сохранить промт"}
          </button>
          {isCustom && (
            <button className="pill ghost" type="button" onClick={() => void save("")}>
              Вернуть прежний
            </button>
          )}
          {saved && <span className="saved on">Сохранено</span>}
        </div>
        {/* Причина недоступности — видимым текстом: серая кнопка сама по себе
            читается как «нет прав», а тут дело в пустом поле. И сразу подсказка,
            чем вернуть стандартный текст, — очистить и сохранить нельзя. */}
        {!prompt.trim() && (
          <div className="quiet">
            <span className="dot" />
            <span className="txt">
              Поле пустое — сохранять нечего.{" "}
              {isCustom ? "Стандартный текст вернёт кнопка «Вернуть прежний»." : "Сейчас действует стандартный текст."}
            </span>
          </div>
        )}
        {error && (
          <div className="quiet crit" role="alert">
            <span className="dot crit" />
            <span className="txt">{error}</span>
          </div>
        )}
      </form>
    </SettingsSection>
  );
}

/**
 * Шаблоны подписи под Reels (решение владельца 04.08.2026): несколько текстов
 * с плейсхолдерами, разделены строкой `---`, выбираются случайно при создании
 * объекта и по кнопке «Перегенерировать». Плейсхолдеры: {{type}}, {{district}},
 * {{address}}, {{documents}}, {{rooms}}, {{bathroom}}, {{windowCount}},
 * {{areaSqm}}, {{floor}}, {{totalFloors}}, {{condition}}, {{price}}, {{phone}},
 * {{hashtags}} (26.09.2026 — район/тип хештегами, см. lib/reelsCaptionTemplate.ts)
 * — строка с плейсхолдером, для которого у объекта нет данных (например,
 * {{rooms}} у участка), убирается из подписи целиком, а не остаётся пустой.
 */
export function ReelsCaptionTemplatesSection() {
  const { data: settings } = useSettings();
  return (
    <PromptCard
      title="Шаблоны подписи под ролики"
      field="reelsCaptionTemplates"
      value={settings?.reelsCaptionTemplates}
      isCustom={settings?.reelsCaptionTemplatesIsCustom ?? false}
      rows={20}
      hint={
        <>
          Несколько шаблонов одним текстом, разделены строкой из трёх дефисов (<code>---</code>) на отдельной строке.
          При создании объекта и по кнопке «Перегенерировать» на карточке выбирается случайный. Плейсхолдеры:{" "}
          <code>{"{{type}}"}</code> <code>{"{{district}}"}</code> <code>{"{{address}}"}</code>{" "}
          <code>{"{{documents}}"}</code> <code>{"{{rooms}}"}</code> <code>{"{{bathroom}}"}</code>{" "}
          <code>{"{{windowCount}}"}</code> <code>{"{{areaSqm}}"}</code> <code>{"{{floor}}"}</code>{" "}
          <code>{"{{totalFloors}}"}</code> <code>{"{{condition}}"}</code> <code>{"{{price}}"}</code>{" "}
          <code>{"{{phone}}"}</code> (телефон интейкера/ответственного), <code>{"{{hashtags}}"}</code> (район и тип
          объекта хештегами — «Соавторы по умолчанию» в разделе публикаций рядом с ним же). Строка с плейсхолдером,
          для которого у объекта нет данных (например, комнаты у участка или санузел, если он не заполнен в карточке),
          убирается из подписи целиком — дырок в тексте не остаётся. Никакой оплаты за ИИ: подстановка бесплатна и
          мгновенна.
        </>
      }
    />
  );
}

/**
 * Промт диалога — «личность» бота. Переехал сюда из вкладки «ИИ»: там остались
 * ключи и выбор модели, то есть чем бот думает, а не что он говорит.
 */
export function BotPromptSection() {
  const { data: settings } = useSettings();
  return (
    <PromptCard
      title="Промт диалога"
      field="botSystemPrompt"
      value={settings?.botSystemPrompt}
      isCustom={settings?.botSystemPromptIsCustom ?? false}
      hint={
        <>
          «Личность» бота: кто он, к чему ведёт разговор, каким языком и какими словами говорит. Это ваш текст —
          правьте свободно, обновления системы его больше не перезаписывают. Дублировать здесь правила не нужно:
          запрет выдумывать объекты и цены, обращения на «Шумо» без указания пола, отсутствие смайликов, приветствие
          один раз, карта районов Душанбе и список жилых комплексов, условия сделки и формат ответа приклеиваются к
          промту автоматически и действуют, что бы вы тут ни написали.
        </>
      }
    />
  );
}

/**
 * Промт ответов на комментарии — второй голос бота, и до сих пор единственный,
 * которого нельзя было тронуть иначе как правкой кода. А цена ошибки здесь выше,
 * чем в переписке: неудачную реплику в личке видит один человек, неудачный ответ
 * под постом — все подписчики.
 *
 * Правится только постоянная часть — правила поведения. Данные конкретного случая
 * (карточка объекта, подпись публикации, «этому человеку мы уже отвечали») и
 * формат ответа подставляет код: их правка не сделала бы бота послушнее, зато
 * очищенное поле оставило бы его без фактов и сломало бы ответы молча.
 */
function BotCommentPromptSection() {
  const { data: settings } = useSettings();
  return (
    <PromptCard
      title="Промт ответов на комментарии"
      field="botCommentPrompt"
      value={settings?.botCommentPrompt}
      isCustom={settings?.botCommentPromptIsCustom ?? false}
      rows={14}
      hint={
        <>
          Что и как бот отвечает под публикациями в Instagram: язык, длина ответа, что считать спамом и когда звать в
          директ. Цену, район и ссылку на объект бот подставляет сам из карточки — в тексте их не задают. Очистите
          поле и сохраните — вернётся стандартный промт, бот без инструкций не останется.
        </>
      }
    />
  );
}

const percent = (share: number): string => `${Math.round(share * 100)}%`;

/**
 * Полоска неопределённости: где доля заявок может лежать на самом деле.
 *
 * Показываем именно ОТРЕЗОК, а не одну цифру, нарочно. «14%» выглядит как факт, хотя
 * на сорока диалогах это «где-то от 6% до 28%» — и вся разница между манерами
 * помещается внутрь такого отрезка. Пока отрезки соседей перекрываются, сравнивать
 * нечего, и это должно быть видно глазами, а не выводиться из подписи мелким шрифтом.
 */
function RateBar({ item }: { item: ScenarioStats }) {
  const left = item.rateLow * 100;
  const width = Math.max(1, (item.rateHigh - item.rateLow) * 100);
  // Отрезок, а не заливка от нуля, поэтому составная полоса `.prog.split`: три
  // куска, средний и есть разброс. Доля куска задаётся переменной `--v` — ширина
  // и marginLeft тут бессильны, кусок рисуется через flex и scaleX (см. прототип).
  return (
    <div className="prog split" style={{ marginTop: 6 }} aria-hidden="true">
      <i className="rest" style={{ "--v": left } as React.CSSProperties} />
      <i
        style={
          {
            "--v": width,
            background: item.enough ? undefined : "var(--line-strong)",
          } as React.CSSProperties
        }
      />
      <i className="rest" style={{ "--v": Math.max(0, 100 - left - width) } as React.CSSProperties} />
    </div>
  );
}

/** Одна манера продажи: название, числа и честная ширина разброса. */
function ScenarioRow({ item, isLeader }: { item: ScenarioStats; isLeader: boolean }) {
  return (
    <div className="mod" style={{ display: "block" }}>
      <div className="wrap">
        <b style={{ flex: 1, minWidth: 0 }}>{item.name}</b>
        {isLeader && <span className="chip ok">впереди</span>}
        {!item.known && <span className="chip mute">нет в коде</span>}
        <span className="money">{item.conversations > 0 ? percent(item.rate) : "нет данных"}</span>
      </div>

      <p className="msg" style={{ color: "var(--muted)" }}>
        {item.summary}
      </p>

      <RateBar item={item} />

      <p className="msg" style={{ color: "var(--muted)" }}>
        диалогов {item.conversations} · заявок {item.leads} · ушли молча {item.lost} · ещё не решилось {item.undecided}
      </p>

      {/* Разброс подписываем словами рядом с самой полоской: без него владелец
          прочитает «14%» как измеренную величину, а это оценка с широкими краями. */}
      {item.conversations > 0 && (
        <p className="msg" style={{ color: "var(--faint)" }}>
          на самом деле где-то между {percent(item.rateLow)} и {percent(item.rateHigh)}
          {item.enough ? "" : ", диалогов слишком мало, число ничего не доказывает"}
        </p>
      )}
    </div>
  );
}

/**
 * Вывод по набранным числам — главное, ради чего экран и существует.
 *
 * Тон намеренно сдержанный: три из четырёх состояний здесь это «выводов пока нет».
 * Так и должно быть. Красивый процент, показанный на сорока диалогах, стоит компании
 * дороже пустого экрана: по нему принимают решение, а он случайный.
 */
function ScenarioVerdictBanner({ data }: { data: ScenarioComparison }) {
  const thin = data.scenarios.filter((s) => s.conversations > 0 && !s.enough);
  const leader = data.scenarios.find((s) => s.id === data.leaderId);

  if (data.verdict === "no_data") {
    return (
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Сравнение ещё не начиналось: ни один диалог не получил манеру продажи. Впишите тексты манер в код и включите
          сравнение — числа начнут копиться с первого же нового клиента.
        </span>
      </div>
    );
  }

  if (data.verdict === "too_little") {
    return (
      <div className="quiet warn">
        <span className="dot warn" />
        <span className="txt">
          Данных слишком мало — выводы делать рано.{" "}
          {thin.length > 0
            ? `Нужно хотя бы ${data.minConversationsPerScenario} диалогов на каждую манеру, чтобы числа перестали прыгать от одного случайного клиента. `
            : "Сравнивать пока не с чем: манера всего одна. "}
          Чтобы уверенно заметить манеру, которая приносит в полтора раза больше заявок, понадобится около{" "}
          {data.requiredPerScenario} диалогов на каждую.
        </span>
      </div>
    );
  }

  if (data.verdict === "no_difference") {
    return (
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Разницы между манерами не видно. Диалогов набралось достаточно, но отрыв укладывается в случайность: сегодня
          впереди одна манера, завтра другая. Это тоже ответ — значит манеры для клиента почти одинаковы. Ждать имеет
          смысл примерно до {data.requiredPerScenario} диалогов на каждую, дальше стоит менять сами тексты.
        </span>
      </div>
    );
  }

  return (
    <div className="quiet">
      <span className="dot ok" />
      <span className="txt">
        Впереди «{leader?.name}». Отрыв больше случайного разброса: {percent(leader?.rate ?? 0)} заявок против
        остальных, на {leader?.conversations} диалогах. Это повод сделать эту манеру основной — впишите её текст в
        манеру «Как сейчас» и выключите сравнение.
      </span>
    </div>
  );
}

/**
 * Сравнение манер продажи бота.
 *
 * ПОЧЕМУ НЕ «КАЖДЫЙ ДЕНЬ НОВАЯ МАНЕРА». Дни несопоставимы между собой: в выходные
 * пишут одни люди, в будни другие, запустили рекламу — пришла толпа холодных
 * любопытных, праздник — не пришёл никто. Разброс между днями заведомо больше
 * разницы между манерами разговора, и вывод получился бы про погоду, а не про бота.
 * Поэтому манера достаётся КАЖДОМУ НОВОМУ ДИАЛОГУ по жребию и закрепляется за ним
 * навсегда: все манеры живут в одних и тех же сутках, с одной и той же публикой, и
 * всё лишнее делится между ними поровну. Данные копятся не по точке в день, а по
 * точке на диалог — ответ приходит в разы быстрее.
 *
 * И почему тут так много слов про «мало данных». Потому что это единственное
 * честное состояние первых дней, а интерфейс, показывающий в этот момент бодрые
 * проценты, прямо толкает принять решение по шуму.
 */
function BotScenariosSection() {
  const { data, isLoading, refetch } = useBotScenarios();
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const [error, setError] = useState<string | null>(null);

  const testEnabled = settings?.salesScenarioTestEnabled ?? false;

  function toggle() {
    setError(null);
    updateSettings.mutate(
      { salesScenarioTestEnabled: !testEnabled },
      { onError: (err) => setError(err instanceof Error ? err.message : "Не удалось переключить сравнение") }
    );
  }

  return (
    <SettingsSection icon={FlaskConical} title="Манеры продажи" badge={testEnabled ? "идёт сравнение" : "выключено"}>
      <div className="mod">
        <div className="t">
          <b>
            Сравнивать манеры продажи <StateWord on={testEnabled} />
          </b>
          <span style={{ whiteSpace: "normal" }}>
            {testEnabled
              ? "Каждый новый диалог получает манеру по жребию и остаётся на ней до конца разговора."
              : "Все новые диалоги идут на манере «Как сейчас». Уже начатые доживают на своей."}
          </span>
        </div>
        <div className="acts">
          <Switch on={testEnabled} onToggle={toggle} label="Сравнивать манеры продажи" />
        </div>
      </div>

      {isLoading ? (
        <div className="state">
          <span className="sk w40" />
          <span className="sk w22" /> Загружаем числа сравнения
        </div>
      ) : !data ? (
        /* Тупик без выхода: раньше здесь была одна серая строка без причины и без
           пути дальше — раздел с этого места выглядел мёртвым. */
        <div className="state err">
          <span className="dot crit" />
          Числа не загрузились — это сбой связи, а не «сравнения нет».{" "}
          <button
            className="lk"
            type="button"
            style={{ color: "inherit", textDecoration: "underline" }}
            onClick={() => void refetch()}
          >
            Повторить
          </button>
        </div>
      ) : (
        <>
          <ScenarioVerdictBanner data={data} />
          <div className="quiet">
            <span className="dot" />
            <span className="txt">
              Всего диалогов со сравнением: {data.totalConversations}, заявок из них: {data.totalLeads}.
              {data.startedAt ? ` Считаем с ${new Date(data.startedAt).toLocaleDateString("ru-RU", { timeZone: "Asia/Dushanbe" })}.` : ""}
            </span>
          </div>

          {data.scenarios.map((item) => (
            <ScenarioRow key={item.id} item={item} isLeader={item.id === data.leaderId} />
          ))}

          <div className="quiet">
            <span className="dot" />
            <span className="txt">
              «Ушли молча» считается тем же разбором, что и в карточке «Куда уходят клиенты», и появляется не сразу:
              диалог признаётся оборванным только через полтора суток тишины. Пока этого не случилось, он лежит в «ещё
              не решилось».
            </span>
          </div>
        </>
      )}
      {error && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{error}</span>
        </div>
      )}
    </SettingsSection>
  );
}

/**
 * «Тренировка ответов» (23.08.2026, пункт 6 очереди ИИ) — рубильник для отдельного
 * экрана /bot-training: владелец отвечает на реальные вопросы клиентов из живых
 * переписок, выбирая лучший из сгенерированных вариантов или вписывая свой. Пара
 * уходит в те же образцы манеры, что и TAKEOVER/HISTORY (StyleExample,
 * ai/styleLearning.ts) — только источником "TRAINING".
 *
 * Здесь только тумблер и ссылка на сам экран — тот же приём, что у «Манер продажи»
 * (BotScenariosSection) выше: карточка Настроек короткая, а рабочий процесс живёт
 * на отдельной странице, куда не тащат подтверждение личности на каждый клик.
 */
function BotTrainingSection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const [error, setError] = useState<string | null>(null);

  const enabled = settings?.botTrainingScreenEnabled ?? false;

  function toggle() {
    setError(null);
    updateSettings.mutate(
      { botTrainingScreenEnabled: !enabled },
      { onError: (err) => setError(err instanceof Error ? err.message : "Не удалось переключить экран тренировки") }
    );
  }

  return (
    <SettingsSection icon={Dumbbell} title="Тренировка ответов" badge={enabled ? "экран включён" : "экран скрыт"}>
      <SwitchRow
        title="Экран «Тренировка»"
        hint={
          enabled
            ? "Задаёте вопрос — выбираете лучший из вариантов ответа или вписываете свой. Пара уходит в примеры манеры бота, рядом с уже накопленными."
            : "Экран скрыт от владельца. Включите, чтобы отвечать на реальные вопросы клиентов и научить бота своей манерой."
        }
        on={enabled}
        onToggle={toggle}
      />
      {enabled && (
        <div className="wrap" style={{ marginTop: "var(--s3)" }}>
          <Link className="pill ghost" to="/ai-learning?tab=manner">
            Открыть тренировку
          </Link>
        </div>
      )}
      {error && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{error}</span>
        </div>
      )}
    </SettingsSection>
  );
}

/**
 * Комментарии под постами Instagram — указатель, а не лента.
 *
 * Прежний текст «эта часть ещё не сделана» стал враньём: бот отвечает на
 * комментарии и скрывает спам в проде. Но саму ленту сюда не переносим: в
 * Настройках лежит то, что настраивают, а комментарии смотрят каждый день и
 * ищут в них конкретный случай — такому место в разделе меню, рядом с
 * «Сообщениями», а не в четвёртой карточке седьмой вкладки Настроек.
 *
 * Поэтому здесь остаётся одно: сказать, что бот делает от имени агентства, и
 * дать короткий путь туда, где это видно. Сам текст ответов теперь правится
 * выше, в карточке «Промт ответов на комментарии».
 */
function BotCommentsSection() {
  const can = useCan();
  const canSee = can("messages.view");
  // Только счётчики: pageSize=1, чтобы ради двух цифр не возить страницу ленты.
  const { data } = useInstagramComments({ pageSize: 1 }, { enabled: canSee });
  const hidden = data?.counts.HIDDEN ?? 0;
  const waiting = data?.counts.ESCALATED ?? 0;

  return (
    <SettingsSection icon={MessageCircle} title="Комментарии под постами Instagram">
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Бот отвечает на комментарии под нашими публикациями и скрывает от подписчиков мат, травлю и рекламу чужих
          услуг. Претензии и критику он не прячет — на них отвечает. Отвечает не сразу, а через 1–3 минуты, чтобы не
          выдавать робота.
        </span>
      </div>
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Включается тем же рубильником, что и переписка, — отдельного выключателя у комментариев нет. Что именно бот
          пишет под постами, задаётся выше, в карточке «Промт ответов на комментарии».
        </span>
      </div>

      {canSee && (
        <div className="quiet">
          <span className="dot" />
          <span className="txt">
            Скрыто от подписчиков: {hidden} · ждут вашего слова: {waiting}
          </span>
          <Link className="lnk" to="/comments">
            Открыть ленту
          </Link>
        </div>
      )}
    </SettingsSection>
  );
}

/**
 * ЖИВОЙ ГОЛОС ПО ТЕЛЕФОНУ — ВСЁ В ОДНОМ МЕСТЕ (13.09.2026, просьба владельца
 * «полный контроль из админки, всё вместе с нашим ботом»). Раньше рубильник и
 * тестовый номер жили в «Каналах связи», а личность/голос/звук были ТОЛЬКО
 * зашитыми константами кода (apps/api/src/lib/telephony/liveVoiceBridge.ts,
 * apps/api/src/ai/liveVoicePersona.ts) — их вообще нельзя было увидеть, не то
 * что поменять, не открывая репозиторий. Теперь то же объединение, что уже
 * когда-то сделали для текстового бота (см. докстринг вверху файла): один
 * рубильник, одно место.
 *
 * Всё, что здесь не тронуто явным полем, остаётся зашитым в коде намеренно —
 * например длительность вдоха и громкость самого щелчка (не факт «есть/нет»,
 * а миллисекунды/децибелы) — это тонкая настройка, которую нельзя проверить
 * на слух без живого звонка, и трогать её ползунком вслепую опаснее, чем
 * полезно. Список того, что ЕЩЁ можно вынести сюда, — docs/TASKS.md.
 */
/**
 * АДРЕС СОБЕСЕДОВАНИЯ (25.09.2026) — робот, приглашающий кандидата, называет
 * его вслух. Пусто — говорит, что адрес пришлют сообщением.
 */
function InterviewAddressField({
  value,
  pending,
  onSave,
}: {
  value: string;
  pending: boolean;
  onSave: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const changed = draft.trim() !== value.trim();
  return (
    <div className="fld" style={{ marginTop: "var(--s3)" }}>
      <label className="lab" htmlFor="interview-address">
        Адрес собеседования
      </label>
      <input
        id="interview-address"
        value={draft}
        maxLength={300}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Например: ул. Айни 45, 3 этаж, офис Royal Home"
      />
      <span className="msg">
        Робот называет его кандидату, когда зовёт на собеседование. Пусто — скажет, что адрес пришлём сообщением.
      </span>
      {changed && (
        <div className="wrap" style={{ marginTop: "var(--s2)" }}>
          <button className="pill sm" type="button" disabled={pending} onClick={() => onSave(draft.trim())}>
            Сохранить адрес
          </button>
        </div>
      )}
    </div>
  );
}

function LiveVoiceSection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const enabled = settings?.liveVoiceEnabled ?? false;
  const voice = settings?.liveVoiceVoiceName || "Kore";
  const voiceTajik = settings?.liveVoiceVoiceNameTajik || "";
  const russianOnly = settings?.liveVoiceForceRussianOnly ?? true;
  const provider = settings?.liveVoiceProvider ?? "google";
  const preview = useLiveVoicePreviewVoice();
  const [previewLang, setPreviewLang] = useState<"ru" | "tg">("ru");
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Прослушать можно любой из двух голосов (владелец 25.09.2026 выбирает русский
  // на слух): раньше кнопка озвучивала только основной, таджикский — никак.
  const listen = async (which: { voice: string; language: "ru" | "tg" } = { voice, language: previewLang }) => {
    setPreviewError(null);
    try {
      const result = await preview.mutateAsync(which);
      const url = pcmBase64ToWavUrl(result.audioBase64, result.sampleRateHz);
      const audio = new Audio(url);
      audio.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
      await audio.play();
    } catch (err) {
      // Не всё — «проверьте ключ»: лимит прослушиваний (429) и нехватка прав (403)
      // приходят со своим текстом сервера (аудит роботов №23).
      setPreviewError(
        err instanceof ApiError && (err.status === 429 || err.status === 403)
          ? err.message
          : "Не удалось озвучить — проверьте ключ Gemini и «Здоровье системы»."
      );
    }
  };

  return (
    <SettingsSection icon={Mic} title="Живой голос по телефону" badge={enabled ? "включено" : "выключено"}>
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Консультант разговаривает с клиентом вслух через {provider === "elevenlabs" ? "ElevenLabs" : "Gemini Live"}.
          Настоящие входящие он берёт, только когда ниже выбрано, когда ему брать трубку; иначе обычные звонки
          агентства эта настройка не трогает.
        </span>
      </div>
      <div className="quiet warn">
        <span className="dot warn" />
        <span className="txt">
          Экспериментально: звук нельзя проверить автоматически, каждая правка ниже подтверждается только живым
          звонком.
        </span>
      </div>

      {settings?.liveVoiceRtpProblem && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">На сервере не настроен приём звука разговора со станции: робот возьмёт трубку и промолчит. Попросите администратора сервера задать адрес и порт для звука — пока их нет, переключатель ниже ничего не даст.</span>
        </div>
      )}

      <SwitchRow
        title="Живой голос"
        hint={
          enabled
            ? "Включено — CRM держит отдельное подключение к станции и примет звонок на тестовый номер ниже, если он заполнен."
            : "Выключено — CRM не открывает это подключение вовсе, независимо от того, заведён ли номер на станции."
        }
        on={enabled}
        onToggle={() => updateSettings.mutate({ liveVoiceEnabled: !enabled })}
      />

      <ConsultantInboundFields enabled={enabled} />

      <PlainSetting
        title="Тестовый внутренний номер"
        description="Номер, который владелец завёл на самой станции и направил в Stasis-приложение royalhome-live-voice. Пусто — тестовый номер не отвечает. Настоящие входящие от этого поля не зависят: их берёт консультант по режиму выше."
        placeholder="1099"
        value={settings?.liveVoiceTestExtension ?? ""}
        pending={updateSettings.isPending}
        onSave={(v) => updateSettings.mutate({ liveVoiceTestExtension: v || null })}
      />

      <LiveVoiceProviderFields />

      {provider === "google" && (
        <>
          <div className="fld" style={{ marginTop: "var(--s4)" }}>
            <span className="lab">Голос</span>
            <select
              value={voice}
              onChange={(e) => updateSettings.mutate({ liveVoiceVoiceName: e.target.value })}
              disabled={updateSettings.isPending}
              aria-label="Голос живого голоса"
            >
              {GEMINI_VOICE_CATALOG.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.title}
                </option>
              ))}
            </select>
            <span className="msg">
              Каталог голосов Gemini — 30 штук, разной подачи; пол голоса указан в списке, и о себе робот говорит в роде
              своего голоса («поняла» или «понял»). «Прослушать» просит у модели приветствие по тому же промту, что у звонка
              по карточке и проверочного звонка (с вашей личностью ниже, если она задана), поэтому фраза каждый раз
              немного другая.
            </span>
            <div className="wrap" style={{ marginTop: "var(--s2)" }}>
              <select
                value={previewLang}
                onChange={(e) => setPreviewLang(e.target.value as "ru" | "tg")}
                aria-label="Язык предпрослушивания"
                style={{ maxWidth: 160 }}
              >
                <option value="ru">По-русски</option>
                <option value="tg">По-таджикски</option>
              </select>
              <button className="pill ghost" type="button" onClick={() => void listen()} disabled={preview.isPending}>
                {preview.isPending ? "Озвучиваю…" : "Прослушать"}
              </button>
            </div>
            {previewError && (
              <div className="quiet crit" role="alert">
                <span className="dot crit" />
                <span className="txt">{previewError}</span>
              </div>
            )}
          </div>

          <div className="fld" style={{ marginTop: "var(--s3)" }}>
            <span className="lab">Голос для таджикского</span>
            <select
              value={voiceTajik}
              onChange={(e) => updateSettings.mutate({ liveVoiceVoiceNameTajik: e.target.value || null })}
              disabled={updateSettings.isPending}
              aria-label="Голос для таджикского языка"
            >
              <option value="">Тот же, что и для русского</option>
              {GEMINI_VOICE_CATALOG.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.title}
                </option>
              ))}
            </select>
            <span className="msg">
              Голос выбирается до ответа и на весь звонок. Тем, кто уже говорил с нами по-таджикски (в чате или по
              телефону), и тем, кто звонит впервые, консультант отвечает этим голосом; тем, кто говорил по-русски, —
              голосом выше. Пока включён «Только русский», всегда голос выше. Кандидатам, писавшим по-таджикски, робот с
              приглашением на собеседование звонит этим голосом всегда.
            </span>
            {voiceTajik && voiceGender(voiceTajik) !== voiceGender(voice) && (
              <div className="quiet warn" role="status">
                <span className="dot warn" />
                <span className="txt">
                  Голоса разного пола: один и тот же клиент в разные звонки услышит то женщину, то мужчину.
                </span>
              </div>
            )}
            <div className="wrap" style={{ marginTop: "var(--s2)" }}>
              <button
                className="pill ghost"
                type="button"
                onClick={() => void listen({ voice: voiceTajik || voice, language: "tg" })}
                disabled={preview.isPending}
              >
                {preview.isPending ? "Озвучиваю…" : "Прослушать по-таджикски"}
              </button>
            </div>
          </div>
        </>
      )}

      <InterviewAddressField
        value={settings?.interviewInviteAddress ?? ""}
        pending={updateSettings.isPending}
        onSave={(v) => updateSettings.mutate({ interviewInviteAddress: v || null })}
      />

      <SwitchRow
        title="Только русский (диагностика акцента)"
        hint={
          russianOnly
            ? "Включено — бот не переключается на таджикский, даже если собеседник заговорит на нём. Google добавил таджикский в Live API в сентябре 2026: выключите и проверьте живым тестовым звонком, ушёл ли акцент."
            : "Выключено — бот отвечает на языке собеседника, включая таджикский, как задумано изначально. Проверьте живым тестовым звонком, что акцент приемлемый — Google добавил язык недавно, качество не гарантировано только фактом поддержки."
        }
        on={russianOnly}
        onToggle={() => updateSettings.mutate({ liveVoiceForceRussianOnly: !russianOnly })}
      />

      <LiveVoiceSoundDesignFields settings={settings} pending={updateSettings.isPending} onSave={updateSettings.mutate} />

      <LiveVoicePromptCard
        value={settings?.liveVoicePrompt}
        isCustom={settings?.liveVoicePromptIsCustom ?? false}
      />

      <SwitchRow
        title="Звонить покупателю после показа и проверять собственника"
        hint={
          enabled
            ? "Через 2–3 часа после показа CRM сама звонит покупателю и спрашивает, как всё прошло — но только если он после показа ничего не написал и не говорил с агентом через CRM. Этот же тумблер включает и звонок собственнику показанного объекта («квартира ещё в продаже?»): он набирается только когда по показу сошлись признаки обхода агентства. Звонки идут с 09:00 до 19:00 по Душанбе, кроме общих выходных из раздела «Сотрудники», не чаще одного на клиента в неделю, максимум две попытки. Тем, кто просил не беспокоить, и номерам из чёрного списка станции робот не звонит."
            : "Недоступно, пока выключен живой голос выше: звонок идёт через тот же мост со станцией."
        }
        on={settings?.postShowingCallEnabled ?? false}
        disabled={!enabled}
        onToggle={() => updateSettings.mutate({ postShowingCallEnabled: !(settings?.postShowingCallEnabled ?? false) })}
      />

      <LiveVoiceOutboundTestCall enabled={enabled} />

      {/* Список последних звонков живого голоса живёт в «Звонках» (владелец
          14.09.2026: «они не должны быть тут»); #363 вернул сюда вторую копию,
          23.09.2026 сведено в components/LiveVoiceSessions.tsx. Здесь — ссылка. */}
      <div className="quiet" style={{ marginTop: "var(--s4)" }}>
        <span className="dot" />
        <span className="txt">
          Расшифровки и записи звонков живого голоса — в разделе{" "}
          <Link className="lnk" to="/calls">
            «Звонки»
          </Link>
          , под журналом разговоров.
        </span>
      </div>
    </SettingsSection>
  );
}

/**
 * КТО СЛЫШИТ И ГОВОРИТ ЗА РОБОТА (02.10.2026, владелец сравнивает ElevenLabs с
 * Gemini Live по телефону). Роль, справочник, досье и функции у обоих наши —
 * меняются только слух, голос и модель разговора (apps/api/src/ai/liveVoiceProvider.ts).
 * Поля ElevenLabs видны только при выборе ElevenLabs; переключатель действует со
 * следующего звонка. Один экран на обе ширины — разметка теми же .fld/.wrap.
 */
function LiveVoiceProviderFields() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  // silent: SecretKeyEditor сам пишет «Ключ сохранён»/ошибку под полем.
  const saveKey = useUpdateSettings({ silent: true });
  const check = useElevenLabsCheck();
  const provider = settings?.liveVoiceProvider ?? "google";

  return (
    <>
      <div className="fld" style={{ marginTop: "var(--s4)" }}>
        <span className="lab">Голос и слух</span>
        <select
          value={provider}
          onChange={(e) => updateSettings.mutate({ liveVoiceProvider: e.target.value as typeof provider })}
          disabled={updateSettings.isPending}
          aria-label="Голос и слух робота"
        >
          <option value="google">Google</option>
          <option value="elevenlabs">ElevenLabs</option>
        </select>
        <span className="msg">
          Кто слышит собеседника и говорит за робота. Роль, справочник агентства, поиск квартир, СМС, перевод
          агенту и запись в карточку — одни и те же при любом выборе. Действует со следующего звонка. Если
          ElevenLabs не ответит, звонок уйдёт на автоответчик, как при сбое Google.
        </span>
      </div>

      {provider === "elevenlabs" && (
        <>
          <SecretKeyEditor
            title="Ключ ElevenLabs"
            description="Берётся в кабинете ElevenLabs: Developers → API Keys. Нужен доступ к агентам."
            placeholder="Ключ начинается с sk_…"
            configured={settings?.elevenLabsApiKeyConfigured}
            masked={settings?.elevenLabsApiKeyMasked}
            source={settings?.elevenLabsApiKeySource}
            onSave={(key) => saveKey.mutateAsync({ elevenLabsApiKey: key })}
            onClear={() => saveKey.mutateAsync({ elevenLabsApiKey: "" })}
          />
          <PlainSetting
            title="Код агента ElevenLabs"
            description="Из кабинета ElevenLabs: Agents → ваш агент, код виден в адресе страницы и в настройках агента."
            placeholder="agent_…"
            value={settings?.elevenLabsAgentId ?? ""}
            pending={updateSettings.isPending}
            onSave={(v) => updateSettings.mutate({ elevenLabsAgentId: v || null })}
          />
          <PlainSetting
            title="Голос для русского (код голоса)"
            description="Из библиотеки голосов ElevenLabs. Пусто — голос, выбранный у агента в кабинете."
            placeholder="Например, код голоса Sherali"
            value={settings?.elevenLabsVoiceIdRu ?? ""}
            pending={updateSettings.isPending}
            onSave={(v) => updateSettings.mutate({ elevenLabsVoiceIdRu: v || null })}
          />
          <PlainSetting
            title="Голос для таджикского (код голоса)"
            description="Тем, кто говорил с нами по-таджикски, робот отвечает этим голосом. Пусто — тот же, что для русского. Пока включён «Только русский», всегда голос для русского."
            placeholder="Например, код голоса Sherali"
            value={settings?.elevenLabsVoiceIdTg ?? ""}
            pending={updateSettings.isPending}
            onSave={(v) => updateSettings.mutate({ elevenLabsVoiceIdTg: v || null })}
          />
          <div className="fld" style={{ marginTop: "var(--s3)" }}>
            <span className="lab">Пол голоса для русского</span>
            <select
              value={settings?.elevenLabsVoiceGender ?? "female"}
              onChange={(e) => updateSettings.mutate({ elevenLabsVoiceGender: e.target.value as "female" | "male" })}
              disabled={updateSettings.isPending}
              aria-label="Пол голоса ElevenLabs для русского"
            >
              <option value="female">Женский</option>
              <option value="male">Мужской</option>
            </select>
            <span className="msg">
              Нужен, чтобы робот говорил о себе в своём роде: женский голос — «поняла», мужской — «понял». По коду
              голоса пол не узнать, поэтому укажите его сами.
            </span>
          </div>
          <div className="wrap" style={{ marginTop: "var(--s3)" }}>
            <button className="pill ghost" type="button" onClick={() => check.mutate()} disabled={check.isPending}>
              {check.isPending ? "Проверяю…" : "Проверить и подготовить агента"}
            </button>
          </div>
          {check.data?.ok && (
            <div className="quiet" role="status">
              <span className="dot" />
              <span className="txt">
                Агент «{check.data.agentName ?? "без имени"}» готов: заведено функций — {check.data.toolsSynced ?? 0}.
              </span>
            </div>
          )}
          {(check.data?.ok === false || check.isError) && (
            <div className="quiet crit" role="alert">
              <span className="dot crit" />
              <span className="txt">
                {check.data?.error ?? "Проверка не прошла — подробности в «Здоровье системы»."}
              </span>
            </div>
          )}
        </>
      )}
    </>
  );
}

/**
 * КОНСУЛЬТАНТ НА ВХОДЯЩИХ (24.09.2026, Dan: «автоответчика больше не будет»; ИИ
 * берёт, «если оператор не взял», и ночью; всё меняется здесь в любой момент).
 * Исполняет станция: значения уезжают в неё при сохранении (failoverSync.ts), а
 * строки диалплана ставятся на станцию один раз (ops/asterisk/extensions_custom.conf).
 *
 * Кому переводить — только сотрудники с внутренним номером: без него станции
 * некому звонить (тот же принцип, что у дежурного обратных звонков).
 */
/**
 * МОЖЕТ ЛИ КОНСУЛЬТАНТ БРАТЬ ТРУБКУ НА САМОМ ДЕЛЕ (28.09.2026, разбор «выбрал
 * консультанта, а отвечает автоответчик»). Выбор выше исполняют сервер и станция,
 * и каждая сторона раньше могла молча его не исполнить: сервер без адреса звука
 * отдаёт станции пустой режим (failoverSync.ts), станция со старым диалпланом не
 * зовёт консультанта вовсе (stationHealth.ts, проверка раз в 15 минут). Здесь —
 * правда из ответа сервера (GET /settings → liveVoiceInbound) и часы, по которым
 * считается «рабочее время» консультанта: они общие с раздачей лидов.
 */
function ConsultantInboundStatus({ mode }: { mode: "no_answer" | "always" }) {
  const { data: settings } = useSettings();
  const status = settings?.liveVoiceInbound;
  const dialplan = status?.stationDialplan ?? null;
  const start = settings?.workHoursStart ?? "09:30";
  const end = settings?.workHoursEnd ?? "18:00";
  return (
    <>
      {mode === "no_answer" && (
        <div className="quiet">
          <span className="dot" />
          <span className="txt">
            Рабочее время консультанта сейчас с {start} до {end} по Душанбе. Это те же часы, что «Когда лиды уходят
            агентам» в разделе «Сотрудники → Распределение лидов»: поменяете там — поменяется и здесь.
          </span>
        </div>
      )}
      {status && !status.rtpHostConfigured && (
        <div className="quiet warn" role="alert">
          <span className="dot warn" />
          <span className="txt">
            Сейчас консультант трубку не берёт: на сервере не задан адрес и порт для звука (LIVE_VOICE_RTP_HOST и
            LIVE_VOICE_RTP_PORT в файле настроек сервера). Станции передано «не звать консультанта», звонки идут по-старому, на автоответчик. Нужен
            администратор сервера.
          </span>
        </div>
      )}
      {dialplan?.ok === false && (
        <div className="quiet warn" role="alert">
          <span className="dot warn" />
          <span className="txt">
            Станция не зовёт консультанта: {(dialplan.detail ?? "").replace(/;\s*нужно .*$/, "")}. Что сделать администратору станции: обновить диалплан
            станции из ops/asterisk/extensions_custom.conf, dialplan reload. Проверено {relativeTime(dialplan.checkedAt)}.
          </span>
        </div>
      )}
      {status && (dialplan === null || dialplan.ok === null) && (
        <div className="quiet">
          <span className="dot" />
          <span className="txt">
            Готова ли станция звать консультанта, сводная проверка телефонии узнаёт раз в 15 минут — результат появится
            здесь.
          </span>
        </div>
      )}
    </>
  );
}

function ConsultantInboundFields({ enabled }: { enabled: boolean }) {
  const { data: settings } = useSettings();
  const { data: agents } = useAgents();
  const updateSettings = useUpdateSettings();
  const mode = settings?.liveVoiceInboundMode ?? "off";
  const wait = settings?.liveVoiceInboundWaitSeconds ?? 30;
  const [waitDraft, setWaitDraft] = useState(String(wait));
  const [waitError, setWaitError] = useState<string | null>(null);
  useEffect(() => setWaitDraft(String(wait)), [wait]);
  const withSip = (agents ?? []).filter((a) => a.sipExtension);

  const saveWait = () => {
    const n = Math.round(Number(waitDraft));
    if (!Number.isFinite(n) || n < 10 || n > 90) {
      // Раньше значение молча откатывалось, и казалось, что поле не сохраняется.
      setWaitError(`Ждать оператора можно от 10 до 90 секунд. Оставлено прежнее значение: ${wait}.`);
      setWaitDraft(String(wait));
      return;
    }
    setWaitError(null);
    if (n !== wait) updateSettings.mutate({ liveVoiceInboundWaitSeconds: n });
  };

  return (
    <>
      <div className="fld" style={{ marginTop: "var(--s4)" }}>
        <span className="lab">Когда консультант берёт трубку</span>
        <select
          value={mode}
          onChange={(e) => updateSettings.mutate({ liveVoiceInboundMode: e.target.value as typeof mode })}
          disabled={updateSettings.isPending || !enabled}
          aria-label="Когда консультант берёт входящие"
        >
          <option value="off">Не берёт (как раньше, автоответчик)</option>
          <option value="no_answer">Если оператор не взял, и ночью сразу</option>
          <option value="always">Всегда отвечает первым</option>
        </select>
        <span className="msg">
          {!enabled
            ? "Сначала включите живой голос выше."
            : mode === "no_answer"
              ? `Днём звонит оператор, через ${wait} секунд трубку берёт консультант. Вне рабочих часов консультант отвечает сразу: часы берутся из «Сотрудники → Когда лиды уходят агентам» (сейчас ${settings?.workHoursStart ?? "09:30"}–${settings?.workHoursEnd ?? "18:00"}), а не из правила «Нерабочее время» в «Каналы связи». Автоответчика нет: он включается, только если консультант недоступен. Консультант говорит с одним человеком за раз: второй звонок в это же время уходит на автоответчик.`
              : mode === "always"
                ? "Консультант первым отвечает незнакомым номерам и клиентам без своего агента и сам соединяет с агентом, когда нужно. Клиент, у которого есть свой агент, сначала попадает к нему (Каналы связи → Телефония, «Звонок известного клиента — сразу его агенту»); не взял — трубку берёт консультант. Консультант говорит с одним человеком за раз: второй звонок в это же время уходит на автоответчик."
                : "Входящие идут по-старому: оператор, потом автоответчик."}
        </span>
      </div>

      {enabled && mode !== "off" && <ConsultantInboundStatus mode={mode} />}

      {enabled && mode === "no_answer" && (
        <div className="fld" style={{ marginTop: "var(--s3)" }}>
          <span className="lab">Сколько секунд ждать оператора</span>
          <input
            className="inp"
            type="number"
            min={10}
            max={90}
            inputMode="numeric"
            value={waitDraft}
            onChange={(e) => setWaitDraft(e.target.value)}
            onBlur={saveWait}
            disabled={updateSettings.isPending}
            aria-label="Сколько секунд ждать оператора"
            style={{ maxWidth: 120 }}
          />
          <span className="msg">От 10 до 90 секунд. У звонящего обычно около минуты гудков, дольше ставить незачем.</span>
          {waitError && (
            <div className="quiet warn" role="alert">
              <span className="dot warn" />
              <span className="txt">{waitError}</span>
            </div>
          )}
        </div>
      )}

      {enabled && (
        <div className="fld" style={{ marginTop: "var(--s3)" }}>
          <span className="lab">Кому соединять, если агента объекта и своего агента нет</span>
          <select
            value={settings?.liveVoiceTransferAgentId ?? ""}
            onChange={(e) => updateSettings.mutate({ liveVoiceTransferAgentId: e.target.value || null })}
            disabled={updateSettings.isPending}
            aria-label="Кому консультант соединяет новых звонящих"
          >
            <option value="">Дежурному оператору обратных звонков</option>
            {withSip.map((a) => (
              <option key={a.id} value={a.id}>
                {a.fullName} (вн. {a.sipExtension})
              </option>
            ))}
          </select>
          <span className="msg">
            Узнал объект — соединяет с агентом объекта, звонит свой клиент — с его агентом. Соединяет только в
            рабочее время; не взяли трубку — звонок возвращается к консультанту.
          </span>
        </div>
      )}
    </>
  );
}

/**
 * Звук помещения — реальный офисный амбиент + вдох. Отдельный компонент —
 * иначе LiveVoiceSection распухает до нечитаемости, а эта часть меняется реже
 * прочих.
 *
 * СИНТЕТИЧЕСКИЙ ГУЛ И ЩЕЛЧКИ КЛАВИАТУРЫ УБРАНЫ ЦЕЛИКОМ (14.09.2026, решение
 * владельца после появления настоящей записи офиса: «в этих mp3 есть любой
 * нужный мне шум» — генерировать искусственный гул/щелчок поверх настоящей
 * записи, где эти же звуки уже есть по-настоящему, стало не запасным
 * вариантом, а просто лишним слоем). Соответствующие функции
 * (generateComfortNoiseFrame/maybeAddTypingClick), константы и поля Settings —
 * удалены из liveVoiceBridge.ts/schema.prisma тем же коммитом, не только
 * скрыты из интерфейса.
 */
function LiveVoiceSoundDesignFields({
  settings,
  pending,
  onSave,
}: {
  settings: ReturnType<typeof useSettings>["data"];
  pending: boolean;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  // С 02.10.2026 оба по умолчанию выключены — как в схеме и в мосте.
  const breath = settings?.liveVoiceBreathEnabled ?? false;
  const officeAmbience = settings?.liveVoiceOfficeAmbienceEnabled ?? false;
  const officeAmbienceVolume = settings?.liveVoiceOfficeAmbienceVolume ?? 0.35;

  return (
    <div className="fld" style={{ marginTop: "var(--s4)" }}>
      <span className="lab">Звук помещения</span>

      <SwitchRow
        title="Настоящий офисный амбиент"
        hint="Реальная запись офиса (голоса, шаги, клавиатура на фоне) — один из двух файлов выбирается случайно на каждый звонок. Выключено — полная цифровая тишина в паузах бота (синтетический генератор шума и щелчков клавиатуры убраны 14.09.2026 — свои голоса и клавиатура в этой записи уже есть, дублировать нечего)."
        on={officeAmbience}
        onToggle={() => onSave({ liveVoiceOfficeAmbienceEnabled: !officeAmbience })}
      />
      {officeAmbience && (
        <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 220, marginTop: "var(--s2)" }}>
          <span className="note">Громкость амбиента: {Math.round(officeAmbienceVolume * 100)}%</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(officeAmbienceVolume * 100)}
            disabled={pending}
            onChange={(e) => onSave({ liveVoiceOfficeAmbienceVolume: Number(e.target.value) / 100 })}
            aria-label="Громкость офисного амбиента"
          />
        </label>
      )}

      <SwitchRow
        title="Вдох перед репликой"
        hint="Короткий вдох перед тем, как бот начинает говорить — приём, чтобы речь не звучала «по-дикторски» идеально ровно."
        on={breath}
        onToggle={() => onSave({ liveVoiceBreathEnabled: !breath })}
      />
    </div>
  );
}

/** Личность живого голоса — тот же PromptCard, что у текстового бота, просто
 *  другое поле Настроек (liveVoicePrompt). AGENCY_VOICE (факты компании) и
 *  контекст звонка (имя клиента/объект) эта замена не трогает — см.
 *  buildLiveVoiceSystemPrompt, apps/api/src/ai/liveVoicePersona.ts.
 *  Действует на звонок по карточке, проверочный звонок и звонок на тестовый номер (bridge: promptSettingsFrom);
 *  консультант и сценарные звонки её не читают (аудит роботов №5, Д24). */
function LiveVoicePromptCard({ value, isCustom }: { value: string | undefined; isCustom: boolean }) {
  return (
    <PromptCard
      title="Личность живого голоса"
      field="liveVoicePrompt"
      value={value}
      isCustom={isCustom}
      hint="Действует на «Звонок роботом» из карточки клиента, исходящий проверочный звонок и звонок на тестовый внутренний номер (так же слышно в «Прослушать»). На настоящие входящие не действует. Консультант на входящих, опрос после показа, проверка собственника и приглашения на собеседование берут свои тексты и этот не используют. Текст заменяет личность целиком, поэтому в нём должны остаться правила, когда записать имя и номер, когда попрощаться и положить трубку и когда позвать человека — без них сервер сохранить не даст (образец — стандартный текст). Общие правила голоса (как называть числа, честный ответ «вы робот?», язык) к вашему тексту добавляются сами. Факты о компании и данные о клиенте и объекте на этом звонке добавляются всегда."
      rows={12}
    />
  );
}

/**
 * Исходящий тестовый звонок (12.09.2026) — бот сам звонит на указанный номер,
 * в отличие от тестового внутреннего номера выше (туда звонят САМИ). Набор идёт
 * тем же путём, что и звонок агента на мобильный (`from-internal`), поэтому
 * звонок реальный и платный — кнопка не срабатывает без явного нажатия.
 */
function LiveVoiceOutboundTestCall({ enabled }: { enabled: boolean }) {
  const [phone, setPhone] = useState("");
  const call = useLiveVoiceTestCall();

  return (
    <div style={{ marginTop: "var(--s4)" }}>
      <div className="lbl">Исходящий тестовый звонок</div>
      <div className="quiet">
        <span className="dot" />
        <span className="txt">Бот сам наберёт указанный номер — удобно проверить, не набирая тестовый номер станции руками.</span>
      </div>
      <div className="wrap" style={{ marginTop: "var(--s2)" }}>
        <input
          className="inp"
          type="tel"
          placeholder="+992 90 000 00 00"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          disabled={call.isPending}
        />
        <button
          className="pill ghost"
          type="button"
          onClick={() => call.mutate(phone)}
          disabled={!enabled || !phone.trim() || call.isPending}
        >
          {call.isPending ? "Звоню…" : "Позвонить для проверки"}
        </button>
        {call.data && (
          <span className={call.data.ok ? "saved on" : "saved"} style={call.data.ok ? undefined : { color: "var(--crit)" }}>
            {call.data.ok ? "Звоню — трубка должна зазвонить в течение минуты" : call.data.error}
          </span>
        )}
      </div>
      {!enabled && (
        <div className="quiet">
          <span className="dot" />
          <span className="txt">Сначала включите тумблер «Живой голос» выше.</span>
        </div>
      )}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  operator_override: "Вместо бота ответил сотрудник",
  client_confused: "Клиент не понял ответ",
  // Эти два вида пишутся в базу давно (звонки — с 07.08.2026, ручной разбор
  // оборванной переписки — с 30.08.2026), а подписей у них не было: в ленте
  // владелец читал латиницей «call_answer».
  call_answer: "Как ответил агент по телефону",
  lost_client: "Предложение из недельной сводки",
  lost_manual: "Оборванная переписка, отправлена в разбор вручную",
};

/** Первоисточник правила: что сказал бот и что ответил человек. Без него выключать
 *  правило пришлось бы вслепую — по одной формулировке не видно, откуда она взялась.
 *  Разметка — пары «вопрос/ответ» `.qa` эталона. */
function LessonSource({ item }: { item: BotLesson }) {
  return (
    <div className="qa">
      <div className="ask">
        <span className="k2">Бот сказал</span>
        <div className="body2">
          <p style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{item.botMessage}</p>
        </div>
      </div>
      <div className="ans">
        <span className="k2">{item.kind === "operator_override" ? "Сотрудник ответил" : "Клиент ответил"}</span>
        <div className="body2">
          <p style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{item.humanMessage}</p>
        </div>
      </div>
    </div>
  );
}

/** Шапка случая: откуда он и когда был. */
function LessonMeta({ item }: { item: BotLesson }) {
  return (
    <span className="meta">
      {KIND_LABEL[item.kind] ?? item.kind} · {CHANNEL_NAMES[item.channel] ?? item.channel} ·{" "}
      {relativeTime(item.createdAt)}
    </span>
  );
}

/**
 * Вопросы бота «как отвечать».
 *
 * Это случаи, где бот сплоховал, а правила из них так и не получилось: ночной
 * разбор либо до них не дошёл, либо не нашёл, чему тут учить. Владелец видит
 * первоисточник и пишет одной строкой, как надо было ответить, — и его слова
 * с этого момента идут боту подсказкой.
 */
export function BotQuestionsSection() {
  const { data, isLoading, isError, refetch } = useBotLearning();
  const update = useUpdateBotLessonGroup();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  // «Показать ещё» — общим хуком useAccumulatedPages (тот же приём, что у восьми
  // остальных списков CRM), а не своей копией накопления: `page` растёт при
  // нажатии, в `pageDelta` лежит ТОЛЬКО свежедогруженная порция (копит сам хук),
  // `baseQuestions` — она же служит ключом сброса: другая ссылка на первую
  // страницу приходит с сервера ровно тогда, когда его стоит доверять больше
  // локального хвоста (правка любой записи инвалидирует запрос).
  // useMemo — не просто дежурная оптимизация: без него `?? []` создавал бы
  // новый (пустой) массив на КАЖДЫЙ рендер, а он служит ключом сброса ниже
  // (useEffect по ссылке) — эффект гонялся бы на каждый чих, а не только на
  // приход свежей первой страницы.
  const baseQuestions = useMemo(() => data?.questions ?? [], [data?.questions]);
  const [page, setPage] = useState(1);
  const [pageDelta, setPageDelta] = useState<BotLessonGroup[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Свежая первая страница обнуляет локальную нумерацию — иначе кнопка «Показать
  // ещё» продолжала бы просить смещение, посчитанное от уже неактуальной выдачи.
  useEffect(() => {
    setPage(1);
    setPageDelta([]);
    setNextOffset(null);
  }, [baseQuestions]);
  const questions = useAccumulatedPages(page <= 1 ? baseQuestions : pageDelta, page, baseQuestions);
  // Группировка теперь по всему скану на сервере (18.09.2026), «Показать ещё»
  // листает ГРУППЫ смещением — не курсором по сырой строке.
  const offsetForMore = page <= 1 ? (data?.questionsNextOffset ?? null) : nextOffset;

  async function loadMore() {
    if (offsetForMore == null) return;
    setLoadingMore(true);
    setError(null);
    try {
      const res = await loadMoreBotLessons("questions", offsetForMore);
      setPageDelta(res.questions);
      setNextOffset(res.questionsNextOffset);
      setPage((p) => p + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить ещё");
    } finally {
      setLoadingMore(false);
    }
  }

  /** Ответ применяется СРАЗУ ко всей группе схлопнутых повторов (владелец
   *  17.09.2026: «повторы исключить полностью, чтобы я сто раз не отвечал на
   *  одинаковые сообщения») — один и тот же вопрос от разных клиентов не
   *  должен требовать отдельного ответа на каждую карточку. */
  async function answer(item: BotLessonGroup) {
    if (item.investigationOnly) return;
    const text = (answers[item.id] ?? "").trim();
    if (!text) return;
    setError(null);
    try {
      await update.mutateAsync({ ids: groupIds(item), lesson: text });
      setAnswers((prev) => ({ ...prev, [item.id]: "" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить подсказку");
    }
  }

  return (
    <SettingsSection
      icon={HelpCircle}
      title="Бот спрашивает: как отвечать?"
      badge={questions.length > 0 ? (data?.questionsGroupsTotal ?? questions.length) : undefined}
      defaultOpen={questions.length > 0}
    >
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Разговоры, где бот не справился, а понятного правила из них не вывелось. Напишите одной фразой, как надо было
          ответить, — бот будет держать это в голове в следующий раз.
        </span>
      </div>

      {isLoading ? (
        <div className="state">
          <span className="sk w40" />
          <span className="sk w22" /> Загружаем вопросы
        </div>
      ) : isError ? (
        /* Праздничная картинка «done» и «Бот справляется сам» по УПАВШЕМУ
           запросу — канонический случай «Все ключи в офисе» из раунда 3
           (аудит 22.08.2026, раунд 6). */
        <div className="state err">
          <span className="dot crit" />
          Не удалось загрузить — это сбой связи, а не «бот справляется сам».{" "}
          <button
            className="lk"
            type="button"
            style={{ color: "inherit", textDecoration: "underline" }}
            onClick={() => refetch()}
          >
            Повторить
          </button>
        </div>
      ) : questions.length === 0 ? (
        <div className="empty">
          <span className="ic">
            <HelpCircle className="i" aria-hidden="true" />
          </span>
          <p>Вопросов нет.</p>
          <span className="sub">
            Бот справляется сам. Сюда попадут разговоры, где он ошибся, а правила из них не вывелось.
          </span>
        </div>
      ) : (
        questions.map((item) => (
          <div className="mod" key={item.id} style={{ display: "block" }}>
            <div className="wrap">
              {/* Пометка «суть», как и у уже выведенных правил ниже: этот вопрос —
                  тоже про ЧТО отвечать, просто правило из него ещё не вывелось. */}
              <span className="chip mute">суть</span>
              <LessonMeta item={item} />
              {item.investigationOnly && <span className="chip mute">Карантин · только просмотр</span>}
              {/* Повтор — тот же вопрос от разных клиентов, схлопнут в одну
                  карточку (владелец 17.09.2026: «повторы исключить полностью»).
                  Ответ ниже уходит СРАЗУ во все записи группы, см. answer(). */}
              {item.dupCount > 1 && <span className="chip">×{item.dupCount}</span>}
            </div>
            <LessonSource item={item} />
            {item.dupCount > 1 && (
              <details style={{ marginTop: "var(--s2)" }}>
                <summary className="lnk" style={{ cursor: "pointer" }}>
                  Ещё {item.dupCount - 1} {pluralizeRu(item.dupCount - 1, ["такой", "таких", "таких"])}
                </summary>
                {item.dupExamples.map((dup) => (
                  <div key={dup.id} style={{ marginTop: "var(--s2)" }}>
                    <LessonMeta item={dup} />
                    <LessonSource item={dup} />
                  </div>
                ))}
              </details>
            )}
            <div className="fld" style={{ marginTop: "var(--s2)" }}>
              <span className="lab">Как надо было ответить</span>
              <input
                value={answers[item.id] ?? ""}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [item.id]: e.target.value }))}
                maxLength={300}
                placeholder="Одной фразой"
                aria-label="Как надо было ответить"
                disabled={item.investigationOnly}
              />
              <div className="wrap" style={{ marginTop: "var(--s2)" }}>
                <button
                  className="pill"
                  type="button"
                  onClick={() => void answer(item)}
                  disabled={item.investigationOnly || update.isPending || !(answers[item.id] ?? "").trim()}
                >
                  Запомнить{item.dupCount > 1 ? ` (×${item.dupCount})` : ""}
                </button>
              </div>
            </div>
          </div>
        ))
      )}
      {offsetForMore != null && (
        <div className="wrap" style={{ marginTop: "var(--s2)" }}>
          <button className="pill ghost sm" type="button" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? "Загружаем…" : "Показать ещё"}
          </button>
        </div>
      )}
      {error && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{error}</span>
        </div>
      )}
    </SettingsSection>
  );
}

/**
 * Чему бот научился. Каждое правило можно выключить одним нажатием — неудачное
 * правило портит ответы всем клиентам сразу, и путь к выключателю обязан быть
 * короче, чем путь до разработчика.
 *
 * Удаление рядом с выключателем, потому что выключения мало: выключенное правило
 * остаётся в списке навсегда, и через месяц владелец разбирает не десяток
 * действующих подсказок, а сотню зачёркнутых строк. Удаление необратимо (уходит и
 * первоисточник — что сказал бот и что ответил человек), поэтому спрашиваем.
 */
export function BotLessonsSection() {
  const { data, isLoading } = useBotLearning();
  const update = useUpdateBotLessonGroup();
  const bump = useBumpBotLesson();
  const remove = useDeleteBotLesson();
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BotLesson | null>(null);
  // «Показать ещё» — тем же общим хуком, что и в BotQuestionsSection (см.
  // комментарий там): свежая первая страница обнуляет локальную нумерацию сама.
  // useMemo — та же причина, что в BotQuestionsSection: `?? []` без него
  // менял бы ссылку на каждый рендер, и эффект сброса ниже гонялся бы зря.
  const baseRules = useMemo(() => data?.rules ?? [], [data?.rules]);
  const [page, setPage] = useState(1);
  const [pageDelta, setPageDelta] = useState<BotLessonGroup[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    setPage(1);
    setPageDelta([]);
    setNextOffset(null);
  }, [baseRules]);
  const rules = useAccumulatedPages(page <= 1 ? baseRules : pageDelta, page, baseRules);
  // Группировка теперь по всему скану на сервере (18.09.2026), «Показать ещё»
  // листает ГРУППЫ смещением — не курсором по сырой строке.
  const offsetForMore = page <= 1 ? (data?.rulesNextOffset ?? null) : nextOffset;
  const promptIds = data?.promptLessonIds;

  async function loadMore() {
    if (offsetForMore == null) return;
    setLoadingMore(true);
    setError(null);
    try {
      const res = await loadMoreBotLessons("rules", offsetForMore);
      setPageDelta(res.rules);
      setNextOffset(res.rulesNextOffset);
      setPage((p) => p + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить ещё");
    } finally {
      setLoadingMore(false);
    }
  }

  /** Переключение применяется КО ВСЕЙ группе одинаковых по смыслу правил разом
   *  (17.09.2026, «повторы исключить полностью») — один и тот же вывод из
   *  разных случаев показывается одной строкой и включается/выключается одним
   *  нажатием, а не по отдельности на каждый первоисточник. */
  function toggle(item: BotLessonGroup) {
    if (item.investigationOnly) return;
    setError(null);
    update.mutate(
      { ids: groupIds(item), active: !item.active },
      { onError: (err) => setError(err instanceof Error ? err.message : "Не удалось переключить правило") }
    );
  }

  /** «Поднять» — решение владельца по умолчанию (17.09.2026): не меняет текст,
   *  только дату, чтобы правило снова попало в число самых свежих, которые
   *  реально видит промт (см. promptLessonIds). Нет смысла поднимать то, что
   *  уже там, — кнопка не показывается у активных правил из promptLessonIds. */
  function raise(item: BotLessonGroup) {
    if (item.investigationOnly) return;
    setError(null);
    bump.mutate(item.id, { onError: (err) => setError(err instanceof Error ? err.message : "Не удалось поднять правило") });
  }

  function confirmDelete() {
    if (!pendingDelete || pendingDelete.investigationOnly) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    setError(null);
    remove.mutate(id, {
      onError: (err) => setError(err instanceof Error ? err.message : "Не удалось удалить правило"),
    });
  }

  return (
    <SettingsSection
      icon={GraduationCap}
      title="Чему бот научился"
      badge={data ? `в промте ${data.promptCount} из ${data.activeCount} включённых` : undefined}
    >
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Правила выведены из разговоров, где бот ошибся, и подмешиваются в его промт. В промт уходят только
          {data ? ` ${data.promptCount} самых свежих из ${data.promptLimit}` : " самые свежие"} включённых — выключите
          то, что боту не идёт на пользу, или поднимите то, что хотите вернуть в промт.
        </span>
      </div>

      {isLoading ? (
        <div className="state">
          <span className="sk w40" />
          <span className="sk w22" /> Загружаем правила
        </div>
      ) : rules.length === 0 ? (
        <div className="empty">
          <span className="ic">
            <GraduationCap className="i" aria-hidden="true" />
          </span>
          <p>Правил пока нет.</p>
          <span className="sub">
            Бот выводит их сам из разговоров, где вместо него ответил сотрудник или клиент не понял ответ.
          </span>
        </div>
      ) : (
        rules.map((item) => {
          const inPrompt = !item.investigationOnly && (promptIds?.includes(item.id) ?? false);
          return (
            <div className="mod" key={item.id} style={{ display: "block" }}>
              <div className="wrap">
                <b
                  style={{
                    flex: 1,
                    minWidth: 0,
                    color: item.active ? undefined : "var(--faint)",
                    textDecoration: item.active ? undefined : "line-through",
                  }}
                >
                  {item.lesson}
                </b>
                {/* Пометка «суть» (вкладка «Правила») — чем отвечать боту, в отличие
                    от «манера» на записях StyleExample (вкладка «Манера»). */}
                <span className="chip mute">суть</span>
                {/* Честная замена «действует 112 из 112» (владелец 17.09.2026):
                    включено — не значит «бот это видит», видит он только
                    promptLessonIds. Чип — только у активных: у выключенного
                    правила и так есть зачёркивание и подпись ниже. */}
                {item.active && inPrompt && <span className="chip ok">в промте</span>}
                {item.dupCount > 1 && <span className="chip">×{item.dupCount}</span>}
                {item.investigationOnly && <span className="chip mute">Карантин · только просмотр</span>}
                <Switch on={item.active} disabled={item.investigationOnly} onToggle={() => toggle(item)} label={`Правило: ${item.lesson ?? ""}`} />
                <button
                  className="pill ghost sm"
                  type="button"
                  onClick={() => setPendingDelete(item)}
                  disabled={item.investigationOnly || remove.isPending}
                  aria-label={`Удалить правило: ${item.lesson ?? ""}`}
                  title="Удалить правило"
                >
                  Удалить
                </button>
              </div>
              {/* Подпись по текущему положению тумблера: без неё правило
                  различалось только зачёркиванием, а «зачёркнуто» и
                  «выключено» — не одно и то же на вид. */}
              <p className="msg" style={{ color: "var(--faint)" }}>
                {item.investigationOnly
                  ? "Историческая запись сохранена. В промт не попадает, изменение недоступно."
                  : !item.active
                  ? "не действует — в промт не уходит"
                  : inPrompt
                    ? "действует и попадает в промт"
                    : "действует, но до промта не доходит — слишком старое, поднимите его"}
              </p>
              <LessonMeta item={item} />
              <div className="wrap" style={{ marginTop: "var(--s2)" }}>
                {/* Выключенное правило запрашивает внимание: оно висит в списке
                    и непонятно, что с ним делать. Видимая кнопка отвечает на
                    это одним нажатием — второй путь к тому же PATCH, что и у
                    тумблера, но названный словами. */}
                {!item.investigationOnly && !item.active && (
                  <button className="pill ghost sm" type="button" onClick={() => toggle(item)} disabled={update.isPending}>
                    Правило верное — включить{item.dupCount > 1 ? ` (×${item.dupCount})` : ""}
                  </button>
                )}
                {/* «Поднять» — только там, где это вообще что-то меняет: активное
                    правило, которое уже и так в промте, поднимать незачем. */}
                {!item.investigationOnly && item.active && !inPrompt && (
                  <button
                    className="pill ghost sm"
                    type="button"
                    onClick={() => raise(item)}
                    disabled={bump.isPending}
                    title="Сделать снова самым свежим, чтобы попало в промт"
                  >
                    Поднять
                  </button>
                )}
              </div>
              {item.dupCount > 1 && (
                <details style={{ marginTop: "var(--s2)" }}>
                  <summary className="lnk" style={{ cursor: "pointer" }}>
                    Ещё {item.dupCount - 1} {pluralizeRu(item.dupCount - 1, ["такое", "таких", "таких"])}
                  </summary>
                  {item.dupExamples.map((dup) => (
                    <div key={dup.id} style={{ marginTop: "var(--s2)" }}>
                      <LessonMeta item={dup} />
                      <LessonSource item={dup} />
                    </div>
                  ))}
                </details>
              )}
              {/* details вместо своего состояния: первоисточник нужен изредка, а
                  раскрытие «своими руками» на списке из сотни строк — лишний код. */}
              <details style={{ marginTop: "var(--s2)" }}>
                <summary className="lnk" style={{ cursor: "pointer" }}>
                  Откуда это правило
                </summary>
                <LessonSource item={item} />
              </details>
            </div>
          );
        })
      )}
      {error && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{error}</span>
        </div>
      )}
      {data && data.rulesGroupsTotal > rules.length && (
        <div className="quiet">
          <span className="dot" />
          <span className="txt">
            Показаны {rules.length} из {data.rulesGroupsTotal} (сырых случаев — {data.rulesTotal}).
          </span>
        </div>
      )}
      {offsetForMore != null && (
        <div className="wrap" style={{ marginTop: "var(--s2)" }}>
          <button className="pill ghost sm" type="button" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? "Загружаем…" : "Показать ещё"}
          </button>
        </div>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Удалить правило?"
          description="Правило исчезнет вместе с первоисточником — разговором, из которого оно выведено. Отменить это нельзя. Чтобы бот просто перестал его учитывать, хватит выключателя."
          confirmLabel="Удалить"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </SettingsSection>
  );
}

/** «01.08 — 07.08» из границ недели. periodEnd хранится исключающим (полночь
 *  следующего дня), поэтому для подписи отступаем на миллисекунду назад — иначе
 *  неделя выглядела бы восьмидневной. */
function periodLabel(digest: LostDigest): string {
  // Число и месяц — ПО ДУШАНБЕ, а не по часам браузера: сервер отдаёт границы
  // как душанбинскую полночь (19:00 UTC предыдущего дня), и у зрителя западнее
  // UTC+5 начало недели всегда съезжало на день назад — «31.07 по 07.08» вместо
  // «01.08 по 07.08». Та же ловушка, что уже ловили в Календаре и Отчётах.
  const day = (iso: string, shiftMs = 0) =>
    dushanbeDate(new Date(new Date(iso).getTime() + shiftMs), { day: "2-digit", month: "2-digit" });
  return `${day(digest.periodStart)} по ${day(digest.periodEnd, -1)}`;
}

/**
 * Воронка потерь: на каком шаге разговор обрывался чаще всего.
 *
 * Полоски, а не диаграмма: шагов семь, порядок у них естественный (от «поздоровались»
 * до «попросили номер»), и читать такое сверху вниз проще, чем искать сектор в круге.
 * Шаги без потерь показываем тоже — строка «Бот попросил номер: 0» это хорошая
 * новость, и заметна она только рядом с остальными.
 */
function LostFunnel({ counts, total }: { counts: Record<string, number>; total: number }) {
  return (
    <div className="bars">
      {LOST_STAGES.map((stage) => {
        const value = counts[stage] ?? 0;
        const share = total > 0 ? Math.round((value / total) * 100) : 0;
        return (
          <div className="b" key={stage}>
            {/* title: подпись шага в `.nm3` обрезается по ширине колонки — полное
                название остаётся доступным наведением и программе чтения. */}
            <span className="nm3" title={LOST_STAGE_LABELS[stage]}>
              {LOST_STAGE_LABELS[stage]}
            </span>
            <span className="tr">
              {/* Заливка задаётся переменной `--v` (scaleX), а не шириной. */}
              <i style={{ "--v": share / 100 } as React.CSSProperties} aria-hidden="true" />
            </span>
            <span className="vl">{value}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Примеры под числами: без них воронка — просто картинка, которую нечем проверить.
 *
 * И с действиями по каждому: до 30.08.2026 здесь висела сотня карточек, с
 * которыми нельзя было сделать ничего — ни согласиться, ни возразить, ни убрать.
 * Три исхода закрывают все случаи: вины бота нет; бот сплоховал — учить; убрать.
 */
function LostExamples({
  digest,
  onResolve,
  onDelete,
  busy,
}: {
  digest: LostDigest;
  onResolve: (r: LostReview, verdict: LostVerdict) => void;
  onDelete: (r: LostReview) => void;
  busy: boolean;
}) {
  return (
    <>
      {digest.reviews.map((r) => (
        <div className="mod" key={r.id} style={{ display: "block" }}>
          <span className="meta">
            {LOST_STAGE_LABELS[r.stage as keyof typeof LOST_STAGE_LABELS] ?? r.stage} ·{" "}
            {CHANNEL_NAMES[r.channel] ?? r.channel} ·{" "}
            {LOST_REASON_LABELS[r.reason as keyof typeof LOST_REASON_LABELS] ?? r.reason} ·{" "}
            {relativeTime(r.lastMessageAt)}
          </span>
          <p className="msg" style={{ color: "var(--body)" }}>
            {r.finding}
          </p>
          {r.suggestion && (
            <p className="msg" style={{ color: "var(--muted)" }}>
              {r.suggestion}
            </p>
          )}

          <div className="qa">
            <div className="ask">
              <span className="k2">Последним бот сказал</span>
              <div className="body2">
                <p style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{r.botMessage}</p>
              </div>
            </div>
            <div className="ans">
              <span className="k2">Последним клиент писал</span>
              <div className="body2">
                <p style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{r.clientMessage}</p>
              </div>
            </div>
          </div>

          <div className="wrap" style={{ marginTop: "var(--s2)" }}>
            <button className="pill ghost sm" type="button" onClick={() => onResolve(r, "bot_right")} disabled={busy}>
              Бот прав — клиент просто ушёл
            </button>
            {r.botMessage.trim() && r.clientMessage.trim() ? (
              <button className="pill ghost sm" type="button" onClick={() => onResolve(r, "bot_error")} disabled={busy}>
                Бот ошибся — разобрать
              </button>
            ) : (
              /* Не серая кнопка, а прямой текст: серая читается как «нет прав». */
              <span className="saved">Разбирать нечего: одна из реплик пуста</span>
            )}
            <button className="pill ghost sm" type="button" onClick={() => onDelete(r)} disabled={busy}>
              Удалить
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

/** Одна недельная сводка: числа, воронка, предложения и примеры. */
function LostDigestCard({
  digest,
  open,
  onToggleProposal,
  onResolveReview,
  onDeleteReview,
  busy,
}: {
  digest: LostDigest;
  open: boolean;
  onToggleProposal: (item: BotLesson) => void;
  onResolveReview: (r: LostReview, verdict: LostVerdict) => void;
  onDeleteReview: (r: LostReview) => void;
  busy: boolean;
}) {
  const reasons = Object.entries(digest.reasonCounts).sort((a, b) => b[1] - a[1]);

  return (
    <div className="mod" style={{ display: "block" }}>
      <div className="wrap">
        <b style={{ flex: 1, minWidth: 0 }}>{periodLabel(digest)}</b>
        <span className="chip warn">оборвалось {digest.lostCount}</span>
        <span className="chip ok">заявок {digest.wonCount}</span>
      </div>

      {/* Свежую сводку раскрываем сразу, старые прячем: ради свежей сюда и заходят. */}
      <details open={open} style={{ marginTop: "var(--s2)" }}>
        <summary className="lnk" style={{ cursor: "pointer" }}>
          Где именно теряли
        </summary>

        <LostFunnel counts={digest.stageCounts} total={digest.lostCount} />

        {reasons.length > 0 && (
          <p className="msg" style={{ color: "var(--muted)" }}>
            {reasons
              .map(
                ([reason, count]) =>
                  `${LOST_REASON_LABELS[reason as keyof typeof LOST_REASON_LABELS] ?? reason}: ${count}`
              )
              .join(" · ")}
          </p>
        )}

        {digest.proposals.length > 0 ? (
          <>
            <div className="grp-lab">Что предлагается поменять</div>
            {digest.proposals.map((item) => (
              <div className="mod" key={item.id}>
                <div className="t">
                  <b style={{ whiteSpace: "normal", color: item.active ? undefined : "var(--muted)" }}>{item.lesson}</b>
                  <span>{item.active ? "действует — бот учитывает это в ответах" : "не действует"}</span>
                </div>
                <div className="acts">
                  <Switch
                    on={item.active}
                    onToggle={() => onToggleProposal(item)}
                    label={`Предложение: ${item.lesson ?? ""}`}
                  />
                </div>
              </div>
            ))}
          </>
        ) : (
          <div className="quiet">
            <span className="dot" />
            <span className="txt">
              Предложений за эту неделю нет — находки не сложились в общее правило. Числа выше от этого не хуже: по ним
              видно, на каком шаге люди уходят.
            </span>
          </div>
        )}

        {digest.reviews.length > 0 && (
          <details style={{ marginTop: "var(--s3)" }}>
            <summary className="lnk" style={{ cursor: "pointer" }}>
              Примеры переписок ({digest.reviews.length})
            </summary>
            <LostExamples digest={digest} onResolve={onResolveReview} onDelete={onDeleteReview} busy={busy} />
            {digest.lostCount > digest.reviews.length && (
              <p className="msg" style={{ color: "var(--faint)" }}>
                Показаны {digest.reviews.length} из {digest.lostCount} переписок этой недели.
              </p>
            )}
          </details>
        )}
      </details>
    </div>
  );
}

/**
 * Куда уходят клиенты — недельный разбор переписок, кончившихся ничем.
 *
 * Почему это здесь, рядом с «чему бот научился», а не отдельным экраном: вопрос
 * тот же самый — что бот говорит клиентам и что в этом поменять. Разводить по двум
 * местам то, где владелец включает боту правила, значило бы гарантированно потерять
 * одно из них.
 *
 * И почему предложения отсюда НЕ включены сразу, в отличие от правил ночного
 * разбора. Там сигнал сильный: вместо бота ответил живой сотрудник, клиент прямо
 * переспросил. Здесь — слабый: человек замолчал, но мог просто передумать, уехать
 * или купить у соседа. Учиться на догадках опасно, поэтому решение принимает
 * человек. Включённое предложение становится обычным действующим правилом и дальше
 * живёт в списке «Чему бот научился».
 */
export function LostClientsSection() {
  const { data, isLoading } = useLostDigests();
  const update = useUpdateBotLesson();
  const resolveReview = useResolveLostReview();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LostReview | null>(null);

  const digests = data?.digests ?? [];
  // Честный count() с сервера, а не длина текущей выдачи (14.09.2026): сводок
  // отдаётся только DIGESTS_LIMIT, и счётчик по загруженным digests молчал про
  // предложения из более старых недель.
  const waiting = data?.pendingProposalsCount ?? 0;

  function toggle(item: BotLesson) {
    setError(null);
    update.mutate(
      { id: item.id, active: !item.active },
      { onError: (err) => setError(err instanceof Error ? err.message : "Не удалось переключить предложение") }
    );
  }

  function resolve(review: LostReview, verdict: LostVerdict) {
    setError(null);
    setNote(null);
    resolveReview.mutate(
      { id: review.id, verdict },
      {
        onSuccess: (res) =>
          setNote(
            res.lessonCreated
              ? "Случай отправлен в разбор — он появится в «Бот спрашивает: как отвечать?», если правило не выведется само."
              : "Разбор убран из списка."
          ),
        onError: (err) => setError(err instanceof Error ? err.message : "Не удалось сохранить решение"),
      }
    );
  }

  return (
    <SettingsSection
      icon={TrendingDown}
      title="Куда уходят клиенты"
      badge={waiting > 0 ? `${waiting} на решение` : undefined}
      defaultOpen={waiting > 0}
    >
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Раз в неделю бот разбирает переписки, которые кончились ничем: человек писал, но номер так и не оставил и не
          вернулся. Здесь видно, сколько таких и на каком шаге они уходят. Предложения сами по себе НЕ действуют —
          включите те, с которыми согласны, и только они попадут боту в подсказки.
        </span>
      </div>

      {isLoading ? (
        <div className="state">
          <span className="sk w40" />
          <span className="sk w22" /> Загружаем сводки
        </div>
      ) : digests.length === 0 ? (
        <div className="empty">
          <span className="ic">
            <TrendingDown className="i" aria-hidden="true" />
          </span>
          <p>Сводок пока нет.</p>
          <span className="sub">
            {data && data.pendingReviews > 0
              ? `Разобрано переписок: ${data.pendingReviews}. Первая сводка соберётся в понедельник утром.`
              : "Сводка собирается по понедельникам за прошедшую неделю. Пока разбирать нечего — это хорошая новость."}
          </span>
        </div>
      ) : (
        digests.map((digest, i) => (
          <LostDigestCard
            key={digest.id}
            digest={digest}
            open={i === 0}
            onToggleProposal={toggle}
            onResolveReview={resolve}
            onDeleteReview={setPendingDelete}
            busy={resolveReview.isPending}
          />
        ))
      )}
      {data && data.reviewsTotal > 0 && (
        <div className="quiet">
          <span className="dot" />
          <span className="txt">
            Разобранных переписок всего: {data.reviewsTotal}
            {data.pendingReviews > 0 ? `, из них в ближайшую сводку войдут ${data.pendingReviews}` : ""}. Каждую можно
            закрыть своим решением — она уйдёт из списка.
          </span>
        </div>
      )}
      {note && (
        <div className="quiet" role="status">
          <span className="dot ok" />
          <span className="txt">{note}</span>
        </div>
      )}
      {error && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{error}</span>
        </div>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Удалить разбор?"
          description="Разбор исчезнет вместе с первоисточником — репликами бота и клиента. Отменить это нельзя. Если переписка свежая (моложе трёх недель), ночной разбор может взять её снова и заплатить за неё второй раз: отметки «уже смотрели» у неё не останется. Чтобы просто закрыть вопрос, выберите «Бот прав»."
          confirmLabel="Удалить"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const review = pendingDelete;
            setPendingDelete(null);
            resolve(review, "delete");
          }}
        />
      )}
    </SettingsSection>
  );
}

/**
 * КАК ПРОДАВАТЬ — то, что владелец правит сам, не трогая промт.
 *
 * Здесь ровно три рычага, и каждый появился из живой жалобы, а не из фантазии.
 * Предел вопросов — из «бот допрашивает и повторяет за клиентом». Список «чем не
 * занимаемся» — из случая, когда бот пообещал поискать землю, которой у агентства
 * нет, и человек ждал звонка. Преимущества — потому что на «почему вы?» бот раньше
 * отвечал общими словами, а ответ знает только владелец.
 */
function SellerRulesSection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();

  const [questions, setQuestions] = useState("2");
  const [notSelling, setNotSelling] = useState("");
  const [advantages, setAdvantages] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Зависимость — на КОНКРЕТНЫЕ ПОЛЯ, а не на объект настроек (аудит
   * 22.08.2026, раунд 6). Объект приходит новым каждый раз, когда на сервере
   * меняется хоть что-то постороннее (сверка расходов на рекламу идёт раз в
   * час, курс валюты — ночью, любой другой админ сохранил свою вкладку), и
   * эффект по нему затирал НЕДОПИСАННЫЙ текст «Чем мы не занимаемся» посреди
   * абзаца. Здесь два длинных поля свободного текста — терять их обиднее
   * всего. Тот же приём уже применён у PromptCard в этом же файле.
   */
  const sellerMaxQuestions = settings?.sellerMaxQuestions;
  const sellerNotSelling = settings?.sellerNotSelling;
  const sellerAdvantages = settings?.sellerAdvantages;
  useEffect(() => {
    if (!settings) return;
    setQuestions(String(sellerMaxQuestions ?? 2));
    setNotSelling(sellerNotSelling ?? "");
    setAdvantages(sellerAdvantages ?? "");
    // settings нужен только как признак «данные уже пришли» — перезаписывать
    // черновик надо по смене самих полей, поэтому его в зависимостях нет.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sellerMaxQuestions, sellerNotSelling, sellerAdvantages]);

  return (
    <SettingsSection icon={Bot} title="Как продавать" badge="3 настройки">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setSaved(false);
          try {
            await updateSettings.mutateAsync({
              sellerMaxQuestions: Number(questions),
              sellerNotSelling: notSelling,
              sellerAdvantages: advantages,
            });
            setSaved(true);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Не удалось сохранить");
          }
        }}
      >
        <div className="mod">
          <div className="t">
            <b>Сколько вопросов бот может задать</b>
            <span style={{ whiteSpace: "normal" }}>
              Исчерпал — оформляет заявку с тем, что есть, и передаёт живому агенту. Два вопроса это район и бюджет;
              остальное агент выяснит голосом быстрее и лучше. Ноль — бот не расспрашивает вовсе, только отвечает и
              передаёт.
            </span>
          </div>
          <div className="acts">
            <select
              className="inp"
              style={{ maxWidth: 120 }}
              aria-label="Сколько вопросов бот может задать"
              value={questions}
              onChange={(e) => setQuestions(e.target.value)}
            >
              {["0", "1", "2", "3", "4", "5"].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="fld" style={{ marginTop: "var(--s4)" }}>
          <span className="lab">Чем мы не занимаемся</span>
          <textarea
            value={notSelling}
            onChange={(e) => setNotSelling(e.target.value)}
            rows={3}
            placeholder={"Земля и участки\nАренда"}
            aria-label="Чем мы не занимаемся"
          />
          <span className="msg">
            По одному пункту в строке. Спросят про это — бот скажет честно и сразу, без «уточню» и «поищу»: ложная
            надежда стоит дороже отказа.
          </span>
        </div>

        <div className="fld" style={{ marginTop: "var(--s4)" }}>
          <span className="lab">Чем мы лучше других</span>
          <textarea
            value={advantages}
            onChange={(e) => setAdvantages(e.target.value)}
            rows={3}
            placeholder="Например: проверяем документы до показа; возим на объект бесплатно"
            aria-label="Чем мы лучше других"
          />
          <span className="msg">
            Две-три фразы своими словами. Бот скажет это к месту — когда человек сомневается или сравнивает, а не в
            каждом сообщении.
          </span>
        </div>

        <div className="wrap" style={{ marginTop: "var(--s4)" }}>
          <button className="pill ghost" type="submit" disabled={updateSettings.isPending}>
            Сохранить
          </button>
          {saved && <span className="saved on">Сохранено</span>}
          {error && (
            <span className="saved" style={{ color: "var(--crit)" }}>
              {error}
            </span>
          )}
        </div>
      </form>
    </SettingsSection>
  );
}

/**
 * «БОТ НА ПАУЗЕ И ЗАБЫЛИ» (Пачка 17, 12.09.2026, apps/api/src/lib/botPauseWatch.ts).
 *
 * Факт прода 11.09.2026: 187 диалогов на паузе бота без единого касания человеком
 * дольше 3 суток — агент ответил вручную один раз, поставил бота на паузу и
 * забыл. Крон раз в час теперь сам будит сначала агента, потом руководство и,
 * если и оно молчит, снимает паузу сам.
 */
function BotPauseWatchSection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();

  const [alertHours, setAlertHours] = useState("24");
  const [escalateHours, setEscalateHours] = useState("72");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const enabled = settings?.botPauseWatchEnabled ?? true;
  const settingsAlertHours = settings?.botPauseAlertHours;
  const settingsEscalateHours = settings?.botPauseEscalateHours;
  useEffect(() => {
    if (settingsAlertHours !== undefined) setAlertHours(String(settingsAlertHours));
    if (settingsEscalateHours !== undefined) setEscalateHours(String(settingsEscalateHours));
  }, [settingsAlertHours, settingsEscalateHours]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await updateSettings.mutateAsync({
        botPauseAlertHours: Number(alertHours),
        botPauseEscalateHours: Number(escalateHours),
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить");
    }
  }

  return (
    <SettingsSection icon={Clock} title="Бот на паузе — если забыли снять" badge={enabled ? "включено" : "выключено"}>
      <div className="mod">
        <div className="t">
          <b>
            Следить за паузой <StateWord on={enabled} />
          </b>
          <span style={{ whiteSpace: "normal" }}>
            {enabled
              ? "Раз в час CRM проверяет диалоги на паузе: если клиент ждёт ответа человека дольше срока ниже — напоминает агенту, а через второй срок снимает паузу сама и сообщает руководству."
              : "Диалоги на паузе бота не отслеживаются: пауза, поставленная агентом вручную, держится, пока её не снимут."}
          </span>
        </div>
        <div className="acts">
          <Switch
            on={enabled}
            onToggle={() =>
              updateSettings.mutate(
                { botPauseWatchEnabled: !enabled },
                { onError: (err) => setError(err instanceof Error ? err.message : "Не удалось сохранить настройку") }
              )
            }
            label="Следить за паузой бота"
          />
        </div>
      </div>

      {enabled && (
        <form onSubmit={handleSave}>
          <div className="mod">
            <div className="t">
              <b>Когда напомнить агенту</b>
              <span style={{ whiteSpace: "normal" }}>
                Клиент ждёт ответа человека дольше этого срока — агенту клиента уходит пуш. Не чаще раза в сутки на
                один диалог.
              </span>
            </div>
            <div className="acts">
              <span className="nf">
                <input
                  type="number"
                  min={1}
                  max={720}
                  inputMode="numeric"
                  value={alertHours}
                  onChange={(e) => setAlertHours(e.target.value)}
                  aria-label="Напомнить агенту через, часов"
                />
                <span className="u">часов</span>
              </span>
            </div>
          </div>
          <div className="mod">
            <div className="t">
              <b>Когда снять паузу самой</b>
              <span style={{ whiteSpace: "normal" }}>
                Агент так и не ответил — бот снова отвечает сам, а руководству уходит пуш с записью в карточке
                клиента. Обязано быть позже срока напоминания.
              </span>
            </div>
            <div className="acts">
              <span className="nf">
                <input
                  type="number"
                  min={1}
                  max={720}
                  inputMode="numeric"
                  value={escalateHours}
                  onChange={(e) => setEscalateHours(e.target.value)}
                  aria-label="Снять паузу через, часов"
                />
                <span className="u">часов</span>
              </span>
            </div>
          </div>
          <div className="wrap" style={{ marginTop: "var(--s3)" }}>
            <button className="pill ghost" type="submit" disabled={updateSettings.isPending}>
              Сохранить сроки
            </button>
            {saved && <span className="saved on">Сохранено</span>}
          </div>
        </form>
      )}

      {error && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{error}</span>
        </div>
      )}
    </SettingsSection>
  );
}
