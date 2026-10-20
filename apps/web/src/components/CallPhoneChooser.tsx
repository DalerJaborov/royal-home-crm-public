import { useState } from "react";
import { Phone } from "lucide-react";
import { CallClientButton } from "./CallClientButton";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { isCallableClientPhone, waLink } from "../lib/phone";

/** Один номер клиента для шторки выбора: подпись + номер, как его показывать
 *  (сервер уже замаскировал, если смотрящему номер закрыт — здесь без изменений). */
export interface CallPhoneOption {
  /** Ключ строки, не сам номер: маска у двух записей может совпасть текстом. */
  key: string;
  /** «Основной» / «WhatsApp» / «Дополнительный» (или «Дополнительный 2» при нескольких). */
  label: string;
  phone: string;
}

interface CallPhoneChooserProps {
  clientId?: string | null;
  /** Один и более номеров без дублей по цифрам (см. lib/phone.ts, secondaryPhones). */
  phones: CallPhoneOption[];
  variant?: "icon" | "full";
  label?: string;
  className?: string;
  title?: string;
}

/**
 * ЕДИНАЯ КНОПКА «ПОЗВОНИТЬ» ДЛЯ НЕСКОЛЬКИХ НОМЕРОВ КЛИЕНТА (владелец 11.09.2026,
 * показ 12.09). Было: «Основной телефон / Номер WhatsApp / доп. номер N» шли
 * отдельными строками, у каждой своя кнопка звонка — на телефоне это три-четыре
 * почти одинаковых строки подряд. Стало: один номер — звонок сразу тем же
 * механизмом, что и раньше (CallClientButton → useCallClient → CRM-звонок через
 * Asterisk ARI); несколько — шторка со списком, звонок по нажатию на строку идёт
 * тем же механизмом.
 *
 * ОБЩИЙ КОМПОНЕНТ, а не часть ClientDetail.tsx: та же шторка нужна в чате и
 * списках клиентов (следующий шаг, по решению владельца), поэтому вся логика
 * выбора номера живёт здесь один раз.
 *
 * Номер, который транк не наберёт (иностранный WhatsApp — не таджикский формат,
 * isCallableClientPhone), в шторке получает не кнопку звонка, а «Открыть в
 * WhatsApp» — тот же запасной путь, что раньше стоял в карточке клиента отдельной
 * строкой (см. lib/phone.ts, waLink).
 */
export function CallPhoneChooser({ clientId, phones, variant = "full", label, className, title }: CallPhoneChooserProps) {
  const [open, setOpen] = useState(false);

  if (phones.length === 0) return null;

  // Один номер — звонок идёт сразу, без промежуточного выбора: это тот же самый
  // CallClientButton, что стоял на месте старой строки «Основной телефон».
  if (phones.length === 1) {
    return (
      <CallClientButton
        clientId={clientId}
        phone={phones[0].phone}
        variant={variant}
        label={label ?? "Позвонить"}
        title={title}
        className={className}
      />
    );
  }

  return (
    <>
      <button type="button" className={className} title={title ?? `Выбрать один из ${phones.length} номеров`} onClick={() => setOpen(true)}>
        <Phone className={variant === "icon" ? "h-3.5 w-3.5" : "w-3.5 h-3.5"} />
        {variant === "full" && (label ?? "Позвонить")}
      </button>
      {open && (
        <Rh2Sheet title="Кому звонить" onClose={() => setOpen(false)} closeOnBackdrop>
          <div className="list">
            {phones.map((p) => (
              <div className="phone-row" key={p.key}>
                <span className="chip mute">
                  <Phone className="i" aria-hidden="true" />
                </span>
                <span className="t">
                  <b>{p.label}</b>
                  <span>{p.phone}</span>
                </span>
                {isCallableClientPhone(p.phone) ? (
                  <CallClientButton
                    clientId={clientId}
                    phone={p.phone}
                    callPhone={p.phone}
                    variant="full"
                    label="Позвонить"
                    title="Позвонить через CRM, разговор запишется и попадёт в хронологию"
                    className="pill ghost sm"
                    stopPropagation={false}
                  />
                ) : (
                  <a
                    className="pill ghost sm"
                    href={waLink(p.phone)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Станция не наберёт этот номер, открыть его в WhatsApp"
                  >
                    Открыть в WhatsApp
                  </a>
                )}
              </div>
            ))}
          </div>
        </Rh2Sheet>
      )}
    </>
  );
}
