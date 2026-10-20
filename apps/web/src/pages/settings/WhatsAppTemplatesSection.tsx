import { useState } from "react";
import { Send } from "lucide-react";
import type { WaTemplateReviewState } from "@royal-home/shared";
import { SettingsSection } from "../../components/settings/SettingsSection";
import {
  useRefreshWaTemplates,
  useSetWaBusinessAccount,
  useSubmitWaTemplates,
  useWaTemplates,
} from "../../hooks/useWhatsAppFirstContact";

/**
 * ПЕРВОЕ СООБЩЕНИЕ В WHATSAPP (24.09.2026): тексты, которые Meta должна одобрить,
 * прежде чем агент сможет написать клиенту первым (кнопка в карточке клиента).
 * Одна кнопка отправляет их на проверку; дальше Meta отвечает сама, обычно за
 * минуты, иногда за сутки. Сервер — routes/whatsappTemplates.ts.
 */

const STATE_LABEL: Record<WaTemplateReviewState, { text: string; tone: "ok" | "warn" | "crit" | "mute" }> = {
  missing: { text: "не отправлен", tone: "mute" },
  pending: { text: "на проверке у Meta", tone: "warn" },
  approved: { text: "одобрен", tone: "ok" },
  rejected: { text: "отклонён", tone: "crit" },
  paused: { text: "приостановлен Meta", tone: "crit" },
  disabled: { text: "отключён Meta", tone: "crit" },
};

export function WhatsAppTemplatesSection() {
  const { data } = useWaTemplates();
  const submit = useSubmitWaTemplates();
  const refresh = useRefreshWaTemplates();
  const setAccount = useSetWaBusinessAccount();
  const [account, setAccountValue] = useState("");

  if (!data || !data.connected) return null;

  const approved = data.templates.filter((t) => t.state === "approved").length;
  const missing = data.templates.some((t) => t.state === "missing");
  const error = (submit.error ?? setAccount.error ?? refresh.error)?.message ?? data.error;

  return (
    <SettingsSection
      icon={Send}
      title="Первое сообщение в WhatsApp"
      badge={approved === data.templates.length ? "одобрено" : approved > 0 ? "одобрено частично" : "не одобрено"}
      defaultOpen={approved < data.templates.length}
    >
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Чтобы агент мог написать клиенту в WhatsApp первым (кнопка «Написать в WhatsApp» в карточке клиента),
          Meta заранее проверяет текст. Отправьте тексты на проверку одной кнопкой ниже. Каждое такое сообщение Meta
          берёт деньгами, поэтому в кабинете Meta должна быть привязана карта.
        </span>
      </div>

      {data.templates.map((t) => {
        const label = STATE_LABEL[t.state];
        return (
          <div className="mod" key={t.key}>
            <div className="t">
              <b>{t.key === "property" ? "Про конкретный объект" : "Общее"}</b>
              <span style={{ whiteSpace: "pre-wrap" }}>{t.body.replace("{{1}}", "[имя сотрудника]").replace("{{2}}", "[номер]")}</span>
              {t.reason && <span className="state err">Причина отказа от Meta: {t.reason}</span>}
            </div>
            <div className="acts">
              <span className={`chip ${label.tone}`}>{label.text}</span>
            </div>
          </div>
        );
      })}

      {!data.accountKnown && (
        <div className="mod">
          <div className="t">
            <b>Кабинет WhatsApp</b>
            <span>
              CRM узнает его сама после первого сообщения клиента в WhatsApp. Если нужно сейчас: Meta Business → Настройки →
              Аккаунты WhatsApp → номер кабинета (только цифры).
            </span>
          </div>
          <div className="acts" style={{ flexWrap: "wrap", gap: 8 }}>
            <input
              className="inp"
              style={{ maxWidth: 220 }}
              aria-label="Номер кабинета WhatsApp"
              inputMode="numeric"
              placeholder="например 1234567890"
              value={account}
              onChange={(e) => setAccountValue(e.target.value.replace(/\D/g, ""))}
            />
            <button
              className="pill ghost sm"
              type="button"
              disabled={!account || setAccount.isPending}
              onClick={() => setAccount.mutate(account)}
            >
              Сохранить
            </button>
          </div>
        </div>
      )}

      <div className="acts" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        {missing && (
          <button
            className="pill sm"
            type="button"
            disabled={!data.accountKnown || submit.isPending}
            onClick={() => submit.mutate()}
          >
            <Send className="i" /> {submit.isPending ? "Отправляю…" : "Отправить тексты на проверку в Meta"}
          </button>
        )}
        <button className="pill ghost sm" type="button" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          {refresh.isPending ? "Спрашиваю Meta…" : "Проверить ответ Meta"}
        </button>
      </div>

      {error && (
        <div className="quiet crit">
          <span className="dot crit" />
          <span className="txt">{error}</span>
        </div>
      )}
    </SettingsSection>
  );
}
