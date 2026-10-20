import { Fragment } from "react";
import { MESSAGE_PHONE_MASK } from "@royal-home/shared";
import { CallClientButton } from "./CallClientButton";
import { humanizeAttachmentTags } from "../lib/botMessages";

/**
 * ТЕКСТ РЕПЛИКИ В ЛЕНТЕ — с кнопкой звонка на месте скрытого номера.
 *
 * ЗАЧЕМ (владелец 07.09.2026, дословно): «маскировку не убирай нигде, просто когда
 * в чате пишут свой номер телефона, пусть вместо некрасивого *** будет кнопка
 * позвонить, и она работает так же, как кнопка позвонить в карточке клиента».
 *
 * Клиент диктует номер в переписку постоянно, и агенту он приходит замаскированным
 * (право `clients.viewPhone`, см. lib/messageAttachments.ts на сервере). До этой
 * правки на его месте стояли четыре звёздочки — неотличимо от битого текста: агент
 * видел «Клиент ****» и не понимал, потерялось сообщение или так и надо.
 *
 * ЗАПРЕТ ПРИ ЭТОМ НЕ СНИМАЕТСЯ. Цифры не показываются и здесь: кнопка набирает
 * клиента через CRM (POST /clients/:id/call — запись разговора, хронология, Royal
 * Score), то есть агент звонит, не видя номера. Это ровно то же, что делает кнопка
 * «Позвонить» на карточке, и то же правило владельца от 17.08.2026, по которому
 * телефон закрыт от агента, остаётся в силе.
 *
 * Набирается ОСНОВНОЙ номер карточки, а не тот, что в самой реплике: разобрать, какой
 * именно номер продиктован, нельзя — он замаскирован ещё на сервере. Запасные номера
 * живут на карточке отдельными кнопками (ClientDetail), там они и остаются.
 *
 * Здесь же техническое «[вложение: template]» превращается в человеческое
 * (humanizeAttachmentTags) — по той же просьбе владельца, «чтобы агенты не думали
 * три часа, что это такое».
 */
/**
 * ОБЛИК. `rh2` включает кнопку прототипа (`.pill sm`) на месте скрытого номера
 * вместо своей плашки на утилитах Tailwind. Необязателен: тот же текст реплики
 * рисуют инбокс (Messages.tsx) и мобильный диалог (MobileChatView.tsx), оба
 * пока вне `.rh2` — там кнопка обязана остаться прежней.
 */
export function MessageText({
  content,
  clientId,
  rh2 = false,
  readOnly = false,
}: {
  content: string;
  clientId?: string | null;
  rh2?: boolean;
  readOnly?: boolean;
}) {
  const text = humanizeAttachmentTags(content);
  if (!text.includes(MESSAGE_PHONE_MASK)) return <>{text}</>;

  // split сохраняет пустые куски по краям — они рисуются как пустые строки и не мешают.
  const parts = text.split(MESSAGE_PHONE_MASK);
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part}
          {i < parts.length - 1 && (readOnly ? <span>Номер скрыт</span> : (
            <CallClientButton
              clientId={clientId}
              /* Маска-«точка» — тот же признак «номер закрыт», что у CallClientButton
                 внутри (isMasked): кнопка сама покажет себя правильно и не попытается
                 подставить цифры в tel:. */
              phone="•••"
              variant="full"
              label="Позвонить"
              title="Клиент продиктовал номер. Позвонить ему через CRM, номер остаётся скрытым, разговор запишется и попадёт в хронологию"
              className={
                rh2
                  ? // `soft`, а не основная капсула: кнопка стоит внутри фразы
                    // клиента и не должна читаться как главное действие пузыря.
                    "pill soft sm"
                  : "mx-0.5 inline-flex items-center gap-1 rounded-lg border border-blue/20 bg-blue/6 px-2 py-0.5 align-middle text-[13px] font-semibold text-blue hover:bg-blue/12 disabled:opacity-60"
              }
            />
          ))}
        </Fragment>
      ))}
    </>
  );
}
