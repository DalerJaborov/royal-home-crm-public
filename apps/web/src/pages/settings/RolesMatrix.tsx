import { Link } from "react-router-dom";
import {
  PERMISSIONS,
  PERMISSION_GROUPS,
  ROLES,
  ROLE_LABELS,
  ROLE_PRESETS,
  type PermissionId,
  type Role,
} from "@royal-home/shared";
import { useCan } from "../../lib/permissions";
import { scrollableRegion } from "../../lib/a11y";

/**
 * «Права по ролям» (макет владельца, `tpl-roles-matrix`): роль на роль, кому что
 * открыто по умолчанию. Источник один — реестр прав и пресеты ролей в
 * packages/shared/src/permissions.ts, те же, по которым сервер решает каждый
 * запрос; вторую таблицу «как должно быть» здесь не ведём.
 *
 * Чего здесь нет по сравнению с макетом, и почему: макет отмечает красным
 * «спорные» пересечения и перечисляет их под таблицей. Это разбор владельца, а
 * не свойство кода: код не знает, о чём договаривались. Строки «Разделы меню»
 * макета тоже не повторены: пункты меню открываются этими же правами
 * (lib/navigation.ts), а дублировать условия второй раз значит разъехаться.
 */

/** «Своё»: права нет, но есть его личная версия — видно только своих. */
const OWN_TWIN: Partial<Record<PermissionId, PermissionId>> = {
  "messages.view": "messages.viewOwn",
  "calls.transcripts": "calls.ownTranscripts",
};

/** Роли, которым без права «все клиенты / все сделки» показывают своих. */
const SALES_ROLES: Role[] = ["AGENT", "MANAGER"];
const OWN_BY_ROLE: PermissionId[] = ["clients.viewAll", "deals.viewAll"];

type Mark = "y" | "n" | "p";

function markFor(role: Role, id: PermissionId): Mark {
  const granted = new Set(ROLE_PRESETS[role]);
  if (granted.has(id)) return "y";
  const twin = OWN_TWIN[id];
  if (twin && granted.has(twin)) return "p";
  if (OWN_BY_ROLE.includes(id) && SALES_ROLES.includes(role)) return "p";
  return "n";
}

const MARK_TEXT: Record<Mark, string> = { y: "есть", n: "нет", p: "своё" };

export function RolesMatrix() {
  const can = useCan();
  const rows = PERMISSIONS.filter((p) => !("deprecated" in p));
  const ownerOnly = rows.filter((p) => "directorOnly" in p);
  const regular = rows.filter((p) => !("directorOnly" in p));

  if (!can("settings.view")) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="pg-h">
            <div>
              <h1>Права по ролям</h1>
              <p className="sub">Раздел доступен только директору и администратору.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="pg-h">
          <div>
            <Link className="lnk" to="/settings?tab=team" style={{ paddingLeft: 0 }}>
              <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}>
                <path d="M15 6l-6 6 6 6" />
              </svg>
              Настройки
            </Link>
            <h1 style={{ marginTop: 4 }}>Права по ролям</h1>
            <p className="sub">
              Ролей: {ROLES.length}, прав: {rows.length}; {ownerOnly.length} из них не выдаются галочкой никому кроме директора.
              Таблица построена по тем же пресетам, по которым сервер отвечает на каждый запрос; личные правки
              прав сотрудника здесь не видны, они в его карточке.
            </p>
          </div>
        </div>

        <div className="card tight">
          <div className="rmx-lgd">
            <span>
              <span className="mk y">да</span> право есть
            </span>
            <span>
              <span className="mk n">нет</span> кнопки и пункта нет вообще
            </span>
            <span>
              <span className="mk p">своё</span> видно только своё
            </span>
          </div>
        </div>

        <div className="card tight">
          <div className="sec-h">
            <h2>Роль на роль</h2>
            <span className="note">директор получает всё, поэтому его столбец сплошной</span>
          </div>
          <p className="quiet only-narrow">
            <span className="dot" />
            <span className="txt">На телефоне таблица прокручивается вбок, название слева остаётся на месте.</span>
          </p>
          <div className="tbl-wrap" {...scrollableRegion("Права ролей по экранам и действиям")}>
            <table className="rmx">
              <thead>
                <tr>
                  <th className="nm">Экран или действие</th>
                  {ROLES.map((r) => (
                    <th key={r}>{ROLE_LABELS[r]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PERMISSION_GROUPS.map((g) => {
                  const inGroup = regular.filter((p) => p.group === g.id);
                  if (inGroup.length === 0) return null;
                  return [
                    <tr className="grp" key={`g-${g.id}`}>
                      <td colSpan={ROLES.length + 1}>
                        <b>{g.label}</b>
                      </td>
                    </tr>,
                    ...inGroup.map((p) => <MatrixRow key={p.id} id={p.id} label={p.label} hint={"hint" in p ? p.hint : undefined} />),
                  ];
                })}
                {ownerOnly.length > 0 && (
                  <tr className="grp">
                    <td colSpan={ROLES.length + 1}>
                      <b>Владельческая граница: не выдаётся галочкой никому</b>
                    </td>
                  </tr>
                )}
                {ownerOnly.map((p) => (
                  <MatrixRow key={p.id} id={p.id} label={p.label} hint={"hint" in p ? p.hint : undefined} />
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="sec-t">Что здесь не отмечено и почему</div>
        <div className="card tight">
          <p className="quiet">
            <span className="dot" />
            <span className="txt">
              Спорные пересечения (в макете красным) здесь не помечаются: их находит владелец при разборе, а не
              код. Таблица показывает, как права работают сегодня.
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}

function MatrixRow({ id, label, hint }: { id: PermissionId; label: string; hint?: string }) {
  return (
    <tr>
      <td className="nm">
        <b>{label}</b>
        <span>{hint ?? id}</span>
      </td>
      {ROLES.map((r) => {
        const m = markFor(r, id);
        return (
          <td key={r}>
            <span className={`mk ${m}`} title={`${ROLE_LABELS[r]}: ${MARK_TEXT[m]}`}>
              {MARK_TEXT[m]}
            </span>
          </td>
        );
      })}
    </tr>
  );
}
