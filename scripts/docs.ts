import { mkdirSync, writeFileSync } from "node:fs";
import { errorsPage } from "../src/openapi/errorsPage.js";
import { buildOpenApi } from "../src/openapi/spec.js";

// Writes the docs' generated parts from the code: the OpenAPI reference (docs/openapi.json) and the errors page
// (docs/errors.mdx). `pnpm docs:generate` after changing a /v1 contract or an error code; a test fails while either is
// out of date. The playground calls the first server (the deployed API; OPENAPI_SERVER_URL overrides it) and can be
// switched to a local one.

const LOCAL = "http://localhost:3000";
const server = process.env.OPENAPI_SERVER_URL ?? "https://magica-backend-production.up.railway.app";
const servers = [{ url: server }, ...(server === LOCAL ? [] : [{ url: LOCAL, description: "Running locally (pnpm dev)" }])];

mkdirSync("docs", { recursive: true });
writeFileSync("docs/openapi.json", `${JSON.stringify(buildOpenApi({ servers }), null, 2)}\n`);
writeFileSync("docs/errors.mdx", errorsPage());
console.log(`wrote docs/openapi.json (servers ${servers.map((s) => s.url).join(", ")}) and docs/errors.mdx`);
