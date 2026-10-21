import { useQuery } from "@tanstack/react-query";
import { clientPropertyActivitySchema } from "@royal-home/shared";
import { api } from "../lib/api";

export function useClientPropertyActivity(clientId: string, section: "sent" | "showings", page: number, enabled: boolean) {
  return useQuery({
    queryKey: ["client", clientId, "property-activity", section, page],
    queryFn: async () => clientPropertyActivitySchema.parse(await api(`/clients/${clientId}/property-activity?section=${section}&page=${page}`)),
    enabled,
  });
}
