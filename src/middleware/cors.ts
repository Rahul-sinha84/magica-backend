import cors from "cors";
import { env } from "#src/env/server.js";

// Auth is a Bearer header, never a cookie, so credentials stay off and CSRF does not apply.
export const corsMiddleware = () =>
  cors({
    origin: env.FRONTEND_ORIGIN,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Trace-Id"],
    // what the browser is allowed to read: the trace id for bug reports, and the rate-limit hints
    exposedHeaders: ["X-Trace-Id", "Retry-After", "RateLimit", "RateLimit-Policy"],
    maxAge: 600,
  });
