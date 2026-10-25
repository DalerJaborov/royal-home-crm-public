import { z } from "zod";

export const postShowingCohortConfigSchema = z.object({
  windowDays: z.number().int().min(1).max(365).default(30),
  minAgentShowings: z.number().int().min(1).max(10000).default(8),
  minPeerShowings: z.number().int().min(1).max(10000).default(20),
  minSilentCases: z.number().int().min(1).max(10000).default(4),
  minRatio: z.number().min(1).max(100).default(2.5),
  minGapPercentagePoints: z.number().min(0).max(100).default(20),
}).strict();
export type PostShowingCohortConfig = z.infer<typeof postShowingCohortConfigSchema>;
export interface PostShowingCohortView {
  version: 2; from: string; to: string; asOf: string;
  source: string; evaluation: string; config: PostShowingCohortConfig;
  coverage: Record<string, number>;
  limitations: string[];
  agents: Array<{ agentId: string; agentName: string; recorded: number; publicResponses: number; robotResponses: number; unresolvedSurvey: number; unknown: number;
    eligible: number | null; silent: number | null; ratePercent: number | null; peerEligible: number | null; peerRatePercent: number | null;
    evaluation?: string; aboveDescriptiveThreshold?: boolean; automaticVerdict?: false }>;
}
