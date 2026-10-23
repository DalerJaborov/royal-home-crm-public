import { Link, useNavigate } from "react-router-dom";
import { CalendarCheck, CalendarPlus, House } from "lucide-react";
import { rh2AvatarTone } from "../../lib/rh2Avatar";
import { dushanbeDateTime } from "../../lib/date";
import { formatMoney } from "../../lib/format";
import type { ClientPropertyMatchEvidence } from "@royal-home/shared";
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

/** Evidence-led recommendation row. The title is a native link; choosing or
 * scheduling must not also navigate the page through a parent keyboard handler. */
export function MatchPropertyCard({
  property: p,
  selected,
  onToggleSelect,
  selectionDisabled,
  offered,
  onSend,
  sending,
  sendDisabled,
  bookedShowingAt,
  onScheduleShowing,
  onClosePanel,
}: {
  property: Property & { match?: ClientPropertyMatchEvidence };
  /** Чекбокс отбора для массовой отправки рисуется, только когда передан
   *  `onToggleSelect` (режим клиента); в остальных списках его нет. */
  selected?: boolean;
  onToggleSelect?: () => void;
  selectionDisabled?: boolean;
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

  return (
    <div className="prow client-match-property">
      {onToggleSelect && (
        <input
          className="pick"
          type="checkbox"
          checked={!!selected}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggleSelect}
          disabled={!canPick || sending || selectionDisabled}
          aria-label={`Отправить клиенту: ${p.title}`}
          title={canPick ? selectionDisabled ? "Можно выбрать до пяти объектов за раз" : "Выбрать для отправки клиенту" : "Объект продан или снят с продажи — клиенту не отправляется"}
        />
      )}
      <span className="ph">
        {p.photos?.[0] ? <img src={p.photos[0].thumbUrl} alt="" loading="lazy" decoding="async" /> : <House className="i" strokeWidth={1.5} />}
      </span>
      <div className="t">
        {/* Две строки названия, а не одна с многоточием (28.09.2026): на
            телефоне «3-комнатная у парка…» не отличить от соседнего объекта. */}
        <Link to={`/properties/${p.shortId}`} onClick={() => onClosePanel?.()}
          style={{
            whiteSpace: "normal",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {p.title}
        </Link>
        <span>{[p.district?.name, `${p.areaSqm} м²`, p.rooms ? `${p.rooms} комн.` : null].filter(Boolean).join(" · ")}</span>
        <span className="wrap" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
          {p.match && <span className={`chip${p.match.tier === "exact" ? " ok" : ""}`}>
            {p.match.tier === "exact" ? "Подходит по параметрам" : p.match.tier === "alternative" ? "Есть компромиссы" : "Нужно уточнить"}
          </span>}
          {p.match?.isMine && <span className="chip">Мой объект</span>}
          {p.distanceM != null && <span className="chip">{formatDistance(p.distanceM)}</span>}
          {offered && <span className="chip">{p.match?.lastSentAt ? `Отправляли ${dushanbeDateTime(p.match.lastSentAt)}` : "Отправляли"}</span>}
          {/* «ИИ» — чипом в общем ряду: внутри `.t` любой span блочный, и
              чип растягивался на всю ширину строки. */}

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
        {p.match && <div className="client-match-evidence">
          {p.match.reasons.length > 0 && <p>{p.match.reasons.join(" · ")}</p>}
          {p.match.tradeoffs.length > 0 && <p className="client-match-tradeoff">Учесть: {p.match.tradeoffs.join(" · ")}</p>}
          {p.match.unknowns.length > 0 && <p>Уточнить: {p.match.unknowns.join(" · ")}</p>}
        </div>}
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
                disabled={!canPick || sending}
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
