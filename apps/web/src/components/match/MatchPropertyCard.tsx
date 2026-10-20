import { useNavigate } from "react-router-dom";
import { CalendarCheck, CalendarPlus, House } from "lucide-react";
import { rh2AvatarTone } from "../../lib/rh2Avatar";
import { dushanbeDateTime } from "../../lib/date";
import { formatMoney } from "../../lib/format";
import type { Property } from "../../types";

/** Ответственный за объект: риелтор сделки, а если его ещё нет — тот, кто завёл.
 *  Перенесено дословно из прежнего MatchPropertiesModal.tsx. */
function agentOf(p: Property) {
  return p.assignedAgent ?? p.intakeAgent ?? null;
}

function initials(name: string) {
  return name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}

/** Метры до желаемого места клиента — округляем до сотни в километрах, до
 *  десятка в метрах: точное «1234 м» ничего агенту не говорит, «≈ 1,2 км» —
 *  говорит сразу. */
function formatDistance(m: number): string {
  if (m >= 1000) return `≈ ${(m / 1000).toFixed(1).replace(".", ",")} км`;
  return `≈ ${Math.round(m / 10) * 10} м`;
}

/**
 * Строка объекта панели «Подбор» (задание D, 17.09.2026,
 * `docs/agent-briefs/match-17-09-D-web-panel.md`).
 *
 * Перенесено из `MatchPropertiesModal.tsx` (файл удалён) и дополнено баллом
 * совпадения/расстоянием — новыми полями `score`/`distanceM`, которых у
 * сервера ещё может не быть (параллельная работа над контрактом, раздел 6
 * плана): оба читаются как `?? null` и просто не рисуются, если пусто.
 *
 * ВСЯ СТРОКА КЛИКАБЕЛЬНА (владелец 17.09.2026 вечер: «карточками везде и
 * кликабельные, чтобы три часа не искать рекомендуемый объект») — тот же
 * приём, что `PropertyCard` в каталоге (`pages/Properties.tsx`, `.cell`):
 * `role="button"`, клавиатура Enter/Space. Внутренние элементы управления
 * (чекбокс, кнопки) останавливают всплытие, иначе клик по ним ещё и уводил бы
 * на страницу объекта.
 */
export function MatchPropertyCard({
  property: p,
  selected,
  onToggleSelect,
  offered,
  onSend,
  sending,
  sendDisabled,
  bookedShowingAt,
  onScheduleShowing,
  onClosePanel,
}: {
  property: Property;
  /** Чекбокс отбора для массовой отправки рисуется, только когда передан
   *  `onToggleSelect` (режим клиента); в остальных списках его нет. */
  selected?: boolean;
  onToggleSelect?: () => void;
  /** Уже предлагали этому клиенту — кнопка «В переписку» превращается в чип. */
  offered?: boolean;
  onSend?: () => void;
  sending?: boolean;
  /** Channel preflight is unknown or failed; selection and showing remain available. */
  sendDisabled?: boolean;
  /** ISO-дата уже назначенного показа этому клиенту — null/undefined, если не назначен. */
  bookedShowingAt?: string | null;
  onScheduleShowing?: () => void;
  /** Панель закрывается при переходе на страницу объекта (как в прежнем окне). */
  onClosePanel?: () => void;
}) {
  const navigate = useNavigate();
  /**
   * Отправить можно любой объект в продаже (28.09.2026). Раньше — только
   * выложенный на сайт или несайтовый, а свежий объект днями ждёт фото и ролик
   * до сайта, и все эти дни его нельзя было ни отметить, ни отправить. Теперь
   * такой уходит личной ссылкой клиента, как несайтовый.
   */
  const canPick = p.status !== "SOLD" && p.status !== "WITHDRAWN";
  const personalLink = p.offSite || !p.publishedOnSite;

  function open() {
    navigate(`/properties/${p.shortId}`);
    onClosePanel?.();
  }

  return (
    <div
      className="prow"
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
    >
      {onToggleSelect && (
        <input
          className="pick"
          type="checkbox"
          checked={!!selected}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggleSelect}
          disabled={!canPick}
          aria-label={`Отправить клиенту: ${p.title}`}
          title={canPick ? "Выбрать для отправки клиенту" : "Объект продан или снят с продажи — клиенту не отправляется"}
        />
      )}
      <span className="ph">
        {p.photos?.[0] ? <img src={p.photos[0].thumbUrl} alt="" /> : <House className="i" strokeWidth={1.5} />}
      </span>
      <div className="t">
        {/* Две строки названия, а не одна с многоточием (28.09.2026): на
            телефоне «3-комнатная у парка…» не отличить от соседнего объекта. */}
        <b
          style={{
            whiteSpace: "normal",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {p.title}
        </b>
        <span>{[p.district?.name, `${p.areaSqm} м²`, p.rooms ? `${p.rooms} комн.` : null].filter(Boolean).join(" · ")}</span>
        <span className="wrap" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
          {p.score != null && (
            <span className={p.score >= 75 ? "chip ok" : "chip"}>Совпало {p.score}%</span>
          )}
          {p.distanceM != null && <span className="chip">{formatDistance(p.distanceM)}</span>}
          {onSend && offered && <span className="chip ok">Отправляли</span>}
          {/* «ИИ» — чипом в общем ряду: внутри `.t` любой span блочный, и
              чип растягивался на всю ширину строки. */}
          {p.aiReason && <span className="chip ok">ИИ</span>}
          {personalLink && (
            <span
              className="chip"
              title={
                p.offSite
                  ? "Объект только в CRM — клиент получит личную ссылку"
                  : "Объекта ещё нет на сайте — клиент получит личную ссылку с фото и описанием"
              }
            >
              личная ссылка
            </span>
          )}
        </span>
        {p.aiReason && <span style={{ whiteSpace: "normal" }}>{p.aiReason}</span>}
      </div>
      <div className="who">
        {agentOf(p) ? (
          <>
            <span className="av" style={rh2AvatarTone(agentOf(p)!.fullName)}>
              {initials(agentOf(p)!.fullName)}
            </span>
            <span>{agentOf(p)!.fullName}</span>
          </>
        ) : (
          <span>без агента</span>
        )}
      </div>
      <div className="pr">{formatMoney(p.price, p.currency)}</div>
      {(onSend || onScheduleShowing) && (
        <div className="act" onClick={(e) => e.stopPropagation()}>
          {/* «Отправляли» больше не прячет кнопку (28.09.2026): клиент мог
              потерять ссылку или попросить ещё раз, и тупиковый чип читался как
              «кнопка не работает». Сам чип — среди примет объекта слева, чтобы
              не отнимать место у названия. */}
          {onSend && canPick && (
            <button
              type="button"
              className="pill ghost sm"
              onClick={onSend}
              disabled={sending || sendDisabled}
              title={sendDisabled ? "Сначала дождитесь проверки канала отправки" : offered ? "Отправить клиенту ещё раз" : "Отправить клиенту ссылку на объект"}
            >
              {offered ? "Ещё раз" : "Отправить"}
            </button>
          )}
          {onScheduleShowing &&
            (bookedShowingAt ? (
              <button
                type="button"
                className="pill ghost sm"
                onClick={() => navigate("/calendar")}
                title="Показ этого объекта уже назначен. Перенести или отменить: в Календаре"
              >
                <CalendarCheck className="i" strokeWidth={1.5} />
                Показ {dushanbeDateTime(bookedShowingAt)}
              </button>
            ) : (
              <button
                type="button"
                className="pill ghost sm"
                onClick={onScheduleShowing}
                title="Назначить показ этого объекта клиенту"
              >
                <CalendarPlus className="i" strokeWidth={1.5} />
                Назначить показ
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
