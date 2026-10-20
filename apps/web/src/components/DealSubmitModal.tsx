import { useState } from "react";
import { Rh2Sheet } from "./rh2/Rh2Sheet";

/**
 * «Отправить сделку на закрытие» — форма фактической цены и комиссии суммой
 * (19.08.2026, просьба владельца). Раньше директор одним кликом завершал
 * сделку сам — теперь агент указывает, за сколько реально продали (торг
 * почти всегда меняет цену объявления) и суммой в сомони (не процентом!)
 * делит комиссию между тем, кто вёл сделку, и компанией. 0,5% «за приём
 * объекта» отменены 11.09.2026 — поля «Привёл лида» больше нет, компания
 * получает и свою долю, и бывшую долю интейкера. Директор дальше одобряет
 * эти цифры, поправляет их сам (тем же окном — режим "review"), отправляет
 * на доработку — или, если сам ведёт сделку, закрывает её этим же окном
 * одним действием (см. DealCard).
 *
 * Оба поля обязательны — это и есть весь смысл шага, не уточнение задним
 * числом. `valid` не даёт отправить пустое.
 *
 * ОКНО БОЛЬШЕ НЕ ЖИВЁТ ВНУТРИ ConfirmDialog (перенос облика 09.09.2026).
 * ConfirmDialog остаётся окном старого облика и стоит вне области темы
 * (`.rh2`): прототипные `.fld`/`.pill` внутри него не значили бы ничего, а
 * выглядело бы это как «перенесли». Вопрос, описание и запрет отправки
 * пустого перенесены сюда дословно — шапка, тихая строка и подвал шторки.
 *
 * ОБЪЕКТ УЖЕ ЗАРЕЗЕРВИРОВАН, А НЕ «В ПРОДАЖЕ» (поправка 19.08.2026): резерв
 * ставится ещё при заведении сделки (POST /deals) — с этого момента объект и
 * так не виден другим агентам как доступный. Эта форма ничего не меняет в
 * статусе объекта, только сохраняет цифры; «Продано» ставится отдельно, при
 * реальном завершении (COMPLETED).
 */
export function DealSubmitModal({
  listedPrice,
  currency,
  initial,
  mode = "submit",
  onSubmit,
  onCancel,
}: {
  /** Цена объявления (строка — Decimal с сервера) — подсказка и черновик поля цены. */
  listedPrice: string;
  currency: string;
  /** Предзаполнение при правке уже отправленной сделки (mode="review") — свои
   *  же ранее введённые цифры, а не чистый бланк. */
  initial?: { soldPrice?: string | null; commissionRealtorAmount?: string | null; commissionCompanyAmount?: string | null };
  /** submit — агент отправляет впервые; review — директор правит уже отправленные суммы. */
  mode?: "submit" | "review" | "complete";
  onSubmit: (data: {
    soldPrice: number;
    commissionRealtorAmount: number;
    commissionCompanyAmount: number;
  }) => void | Promise<unknown>;
  onCancel: () => void;
}) {
  // Окно ждёт ответа сервера и закрывается только при успехе (аудит 23.09.2026,
  // №58): раньше оно закрывалось сразу, и при отказе («не хватает документов»)
  // введённые цена и комиссия пропадали.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listedPriceNum = Number(listedPrice);
  const initialSoldPrice = initial?.soldPrice ? Number(initial.soldPrice) : listedPriceNum;
  const [soldPrice, setSoldPrice] = useState(initialSoldPrice ? String(initialSoldPrice) : "");
  const [realtor, setRealtor] = useState(initial?.commissionRealtorAmount ? String(Number(initial.commissionRealtorAmount)) : "");
  const [company, setCompany] = useState(initial?.commissionCompanyAmount ? String(Number(initial.commissionCompanyAmount)) : "");

  const nums = {
    soldPrice: Number(soldPrice.replace(",", ".")),
    realtor: Number(realtor.replace(",", ".") || "0"),
    company: Number(company.replace(",", ".") || "0"),
  };
  // Цена обязана быть положительной; хотя бы одна доля комиссии — тоже (сделка
  // без всякой комиссии — редкий, но не невозможный случай, поэтому 0 разрешён
  // у каждого отдельного поля, но не у обоих сразу — иначе поля просто не
  // заполнили).
  const total = nums.realtor + nums.company;
  // Комиссия больше цены продажи — не запятая, а реальная ошибка ввода (найдено
  // аудитом 18.09.2026: ни сервер, ни эта форма её раньше не ловили).
  const commissionExceedsPrice = Number.isFinite(nums.soldPrice) && nums.soldPrice > 0 && total > nums.soldPrice;
  const valid =
    Number.isFinite(nums.soldPrice) &&
    nums.soldPrice > 0 &&
    [realtor, company].every((v) => v.trim() !== "" && Number.isFinite(Number(v.replace(",", "."))) && Number(v.replace(",", ".")) >= 0) &&
    total > 0 &&
    !commissionExceedsPrice;

  const copy = {
    submit: {
      title: "Отправить на закрытие?",
      description: "Директор увидит эти цифры и одобрит сделку или отправит на доработку. Объект уже зарезервирован, «Продано» появится только после одобрения.",
      confirmLabel: "Отправить",
    },
    review: {
      title: "Поправить цифры?",
      description: "Новые цена и комиссия заменят то, что указал агент. Сделка остаётся «Ждёт одобрения», потребуется отдельно нажать «Одобрить».",
      confirmLabel: "Сохранить",
    },
    complete: {
      title: "Закрыть сделку?",
      description: "Вы закрываете сделку сами, минуя отправку на согласование. Объект станет «Продано», деньги зафиксируются в отчётах. Отменить нельзя.",
      confirmLabel: "Закрыть сделку",
    },
  }[mode];

  return (
    <Rh2Sheet
      title={copy.title}
      onClose={onCancel}
      // Как в AddInteractionModal/ClientFormModal: форма с деньгами, которые
      // жалко потерять от случайного клика по подложке или смахивания пальцем.
      closeOnBackdrop={false}
      onSubmit={async () => {
        if (!valid || busy) return;
        setBusy(true);
        setError(null);
        try {
          await onSubmit({
            soldPrice: nums.soldPrice,
            commissionRealtorAmount: nums.realtor,
            commissionCompanyAmount: nums.company,
          });
        } catch (err) {
          setError(err instanceof Error && err.message ? err.message : "Не удалось сохранить. Попробуйте ещё раз.");
        } finally {
          setBusy(false);
        }
      }}
      footer={
        <>
          <button type="button" className="pill ghost" onClick={onCancel}>
            Отмена
          </button>
          <button type="submit" className="pill" disabled={!valid || busy}>
            {busy ? "Сохраняю…" : copy.confirmLabel}
          </button>
        </>
      }
    >
      {/* Необратимое действие объявляется тихой строкой с красной точкой —
          «крикливых карточек-уведомлений» владелец просил не заводить. */}
      <p className={mode === "complete" ? "quiet crit" : "quiet"}>
        <span className={mode === "complete" ? "dot crit" : "dot"} />
        <span className="txt">{copy.description}</span>
      </p>
      {error && (
        <p className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{error}</span>
        </p>
      )}

      <label className="fld" style={{ marginTop: "var(--s4)" }}>
        <span className="lab">За сколько фактически продали? ({currency})</span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={soldPrice}
          onChange={(e) => setSoldPrice(e.target.value)}
          placeholder={listedPriceNum ? String(listedPriceNum) : "Сумма"}
        />
        {listedPriceNum > 0 && (
          <span className="msg">
            Цена объявления {listedPriceNum.toLocaleString("ru-RU")}, часто продают дешевле из-за торга.
          </span>
        )}
      </label>

      <div className="sec-t">Комиссия суммой ({currency}, не процентом)</div>
      <div className="fgrid">
        <label className="fld">
          <span className="lab">Вёл сделку</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={realtor}
            onChange={(e) => setRealtor(e.target.value)}
            placeholder="0"
          />
        </label>
        <label className="fld">
          <span className="lab">Компания</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="0"
          />
        </label>
      </div>

      {total > 0 && (
        <p className="state">
          Итого комиссии: <span className="money">{total.toLocaleString("ru-RU")}<span className="cur">{currency}</span></span>
        </p>
      )}
      {commissionExceedsPrice && (
        <p className="quiet crit">
          <span className="dot crit" />
          <span className="txt">Комиссия больше цены продажи — проверьте цифры.</span>
        </p>
      )}
    </Rh2Sheet>
  );
}
