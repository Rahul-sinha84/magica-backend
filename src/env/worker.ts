import { WorkerEnvSchema, parseEnv } from "./schema.js";

export const env = parseEnv(WorkerEnvSchema, process.env);
