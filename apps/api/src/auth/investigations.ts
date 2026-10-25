import type { Request, Response, NextFunction } from "express";
import { canViewInvestigations } from "@royal-home/shared";
import { can } from "./middleware.js";

/** Both the role ceiling and current effective grant apply to every private surface. */
export function canReadInvestigations(req: Request): boolean {
  return canViewInvestigations(req.agent?.role) && can(req, "clients.securityReview");
}

/** Pass only this role to projection/query helpers; undefined means public-only. */
export function investigationViewerRole(req: Request): string | undefined {
  return canReadInvestigations(req) ? req.agent?.role : undefined;
}

export function requireInvestigations(req: Request, res: Response, next: NextFunction) {
  if (!canReadInvestigations(req)) return res.status(403).json({ error: "Недостаточно прав" });
  next();
}
