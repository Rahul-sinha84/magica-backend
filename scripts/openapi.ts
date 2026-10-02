import { mkdirSync, writeFileSync } from "node:fs";
import { buildOpenApi } from "../src/openapi/spec.js";

// Writes the public API's OpenAPI document (docs/openapi.json) from the Zod contracts: `pnpm openapi`. Run it after
// changing a /v1 contract; a test fails while the file is out of date. The server URL can be set for the hosted docs.

export const OPENAPI_PATH = "docs/openapi.json";
export const OPENAPI_SERVER = process.env.OPENAPI_SERVER_URL ?? "http://localhost:3000";

mkdirSync("docs", { recursive: true });
writeFileSync(OPENAPI_PATH, `${JSON.stringify(buildOpenApi({ serverUrl: OPENAPI_SERVER }), null, 2)}\n`);
console.log(`wrote ${OPENAPI_PATH}`);
