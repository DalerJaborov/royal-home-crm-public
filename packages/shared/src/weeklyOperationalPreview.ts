import { z } from 'zod';
export const weeklyOperationalPreviewQuerySchema = z.object({ kind: z.enum(['DEFERRED_AFTER_SHOWING', 'PROPERTY_NO_RECORDED_ACTIVITY', 'IDLE_RESERVATION_DEAL']).default('DEFERRED_AFTER_SHOWING'), page: z.coerce.number().int().min(1).max(10000).default(1) });
export type WeeklyOperationalPreviewKind = z.infer<typeof weeklyOperationalPreviewQuerySchema>['kind'];
export interface WeeklyOperationalPreviewItem { id: string; clientId: string | null; propertyId: string | null; agentId: string | null; agentName: string | null; observedAt: string; sourceId: string; sourceType: string }
export interface WeeklyOperationalPreviewPage { mode: 'PREVIEW'; kind: WeeklyOperationalPreviewKind; generatedAt: string; periodStart: string; page: number; pageSize: number; total: number; coverage: 'RECORDED_CRM_FACTS_ONLY'; items: WeeklyOperationalPreviewItem[] }
export interface AgencyLabelCoincidence { agentId: string; originalLabels: string[]; distinctClients: number; sourceIds: string[]; clientIds: string[]; latestAt: string; companyIdentity: 'UNKNOWN' }
export interface AgencyLabelPreview { mode: 'PREVIEW'; from: string; to: string; truncated: boolean; sourceRows: number; groups: AgencyLabelCoincidence[] }
