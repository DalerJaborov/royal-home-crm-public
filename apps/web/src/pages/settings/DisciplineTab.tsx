import { useState } from "react";
import { useServerSyncedForm } from "../../hooks/useServerSyncedForm";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { MutationError } from "../../components/MutationError";
import { SwitchRow } from "../../components/Switch";

/**
 * Числа, по которым система требует работу от агента.
 *
 * Решение владельца 01.08.2026 звучит буквально: «любое число правится в
 * Настройках, ничего не остаётся в коде». Обязательные окна, пауза «не принимаю
 * лиды» и (до 16.11.2026) штраф за бездействие принесли с собой одиннадцать новых чисел — и без
 * этого экрана они хоть и лежали в базе, но правились только разработчиком, то есть
 * фактически оставались в коде.
 *
 * Всё на одной вкладке нарочно: это одна тема — сколько система ждёт, прежде чем
 * напомнить, и что делает, когда не дождалась. Разложенные по трём разным экранам,
 * эти числа настраивались бы вразнобой.
 *
 * Разметка — эталон темы «Royal Home 2026»: каждая тема отдельной карточкой
 * `.card` с шапкой `.sec-h.stack`, числа — поля `.fgrid`/`.fld`, рубильник —
 * строка `.mod` (SwitchRow). Сохраняет всё одна кнопка: мутация тоже одна.
 */
export function DisciplineSection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  // silent: форма ниже сама пишет «Сохранено» (state `saved`) и рендерит MutationError —
  // общий тост дублировал то же самое.
  const updateForm = useUpdateSettings({ silent: true });
  const [form, setForm] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  useServerSyncedForm(
    settings && {
      agentPauseMaxHours: String(settings.agentPauseMaxHours ?? 48),
      agentPauseCooldownHours: String(settings.agentPauseCooldownHours ?? 24),
      dealStaleSellerDays: String(settings.dealStaleSellerDays ?? 10),
      dealStaleBuyerDays: String(settings.dealStaleBuyerDays ?? 21),
      lostReturnAcceptMinutes: String(settings.lostReturnAcceptMinutes ?? 120),
      sellerPropertyMissingWarnDays: String(settings.sellerPropertyMissingWarnDays ?? 3),
      sellerPropertyMissingCriticalDays: String(settings.sellerPropertyMissingCriticalDays ?? 5),
      buyerThinkingFirstPingHours: String(settings.buyerThinkingFirstPingHours ?? 48),
      buyerThinkingSecondPingHours: String(settings.buyerThinkingSecondPingHours ?? 72),
      buyerThinkingSlowTrackDays: String(settings.buyerThinkingSlowTrackDays ?? 7),
    },
    form,
    (patch) => setForm((f) => ({ ...f, ...patch }) as Record<string, string>)
  );

  const set = (key: string, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  };

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    /* Форма наполняется только внутри `if (settings)`. Без ответа сервера все
       поля пусты, и `Number("")`/`Number(undefined)` уехали бы в базу нулями и
       NaN — то есть сроки паузы и застоя
       переписались бы мусором (аудит 22.08.2026, раунд 6). */
    if (!settings) return;
    setSaved(false);
    await updateForm.mutateAsync({
      agentPauseMaxHours: Number(form.agentPauseMaxHours),
      agentPauseCooldownHours: Number(form.agentPauseCooldownHours),
      dealStaleSellerDays: Number(form.dealStaleSellerDays),
      dealStaleBuyerDays: Number(form.dealStaleBuyerDays),
      lostReturnAcceptMinutes: Number(form.lostReturnAcceptMinutes),
      sellerPropertyMissingWarnDays: Number(form.sellerPropertyMissingWarnDays),
      sellerPropertyMissingCriticalDays: Number(form.sellerPropertyMissingCriticalDays),
      buyerThinkingFirstPingHours: Number(form.buyerThinkingFirstPingHours),
      buyerThinkingSecondPingHours: Number(form.buyerThinkingSecondPingHours),
      buyerThinkingSlowTrackDays: Number(form.buyerThinkingSlowTrackDays),
    });
    setSaved(true);
  }

  const sellerWarn = Number(form.sellerPropertyMissingWarnDays);
  const sellerCritical = Number(form.sellerPropertyMissingCriticalDays);

  return (
    <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
      {/* «Ждёт варианты» и «Ждёт показ» убраны с экрана 23.09.2026: блок обещал
          напоминания агенту и стоп на выдачу лидов, но ни напоминаний, ни стопа в
          коде нет — ни одна строка сервера это поле не читает (проверено поиском 23.09.2026). Поля
          waitingCheckAfterMinutes/waitingCheckMaxRepeats остаются в базе. */}
      <section className="card">
        <div className="sec-h stack">
          <h2>Пауза «не принимаю лиды»</h2>
          <span className="note">
            Агент выключает выдачу новых лидов сам — болезнь, отпуск, завал. KPI при этом идёт как обычно:
            иначе пауза станет способом прятать просрочки
          </span>
        </div>
        <div className="fgrid">
          <Field
            label="Не дольше, часов"
            value={form.agentPauseMaxHours}
            min={1}
            max={168}
            onChange={(v) => set("agentPauseMaxHours", v)}
          />
          <Field
            label="Остыть перед следующей, часов"
            value={form.agentPauseCooldownHours}
            min={0}
            max={168}
            onChange={(v) => set("agentPauseCooldownHours", v)}
            hint="Отсчитывается от конца прошлой паузы."
          />
        </div>
      </section>

      {/* «Бездействие по клиенту» (предупреждение, потом штраф) убрано 16.11.2026
          вместе с автоматическими штрафами Royal Score — решение владельца. Поля
          Settings.inactivity* остаются в базе, их больше никто не читает. */}
      <section className="card">
        <div className="sec-h stack">
          <h2>Застой сделки</h2>
          <span className="note">
            Если продавец долго висит без единого объекта в CRM, или покупатель — без единой сделки, вам
            приходит уведомление, а агенту — задача
          </span>
        </div>
        <div className="fgrid">
          <Field
            label="Продавец без объекта, дней"
            value={form.dealStaleSellerDays}
            min={1}
            max={60}
            onChange={(v) => set("dealStaleSellerDays", v)}
          />
          <Field
            label="Покупатель без сделки, дней"
            value={form.dealStaleBuyerDays}
            min={1}
            max={90}
            onChange={(v) => set("dealStaleBuyerDays", v)}
          />
        </div>
      </section>

      <section className="card">
        <div className="sec-h stack">
          <h2>Возврат клиента</h2>
          <span className="note">
            Клиент из Корзины, написавший или позвонивший сам, сначала идёт прежнему агенту. Если тот не
            откликнулся за это время — уходит в общую очередь по KPI
          </span>
        </div>
        <div className="fgrid">
          <Field
            label="Ждать прежнего агента, минут"
            value={form.lostReturnAcceptMinutes}
            min={5}
            max={1440}
            onChange={(v) => set("lostReturnAcceptMinutes", v)}
          />
        </div>
      </section>

      <section className="card">
        <div className="sec-h stack">
          <h2>Продавец без объекта</h2>
          <span className="note">
            Приёмка от продавца принята, но объект в CRM всё ещё не заведён. «Предупреждение» переносит
            внутреннее напоминание агенту; «Критично» — тот же случай попадает в «Контроль руководителя»
          </span>
        </div>
        <div className="fgrid">
          <Field
            label="Предупреждение, дней"
            value={form.sellerPropertyMissingWarnDays}
            min={1}
            max={30}
            onChange={(v) => set("sellerPropertyMissingWarnDays", v)}
          />
          <Field
            label="Критично, дней"
            value={form.sellerPropertyMissingCriticalDays}
            min={1}
            max={60}
            onChange={(v) => set("sellerPropertyMissingCriticalDays", v)}
            bad={sellerCritical > 0 && sellerWarn > 0 && sellerCritical <= sellerWarn}
            hint={
              sellerCritical > 0 && sellerWarn > 0 && sellerCritical <= sellerWarn
                ? "«Критично» наступает не позже «Предупреждения» — тогда предупреждать уже некогда. Поставьте срок критичности больше срока предупреждения."
                : undefined
            }
          />
        </div>
      </section>

      <section className="card">
        <div className="sec-h stack">
          <h2>Покупатель думает (медленный трек)</h2>
          <span className="note">
            Клиент взял паузу подумать: первые два напоминания агенту — короткие, дальше система переходит на
            редкий темп, чтобы не давить на клиента, который уже сказал, что ему нужно время
          </span>
        </div>
        <div className="fgrid">
          <Field
            label="Первое напоминание, часов"
            value={form.buyerThinkingFirstPingHours}
            min={1}
            max={240}
            onChange={(v) => set("buyerThinkingFirstPingHours", v)}
          />
          <Field
            label="Второе напоминание, часов"
            value={form.buyerThinkingSecondPingHours}
            min={1}
            max={480}
            onChange={(v) => set("buyerThinkingSecondPingHours", v)}
          />
          <Field
            label="Дальше — раз в, дней"
            value={form.buyerThinkingSlowTrackDays}
            min={1}
            max={30}
            onChange={(v) => set("buyerThinkingSlowTrackDays", v)}
          />
        </div>
      </section>

      <div className="card tight">
        <div className="wrap">
          <button className="pill ghost" type="submit" disabled={updateForm.isPending || !settings}>
            Сохранить
          </button>
          {saved && <span className="saved on">Сохранено</span>}
          {!settings && <span className="saved">Настройки ещё не загрузились — сохранять нечего.</span>}
        </div>
        <MutationError mutation={updateForm} fallback="Не удалось сохранить" variant="rh2" />
      </div>
    </form>
  );
}

/** Числовое поле настройки — поле эталона `.fld` с подписью и пояснением. */
function Field({
  label,
  value,
  min,
  max,
  onChange,
  hint,
  bad = false,
}: {
  label: string;
  value: string | undefined;
  min: number;
  max: number;
  onChange: (v: string) => void;
  /** Пояснение под полем. Красное, когда `bad` — значение противоречит соседнему. */
  hint?: string;
  bad?: boolean;
}) {
  return (
    <label className={`fld${bad ? " bad" : ""}`}>
      <span className="lab">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        inputMode="numeric"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="msg">{hint}</span>}
    </label>
  );
}
