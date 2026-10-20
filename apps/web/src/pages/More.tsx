import type { CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, LogOut, UserCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useNavigation, type NavItem } from "../lib/navigation";
import { signOut } from "../lib/signOut";
import { RH2_UNREAD_CHIP } from "../components/rh2/Rh2Scope";
import { useMobileUx } from "../hooks/useMobileUx";
import { MobileMore } from "../components/mobile/MobileMore";

/**
 * «Ещё» — пятая вкладка нижней навигации телефона (view 'more' в прототипе
 * design_handoff; сверяется по screenshots/mobile-05-more-menu.png и
 * role-director-more-menu.png): все разделы роли, не поместившиеся в нижнюю
 * панель, группами карточек-списков.
 *
 * Состав НЕ прошит руками — собирается из того же реестра useNavigation(),
 * что кормит сайдбар и нижние вкладки: новый раздел появляется здесь сам,
 * с теми же правами и счётчиками. Первая группа «Работа» — ежедневное (main
 * минус нижние вкладки), дальше складки реестра (Обращения/Аналитика/
 * Агентство), в конце «Личное»: профиль, настройки и выход — как в макете.
 *
 * ОБЛИК — тема «Royal Home 2026». Своего фрагмента у этого экрана в прототипе
 * нет, поэтому он собран из тех же кирпичей, что соседи: обёртка `.rh2 > .scr`,
 * подпись группы — `.sec-t`, сама группа — список `.list`, строка — `.row`
 * эталона: тонированный кружок `.av`, название в `.t b`, счётчик `.chip`,
 * шеврон в `.meta`.
 *
 * ПЛОТНОСТЬ (разбор `docs/mobile-review-09-09.md`, пункты 4 и 5). Раньше каждая
 * группа лежала в своей карточке `.card.tight`, и группа из ОДНОГО пункта
 * («Работа» → «Календарь», «Клиенты и сделки» → «Сделки») занимала 117 px ради
 * строки в 60: подпись с отступами 24/8, свои 16+16 внутренних отступов
 * карточки и 16 между карточками. Групп девять, четыре из них по одному пункту.
 * Карточки больше нет: подпись `.sec-t`, под ней сразу `.list` со строками
 * `.row`, разделённые собственной чертой строки (`border-bottom` эталона).
 * Ровно так же это устроено в меню кнопки «+» (`FabMenu.tsx`, раздел
 * «Спросить»): `.sec-t` и следом `.list` без карточки — это не отступление от
 * макета, а уже принятый в приложении способ показать группу-список.
 */
export function More() {
  const navigate = useNavigate();
  const mobile = useMobileUx();
  const { main, more, sections, system, bottom } = useNavigation();

  // Нижние вкладки уже на экране всегда — в «Ещё» их не дублируем.
  const inBottom = new Set([...bottom.left, ...bottom.right].map((i) => i.to));
  const work = [...main, ...more].filter((i) => !inBottom.has(i.to) && i.to !== "/");

  function handleLogout() {
    // Ровно тот же выход, что в ProfileMenu — общий lib/signOut: он же снимает
    // push-подписку телефона, иначе уведомления приходили бы и после выхода.
    void signOut();
    navigate("/login");
  }

  // На телефоне экран рисует третий артефакт владельца (de2845f1, «телефон
  // после экспертизы»): квадратные плашки 36 px, строки 56 px, счётчики двух
  // видов. Разметка у него своя и область стилей своя (`.rh2 .mh`), поэтому
  // отдельным компонентом, а не набором условий внутри одной. Ветвление ПОСЛЕ
  // всех хуков — состав хуков не должен зависеть от ширины экрана.
  if (mobile) return <MobileMore />;

  return (
    <div className="rh2 screens">
      <div className="scr" data-stagger>
        <h1 className="vh">Ещё</h1>

        {work.length > 0 && (
          <div>
            <div className="sec-t">Работа</div>
            <div className="list">
              {work.map((item, i) => (
                <Row key={item.to + item.label} item={item} tint={TINT_CYCLE[i % TINT_CYCLE.length]} onGo={navigate} />
              ))}
            </div>
          </div>
        )}

        {sections.map((section) => {
          const items = section.items.filter((i) => !inBottom.has(i.to));
          if (items.length === 0) return null;
          return (
            <div key={section.key}>
              <div className="sec-t">{section.title}</div>
              <div className="list">
                {items.map((item, i) => (
                  <Row key={item.to + item.label} item={item} tint={TINT_CYCLE[i % TINT_CYCLE.length]} onGo={navigate} />
                ))}
              </div>
            </div>
          );
        })}

        <div>
          <div className="sec-t">Личное</div>
          <div className="list">
            <RowBase icon={UserCircle} tint="sky" label="Мой профиль" onClick={() => navigate("/profile")} />
            {system.map((item) => (
              <Row key={item.to} item={item} tint="lav" onGo={navigate} />
            ))}
            {/* Выход — красным, как в макете; это единственная строка-действие. */}
            <RowBase icon={LogOut} tint="pink" label="Выйти" danger onClick={handleLogout} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Тона кружков эталона. Смысловой привязки цвет→раздел в макете нет, цвета
 * просто чередуются, чтобы список читался не серой простынёй.
 */
type Tint = "lime" | "sky" | "aqua" | "pink" | "lav";
const TINT_CYCLE: Tint[] = ["lime", "sky", "aqua", "pink"];
const tintStyle = (tint: Tint): CSSProperties => ({
  background: `var(--${tint})`,
  color: `var(--${tint}-ink)`,
});

function Row({ item, tint, onGo }: { item: NavItem; tint: Tint; onGo: (to: string) => void }) {
  return (
    <RowBase icon={item.icon} tint={tint} label={item.label} badge={item.badge} onClick={() => onGo(item.to)} />
  );
}

function RowBase({
  icon: Icon,
  tint,
  label,
  badge,
  danger,
  onClick,
}: {
  icon: LucideIcon;
  tint: Tint;
  label: string;
  badge?: number;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <div className="row" role="button" tabIndex={0} onClick={onClick} onKeyDown={(e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    }}>
      <span className="av" style={tintStyle(tint)}>
        <Icon className="i" aria-hidden />
      </span>
      <div className="t">
        <b style={danger ? { color: "var(--crit)" } : undefined}>{label}</b>
      </div>
      {/* Счётчик непрочитанного — пастельный, не красный: красная семья по
          договору §3 и §6.1 закреплена за «надо сделать». Разбор и цвет —
          RH2_UNREAD_CHIP, тот же, что у счётчика в шапке приложения. */}
      {!!badge && (
        <span className="chip" style={RH2_UNREAD_CHIP}>
          {badge > 99 ? "99+" : badge}
        </span>
      )}
      {/* Шеврон — `.meta` (flex:none), а не `.act`: в узком режиме эталон
          отдаёт `.row .act` всю ширину строки, и одна стрелка уезжала бы
          на вторую строку. */}
      <span className="meta">
        <ChevronRight className="i" aria-hidden />
      </span>
    </div>
  );
}
