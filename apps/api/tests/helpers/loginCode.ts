import type { Express } from "express";
import request from "supertest";

/** Real supported login flow, with development code echo scoped to this local test request. */
export async function loginWithCode(app: Express, phone: string) {
  const previous = process.env.LOGIN_CODE_DEV_ECHO;
  process.env.LOGIN_CODE_DEV_ECHO = "1";
  try {
    const issued = await request(app).post("/api/v1/auth/login/code").send({ phone });
    if (issued.status !== 200 || !issued.body.devCode) throw new Error(`Test code login failed: ${issued.status}`);
    return await request(app).post("/api/v1/auth/login/verify-code").send({ pendingToken: issued.body.pendingToken, code: issued.body.devCode });
  } finally {
    if (previous === undefined) delete process.env.LOGIN_CODE_DEV_ECHO;
    else process.env.LOGIN_CODE_DEV_ECHO = previous;
  }
}
