import { smsTestResultLabel } from "../../lib/smsTestResult";
import { useState } from "react";
import { useServerSyncedFields } from "../../hooks/useServerSyncedForm";
import { MessageSquareText } from "lucide-react";
import { api } from "../../lib/api";
import { SwitchRow } from "../../components/Switch";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { SecretKeyEditor } from "../../components/SecretKeyEditor";
import { useSmsSettings, useUpdateSmsSettings } from "../../hooks/useSms";

/**
 * СМС (23.09.2026, провайдер Payom с 24.09): имя отправителя, токен,
 * проверочное СМС, баланс.
 * Сервер — routes/sms.ts. Отсюда же работают код при входе (раздел ниже, во
 * вкладке «Система») и кнопка «Разослать по СМС» в подборке объекта.
 */
/** Исходящий адрес боевого сервера — его Payom пускает (белый список в кабинете). */
const SERVER_IP = "85.198.70.182";

export function SmsSection() {
  const { data } = useSmsSettings();
  const save = useUpdateSmsSettings();
  const [sender, setSender] = useState("");
  const [testPhone, setTestPhone] = useState("");
  const [note, setNote] = useState<{ tone: "ok" | "crit"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useServerSyncedFields(
    data && {
      sender: data.sender ?? "",
    },
    {
      sender: [sender, setSender],
    }
  );

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setNote(null);
    try {
      setNote({ tone: "ok", text: await action() });
    } catch (e) {
      setNote({ tone: "crit", text: e instanceof Error ? e.message : "Не получилось" });
    } finally {
      setBusy(false);
    }
  }

  const dirty = !!data && (sender !== (data.sender ?? "") || data.provider !== "payom");

  return (
    <SettingsSection
      key={data ? String(data.configured) : "loading"}
      icon={MessageSquareText}
      title="СМС через Payom"
      badge={data ? (data.configured ? "подключено" : "не подключено") : undefined}
      defaultOpen={!!data && !data.configured}
    >
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Нужны для кода при входе и для рассылки объектов клиентам ссылкой. Только на таджикские номера.
          Токен — в кабинете platform.payom.tj, «Настройки API». Там же в белый список нужно внести IP
          сервера CRM: {SERVER_IP}. Имя отправителя Payom одобряет заявкой, до одного рабочего дня.
        </span>
      </div>

      <div className="mod">
        <div className="t">
          <b>Имя отправителя</b>
          <span>Латиница, цифры и точка, без пробелов, до 11 знаков — ровно то, что одобрил Payom (например RoyalHome).</span>
        </div>
        <div className="acts" style={{ flexWrap: "wrap", gap: 8 }}>
          <input className="inp" style={{ maxWidth: 160 }} aria-label="Имя отправителя" placeholder="RoyalHome" value={sender} onChange={(e) => setSender(e.target.value)} />
          <button
            className="pill ghost sm"
            type="button"
            disabled={busy || !dirty}
            onClick={() =>
              run(async () => {
                await save.mutateAsync({ provider: "payom", sender });
                return "Сохранено";
              })
            }
          >
            Сохранить
          </button>
        </div>
      </div>

      <SecretKeyEditor
        title="Токен Payom"
        description="API-токен из кабинета platform.payom.tj («Настройки API»). Хранится зашифрованным."
        placeholder="токен"
        configured={data?.tokenConfigured}
        masked={data?.tokenMasked}
        source={data?.tokenConfigured ? "settings" : null}
        onSave={(apiToken) => save.mutateAsync({ provider: "payom", apiToken })}
        onClear={() => save.mutateAsync({ apiToken: "" })}
      />

      {data?.configured && (
        <div className="mod">
          <div className="t">
            <b>Проверка</b>
            <span>Проверочное СМС на ваш номер и остаток на счёте. Одно СМС стоит как обычное.</span>
          </div>
          <div className="acts" style={{ flexWrap: "wrap", gap: 8 }}>
            <input className="inp" style={{ maxWidth: 190 }} aria-label="Номер для проверки" placeholder="+992900000001" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} />
            <button
              className="pill ghost sm"
              type="button"
              disabled={busy || testPhone.replace(/\D/g, "").length < 9}
              onClick={() =>
                run(async () => {
                  const result = await api<{ status?: string }>("/sms/test", { method: "POST", body: { phone: testPhone } });
                  return smsTestResultLabel(result.status);
                })
              }
            >
              Отправить проверку
            </button>
            <button
              className="pill ghost sm"
              type="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = await api<{ balance: number; currency: string }>("/sms/balance");
                  return `На счёте Payom: ${r.balance.toLocaleString("ru-RU")} ${r.currency === "TJS" ? "сомони" : r.currency}`;
                })
              }
            >
              Баланс
            </button>
          </div>
        </div>
      )}

      {note && (
        <div className={`quiet ${note.tone}`}>
          <span className={`dot ${note.tone}`} />
          <span className="txt">{note.text}</span>
        </div>
      )}
    </SettingsSection>
  );
}
