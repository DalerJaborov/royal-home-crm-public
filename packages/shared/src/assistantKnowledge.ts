import { z } from "zod";
export const assistantKnowledgeInputSchema = z.object({
  title: z.string().trim().min(3).max(100),
  content: z.string().trim().min(5).max(800),
  source: z.string().trim().min(3).max(200),
  validUntil: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();
export const assistantKnowledgeArchiveSchema = z.object({ title: z.string().trim().min(3).max(100) }).strict();
export const assistantKnowledgeSearchSchema = z.object({ query: z.string().trim().max(200).default("") }).strict();
export type AssistantKnowledgeInput = z.infer<typeof assistantKnowledgeInputSchema>;
