import { RefreshCw } from "lucide-react";
import type { EmptyListGuard } from "../hooks/useEmptyListGuard";

/**
 * Плашка самолечения списка (hooks/useEmptyListGuard.ts). Одна на ПК и телефон:
 * идиомы `.empty` / `.pill` (ПК) и `.state err` / `.lnk` (телефон, components/mobile).
 */
export function EmptyListGuardBanner({ guard, variant }: { guard: EmptyListGuard; variant: "desktop" | "mobile" }) {
  const text = "Список не загрузился. Нажмите «Обновить», мы очистим старые данные и загрузим заново.";
  if (variant === "mobile") {
    return (
      <div className="state err" role="alert" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
        {text}
        <button type="button" className="lnk" onClick={() => void guard.repair()} disabled={guard.healing}>
          {guard.healing ? "Обновляем…" : "Обновить"}
        </button>
      </div>
    );
  }
  return (
    <div className="empty" role="alert">
      <span className="ic">
        <RefreshCw className="i" aria-hidden />
      </span>
      <p>{text}</p>
      <button className="pill ghost" type="button" onClick={() => void guard.repair()} disabled={guard.healing}>
        {guard.healing ? "Обновляем…" : "Обновить"}
      </button>
    </div>
  );
}
