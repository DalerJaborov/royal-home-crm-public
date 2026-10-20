import { useEffect, useState } from "react";
import { didRefreshFailOffline, refreshAccessToken } from "../lib/api";
import { Rh2Inline } from "./rh2/Rh2Scope";
import { getRejectedOfflineRequests, retryRejectedOfflineRequest, discardRejectedOfflineRequest, flushOfflineQueue, OFFLINE_QUEUE_EVENT, type QueuedRequest } from "../lib/offlineQueue";
import { useAuthStore } from "../store/auth";
import { toast } from "../store/toast";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * Полоса «нет соединения».
 *
 * Одного navigator.onLine мало: он отвечает «онлайн», если есть хоть какой-то
 * сетевой интерфейс, и уверенно врёт при мёртвом Wi-Fi, отвалившемся мобильном
 * интернете и в гостиничном captive-портале — то есть ровно тогда, когда агенту
 * и нужно объяснение, почему ничего не грузится. Поэтому вторым признаком берём
 * факт: обновление токена сорвалось сетевой ошибкой (lib/api).
 */
export function OfflineBanner() {
  const actorId = useAuthStore((state) => state.agent?.id);
  const [rejected, setRejected] = useState(getRejectedOfflineRequests);
  useEffect(() => {
    const update = () => setRejected(getRejectedOfflineRequests());
    update(); window.addEventListener(OFFLINE_QUEUE_EVENT, update);
    return () => window.removeEventListener(OFFLINE_QUEUE_EVENT, update);
  }, [actorId]);
  const owned = rejected.filter((item) => item.agentId === actorId);
  const [online, setOnline] = useState(navigator.onLine);
  // Сетевой отказ обнаруживается вне React — опрашиваем, иначе полоса появится
  // только на следующей перерисовке по другой причине и человек её не увидит.
  const [refreshFailed, setRefreshFailed] = useState(didRefreshFailOffline);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    // Пока метка сетевого отказа стоит — сами пробуем восстановиться. Ждать
    // события «online» нельзя: браузер его не пришлёт, если и не считал себя
    // офлайн (мёртвый Wi-Fi, captive-портал). Удачная попытка вернёт токен —
    // приложение снова живое, и полоса гаснет сама, без перезагрузки страницы.
    const poll = setInterval(() => {
      if (!didRefreshFailOffline()) {
        setRefreshFailed(false);
        return;
      }
      void refreshAccessToken().then(() => setRefreshFailed(didRefreshFailOffline()));
    }, 3000);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      clearInterval(poll);
    };
  }, []);

  if (online && !refreshFailed && !owned.length) return null;

  // Тихая строка `.quiet`, а не жёлтая плашка во всю ширину: договор дизайна
  // §6.1 — срочное сообщается строкой в своём месте, а не кричащей карточкой.
  // Полоса живёт в рамке приложения, вне области темы экрана, поэтому открывает
  // область сама (см. Rh2Scope.tsx).
  return (
    <Rh2Inline className="shrink-0">
      {(!online || refreshFailed) && <p className="quiet warn" style={{ justifyContent: "center", padding: "8px 16px" }}>
        <span className="dot warn" />
        <span className="txt" style={{ flex: "0 1 auto" }}>
          Нет соединения, данные могут быть неактуальны
        </span>
      </p>}
      {!!owned.length && <details className="clean-offline-recovery" style={{ padding: "12px 16px" }}>
        <summary style={{ minHeight: 44, cursor: "pointer", fontSize: 15 }}><strong>Не отправлено: {owned.length}</strong> · данные сохранены на этом устройстве</summary>
        <p>Сервер отклонил записи. Проверьте причину: можно исправить данные, повторить отправку или скачать копию.</p>
        {owned.map((item) => <OfflineRejectedRow key={item.id} item={item} />)}
      </details>}
    </Rh2Inline>
  );
}

const FIELD_LABELS: Record<string, string> = { fullName: "Имя", phone: "Телефон", title: "Название", address: "Адрес", notes: "Заметка", note: "Описание", nextAction: "Следующий шаг" };
function OfflineRejectedRow({ item }: { item: QueuedRequest }) {
  const body = item.body && typeof item.body === "object" && !Array.isArray(item.body) ? item.body as Record<string, unknown> : {};
  const fields = Object.entries(FIELD_LABELS).filter(([key]) => typeof body[key] === "string");
  const [editing, setEditing] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const name = typeof body.fullName === "string" ? body.fullName : typeof body.title === "string" ? body.title : item.path.includes("interactions") ? "Взаимодействие" : item.path.includes("clients") ? "Клиент" : item.path.includes("properties") ? "Объект" : "Запись CRM";
  function retry() {
    if (!retryRejectedOfflineRequest(item.id, editing ? { ...body, ...draft } : undefined)) { toast.error("Запись уже недоступна в этой сессии."); return; }
    void flushOfflineQueue().catch(() => toast.error("Отправка пока не завершена. Данные остаются на устройстве."));
  }
  function download() {
    // Explicit user download; never send the saved payload to an external service.
    if (!getRejectedOfflineRequests().some((entry) => entry.id === item.id)) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ name, data: item.body, reason: item.rejection?.message }, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "royal-home-unsent-record.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="clean-offline-recovery-row" style={{ marginTop: 12, padding: 16, borderRadius: 16, background: "var(--c-row-alt)" }}>
    <strong>{name}</strong><p role="status">{item.rejection?.message}</p>
    {editing && fields.map(([key, label]) => <label key={key} style={{ display: "grid", gap: 6, marginBottom: 10 }}>{label}<input className="inp" style={{ minHeight: 44, fontSize: 16 }} value={draft[key] ?? String(body[key])} onChange={(event) => setDraft((previous) => ({ ...previous, [key]: event.target.value }))} /></label>)}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {!!fields.length && <button type="button" className="pill ghost" onClick={() => setEditing(!editing)}>{editing ? "Свернуть правку" : "Исправить"}</button>}
      <button type="button" className="pill" onClick={retry}>{editing ? "Отправить исправленное" : "Повторить отправку"}</button>
      <button type="button" className="pill ghost" onClick={download}>Скачать копию</button>
      <button type="button" className="pill ghost" onClick={() => setConfirmDiscard(true)}>Удалить копию</button>
    </div>
    {confirmDiscard && <ConfirmDialog title="Удалить неотправленную запись?" description="Удалится только копия на этом устройстве. Сервер эту запись не получил." confirmLabel="Удалить копию" danger onConfirm={() => discardRejectedOfflineRequest(item.id)} onCancel={() => setConfirmDiscard(false)} />}
  </section>;
}
