import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  V1ChatCompletionPendingSchema,
  V1ChatCompletionSchema,
  V1ErrorResponseSchema,
  V1MessageAcceptedSchema,
  V1RunResponseSchema,
  V1ToolRunAcceptedSchema,
  V1SendMessageBodySchema,
  V1ToolRunResponseSchema,
  WaitpointSchema,
  WebhookEventSchema,
} from "#src/contracts/index.js";
import { errorsPage, RUN_FAILURES } from "#src/openapi/errorsPage.js";

// The docs can't drift from the code: the generated page is current, every example that names a response shape is
// that shape, every page in the navigation exists, and every way a run can fail is explained.

const DOCS = "docs";
const pages = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? pages(join(dir, entry.name)) : entry.name.endsWith(".mdx") ? [join(dir, entry.name)] : []));

// a ```json block's title names the request or response it shows
const EXAMPLES: Record<string, z.ZodType> = {
  SendMessage: V1SendMessageBodySchema,
  Waitpoint: WaitpointSchema,
  Error: V1ErrorResponseSchema,
  MessageAccepted: V1MessageAcceptedSchema,
  RunResponse: V1RunResponseSchema,
  ToolRunAccepted: V1ToolRunAcceptedSchema,
  ToolRunResponse: V1ToolRunResponseSchema,
  ChatCompletion: V1ChatCompletionSchema,
  ChatCompletionPending: V1ChatCompletionPendingSchema,
  WebhookEvent: WebhookEventSchema,
};

describe("the docs", () => {
  it("have a current errors page (run `pnpm docs:generate` after changing an error code)", () => {
    expect(readFileSync(join(DOCS, "errors.mdx"), "utf8")).toBe(errorsPage());
  });

  it("show only requests and responses that match the real contracts", () => {
    const found: string[] = [];
    for (const file of pages(DOCS)) {
      // a block can be indented (inside a <Step>); its closing fence has the same indent
      for (const [, indent, title, body] of readFileSync(file, "utf8").matchAll(/^( *)```json(?: ([A-Za-z]+))?\n([\s\S]*?)\n\1```$/gm)) {
        expect(title, `${file}: a json example without a title, so nothing checks it`).toBeDefined();
        const schema = EXAMPLES[title!];
        expect(schema, `${file}: no schema for an example titled ${title}`).toBeDefined();
        const json = body!.split("\n").map((line) => line.slice(indent!.length)).join("\n");
        const parsed = schema!.safeParse(JSON.parse(json));
        expect(parsed.success, `${file}: the ${title} example doesn't match: ${parsed.error?.message ?? ""}`).toBe(true);
        found.push(title!);
      }
    }
    expect(new Set(found)).toEqual(new Set(Object.keys(EXAMPLES))); // every kind has an example somewhere
  });

  it("list only pages that exist", () => {
    const config = JSON.parse(readFileSync(join(DOCS, "docs.json"), "utf8")) as { navigation: { tabs: { groups?: { pages: string[] }[]; openapi?: string }[] } };
    for (const tab of config.navigation.tabs) {
      if (tab.openapi) expect(existsSync(join(DOCS, tab.openapi)), tab.openapi).toBe(true);
      for (const page of tab.groups?.flatMap((group) => group.pages) ?? []) expect(existsSync(join(DOCS, `${page}.mdx`)), page).toBe(true);
    }
  });

  it("explain every code a run can fail with", () => {
    const sources = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? (entry.name === "generated" ? [] : sources(join(dir, entry.name))) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []));
    const used = new Set<string>();
    for (const file of sources("src")) {
      const text = readFileSync(file, "utf8");
      for (const [, code] of text.matchAll(/(?:TurnError\(|failed\()"([A-Z_]+)"/g)) used.add(code!);
      for (const [, code] of text.matchAll(/const (?:GENERIC|TIMEOUT) = \{ code: "([A-Z_]+)"/g)) used.add(code!);
    }
    used.delete("RUN_ENDED"); // internal: the run had already ended, so it is never stored
    const documented = new Set(RUN_FAILURES.map((failure) => failure.code));
    for (const code of used) expect(documented.has(code), `${code} isn't on the errors page`).toBe(true);
    expect(documented.has("WAITPOINT_EXPIRED") && documented.has("MODEL_DAILY_LIMIT")).toBe(true);
  });
});
