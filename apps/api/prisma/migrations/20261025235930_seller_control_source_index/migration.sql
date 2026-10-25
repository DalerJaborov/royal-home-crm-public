-- PostgreSQL truncates long identifiers; keep the source queue index name explicit.
ALTER INDEX "SellerIntakeAppointmentEvidence_executionMode_controlEpisodeId_"
  RENAME TO "SellerIntakeEvidence_control_source_idx";
