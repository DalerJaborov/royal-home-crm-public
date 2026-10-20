import { CalendarClock, Home } from "lucide-react";
import { dushanbeDate } from "../lib/date";
import {
  conductedShowings,
  nextStepOf,
  type SignalTone,
} from "../lib/clientSignals";
import type { Client } from "../types";

/**
 * ПОЛОСА «ЧТО ГОРИТ» — под именем клиента, до кнопок.
 *
 * ЗАЧЕМ (владелец 20.08.2026, выбрал из списка предложений). Самый громкий факт о
 * клиенте лежал внутри свёрнутой карточки «Детали клиента»: чтобы его узнать,
 * надо было доскроллить и нажать «Подробнее». Агент, который открыл карточку
 * перед звонком, этого не делает — он смотрит на верх экрана и жмёт «Позвонить».
 * Значит наверху и должно стоять то, от чего зависит разговор.
 *
 * Плашка «молчит N дней» убрана 05.09.2026 (решение владельца — посчитал её
 * лишней на карточке). Функция `silenceLabel`/`silenceTone` в lib/clientSignals.ts
 * не удалена — ей всё ещё пользуются другие экраны (см. MobileTelephony.tsx).
 *
 * Показы и обещанный шаг — только когда есть: пустая плашка «показов 0» занимает
 * место и ничего не сообщает, а «нет следующего шага» — не факт о клиенте, а
 * укор агенту, и место ему не здесь.
 *
 * НИЧЕГО НЕ ВЫДУМЫВАЕТСЯ. Оба сигнала считаются из полей, которые уже пришли с
 * сервером, теми же правилами, что и на десктопной полосе фактов
 * (см. lib/clientSignals.ts — общий модуль ровно поэтому).
 */

/**
 * ОБЛИК — тема «Royal Home 2026» (09.09.2026): плашка прототипа `.chip`
 * (screens/client-detail.html, полоса под именем) вместо своей круглой рамки.
 * Оттенки — `.chip warn`/`.chip crit` того же макета. Компонент рендерит только
 * карточка клиента, поэтому переключателя облика не понадобилось.
 */
const TONE_CLASS: Record<SignalTone, string> = {
  normal: "chip mute",
  amber: "chip warn",
  red: "chip crit",
};

function Signal({
  icon,
  children,
  tone = "normal",
  title,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  tone?: SignalTone;
  title?: string;
}) {
  return (
    <span title={title} className={TONE_CLASS[tone]}>
      {icon}
      {children}
    </span>
  );
}

export function ClientSignals({ client, showNext = true }: { client: Client; showNext?: boolean }) {
  const interactions = client.interactions ?? [];
  const showings = conductedShowings(interactions);
  const next = showNext ? nextStepOf(client) : null;
  // Нет ни показов, ни следующего шага — не рисуем ничего: пустая карточка `.card.tight`
  // висела белой полосой над «Где сделка» (сверка с артефактом 10.09).
  if (showings === 0 && !next) return null;

  return (
    /**
     * `.wrap` прототипа — та же строка плашек, что под именем клиента в макете.
     * Переносом, а не прокруткой вбок: `.chip` в макете живёт именно в `.wrap`,
     * а высота шапки от переноса не растёт настолько, чтобы «Позвонить» ушла за
     * край (кнопка теперь стоит в `.cd-h .acts`, а не под полосой).
     */
    <div className="card tight">
      <div className="wrap">
        {showings > 0 && (
          <Signal
            icon={<Home className="i" />}
            title="Показы, которые уже состоялись: назначенные на будущее сюда не считаются"
          >
            показов {showings}
          </Signal>
        )}

        {next && (
          <Signal
            icon={<CalendarClock className="i" />}
            tone={
              next.at && new Date(next.at).getTime() < Date.now()
                ? "amber"
                : "normal"
            }
            title="Что вы сами записали как следующий шаг по этому клиенту"
          >
            {next.at ? dushanbeDate(next.at) : "далее"} · {next.action}
          </Signal>
        )}
      </div>
    </div>
  );
}
