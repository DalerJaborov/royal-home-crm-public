import { useQuery } from "@tanstack/react-query";
import type { ClientKind, ClientStatus, Currency, DealStage, InteractionOutcome, InteractionType, PropertyStatus, Role } from "@royal-home/shared";
import { api } from "../lib/api";

/** Ответ GET /agents/:id/overview — карточка сотрудника для руководства (см. team.ts). */
export interface AgentOverview {
  agent: {
    id: string;
    fullName: string;
    phone: string;
    email: string | null;
    role: Role;
    isActive: boolean;
    avatarUrl: string | null;
    lastSeenAt: string | null;
    createdAt: string;
    kpi: number | null;
    /** Внутренний номер на АТС — по нему коллеге звонят из карточки через станцию. */
    sipExtension?: string | null;
  };
  properties: {
    total: number;
    available: number;
    created: number;
    last: {
      id: string;
      shortId: number;
      title: string;
      price: string;
      currency: Currency;
      status: PropertyStatus;
      createdAt: string;
    }[];
  };
  clients: {
    total: number;
    last: {
      id: string;
      shortId: number;
      fullName: string;
      phone: string;
      status: ClientStatus;
      createdAt: string;
      kind: ClientKind;
      firstContactAt: string | null;
    }[];
  };
  deals: {
    total: number;
    completed: number;
    cancelled: number;
    /** null — у смотрящего нет finance.view (ночная проверка 24.09.2026, №159/М4). */
    commissionTotal: number | null;
    last: {
      id: string;
      stage: DealStage;
      commissionAmount: string | null;
      /** Валюта комиссии = валюта объекта на момент сделки. */
      currency: Currency;
      startedAt: string;
      closedAt: string | null;
      /** Аннулирована после закрытия (C10, 02.10.2026). */
      annulledAt?: string | null;
      client: { fullName: string };
      property: { shortId: number; title: string };
    }[];
  };
  kpiHistory: { date: string; score: number }[];
  /** Красные флаги антифрода из звонков-опросов после показа (см. Oversight.tsx) —
   *  собранные по этому сотруднику, а не только видны пуш-уведомлением в момент эскалации. */
  violations: {
    flaggedShowingCalls: number;
    lastFlags: {
      id: string;
      createdAt: string;
      escalatedAt: string | null;
      flags: { category: string; detail: string }[];
      client: { id: string; shortId: number; fullName: string } | null;
    }[];
  };
  /** «Его звонки последние» и «если он не позвонил» (владелец 16.09.2026). */
  activity: {
    recentInteractions: {
      id: string;
      type: InteractionType;
      notes: string;
      outcome: InteractionOutcome | null;
      createdAt: string;
      client: { id: string; shortId: number; fullName: string };
      property: { shortId: number; title: string } | null;
    }[];
    /** Клиент писал — агент с тех пор не отвечал (та же логика, что и в
     *  lib/agentUnansweredAlarm.ts, только без порога и пуша: снимок для карточки). */
    waitingForReply: { id: string; shortId: number; fullName: string; lastClientMessageAt: string }[];
  };
  /** Все красные флаги «Контроля руководителя» (Oversight.tsx), сужены на этого
   *  агента, в одном месте (владелец 16.09.2026: «по-крупному, чтобы не искать
   *  что где когда»). Честное число: пусто — сигнал не сработал, не заглушка. */
  problems: {
    overdueTasks: {
      total: number;
      items: {
        id: string;
        notes: string;
        nextAction: string | null;
        nextActionDate: string | null;
        client: { id: string; shortId: number; fullName: string };
      }[];
    };
    stalledClients: {
      total: number;
      items: { id: string; shortId: number; fullName: string; status: ClientStatus; aiScore: number | null; lastContactAt: string | null }[];
    };
    silentAfterShowing: {
      total: number;
      days: number;
      items: { id: string; shortId: number; fullName: string; lastContactAt: string | null }[];
    };
    refusedHighScore: {
      total: number;
      windowDays: number;
      items: {
        id: string;
        createdAt: string;
        client: { id: string; shortId: number; fullName: string; refusalReason: string | null } | null;
      }[];
    };
    endlessNegotiations: {
      total: number;
      items: { id: string; subjectName: string; rounds: number; client: { id: string; shortId: number; fullName: string } }[];
    };
    sellerPropertyMissing: {
      total: number;
      items: { id: string; shortId: number; fullName: string; daysSince: number; level: "WARN" | "CRITICAL" }[];
    };
    lossSeries: { count: number; windowDays: number; threshold: number } | null;
  };
}

export function useAgentOverview(agentId: string | undefined) {
  return useQuery({
    queryKey: ["agent-overview", agentId],
    queryFn: () => api<AgentOverview>(`/agents/${agentId}/overview`),
    enabled: !!agentId,
  });
}

/**
 * Ответ GET /agents/:id/live — «что сотрудник делает прямо сейчас» (см.
 * docs/archive/employee-card-brief-20-09.md, 2.4). Отдельная ручка и отдельный хук от
 * `useAgentOverview`: верх карточки (сейчас, лиды, переписка, звонки) обязан
 * рисоваться быстро и не ждать тяжёлый разбор проблем — см. там же, 2.1.
 */
export interface AgentLive {
  now: {
    online: boolean;
    lastSeenAt: string | null;
    device: string | null;
    /** Живой звонок — ИЗ ПАМЯТИ процесса api. `null` значит «не на звонке
     *  прямо сейчас через CRM», а не «звонков вообще не было». */
    call: {
      direction: "out" | "in";
      clientId: string | null;
      clientShortId: number | null;
      clientName: string | null;
      state: string;
      startedAt: string | null;
      answeredAt: string | null;
    } | null;
    nextTask: {
      id: string;
      type: string;
      title: string | null;
      at: string;
      client: { id: string; shortId: number; fullName: string };
    } | null;
  };
  leads: {
    inWork: number;
    /** 0 = раздача без предела, полосу нагрузки не рисуем. */
    limit: number;
    unaccepted: number;
    byStatus: Record<string, number>;
  };
  chats: {
    conversationId: string;
    channel: string;
    client: { id: string; shortId: number; fullName: string };
    lastMessageAt: string;
    lastFrom: "client" | "agent" | "bot";
    lastText: string;
  }[];
  calls: {
    weekTotal: number;
    weekTalked: number;
    weekMissedIncoming: number;
    /** Право слушать запись у СМОТРЯЩЕГО — отдельно от чтения (calls.hearRecording). */
    canHear: boolean;
    last: {
      id: string;
      createdAt: string;
      /** Факт записи, а не её ключ в хранилище — ссылку подписывают отдельно. */
      hasRecording: boolean;
      durationSec: number | null;
      callAttempt: string;
      outcome: string | null;
      client: { id: string; shortId: number; fullName: string };
      score: number | null;
      agreedNextStep: boolean | null;
    }[];
  };
}

export function useAgentLive(agentId: string | undefined) {
  return useQuery({
    queryKey: ["agent-live", agentId],
    queryFn: () => api<AgentLive>(`/agents/${agentId}/live`),
    enabled: !!agentId,
    // Сотрудник может начать звонок или получить сообщение, пока карточка
    // открыта — блок «Сейчас» обновляется сам, без ручного обновления страницы.
    refetchInterval: 30_000,
  });
}
