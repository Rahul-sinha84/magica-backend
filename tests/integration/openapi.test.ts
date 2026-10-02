import { readFileSync } from "node:fs";
import type { RequestHandler, Router } from "express";
import { describe, expect, it } from "vitest";
import { buildOpenApi } from "#src/openapi/spec.js";
import { v1Router } from "#src/routes/v1.js";

const committed = JSON.parse(readFileSync("docs/openapi.json", "utf8")) as Record<string, unknown> & { paths: Record<string, Record<string, unknown>> };
const built = buildOpenApi() as typeof committed;
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** Every route the /v1 router answers, as "METHOD /v1/path/{param}". */
function routes(router: Router): string[] {
  const stack = (router as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] }).stack;
  return stack.flatMap((layer) =>
    layer.route ? Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} /v1${layer.route!.path.replace(/:([A-Za-z]+)/g, "{$1}")}`) : [],
  );
}
const documented = (spec: typeof committed) =>
  Object.entries(spec.paths).flatMap(([path, operations]) => METHODS.filter((method) => method in operations).map((method) => `${method.toUpperCase()} ${path}`));

describe("the OpenAPI document", () => {
  it("is up to date with the contracts (run `pnpm openapi` after changing them)", () => {
    const { servers: _a, ...current } = built;
    const { servers: _b, ...file } = committed;
    expect(file).toEqual(current);
  });

  it("describes every /v1 route, and nothing else", () => {
    const pass: RequestHandler = (_req, _res, next) => next();
    const actual = routes(v1Router({ sessionAuth: pass, sendLimit: pass }))
      // one route serves all three tools
      .flatMap((route) => (route === "POST /v1/tools/{tool}" ? ["POST /v1/tools/gpt-image-2", "POST /v1/tools/crop-image", "POST /v1/tools/merge-videos"] : [route]));
    expect(documented(built).sort()).toEqual(actual.sort());
    expect(Object.keys(built.paths).every((path) => path.startsWith("/v1/"))).toBe(true);
  });

  it("resolves every reference, and documents the sign-in and error of every operation", () => {
    const text = JSON.stringify(built);
    const schemas = (built.components as { schemas: Record<string, unknown> }).schemas;
    for (const [, name] of text.matchAll(/"#\/components\/schemas\/([A-Za-z0-9]+)"/g)) expect(schemas, name).toHaveProperty(name!);
    for (const [path, operations] of Object.entries(built.paths)) {
      for (const method of METHODS) {
        const operation = operations[method] as { responses: Record<string, { content?: Record<string, { schema: { $ref?: string } }> }> } | undefined;
        if (!operation) continue;
        expect(operation.responses["401"]?.content?.["application/json"]?.schema.$ref, `${method} ${path}`).toBe("#/components/schemas/Error");
      }
    }
    expect(built).toMatchObject({ openapi: "3.1.0", security: [{ ApiKey: [] }, { Bearer: [] }] });
  });

  it("documents the chat-completions request as the server takes it", () => {
    const request = (built.components as { schemas: Record<string, { properties: Record<string, unknown>; required: string[] }> }).schemas.ChatCompletionRequest!;
    expect(request.properties.model).toMatchObject({ const: "openrouter/free" });
    expect(Object.keys(request.properties)).toEqual(["model", "messages", "stream"]);
    expect(request.required).toEqual(["model", "messages"]);
  });
});
