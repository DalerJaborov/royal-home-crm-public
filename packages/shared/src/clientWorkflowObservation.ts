export interface ClientWorkflowObservationView {
  id: string; kind: string; clientId: string; propertyId: string | null;
  assignmentAt: string; sourceType: string; occurredAt: string; executionMode: "PREVIEW";
  payload: Record<string, unknown>;
}
export interface ManualContactPreviewPage {
  page: number; total: number; windowDays: number;
  items: Array<{ clientId: string; manualCalls: number; evaluation: string; coverage: string }>;
}
export interface NamedAssignmentPreviewPage {
  evaluation?: string;
  groups: Array<{ subjectAgentId: string; agentName: string; sourceCohort: string; allObservedAssignments: number; namedDeclared: number;
    namedSourceConfirmed: number; peerAssignments: number; evaluation: string }>;
}
