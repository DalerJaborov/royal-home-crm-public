import { z } from "zod";
import { clientUpdateSchema } from "./schemas.js";

const fields = clientUpdateSchema.shape;
/** Reuse the card's field validation; this boundary only accepts buyer requirements. */
export const clientBuyerRequirementsSchema = z.object({
  budgetMin: fields.budgetMin, budgetMax: fields.budgetMax, currency: fields.currency,
  desiredType: fields.desiredType, desiredRooms: fields.desiredRooms,
  desiredDistrictId: fields.desiredDistrictId, desiredAreaMin: fields.desiredAreaMin,
  desiredFloorMin: fields.desiredFloorMin, desiredFloorMax: fields.desiredFloorMax,
  desiredTotalFloors: fields.desiredTotalFloors, requirementsNotes: fields.requirementsNotes,
}).strict().superRefine((data, ctx) => {
  if (!Object.keys(data).length) ctx.addIssue({ code: "custom", message: "Укажите пожелания покупателя" });
  const parsed = clientUpdateSchema.safeParse(data);
  if (!parsed.success) for (const issue of parsed.error.issues) {
    ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
});
export type ClientBuyerRequirementsInput = z.infer<typeof clientBuyerRequirementsSchema>;
