import { useNavigate } from "react-router-dom";
import { LogOut, UserCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useNavigation, type NavItem } from "../../lib/navigation";
import { signOut } from "../../lib/signOut";
import { useAuthStore } from "../../store/auth";
import { avatarInitial, avatarToneClass } from "../../lib/avatarTone";
import { MhListScreen } from "./mh/MhList";

/**
 * «ЕЩЁ» НА ТЕЛЕФОНЕ — третий артефакт владельца, дословно
 * (docs/pult/theme-2026/artifact-de2845f1-phone-after.html,
 * `<section class="screen" data-screen="more">`): шапка «Ещё» с кружком
 * профиля справа, дальше группы «Работа» / «Обращения» — подпись `.sec-t` и
 * сразу список `.list` со строками 56 px, у каждой квадратная плашка 36 px в
 * своём пастельном тоне и счётчик справа.
 *
 * СОСТАВ НЕ ПРОШИТ РУКАМИ — собирается из того же реестра `useNavigation()`,
 * что кормит боковое меню и нижние вкладки: новый раздел появляется здесь сам,
 * с теми же правами и счётчиками. Названия групп («Работа», «Обращения»,
 * «Аналитика»…) приходят оттуда же; артефакт рисует первые две, остальные
 * продолжают тот же ряд.
 *
 * ЧЕМ ОТЛИЧАЕТСЯ ОТ ПРЕЖНЕЙ ВЕРСИИ (pages/More.tsx, эталон пульта `.rh2 .scr`):
 * круглый аватар-кружок заменён квадратной плашкой `.plate` 36 px (артефакт),
 * строка ужата с 64 до 56 px, шеврон справа убран — его место занял счётчик,
 * а «строка открывается вся» и так понятно по списку.
 *
 * ДВЕ ФОРМЫ СЧЁТЧИКА, ОБЕ ИЗ АРТЕФАКТА: капсула для «надо разобрать» (у него
 * это «Комментарии 1») и голое число для справочного (у него «Объекты 94»).
 * Что из двух — решает сам реестр полем `badgeQuiet`, а не этот файл: иначе
 * телефон и боковое меню разошлись бы в том, что считать срочным. Капсула
 * пастельная, не красная: красная семья по договору §3 закреплена за «надо
 * сделать», а не за «есть новое».
 */

/**
 * Тона плашек. Смысловой привязки цвет→раздел у владельца нет — цвета просто
 * чередуются, чтобы список не читался серой простынёй (то же в pages/More.tsx).
 */
const TINTS = ["sky", "lime", "aqua", "lav", "pink"] as const;

export function MobileMore() {
  const navigate = useNavigate();
  const { main, more, sections, system, bottom } = useNavigation();
  const me = useAuthStore((s) => s.agent);

  // Нижние вкладки уже на экране всегда — в «Ещё» их не дублируем.
  const inBottom = new Set([...bottom.left, ...bottom.right].map((i) => i.to));
  const work = [...main, ...more].filter((i) => !inBottom.has(i.to) && i.to !== "/");

  const groups: { key: string; title: string; items: NavItem[] }[] = [
    ...(work.length > 0 ? [{ key: "work", title: "Работа", items: work }] : []),
    ...sections
      .map((s) => ({ key: s.key, title: s.title, items: s.items.filter((i) => !inBottom.has(i.to)) }))
      .filter((s) => s.items.length > 0),
  ];

  function handleLogout() {
    // Тот же выход, что в ProfileMenu — общий lib/signOut: он же снимает
    // push-подписку телефона, иначе уведомления приходили бы и после выхода.
    void signOut();
    navigate("/login");
  }

  const myName = me?.fullName ?? "";

  /**
   * Тон плашки чередуется СКВОЗНО по всему экрану, а не внутри каждой группы.
   * Счёт от нуля в каждой группе давал у ролей с одиночными пунктами («Работа»
   * → Календарь, «Обращения» → Звонки, «Объекты» → Объекты) один и тот же
   * голубой во всех строках подряд — ровно та серая простыня, ради которой
   * цвета и заводились.
   */
  let tintAt = 0;
  const nextTint = () => TINTS[tintAt++ % TINTS.length];

  return (
    <MhListScreen
      title="Ещё"
      actions={
        <button type="button" className="ico" aria-label="Мой профиль" onClick={() => navigate("/profile")}>
          <span
            className={`av ${avatarToneClass(myName)}`}
            style={{ width: 32, height: 32, fontSize: 13 }}
            aria-hidden="true"
          >
            {avatarInitial(myName)}
          </span>
        </button>
      }
    >
      {groups.map((g, gi) => (
        <section className="sec" key={g.key} style={gi === 0 ? { marginTop: 14 } : undefined}>
          <div className="sec-t">
            <h2>{g.title}</h2>
          </div>
          <div className="list compact">
            {g.items.map((item) => (
              <MoreRow
                key={item.to + item.label}
                icon={item.icon}
                tint={nextTint()}
                label={item.label}
                badge={item.badge}
                quiet={item.badgeQuiet}
                onClick={() => navigate(item.to)}
              />
            ))}
          </div>
        </section>
      ))}

      <section className="sec">
        <div className="sec-t">
          <h2>Личное</h2>
        </div>
        <div className="list compact">
          <MoreRow icon={UserCircle} tint="sky" label="Мой профиль" onClick={() => navigate("/profile")} />
          {system.map((item) => (
            <MoreRow
              key={item.to}
              icon={item.icon}
              tint={nextTint()}
              label={item.label}
              badge={item.badge}
              quiet={item.badgeQuiet}
              onClick={() => navigate(item.to)}
            />
          ))}
          {/* Выход — красным, как в макете; единственная строка-действие. */}
          <MoreRow icon={LogOut} tint="pink" label="Выйти" danger onClick={handleLogout} />
        </div>
      </section>
    </MhListScreen>
  );
}

function MoreRow({
  icon: Icon,
  tint,
  label,
  badge,
  quiet,
  danger,
  onClick,
}: {
  icon: LucideIcon;
  tint: (typeof TINTS)[number];
  label: string;
  badge?: number;
  /** Счётчик справочный, а не «надо разобрать» — голым числом, без капсулы. */
  quiet?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="row" onClick={onClick}>
      <span className={`plate ${tint}`} aria-hidden="true">
        <Icon className="i" />
      </span>
      <span className="b">
        <span className="n">
          <span className="nm" style={danger ? { color: "var(--crit)" } : undefined}>
            {label}
          </span>
        </span>
      </span>
      {!!badge &&
        (quiet ? (
          <span className="tm">{badge > 999 ? "999+" : badge}</span>
        ) : (
          <span className="unread lav">{badge > 99 ? "99+" : badge}</span>
        ))}
    </button>
  );
}
