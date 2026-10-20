import { useEffect, useRef, useState } from "react";
import { useServerSyncedFields } from "../../hooks/useServerSyncedForm";
import { Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { SecretKeyEditor } from "../../components/SecretKeyEditor";
import { CoverTemplatesSection } from "./CoverTemplatesSection";
import { api } from "../../lib/api";
import {
  OPENAI_IMAGE_MODEL_OPTIONS,
  useCoverReference,
  useOpenAiCovers,
  useTestOpenAiCover,
  useUpdateOpenAiCovers,
  type OpenAiCoverSettings,
  type OpenAiImageModel,
} from "../../hooks/useSettings";
import { coverSettingEffects } from "../../lib/coverSettingEffects";

/**
 * «Обложки для соцсетей» (29.09.2026). По умолчанию ChatGPT рисует обложку
 * целиком по образцу (блок «Образец для ChatGPT»), знак владельца ставит CRM.
 * Переключатель «Кто рисует» даёт и наш шаблон (`CoverTemplatesSection` ниже).
 * Показываются только настройки, которые действуют в выбранном режиме
 * (аудит 29.09.2026): «Фото на обложке» ChatGPT — только в режиме «Мы — точный
 * текст поверх», предупреждение о мелком логотипе — только там же.
 *
 * Идиома эталона «Royal Home 2026»: `.card`, `.sec-h.stack`, `.chip`, `.quiet`,
 * `.list`/`.row`. Одна разметка на ПК и телефон — узкую раскладку делают
 * медиазапросы темы (правило CLAUDE.md).
 */
/** Цена одной картинки gpt-image-1: квадрат + вертикаль (прайс OpenAI). */
const QUALITY_LABEL: Record<OpenAiCoverSettings["quality"], string> = {
  low: "Низкое",
  medium: "Среднее",
  high: "Высокое",
};
/** Перерисовка фото под наш шаблон — одна вертикальная картинка на объект (прайс gpt-image-1). */
const QUALITY_REDRAW_USD: Record<OpenAiCoverSettings["quality"], number> = { low: 0.016, medium: 0.063, high: 0.25 };
/** Цена пары картинок gpt-image-1 (квадрат + вертикаль, прайс OpenAI). Только для
 *  gpt-image-1: у моделей 2.x цена по токенам, см. lib/coverSettingEffects.ts. */
const QUALITY_PAIR_USD: Record<OpenAiCoverSettings["quality"], number> = {
  low: 0.027,
  medium: 0.105,
  high: 0.417,
};

export function OpenAiCoversSection({ templateHeading }: { templateHeading?: string } = {}) {
  const { data, isLoading } = useOpenAiCovers();
  const update = useUpdateOpenAiCovers();
  const test = useTestOpenAiCover();
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState("");
  const [propertyId, setPropertyId] = useState("");

  useServerSyncedFields(
    data && {
      limit: String(data.dailyLimit),
    },
    {
      limit: [limit, setLimit],
    }
  );

  async function save(input: Parameters<typeof update.mutateAsync>[0]) {
    setError(null);
    try {
      await update.mutateAsync(input);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить");
    }
  }

  function saveLimit() {
    const value = Number(limit);
    if (!Number.isInteger(value) || value < 0 || value > 1000) {
      setError("Лимит — целое число от 0 до 1000");
      return;
    }
    void save({ dailyLimit: value });
  }

  const isTemplate = data?.provider === "TEMPLATE";
  // ChatGPT нужен и нашему шаблону, когда он перерисовывает фото (29.09.2026).
  const usesOpenAi = !isTemplate || Boolean(data?.photoRedraw);
  // Что из переключателей ChatGPT-режима сервер при выбранном режиме реально читает —
  // остальное показываем выключенным с пояснением (сохранённые значения не трогаем).
  const effects = data ? coverSettingEffects(data) : null;
  const modelLabel = data
    ? (OPENAI_IMAGE_MODEL_OPTIONS.find((o) => o.id === data.imageModel)?.label ?? data.imageModel)
    : "";
  // Цена «за картинку» — только по прайсу gpt-image-1; у моделей 2.x цену не выдумываем.
  const showPrice = isTemplate ? data?.imageModel === "gpt-image-1" : Boolean(effects?.showPerImagePrice);

  return (
    <>
      <section className="card">
        <div className="sec-h stack">
          <h2>Обложки для соцсетей</h2>
          <span className="note">
            {isTemplate ? "Рисует наш шаблон по лучшему фото объекта" : "Рисует ChatGPT по лучшему фото объекта"}
          </span>
        </div>

        {!isTemplate && (
          <p className="quiet" style={{ marginTop: 0 }}>
            Квадрат 1080×1080 (лента, Facebook, YouTube, сайт) и вертикаль 1080×1920 (Reels, Telegram) ChatGPT рисует
            целиком по образцу — фон, текст, цифры; наш знак ставит CRM. Фото берётся лучшее из первых восьми. Вторая
            модель проверяет цифры и слова; брак — одна повторная попытка, затем публикация идёт без обложки, причина —
            на карточке объекта и в журнале ошибок.
          </p>
        )}

        {isLoading || !data ? (
          <p className="quiet">Загружаем…</p>
        ) : (
          <>
            <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button
                type="button"
                className={`chip${data.enabled ? " on" : ""}`}
                aria-pressed={data.enabled}
                onClick={() => save({ enabled: true })}
              >
                Включено
              </button>
              <button
                type="button"
                className={`chip${!data.enabled ? " on" : ""}`}
                aria-pressed={!data.enabled}
                onClick={() => save({ enabled: false })}
              >
                Выключено
              </button>
              <span className="quiet">
                {data.enabled
                  ? "Каждая публикация ролика получает обложку."
                  : "Публикации идут без обложки — площадка берёт кадр сама."}
              </span>
            </div>

            <div className="fld" style={{ marginTop: 12 }}>
              <span className="lab">Кто рисует</span>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {(["TEMPLATE", "OPENAI"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`chip${data.provider === p ? " on" : ""}`}
                    aria-pressed={data.provider === p}
                    onClick={() => save({ provider: p })}
                  >
                    {p === "TEMPLATE" ? "Наш шаблон — цифры точные" : "ChatGPT — рисует всё, по ключу OpenAI"}
                  </button>
                ))}
              </div>
            </div>

            {isTemplate && (
              <div className="fld" style={{ marginTop: 12 }}>
                <span className="lab">Фото на обложке</span>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {([true, false] as const).map((on) => (
                    <button
                      key={String(on)}
                      type="button"
                      className={`chip${data.photoRedraw === on ? " on" : ""}`}
                      aria-pressed={data.photoRedraw === on}
                      onClick={() => save({ photoRedraw: on })}
                    >
                      {on ? "ChatGPT перерисовывает — ярко, как в журнале" : "Настоящее — только свет"}
                    </button>
                  ))}
                </div>
                <span className="quiet">
                  {data.photoRedraw
                    ? "Перерисованное фото идёт только на обложку, в объявлении остаются настоящие. Одно фото — один раз, дальше из памяти."
                    : "Фото только осветляется, бесплатно."}
                </span>
              </div>
            )}

            {/* Логотип из Настроек нужен только режиму «Мы — точный текст поверх»: в «ChatGPT рисует всё» и
                в шаблоне «Royal Green» стоит знак владельца, вшитый в CRM. */}
            {!isTemplate &&
              data.textMode === "OVERLAY" &&
              data.logoWidth != null &&
              data.logoWidth < data.logoMinWidth && (
                <p className="quiet warn">
                  Логотип мелкий ({data.logoWidth} px) — на обложке он расплывается. Загрузите логотип от {data.logoMinWidth} px:{" "}
                  <Link to="/settings?tab=agency">Настройки → Агентство → Логотип</Link>.
                </p>
              )}

            {!isTemplate && (
              <>
                <div className="sec-h stack" style={{ marginTop: 12 }}>
                  <h3 style={{ fontSize: 15, margin: 0 }}>Образец для ChatGPT</h3>
                  <span className="note">
                    ChatGPT рисует обложки именно в таком дизайне, с нашими цифрами и надписями
                  </span>
                </div>
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
                  <CoverReferenceTile format="square" custom={data.referenceSquareUrl} />
                  <CoverReferenceTile format="story" custom={data.referenceStoryUrl} />
                </div>
                <p className="quiet" style={{ marginTop: 6 }}>
                  Встроенный образец — зелёный «Royal Green»: наш знак ставит CRM, точно и без тени. Со своим образцом
                  знак ставит ChatGPT туда же, где он на образце. Нет своей вертикали — ChatGPT берёт квадратный
                  образец.
                </p>
              </>
            )}

            {usesOpenAi && (
              <>
                <SecretKeyEditor
                  title="Ключ OpenAI"
                  description="Берётся на platform.openai.com → API keys. Для gpt-image-1 организация в OpenAI должна пройти верификацию (Settings → Organization → Verify)."
                  placeholder="Ключ начинается с sk-…"
                  configured={data.keyConfigured}
                  masked={data.keyMasked}
                  source={data.keySource}
                  onSave={(key) => update.mutateAsync({ apiKey: key })}
                  onClear={() => update.mutateAsync({ apiKey: "" })}
                />

                <div className="sec-h stack" style={{ marginTop: 12 }}>
                  <h3 style={{ fontSize: 15, margin: 0 }}>Качество картинки</h3>
                  <span className="note">
                    {!isTemplate && effects?.qualityOnlyDigit
                      ? "в этом режиме фото не перерисовывается"
                      : !showPrice
                        ? "цена зависит от модели"
                        : isTemplate
                          ? "цена перерисовки одного фото"
                          : "до такой суммы за обложку (с повтором); оценка по прайсу, точная цена — в журнале ниже"}
                  </span>
                </div>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  {(Object.keys(QUALITY_LABEL) as OpenAiCoverSettings["quality"][]).map((q) => (
                    <button
                      key={q}
                      type="button"
                      className={`chip${data.quality === q ? " on" : ""}`}
                      aria-pressed={data.quality === q}
                      onClick={() => save({ quality: q })}
                    >
                      {QUALITY_LABEL[q]}
                      {showPrice
                        ? ` · ~$${(isTemplate ? QUALITY_REDRAW_USD[q] : QUALITY_PAIR_USD[q] * data.candidates * 2).toFixed(2)}`
                        : ""}
                    </button>
                  ))}
                </div>
                {!isTemplate && effects?.qualityOnlyDigit ? (
                  <p className="quiet">
                    Режим «Мы — точный текст поверх» с настоящим фото: ChatGPT обложку не рисует, качество влияет только
                    на золотую цифру комнат — она рисуется один раз на каждую цифру и дальше берётся готовой. За обложку
                    платится только проверка цифр — центы.
                  </p>
                ) : (
                  !showPrice && (
                    <p className="quiet">
                      У модели «{modelLabel}» цена считается по токенам, а не за картинку, — заранее её не показываем.
                      Фактическая стоимость каждой картинки — в «Последних обращениях» ниже.
                    </p>
                  )
                )}

                <div className="fgrid" style={{ marginTop: 12 }}>
                  <div className="fld">
                    <label className="lab" htmlFor="openai-cover-limit">
                      Картинок в сутки (сегодня {data.usedToday})
                    </label>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        id="openai-cover-limit"
                        className="inp"
                        inputMode="numeric"
                        value={limit}
                        onChange={(e) => setLimit(e.target.value.replace(/\D/g, ""))}
                      />
                      <button type="button" className="pill ghost sm" onClick={saveLimit} disabled={update.isPending}>
                        Сохранить
                      </button>
                    </div>
                  </div>
                  <div className="fld">
                    <label className="lab" htmlFor="openai-image-model">
                      Модель картинок
                    </label>
                    <select
                      id="openai-image-model"
                      className="inp"
                      value={data.imageModel}
                      onChange={(e) => save({ imageModel: e.target.value as OpenAiImageModel })}
                    >
                      {OPENAI_IMAGE_MODEL_OPTIONS.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {!isTemplate && (
                    <>
                      <div className="fld">
                        <span className="lab">Кто пишет текст</span>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {(["MODEL", "OVERLAY"] as const).map((mode) => (
                            <button
                              key={mode}
                              type="button"
                              className={`chip${data.textMode === mode ? " on" : ""}`}
                              aria-pressed={data.textMode === mode}
                              onClick={() => save({ textMode: mode })}
                            >
                              {mode === "MODEL" ? "ChatGPT — весь дизайн и текст" : "Мы — точный текст поверх"}
                            </button>
                          ))}
                        </div>
                      </div>
                      {data.textMode === "OVERLAY" && (
                        <div className="fld">
                          <span className="lab">Фото на обложке</span>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            {(["ORIGINAL", "MODEL"] as const).map((src) => (
                              <button
                                key={src}
                                type="button"
                                className={`chip${data.photoSource === src ? " on" : ""}`}
                                aria-pressed={data.photoSource === src}
                                onClick={() => save({ photoSource: src })}
                              >
                                {src === "ORIGINAL"
                                  ? "Настоящее — без изменений"
                                  : "Перерисовка ChatGPT — может менять комнату"}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="fld">
                        <span className="lab">Вариантов на картинку</span>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {([1, 2] as const).map((n) => (
                            <button
                              key={n}
                              type="button"
                              className={`chip${data.candidates === n ? " on" : ""}`}
                              aria-pressed={data.candidates === n}
                              disabled={!effects?.candidatesApplies}
                              onClick={() => save({ candidates: n })}
                            >
                              {n === 1 ? "1 — дешевле" : "2 — лучший из двух"}
                            </button>
                          ))}
                        </div>
                        {!effects?.candidatesApplies && (
                          <span className="quiet">
                            Не действует с настоящим фото в режиме «Мы — точный текст поверх»: картинку обложки ChatGPT не
                            рисует, выбирать не из чего.
                          </span>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </>
            )}

            <div className="sec-h stack" style={{ marginTop: 16 }}>
              <h3 style={{ fontSize: 15, margin: 0 }}>
                <Sparkles size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
                Пробная обложка
              </h3>
              <span className="note">
                {!usesOpenAi
                  ? "в объект не записывается, бесплатно"
                  : "в объект не записывается, но деньги и лимит тратит"}
              </span>
            </div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input
                className="inp"
                style={{ flex: "1 1 220px", minWidth: 0 }}
                placeholder="id объекта (пусто — последний с фото)"
                aria-label="id объекта для пробной обложки"
                value={propertyId}
                onChange={(e) => setPropertyId(e.target.value.trim())}
              />
              <button
                type="button"
                className="pill sm"
                onClick={() => test.mutate(propertyId || undefined)}
                disabled={test.isPending || (usesOpenAi && !data.keyConfigured)}
              >
                {test.isPending ? (usesOpenAi ? "Рисуем… до 5 минут" : "Рисуем…") : "Пробная обложка"}
              </button>
            </div>
            {usesOpenAi && !data.keyConfigured && <p className="quiet warn">Сначала вставьте ключ OpenAI.</p>}
            {test.error && (
              <p className="quiet crit">{test.error instanceof Error ? test.error.message : "Не получилось"}</p>
            )}
            {test.data && (
              <div style={{ marginTop: 12 }}>
                <p className="quiet" style={{ marginTop: 0 }}>
                  {test.data.seconds} с{test.data.costUsd != null ? ` · $${test.data.costUsd.toFixed(3)}` : ""} · объект {test.data.propertyId.slice(0, 8)}
                </p>
                <div
                  style={{
                    display: "flex",
                    gap: 12,
                    flexWrap: "wrap",
                    alignItems: "flex-start",
                  }}
                >
                  <img
                    src={test.data.squareDataUrl}
                    alt="Пробная обложка, квадрат"
                    style={{ width: "min(100%, 280px)", borderRadius: 12 }}
                  />
                  <img
                    src={test.data.storyDataUrl}
                    alt="Пробная обложка, вертикаль"
                    style={{ width: "min(100%, 180px)", borderRadius: 12 }}
                  />
                </div>
              </div>
            )}

            {usesOpenAi && (
              <>
                <div className="sec-h stack" style={{ marginTop: 16 }}>
                  <h3 style={{ fontSize: 15, margin: 0 }}>Последние обращения</h3>
                </div>
                {data.recent.length === 0 ? (
                  <p className="quiet">Пока ни одной генерации.</p>
                ) : (
                  <div className="list">
                    {data.recent.map((r) => (
                      <div className="row" key={r.id} style={{ gap: 8, flexWrap: "wrap" }}>
                        <span className={`chip${r.ok ? "" : " crit"}`}>
                          {r.kind === "image" ? "картинка" : "проверка ChatGPT"}
                        </span>
                        <span className="quiet" style={{ flex: 1, minWidth: 0 }}>
                          {new Date(r.createdAt).toLocaleString("ru-RU", { timeZone: "Asia/Dushanbe",
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}{" "}
                          · {(r.ms / 1000).toFixed(1)} с{r.costUsd != null ? ` · $${r.costUsd.toFixed(3)}` : ""}
                          {r.ok ? "" : " · не удалось"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}

        {error && <p className="quiet crit">{error}</p>}
      </section>
      {/* Наш шаблон (28.09.2026): выбор встроенных и своих шаблонов с превью, «Royal Green» первым. */}
      {isTemplate && <CoverTemplatesSection title={templateHeading} />}
    </>
  );
}

/**
 * Образец одного формата: превью действующего (свой или встроенный), «Загрузить свой»
 * и «Вернуть встроенный». Превью тянем запросом с маркером доступа — маршрут закрыт
 * правом settings.manage (та же механика, что у превью шаблонов).
 */
function CoverReferenceTile({ format, custom }: { format: "square" | "story"; custom: string | null }) {
  const change = useCoverReference();
  const fileRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    setUrl(null);
    api<Blob>(`/settings/cover-templates/openai-reference/${format}/image`, { responseType: "blob" })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        // Превью не пришло — рамка остаётся пустой, кнопки работают.
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [format, custom]);

  const width = format === "square" ? 180 : 101;
  const box = {
    width,
    height: format === "square" ? 180 : 180,
    borderRadius: 12,
    background: "rgba(0,0,0,.08)",
    display: "block",
  } as const;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, width: Math.max(width, 150) }}>
      <span className="lab">
        {format === "square" ? "Квадрат" : "Вертикаль"} · {custom ? "свой" : "встроенный"}
      </span>
      {url ? (
        <img
          src={url}
          alt={`Образец обложки, ${format === "square" ? "квадрат" : "вертикаль"}`}
          style={{ ...box, objectFit: "cover" }}
        />
      ) : (
        <div style={box} />
      )}
      <button
        type="button"
        className="pill ghost sm"
        onClick={() => fileRef.current?.click()}
        disabled={change.isPending}
      >
        {change.isPending ? "Сохраняем…" : "Загрузить свой"}
      </button>
      {custom && (
        <button
          type="button"
          className="pill ghost sm"
          onClick={() => change.mutate({ format, file: null })}
          disabled={change.isPending}
        >
          Вернуть встроенный
        </button>
      )}
      {change.error && (
        <span className="quiet crit">{change.error instanceof Error ? change.error.message : "Не получилось"}</span>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) change.mutate({ format, file });
        }}
      />
    </div>
  );
}
