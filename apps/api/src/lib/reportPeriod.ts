import { z } from "zod";

/** Calendar labels must not silently roll into another day/month. No year ceiling. */
export const reportCalendarDaySchema = z.iso.date();
export const reportCalendarMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Некорректный месяц");

/** Preserve Date/ISO instant inputs accepted by ordinary reports, while checking
 * the original ISO calendar date before Date coercion can normalize it. */
export const reportDateQuerySchema = z.preprocess((value, ctx) => {
  if (typeof value === "string") {
    const day = value.match(/^(\d{4}-\d{2}-\d{2})(?:$|[Tt ])/);
    if (day && !reportCalendarDaySchema.safeParse(day[1]).success) {
      ctx.addIssue({ code: "custom", message: "Несуществующая календарная дата" });
      return z.NEVER;
    }
  }
  return value;
}, z.coerce.date());
