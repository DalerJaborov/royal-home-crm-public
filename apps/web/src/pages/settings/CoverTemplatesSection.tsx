import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Image as ImageIcon, Trash2, Upload } from "lucide-react";
import { api } from "../../lib/api";
import { nextEnabledIds } from "../../lib/coverTemplateSelection";
import {
  useCoverTemplates,
  useDeleteCoverTemplate,
  useSettings,
  useUpdateSettings,
  useUploadCoverTemplate,
} from "../../hooks/useSettings";

/**
 * «Обложки для соцсетей» — раздел Настроек (владелец, 23.09.2026).
 *
 * Разметка в идиоме эталона темы «Royal Home 2026»: карточка `.card` с шапкой
 * `.sec-h.stack`, список `.list` со строками `.row`, чипы `.chip`, пояснения
 * `.quiet`. Отдельного файла под телефон НЕТ и быть не должно — правило
 * CLAUDE.md (история Oversight/MobileOversight): узкую раскладку делают
 * медиазапросы темы, одна разметка на оба размера.
 */
export function CoverTemplatesSection({ title = "Обложки для соцсетей" }: { title?: string } = {}) {
  const { data: settings } = useSettings();
  const { data: list, isLoading, isFetching } = useCoverTemplates();
  const qc = useQueryClient();
  const updateSettings = useUpdateSettings();
  const uploadTemplate = useUploadCoverTemplate();
  const deleteTemplate = useDeleteCoverTemplate();

  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const svgRef = useRef<HTMLInputElement>(null);
  const specRef = useRef<HTMLInputElement>(null);
  const leavesRef = useRef<HTMLInputElement>(null);

  const mode = list?.mode ?? settings?.coverTemplateMode ?? "FIXED";
  const selectedId = list?.selectedId ?? settings?.coverTemplateId ?? "royal-green";
  const templates = list?.templates ?? [];
  // Пока список перечитывается после правки, отметки на экране ещё старые: клик в
  // этот момент построил бы следующий PATCH от них и отменил предыдущую правку.
  const busy = updateSettings.isPending || isFetching;

  /** Правка настроек и перечитывание списка: он живёт в своём кэше, а мутация
   *  настроек его намеренно не трогает (skipSettings), поэтому без этого режим,
   *  выбранный шаблон и отметки оставались прежними до следующего фокуса. */
  async function saveAndRefresh(patch: Parameters<typeof updateSettings.mutateAsync>[0]) {
    await updateSettings.mutateAsync(patch);
    await qc.invalidateQueries({ queryKey: ["settings", "cover-templates"] });
  }

  async function setMode(next: "FIXED" | "RANDOM") {
    setError(null);
    try {
      await saveAndRefresh({ coverTemplateMode: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить режим");
    }
  }

  async function setSelected(id: string) {
    setError(null);
    try {
      await saveAndRefresh({ coverTemplateId: id });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось выбрать шаблон");
    }
  }

  /** Отметка «участвует в выборе» — список отправляется целиком, как у моделей ИИ. */
  async function toggleEnabled(id: string, enabled: boolean) {
    setError(null);
    const next = nextEnabledIds(templates, id, enabled);
    if (!next) {
      setError("Хотя бы один шаблон должен участвовать в выборе");
      return;
    }
    try {
      await saveAndRefresh({ coverTemplateEnabledIds: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить список");
    }
  }

  async function handleUpload() {
    setError(null);
    const svg = svgRef.current?.files?.[0];
    const spec = specRef.current?.files?.[0];
    const leaves = leavesRef.current?.files?.[0] ?? null;
    if (!name.trim()) return setError("Дайте шаблону название");
    if (!svg || !spec) return setError("Нужны оба файла: слой SVG и spec.json");
    try {
      await uploadTemplate.mutateAsync({ name: name.trim(), svg, spec, leaves });
      setName("");
      if (svgRef.current) svgRef.current.value = "";
      if (specRef.current) specRef.current.value = "";
      if (leavesRef.current) leavesRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить шаблон");
    }
  }

  async function handleDelete(id: string, templateName: string) {
    setError(null);
    if (!window.confirm(`Удалить шаблон «${templateName}»?`)) return;
    try {
      await deleteTemplate.mutateAsync(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось удалить шаблон");
    }
  }

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>{title}</h2>
        <span className="note">Чем накрывается ролик и фото объекта при публикации</span>
      </div>

      <p className="quiet" style={{ marginTop: 0 }}>
        Фирменный постер «Royal Gold» свёрстан по эталону владельца (21–22.09.2026) и рисуется в двух размерах: 1080×1080
        для ленты и сайта, 1080×1920 для Reels, TikTok, Shorts и Telegram.
      </p>
      <p className="quiet" style={{ marginTop: 0, overflowWrap: "anywhere" }}>
        Свой шаблон можно добавить ниже — парой файлов, ровно в том виде, в каком приходят исходники: слой геометрии
        (SVG) и числа (spec.json). В SVG подставляются значения объекта: {"{{rooms}}"}, {"{{roomsWord}}"},{" "}
        {"{{price}}"}, {"{{priceNumber}}"}, {"{{currency}}"}, {"{{area}}"}, {"{{areaNumber}}"}, {"{{floor}}"},{" "}
        {"{{city}}"}, {"{{district}}"}, {"{{landmark}}"}, {"{{areaSqm}}"}, {"{{slogan}}"}; {"{{поле|upper}}"} — заглавными.
        Блок с атрибутом data-if="поле" рисуется, только если у объекта это поле есть; data-fit="ширина" на строке
        уменьшает кегль, чтобы длинная цена или ориентир не вылезли за плашку.
      </p>

      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className={`chip${mode === "FIXED" ? " on" : ""}`}
          aria-pressed={mode === "FIXED"}
          onClick={() => setMode("FIXED")}
        >
          Один и тот же
        </button>
        <button
          type="button"
          className={`chip${mode === "RANDOM" ? " on" : ""}`}
          aria-pressed={mode === "RANDOM"}
          onClick={() => setMode("RANDOM")}
        >
          Случайный
        </button>
        <span className="quiet">
          {mode === "FIXED"
            ? "Каждая публикация выходит выбранным шаблоном."
            : "Публикация берёт случайный шаблон из отмеченных — одинаковый во всех сетях одного объекта."}
        </span>
      </div>

      {isLoading ? (
        <p className="quiet">Загружаем список…</p>
      ) : (
        <div className="list" style={{ marginTop: 12 }}>
          {templates.map((template) => (
            <div className="row" key={template.id} style={{ alignItems: "center", gap: 12 }}>
              <TemplatePreview id={template.id} name={template.name} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <strong>{template.name}</strong>
                  {template.builtin && <span className="chip">встроенный</span>}
                  {template.formats.map((format) => (
                    <span className="chip" key={format}>
                      {format === "square" ? "1080×1080" : "1080×1920"}
                    </span>
                  ))}
                </div>
                <label className="quiet" style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                  <input
                    type="checkbox"
                    checked={template.enabled}
                    disabled={busy}
                    onChange={(e) => toggleEnabled(template.id, e.target.checked)}
                  />
                  участвует в выборе
                </label>
              </div>
              {mode === "FIXED" && (
                <label className="quiet" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="radio"
                    name="cover-template-selected"
                    checked={selectedId === template.id}
                    disabled={busy}
                    onChange={() => setSelected(template.id)}
                  />
                  этот
                </label>
              )}
              {!template.builtin && (
                <button
                  type="button"
                  className="pill ghost sm"
                  onClick={() => handleDelete(template.id, template.name)}
                  title="Удалить шаблон"
                >
                  <Trash2 size={14} /> Удалить
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="sec-h stack" style={{ marginTop: 16 }}>
        <h3 style={{ fontSize: 15, margin: 0 }}>
          <ImageIcon size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          Добавить свой шаблон
        </h3>
        <span className="note">SVG-слой и spec.json обязательны, слой листьев — по желанию</span>
      </div>

      <div className="fgrid">
        <div className="fld">
          <span className="lab">Название</span>
          <input className="inp" value={name} onChange={(e) => setName(e.target.value)} placeholder="Royal Night" />
        </div>
        <div className="fld">
          <span className="lab">Слой геометрии (.svg)</span>
          <input type="file" accept=".svg,image/svg+xml" ref={svgRef} />
        </div>
        <div className="fld">
          <span className="lab">Числа (spec.json)</span>
          <input type="file" accept=".json,application/json" ref={specRef} />
        </div>
        <div className="fld">
          <span className="lab">Листья по краям (.png, необязательно)</span>
          <input type="file" accept="image/png" ref={leavesRef} />
        </div>
      </div>

      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button type="button" className="pill ghost sm" onClick={handleUpload} disabled={uploadTemplate.isPending}>
          <Upload size={14} /> {uploadTemplate.isPending ? "Загружаем…" : "Загрузить шаблон"}
        </button>
      </div>

      {error && <p className="quiet crit">{error}</p>}
    </section>
  );
}

/**
 * Превью шаблона. Картинку тянем запросом с маркером доступа, а не тегом
 * `<img src>`: маршрут предпросмотра закрыт правом `settings.manage`, и браузер
 * в обычной картинке заголовок Authorization не пошлёт — вышла бы битая иконка
 * (та же механика, что у записи звонка в `CallDetails.tsx`).
 */
function TemplatePreview({ id, name }: { id: string; name: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    setUrl(null);
    api<Blob>(`/settings/cover-templates/${id}/preview.jpg`, { responseType: "blob" })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        // Предпросмотр не нарисовался — оставляем пустую рамку, список важнее.
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);

  const box = { width: 64, height: 64, borderRadius: 10, background: "rgba(0,0,0,.2)", flex: "0 0 auto" } as const;
  if (!url) return <div style={box} aria-label={`Превью шаблона ${name}`} />;
  return <img src={url} alt={`Превью шаблона ${name}`} style={{ ...box, objectFit: "cover" }} />;
}
