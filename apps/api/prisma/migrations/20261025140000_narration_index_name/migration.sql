-- PostgreSQL truncates identifiers to 63 bytes; give the index an explicit stable name.
ALTER INDEX "PublicationMetadataSync_propertyId_revisionHash_channel_operation_key"
RENAME TO "PublicationMetadataSync_revision_channel_operation_key";
