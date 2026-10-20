import { ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { REFUSAL_REASON_LABELS, REFUSAL_INITIATOR_LABELS, SECURITY_REVIEW_LABELS } from "@royal-home/shared";
import type { SecurityClientRow } from "../../hooks/useSecurity";
import { relativeTime } from "../../lib/format";
import { formatClientCode, formatClientName } from "../../lib/clientFormat";
import { AVATAR_TONES, initials } from "../../lib/theme2026Person";
import { Rh2ErrorState } from "../rh2/Rh2ErrorState";
import { Rh2EmptyState } from "../rh2/Rh2EmptyState";

/**
 * Список проверок службы безопасности — используется одним `pages/SecurityCenter.tsx`
 * на обе ширины (10.09.2026 отдельный `MobileSecurityCenter.tsx` удалён: он лишь
 * повторял разметку без своей логики, узкую раскладку делают медиазапросы
 * `theme-2026-proto.css`). Раньше строка была написана в двух файлах дважды и
 * успела разойтись: скоринг ИИ появился в мобильной копии на девять дней позже
 * десктопной — сама разметка `.pcard` тоже вынесена сюда отдельным модулем,
 * чтобы так больше не повторилось.
 */

/** Вердикт СБ — метки эталона: ждёт → warn, снято → ok, подтверждено → crit. */
const VERDICT_CHIP: Record<string, string> = {
  PENDING: "chip warn",
  CLEARED: "chip ok",
  CONFIRMED: "chip crit",
};

const FAULT_LABELS: Record<SecurityClientRow["lossFault"], string> = {
  client_lost_agent_fault: "Есть просрочки со стороны агента",
  client_lost_no_fault: "Без просрочек со стороны агента",
};

/**
 * Три РАЗНЫХ состояния, которые раньше выглядели одинаково: пока данные едут и
 * когда сервер отказал, `data?.items ?? []` давало пустой массив, и человек читал
 * «ничего не ждёт проверки» — то есть отсутствие ответа выглядело как отсутствие
 * работы. Для кабинета, куда попадают потерянные сделки, это худший вид молчания.
 */
export function SecurityList({
  rows,
  isLoading,
  isError,
  onRetry,
}: {
  rows: SecurityClientRow[];
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
}) {
  if (isLoading) {
    return (
      <div className="state">
        <span className="sk av" />
        <span className="sk w40" />
        <span className="sk w22" /> Загружаем список
      </div>
    );
  }
  if (isError) {
    return (
      <Rh2ErrorState
        message="Не удалось загрузить список. Это не значит, что раздел пуст — попробуйте ещё раз."
        onRetry={() => onRetry?.()}
      />
    );
  }
  if (rows.length === 0) {
    return (
      <Rh2EmptyState icon={ShieldCheck} title="Пусто: сейчас ничего не ждёт и не ждало проверки." />
    );
  }
  return (
    <>
      {rows.map((r, i) => (
        <SecurityRow key={r.id} row={r} tone={i % AVATAR_TONES.length} />
      ))}
    </>
  );
}

/**
 * Строка проверки. Телефон — САМ ПО СЕБЕ ТЕКСТ, не ссылка `tel:`/кнопка звонка:
 * у роли СБ нет прав `calls.*`, а `phone` может прийти замаскированным
 * («91•••••67») — попытка выглядеть как кликабельный номер создала бы кнопку,
 * которая либо звонит без права, либо тихо ничего не делает.
 */
/** Экспортируется отдельно: страница делит список на «Ждут проверки» и «Уже
 *  разобрано» (шаблон tpl-security) и рисует строки сама, а не через `SecurityList`
 *  целиком — состояния загрузки/ошибки/пусто остаются в одном месте здесь. */
export function SecurityRow({ row: r, tone }: { row: SecurityClientRow; tone: number }) {
  const verdict = r.securityReview ? SECURITY_REVIEW_LABELS[r.securityReview] : "Ожидает проверки";
  return (
    <div className="pcard">
      <span className="av" style={AVATAR_TONES[tone % AVATAR_TONES.length]}>
        {initials(r.fullName ?? "?")}
      </span>
      <div className="t">
        <b>
          <Link className="lk" to={`/clients/${r.shortId}`}>
            {formatClientName(r)}
          </Link>
        </b>
        <p className="why2">
          {r.refusalReason ? REFUSAL_REASON_LABELS[r.refusalReason] : "Причина не указана"}. Инициатор:{" "}
          {r.initiator ? REFUSAL_INITIATOR_LABELS[r.initiator] : "не определён"}.{" "}
          {r.aiScore !== null ? `Оценка на момент отказа ${r.aiScore}.` : "Оценки нет."}
        </p>
        <p className="meta2">
          {formatClientCode(r.shortId, r.kind)} · {r.phone} · {relativeTime(r.securityReviewedAt ?? r.createdAt)}.
          Агент на момент потери:{" "}
          {r.responsibleAgent ? (
            <Link className="lk" to={`/team/${r.responsibleAgent.id}`}>
              {r.responsibleAgent.fullName}
            </Link>
          ) : (
            "не указан"
          )}
          . {FAULT_LABELS[r.lossFault]}.
          {r.reviewedBy ? ` Проверил: ${r.reviewedBy.fullName}.` : ""}
        </p>
      </div>
      <span className="side2">
        <span className={VERDICT_CHIP[r.securityReview ?? "PENDING"] ?? "chip mute"}>{verdict}</span>
        <Link className="pill ghost sm" to={`/clients/${r.shortId}`}>
          {r.securityReview ? "Открыть" : "Открыть проверку"}
        </Link>
      </span>
    </div>
  );
}
