/** Shared knowledge record shape; retrieval implementations must not import each other for types. */
export interface CompanyKnowledge {
  id: string; key: string; title: string; content: string; source: string; authorId: string;
  revision: number; archived: boolean; validUntil: Date | null; createdAt: Date; updatedAt: Date;
}
