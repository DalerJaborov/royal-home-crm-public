import { useNavigate } from "react-router-dom";
import { useNavigation, type NavItem } from "../../../lib/navigation";
import { signOut } from "../../../lib/signOut";
import { useAuthStore } from "../../../store/auth";
import { ROLE_LABELS } from "../../../lib/roles";
import { RhAvatar, RhGroup, RhRow, type RhTone } from "../ui";
import { RoyalIcon } from "../RoyalIcon";
import { royalIconForPath, royalToneForPath } from "../royalNavIcons";
import { RyChevron } from "./parts";
import { RoyalSection } from "../clients/RoyalSection";

/**
 * «ЕЩЁ» В «НОВОМ ВИДЕ» (18.11.2026, макет `screenMore`, кадр rh-phone-more.png).
 *
 * Состав — тот же реестр `useNavigation()`, что у прежнего экрана и меню: те же
 * разделы, права и счётчики; новый раздел появится здесь сам. Значок и цвет
 * круга — по адресу (royalNavIcons), как в боковом меню нового вида. Выход —
 * отдельной группой в самом низу, тем же общим `signOut`.
 */
export function RoyalMore() {
  const navigate = useNavigate();
  const me = useAuthStore((s) => s.agent);
  const { main, more, sections, system, bottom } = useNavigation();

  // Нижние вкладки уже на экране — в «Ещё» их не дублируем (как прежде).
  const inBottom = new Set([...bottom.left, ...bottom.right].map((i) => i.to));
  const work = [...main, ...more].filter((i) => !inBottom.has(i.to) && i.to !== "/");
  const groups: { key: string; title: string; items: NavItem[] }[] = [
    ...(work.length > 0 ? [{ key: "work", title: "Работа", items: work }] : []),
    ...sections
      .map((s) => ({ key: s.key, title: s.title, items: s.items.filter((i) => !inBottom.has(i.to)) }))
      .filter((s) => s.items.length > 0),
  ];

  function handleLogout() {
    void signOut();
    navigate("/login");
  }

  return (
    <RoyalSection name="team">
    <div className="ry-more" data-ry-section="team">
      <h1 className="ry-title" data-dup>Ещё</h1>
      {groups.map((group) => (
        <section key={group.key} className="ry-section" aria-label={group.title}>
          <header className="ry-section-head"><h2>{group.title}</h2></header>
          <RhGroup>{group.items.map((item) => <NavRow key={item.to + item.label} item={item} />)}</RhGroup>
        </section>
      ))}
      <section className="ry-section" aria-label="Личное">
        <header className="ry-section-head"><h2>Личное</h2></header>
        <RhGroup>
          {me && (
            <RhRow to="/profile" label="Мой профиль" lead={<RhAvatar name={me.fullName} src={me.avatarUrl} />}
              title="Мой профиль" sub={`${me.fullName} · ${ROLE_LABELS[me.role]}`} right={<RyChevron />} />
          )}
          {system.map((item) => <NavRow key={item.to} item={item} />)}
        </RhGroup>
      </section>
      <RhGroup label="Выход">
        <button type="button" className="ry-row ry-row-link ry-row-danger" onClick={handleLogout}>
          <span className="ry-circle" data-tone="a0" aria-hidden="true"><RoyalIcon name="log-out" /></span>
          <span className="ry-row-text"><span className="ry-row-title">Выйти</span></span>
        </button>
      </RhGroup>
    </div>
    </RoyalSection>
  );
}

function NavRow({ item }: { item: NavItem }) {
  const tone = `a${royalToneForPath(item.to)}` as RhTone;
  const badge = item.badge ? (item.badge > 99 ? "99+" : String(item.badge)) : null;
  return (
    <RhRow to={item.to} title={item.label}
      lead={<span className="ry-circle" data-tone={tone} aria-hidden="true"><RoyalIcon name={royalIconForPath(item.to)} /></span>}
      right={<>{badge && <span className="ry-badge" data-quiet={item.badgeQuiet || undefined} aria-label={`${badge} новых`}>{badge}</span>}<RyChevron /></>} />
  );
}
