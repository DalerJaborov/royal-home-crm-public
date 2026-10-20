import { PROPERTY_TYPE_LABELS, propertyFieldShown, propertyFinishSummary, propertyHasCondition } from "@royal-home/shared";
import type { District } from "../../types";
import type { DraftMediaSummary } from "../../hooks/useDraftMedia";
import { formatUploadSize } from "../UploadTaskRow";
import { needsLandArea, needsRooms, stepIndexOf, type WizardValues } from "./types";
import { useDuplicateAddress } from "./useDuplicateAddress";
import { DuplicateAddressWarning } from "./DuplicateAddressWarning";

/**
 * ШАГ 5 — ПРОВЕРКА. Облик — артефакт владельца (stepReview): один блок `.rev`
 * строками `.r` (`.k` слева, `.v` справа), пропущенное — серым `.v.gap`
 * словами «добавлю позже», вместо прежних четырёх карточек-секций с кнопками
 * «Изменить». Переход к шагу по-прежнему возможен — клик по строке ведёт на
 * тот шаг, который её заполняет (`onGoTo`), артефакт под это своей ссылки не
 * даёт, но и не запрещает: без неё правка ошибки стоила бы лишнего клика по
 * прогресс-бару.
 *
 * ДУБЛЬ `.dup`. У сервера сегодня есть только проверка ПРИ СОХРАНЕНИИ
 * (`routes/properties/crud.ts`, `DuplicatePropertyError`, ответ 409 с
 * `existingPropertyId`/`existingShortId`) — отдельного «посмотреть заранее»
 * маршрута нет. Выдумывать площадь/этаж «рядом уже есть, 62 м², 3/9» из
 * артефакта нельзя — таких чисел сервер не отдаёт ни разу до отправки.
 * Поэтому `.dup` здесь принимает готовый `duplicate` (текст сообщения сервера,
 * настоящий) и НЕ рендерится, пока его нет — то есть сейчас, до первой
 * попытки сохранения. ТОЧКА ПОДКЛЮЧЕНИЯ ЖИВОЙ ПРОВЕРКИ (для третьего
 * исполнителя, если появится маршрут вида `GET /properties/check-duplicate`):
 * `PropertyWizard.tsx`, там же, где сейчас разбирается `ApiError` от
 * `create.mutateAsync` (`catch (err)` в функции `save()`) — эту же форму
 * `{ shortId, message }` можно получать заранее по `values.address` +
 * `values.districtId` + `values.floor` и прокидывать сюда пропом раньше
 * попытки сохранить.
 */
export function StepReview({
  values,
  districts,
  media,
  errors,
  onGoTo,
  duplicate,
}: {
  values: WizardValues;
  districts: District[];
  /** Сводка по файлам черновика: что уже на сервере, что едет, что не ушло. */
  media: DraftMediaSummary;
  errors: Record<string, string>;
  onGoTo: (step: number) => void;
  /** Совпадение по адресу+площади — ТОЛЬКО настоящий ответ сервера (409 при
   *  сохранении). До ответа или без совпадения — undefined, блок скрыт. */
  duplicate?: { shortId: number; message: string } | null;
}) {
  const photoCount = media.photos.length;
  const videoCount = media.videos.length;
  const videoBytes = media.videos.reduce((sum, v) => sum + v.sizeBytes, 0);
  const district = districts.find((d) => d.id === values.districtId);
  const rooms = needsRooms(values.type);
  const money = new Intl.NumberFormat("ru-RU").format(Number(values.price) || 0);
  const problems = Object.values(errors);
  const gap = "добавлю позже";

  const filesValue =
    media.failed > 0
      ? `${media.failed} ${media.failed === 1 ? "файл не ушёл" : "файлов не ушло"}`
      : media.pending > 0
        ? `${photoCount + videoCount} шт., грузится ещё ${media.pending} (${media.percent}%)`
        : photoCount + videoCount > 0
          ? `фото ${photoCount}, видео ${videoCount}${videoCount ? ` (${formatUploadSize(videoBytes)})` : ""}`
          : gap;

  // Индекс по ключу, а не магическое число (21.09.2026, «Продавец» теперь
  // первый шаг) — см. stepIndexOf в types.ts.
  const mainStep = stepIndexOf("main");
  const placeStep = stepIndexOf("place");
  const sellerStep = stepIndexOf("seller");
  const mediaStep = stepIndexOf("media");
  const landArea = needsLandArea(values.type);

  const rows: { k: string; v: string; step: number; gap?: boolean }[] = [
    { k: "Тип", v: values.offSite ? "Закрытый" : "Публичный", step: mainStep },
    { k: "Вид", v: PROPERTY_TYPE_LABELS[values.type], step: mainStep },
    ...(rooms ? [{ k: "Комнат", v: values.rooms || gap, step: mainStep, gap: !values.rooms }] : []),
    ...(propertyFieldShown(values.type, "areaSqm")
      ? [{ k: "Площадь", v: values.areaSqm ? `${values.areaSqm} м²` : gap, step: mainStep, gap: !values.areaSqm }]
      : []),
    ...(landArea ? [{ k: "Сотки", v: values.landAreaSotka ? `${values.landAreaSotka} сот.` : gap, step: mainStep, gap: !values.landAreaSotka }] : []),
    // У дома своего этажа нет — только этажность (propertyTypeFields.ts).
    ...(propertyFieldShown(values.type, "floor")
      ? [
          {
            k: "Этаж",
            v: values.floor && values.totalFloors ? `${values.floor} из ${values.totalFloors}` : gap,
            step: mainStep,
            gap: !(values.floor && values.totalFloors),
          },
        ]
      : propertyFieldShown(values.type, "totalFloors")
        ? [{ k: "Этажей", v: values.totalFloors || gap, step: mainStep, gap: !values.totalFloors }]
        : []),
    {
      k: "Цена",
      v: values.price ? `${money} ${values.currency === "TJS" ? "сомони" : "$"}` : gap,
      step: mainStep,
      gap: !values.price,
    },
    ...(propertyHasCondition(values.type)
      ? [{ k: "Состояние", v: propertyFinishSummary(values) ?? gap, step: mainStep, gap: !propertyFinishSummary(values) }]
      : []),
    { k: "Район", v: district?.name ?? gap, step: placeStep, gap: !district },
    { k: "Адрес", v: values.address || gap, step: placeStep, gap: !values.address },
    { k: "Продавец", v: sellerLine(values) ?? gap, step: sellerStep, gap: !sellerLine(values) },
    { k: "Файлы", v: filesValue, step: mediaStep, gap: filesValue === gap },
  ];

  return (
    <>
      {problems.length > 0 && (
        <section className="blk">
          <div className="chip warn">{problems.join(". ")}.</div>
        </section>
      )}

      <section className="blk">
        <div className="rev">
          {rows.map((r) => (
            <button
              key={r.k}
              type="button"
              className="r"
              aria-label={`Изменить: ${r.k}, ${r.v}`}
              style={{ width: "100%", background: "none", border: 0, cursor: "pointer" }}
              onClick={() => onGoTo(r.step)}
            >
              <span className="k">{r.k}</span>
              <span className={r.gap ? "v gap" : "v"}>{r.v}</span>
              <svg className="wizard-review-edit" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6Z" /><path d="m14 5 5 5" /></svg>
            </button>
          ))}
        </div>
      </section>

      {media.failed > 0 && (
        <section className="blk">
          <div className="chip warn">
            {media.failed} {media.failed === 1 ? "файл не ушёл" : "файлов не ушло"}. При «Сохранить» предложу повторить,
            убрать их или сохранить без них — тогда они в карточку НЕ попадут.
          </div>
          <button type="button" className="chip warn" style={{ marginTop: 8 }} onClick={() => onGoTo(mediaStep)}>
            К файлам
          </button>
        </section>
      )}

      {duplicate && (
        <div className="dup" data-testid="wizard-duplicate-warning">
          <span className="dot" aria-hidden />
          {duplicate.message}
        </div>
      )}
    </>
  );
}

function sellerLine(values: WizardValues): string | null {
  if (values.sellerClientId) return "Выбран продавец из CRM";
  if (values.sellerName || values.sellerPhone) return [values.sellerName, values.sellerPhone].filter(Boolean).join(" · ");
  return null;
}
