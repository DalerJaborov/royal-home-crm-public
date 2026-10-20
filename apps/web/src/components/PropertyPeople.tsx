import { Link } from "react-router-dom";
import { initials } from "../lib/theme2026";
import { CallClientButton } from "./CallClientButton";
import type { Property } from "../types";

/**
 * «Кто ведёт объект» — агенты и собственник одним списком (владелец 24.09.2026).
 *
 * До этого блок был нарисован в карточке объекта ЧЕТЫРЕ раза по-разному
 * (просмотр на телефоне, просмотр на компьютере, режим правки, карточка
 * монтажёра): в одном месте агент без сделки назывался «Не назначен», в другом
 * «Ответственный агент не назначен», один и тот же человек мог стоять двумя
 * строками, а собственник был голым номером под служебным заголовком «видно
 * при полном доступе к объектам». Один компонент — одна правда на всех экранах.
 *
 * Собственник — именем со ссылкой на карточку продавца (`sellerClient` из
 * GET /properties/:id). Ссылка только там, где карточка откроется
 * (`canOpen` считает сервер по правилу GET /clients/:id), иначе человек
 * упирался бы в «Недостаточно прав».
 */
export function PropertyPeople({
  property,
  showIntakeShare = false,
  showOwner = true,
  ownerPhoneInField = false,
}: {
  property: Pick<Property, "assignedAgent" | "intakeAgent" | "ownerContact" | "ownerContactHidden" | "sellerClient">;
  /** Доля принявшего объект — финансовая информация, только при finance.view. */
  showIntakeShare?: boolean;
  /** Монтажёру собственник не нужен вовсе (решение владельца 17.08.2026). */
  showOwner?: boolean;
  /** В режиме правки номер стоит полем прямо под блоком — второй раз строкой его
   *  не печатаем (кадр директора 24.09.2026: номер собственника дважды). */
  ownerPhoneInField?: boolean;
}) {
  const assigned = property.assignedAgent ?? null;
  const intake = property.intakeAgent ?? null;
  // Подписи — ролью, а не глаголом: «Принял» про Мадину читалось как ошибка
  // (кадры 24.09.2026), а «Ведёт сделку» стояло и там, где сделки ещё нет.
  const intakeNote = `Приёмка объекта у собственника${showIntakeShare ? ", 0,5% со сделки" : ""}`;

  const rows: { key: string; name: string; note: string }[] = [];
  if (assigned && intake && assigned.id === intake.id) {
    rows.push({ key: assigned.id, name: assigned.fullName, note: `Ответственный за объект. ${intakeNote}` });
  } else {
    if (assigned) rows.push({ key: assigned.id, name: assigned.fullName, note: "Ответственный за объект" });
    if (intake) rows.push({ key: intake.id, name: intake.fullName, note: intakeNote });
  }

  return (
    <>
      <div className="list" data-testid="property-people">
        {rows.length > 0 ? (
          rows.map((r) => (
            <div className="row" key={r.key}>
              <span className="av">{initials(r.name)}</span>
              <div className="t">
                <b>{r.name}</b>
                <span>{r.note}</span>
              </div>
            </div>
          ))
        ) : (
          <div className="row">
            <span className="av">?</span>
            <div className="t">
              <b>Агент не назначен</b>
              <span>Объект пока никто не ведёт</span>
            </div>
          </div>
        )}
      </div>

      {/* Тем, кому собственник закрыт (`ownerContactHidden` считает сервер), блока нет
          вовсе (контракт 06.10.2026, review-pc.md: «контракт показывает недоступное»).
          Раньше стояли заголовок и строка «видят руководитель и агент объекта»:
          выглядело как место, куда можно нажать. Остаётся «Кто ведёт» выше: к кому
          идти за номером, видно и так. */}
      {showOwner && !property.ownerContactHidden && (
        <>
          <h3 className="sec-t">Собственник</h3>
          <OwnerRow property={property} phoneInField={ownerPhoneInField} />
        </>
      )}
    </>
  );
}

function OwnerRow({
  property,
  phoneInField = false,
}: {
  property: Pick<Property, "ownerContact" | "sellerClient">;
  phoneInField?: boolean;
}) {
  const seller = property.sellerClient ?? null;
  const phone = property.ownerContact?.trim() || null;
  const name = seller?.fullName?.trim() || "Имя не записано";
  const canOpen = !!seller?.canOpen;
  // Строка больше не ссылка целиком (24.09.2026): в ней появилась кнопка звонка,
  // а кнопка внутри ссылки — это нажатие, которое открывает карточку вместо звонка.
  return (
    <div className="list" data-testid="property-owner">
      <div className="row">
        <span className="av">{seller ? initials(name) : "?"}</span>
        <div className="t">
          {canOpen ? (
            <Link to={`/clients/${seller!.shortId}`} aria-label={`Открыть карточку продавца ${name}`}>
              <b>{name}</b>
            </Link>
          ) : (
            <b>{name}</b>
          )}
          {!phoneInField && <span>{phone ?? "Телефон не записан"}</span>}
        </div>
        <div className="act">
          {/* Звонок собственнику через CRM: запись разговора ляжет в историю
              продавца. Правило звонка живёт в CallClientButton: без открытой
              карточки продавца звонить через станцию не от чего — кнопка
              неактивна (звонка с личного телефона нет с 29.09.2026). */}
          {phone && (
            <CallClientButton
              clientId={canOpen ? seller!.id : null}
              phone={phone}
              callPhone={canOpen ? phone : undefined}
              variant="full"
              label="Позвонить"
              title="Позвонить собственнику через CRM, разговор запишется в карточку продавца"
              className="pill sm"
              stopPropagation={false}
            />
          )}
          {canOpen && (
            <Link className="pill sm ghost" to={`/clients/${seller!.shortId}`}>
              Карточка
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
