import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Captured from the real Magica API. They are committed, so they must never carry a credential.
const dir = join(import.meta.dirname, "../fixtures/magica");
const files = readdirSync(dir).filter((file) => file.endsWith(".json"));

describe("Magica fixtures", () => {
  it("exist for every model, schema and run state the tests rely on", () => {
    for (const name of ["models.json", "schema.crop_image.json", "schema.gpt-image-2-text.json", "schema.gpt-image-2-edit.json", "schema.merge_videos.json", "run.gpt_text.completed.json", "run.crop.completed.json", "run.merge.completed.json", "error.401.json"]) {
      expect(files).toContain(name);
    }
  });

  it.each(files)("%s is valid JSON with no API key or auth header in it", (file) => {
    const text = readFileSync(join(dir, file), "utf8");
    expect(() => JSON.parse(text) as unknown).not.toThrow();
    expect(text).not.toMatch(/gx_[A-Za-z0-9]{8,}/);
    expect(text).not.toMatch(/authorization|bearer/i);
  });
});
