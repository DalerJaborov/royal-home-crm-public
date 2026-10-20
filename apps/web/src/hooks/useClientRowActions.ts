import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCan } from "../lib/permissions";
import { useAuthStore } from "../store/auth";
import { isRequiresRelease, useAcceptLead, useDeclineLead, useRestoreClient, useRequestRestoreClient } from "./useClients";
import type { Client } from "../types";

/** Shared row workflow; each surface retains its own markup and list query policy. */
export function useClientRowActions(client: Client) {
  const me = useAuthStore((s) => s.agent);
  const canRestore = useCan()("clients.delete");
  const navigate = useNavigate();
  const restoreClient = useRestoreClient();
  const requestRestore = useRequestRestoreClient();
  const acceptLead = useAcceptLead(client.id);
  const declineLead = useDeclineLead(client.id);
  const [restoreRequested, setRestoreRequested] = useState(false);
  const [confirmDecline, setConfirmDecline] = useState(false);
  const isTrashed = !!client.deletedAt;
  const isOther = client.kind === "OTHER";
  const pending = !!client.pendingAcceptance && !isOther;
  const canAcceptRow = pending && !client.escalatedAt && me?.role === "AGENT" && client.assignedAgentId === me.id;
  const canCall = !isTrashed && !pending && !canAcceptRow && !!client.phone;

  function acceptClient() {
    acceptLead.mutate(undefined, {
      onError: (err) => {
        if (isRequiresRelease(err)) navigate(`/clients/${client.shortId}`);
      },
    });
  }
  function restore() {
    restoreClient.mutate(client.id);
  }
  function requestRestoration() {
    requestRestore.mutate(client.id, { onSuccess: () => setRestoreRequested(true) });
  }
  function confirmRejection() {
    setConfirmDecline(false);
    declineLead.mutate();
  }

  return { isTrashed, isOther, pending, canRestore, canAcceptRow, canCall, restoreClient, requestRestore, acceptLead, declineLead, restoreRequested, confirmDecline, setConfirmDecline, acceptClient, restore, requestRestoration, confirmRejection };
}
