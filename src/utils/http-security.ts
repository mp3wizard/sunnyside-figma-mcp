import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { Logger } from "./logger.js";

// Only loopback hosts are accepted. An optional :port suffix is allowed.
// This blocks DNS-rebinding attacks where a malicious site resolves a
// hostname to 127.0.0.1 and the browser sends the attacker's Host header.
const ALLOWED_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * Rejects requests whose Host header is not a loopback address.
 * Must be registered before any route handlers.
 */
export function hostValidationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const host = req.headers.host ?? "";

  if (!ALLOWED_HOST_RE.test(host)) {
    Logger.error(`Rejected request with non-loopback Host header: '${host}'`);
    res.status(403).json({
      error: "Forbidden: requests are only accepted from loopback hosts",
    });
    return;
  }

  next();
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, so guard first. The length
  // check itself leaks length, which is acceptable for a bearer token.
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Builds a middleware that requires `Authorization: Bearer <token>`.
 * If `token` is empty, returns a pass-through (auth disabled).
 */
export function createBearerAuthMiddleware(token: string) {
  if (!token) {
    return (_req: Request, _res: Response, next: NextFunction): void => next();
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? "";
    const match = header.match(/^Bearer\s+(.+)$/);

    if (!match || !constantTimeEquals(match[1], token)) {
      res.status(401).json({ error: "Unauthorized: valid bearer token required" });
      return;
    }

    next();
  };
}
