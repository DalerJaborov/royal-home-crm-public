import type { Request, Response, NextFunction } from "express";
import { canViewInvestigations } from "@royal-home/shared";

/** Role-only boundary: permission overrides never disclose investigations. */
export function requireInvestigations(req: Request, res: Response, next: NextFunction) {
  if (!canViewInvestigations(req.agent?.role)) return res.status(403).json({ error: "Недостаточно прав" });
  next();
}
