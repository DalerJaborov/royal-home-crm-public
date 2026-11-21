import { RoyalInboxSwitch } from "../chats/RoyalInboxSwitch";
import { CallIcon } from "./CallIcon";

/**
 * Шапка «Звонков» и «Телефонии» в новом виде: заголовок и переключатель
 * Сообщения / Комментарии / Звонки / Телефония — тот же компонент, что у «Чатов»
 * (`RoyalInboxSwitch`, состав и права — общий `inboxTabs()`), справа одна синяя
 * кнопка «Набрать номер» (открывает прежний наборщик DialPadModal). Кнопки нет,
 * если вызывающая сторона не передала `onDial` (агенту на ПК её не было и раньше).
 */
export function RoyalCallsTop({ title, sub, onDial }: { title: string; sub?: string; onDial?: () => void }) {
  return (
    <div className="ry-calls-top">
      <RoyalInboxSwitch title={title} />
      {onDial && (
        <button type="button" className="ry-btn ry-calls-dial" data-variant="primary" onClick={onDial}>
          <CallIcon name="keypad" size={22} />
          <span className="ry-calls-dial-l">Набрать номер</span>
        </button>
      )}
      {sub && <p className="ry-calls-sub">{sub}</p>}
    </div>
  );
}
