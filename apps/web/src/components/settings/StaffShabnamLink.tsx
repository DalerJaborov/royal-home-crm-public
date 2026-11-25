import { useState } from "react";
import type { StaffTelegramLink } from "../../hooks/useAgents";

/**
 * ССЫЛКА «ПОДКЛЮЧИТЬ К ШАБНАМ» ДЛЯ СОТРУДНИКА (25.11.2026, Настройки → Сотрудники).
 *
 * Руководитель получает одноразовую ссылку и пересылает её сотруднику; тот открывает её
 * в СВОЁМ Telegram — бот запоминает чат, и Шабнам начинает его узнавать. Кнопки
 * «Открыть в Telegram» здесь нет намеренно: открыв ссылку сам, руководитель привязал бы
 * к чужой учётке свой Telegram (а это канал кода входа).
 *
 * Ссылка живёт только в памяти этой панели: закрыли — пропала, в хранилище браузера
 * и в журналы она не пишется.
 */
export function shabnamLinkText(link: StaffTelegramLink): string {
  return link.deepLink ?? `/start ${link.code}`;
}

export function StaffShabnamLinkPanel({
  name,
  link,
  onClose,
}: {
  name: string;
  link: StaffTelegramLink;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const text = shabnamLinkText(link);

  async function copy() {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Буфер недоступен (старый браузер, нет разрешения): ссылку видно в поле, её можно выделить.
      setCopyFailed(true);
    }
  }

  return (
    <div className="quiet wide" role="status" aria-label={`Ссылка подключения к Шабнам: ${name}`} style={{ flexWrap: "wrap", gap: 8 }}>
      <span className="dot ok" />
      <span className="txt" style={{ flex: "1 1 260px", whiteSpace: "normal" }}>
        {link.deepLink
          ? `Ссылка для ${name}. Перешлите её сотруднику: пусть откроет в своём Telegram. Сработает один раз, действует ${link.expiresInHours} ч.`
          : `Бот ещё не назвал своё имя. Пусть ${name} напишет боту в Telegram сообщение ниже. Сработает один раз, действует ${link.expiresInHours} ч.`}{" "}
        Не успел открыть, выдайте новую: прежняя тогда перестанет работать. Сами не открывайте: к учётке привяжется ваш Telegram.
      </span>
      <input
        className="inp"
        readOnly
        value={text}
        aria-label="Ссылка подключения"
        onFocus={(e) => e.currentTarget.select()}
        style={{ flex: "1 1 220px", minWidth: 0 }}
      />
      <button className="pill sm" type="button" onClick={copy}>
        {copied ? "Скопировано" : "Скопировать"}
      </button>
      <button className="pill ghost sm" type="button" onClick={onClose}>
        Готово
      </button>
      {copyFailed && <span className="msg">Не удалось скопировать. Выделите ссылку в поле и скопируйте вручную.</span>}
    </div>
  );
}
