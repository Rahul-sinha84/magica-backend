// Shared modules (db, logger) import this subset so they load in both the API and the worker.
import { BaseEnvSchema, parseEnv } from "./schema.js";

export const env = parseEnv(BaseEnvSchema, process.env);
