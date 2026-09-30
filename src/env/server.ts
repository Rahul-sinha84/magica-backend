import { ServerEnvSchema, parseEnv } from "./schema.js";

export const env = parseEnv(ServerEnvSchema, process.env);
