import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { District } from "../types";

export function useDistricts() {
  return useQuery({
    queryKey: ["districts"],
    queryFn: () => api<District[]>("/districts"),
  });
}

export function useCreateDistrict() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api<District>("/districts", { method: "POST", body: { name } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["districts"] }),
  });
}
