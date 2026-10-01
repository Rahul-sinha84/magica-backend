import { describe, expect, it } from "vitest";
import {
  CropImageInputSchema,
  CropImageOutputSchema,
  GptImage2InputSchema,
  GptImage2OutputSchema,
  LoadSkillInputSchema,
  LoadSkillOutputSchema,
  MergeVideosInputSchema,
  MergeVideosOutputSchema,
  ReadSkillAssetInputSchema,
  ReadSkillAssetOutputSchema,
  ToolNameSchema,
} from "#src/contracts/index.js";

const IMG = "https://cdn.example.com/fox.png";
const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => schema.safeParse(value).success;
const messages = (schema: typeof CropImageInputSchema | typeof GptImage2InputSchema, value: unknown) => {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe("tool names", () => {
  it("are the five agent tools", () => {
    expect(ToolNameSchema.options).toEqual(["load_skill", "read_skill_asset", "gpt_image_2", "crop_image", "merge_videos"]);
  });
});

describe("load_skill and read_skill_asset", () => {
  it("take a skill name (and a path), trimmed and bounded", () => {
    expect(LoadSkillInputSchema.parse({ name: "  image-editing " })).toEqual({ name: "image-editing" });
    expect(ok(LoadSkillInputSchema, { name: "" })).toBe(false);
    expect(ok(LoadSkillInputSchema, { name: "x".repeat(65) })).toBe(false);
    expect(ok(LoadSkillInputSchema, {})).toBe(false);
    expect(ReadSkillAssetInputSchema.parse({ skill: "image-editing", path: " notes.md " })).toEqual({ skill: "image-editing", path: "notes.md" });
    expect(ok(ReadSkillAssetInputSchema, { skill: "image-editing", path: "x".repeat(201) })).toBe(false);
  });

  it("return the instructions, or the file's content", () => {
    expect(ok(LoadSkillOutputSchema, { skill: "a", instructions: "Do this." })).toBe(true);
    expect(ok(ReadSkillAssetOutputSchema, { skill: "a", path: "n.md", content: "" })).toBe(true);
    expect(ok(LoadSkillOutputSchema, { skill: "a" })).toBe(false);
  });
});

describe("gpt_image_2", () => {
  it("creates from a prompt in text mode, with the defaults filled in", () => {
    expect(GptImage2InputSchema.parse({ mode: "text", prompt: "A red fox in snow" })).toEqual({
      mode: "text",
      prompt: "A red fox in snow",
      size: "auto",
      quality: "medium",
      background: "auto",
      n: 1,
      output_format: "png",
    });
  });

  it("edits the given images in edit mode", () => {
    expect(GptImage2InputSchema.parse({ mode: "edit", prompt: "Make it night", image_urls: [IMG] })).toMatchObject({ mode: "edit", image_urls: [IMG] });
  });

  it("needs an image to edit, and refuses images in text mode", () => {
    expect(messages(GptImage2InputSchema, { mode: "edit", prompt: "Make it night" })).toContain("edit mode needs at least one image URL");
    expect(messages(GptImage2InputSchema, { mode: "edit", prompt: "Make it night", image_urls: [] }).join()).toMatch(/at least 1|>=1|too small/i);
    expect(messages(GptImage2InputSchema, { mode: "text", prompt: "A fox", image_urls: [IMG] }).join()).toMatch(/use edit mode/);
  });

  it("refuses a transparent background as JPEG", () => {
    expect(messages(GptImage2InputSchema, { mode: "text", prompt: "Logo", background: "transparent", output_format: "jpeg" })).toContain("a transparent background needs png or webp");
    expect(ok(GptImage2InputSchema, { mode: "text", prompt: "Logo", background: "transparent", output_format: "webp" })).toBe(true);
  });

  it.each([
    ["an empty prompt", { mode: "text", prompt: "   " }],
    ["a prompt over 4,000 characters", { mode: "text", prompt: "a".repeat(4001) }],
    ["an unknown mode", { mode: "remix", prompt: "x" }],
    ["an unsupported size", { mode: "text", prompt: "x", size: "999x999" }],
    ["an unknown quality", { mode: "text", prompt: "x", quality: "ultra" }],
    ["n of 0", { mode: "text", prompt: "x", n: 0 }],
    ["n of 5", { mode: "text", prompt: "x", n: 5 }],
    ["a fractional n", { mode: "text", prompt: "x", n: 1.5 }],
    ["an http image", { mode: "edit", prompt: "x", image_urls: ["http://cdn.example.com/a.png"] }],
    ["a file URL", { mode: "edit", prompt: "x", image_urls: ["file:///etc/passwd"] }],
    ["eleven images", { mode: "edit", prompt: "x", image_urls: Array(11).fill(IMG) }],
  ])("refuses %s", (_label, value) => {
    expect(ok(GptImage2InputSchema, value)).toBe(false);
  });

  it("accepts every size and quality Magica offers", () => {
    for (const size of ["auto", "1024x1024", "1536x1024", "1024x1536", "2048x2048", "2048x1152", "3840x2160", "2160x3840"]) {
      for (const quality of ["low", "medium", "high"]) expect(ok(GptImage2InputSchema, { mode: "text", prompt: "x", size, quality })).toBe(true);
    }
  });

  it("returns at least one image", () => {
    expect(ok(GptImage2OutputSchema, { images: [{ url: IMG, width: 1024, height: 1024, mimeType: "image/png" }] })).toBe(true);
    expect(ok(GptImage2OutputSchema, { images: [] })).toBe(false);
  });
});

describe("crop_image: exactly one of three forms, always a complete rectangle", () => {
  it.each([
    ["crop in percent (the default unit)", { crop: { x: 0, y: 0, width: 100, height: 50 } }],
    ["crop in percent, explicitly", { crop: { x: 16.67, y: 0, width: 66.67, height: 100, unit: "percent" } }],
    ["crop in pixels", { crop: { x: 10, y: 20, width: 300, height: 200, unit: "pixel" } }],
    ["the four percent fields", { x_percent: 0, y_percent: 50, width_percent: 100, height_percent: 50 }],
    ["pixel size only (centred)", { width_px: 512, height_px: 512 }],
    ["pixel size and corner", { x_px: 0, y_px: 0, width_px: 512, height_px: 256 }],
  ])("accepts %s", (_label, form) => {
    expect(CropImageInputSchema.safeParse({ image_url: IMG, ...form }).success).toBe(true);
  });

  it("fills in percent as the crop's unit", () => {
    expect(CropImageInputSchema.parse({ image_url: IMG, crop: { x: 0, y: 0, width: 100, height: 50 } }).crop?.unit).toBe("percent");
  });

  it.each([
    ["no crop at all", {}, /exactly one form/],
    ["two forms at once", { crop: { x: 0, y: 0, width: 50, height: 50 }, width_px: 10, height_px: 10 }, /exactly one form/],
    ["percent and pixel fields mixed", { x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 50, width_px: 10 }, /exactly one form/],
    ["an incomplete percent rectangle", { x_percent: 0, y_percent: 0, width_percent: 50 }, /needs all four/],
    ["a percent rectangle past the right edge", { x_percent: 60, y_percent: 0, width_percent: 50, height_percent: 10 }, /x \+ width/],
    ["a percent rectangle past the bottom edge", { x_percent: 0, y_percent: 60, width_percent: 10, height_percent: 50 }, /y \+ height/],
    ["a zero-size percent rectangle", { x_percent: 0, y_percent: 0, width_percent: 0, height_percent: 50 }, /greater than 0/],
    ["a crop past the edge", { crop: { x: 50, y: 50, width: 60, height: 10 } }, /x \+ width/],
    ["a percent crop over 100", { crop: { x: 0, y: 0, width: 150, height: 10 } }, /between 0 and 100/],
    ["a fractional pixel crop", { crop: { x: 0.5, y: 0, width: 10, height: 10, unit: "pixel" } }, /whole numbers/],
    ["a pixel crop missing its height", { width_px: 512 }, /width_px and height_px/],
    ["a pixel corner with only x", { x_px: 10, width_px: 512, height_px: 512 }, /both x_px and y_px/],
  ])("refuses %s", (_label, form, reason) => {
    expect(messages(CropImageInputSchema, { image_url: IMG, ...form }).join(" | ")).toMatch(reason);
  });

  it.each([
    ["a negative percent", { x_percent: -1, y_percent: 0, width_percent: 50, height_percent: 50 }],
    ["a negative crop corner", { crop: { x: -5, y: 0, width: 10, height: 10 } }],
    ["a zero-size crop", { crop: { x: 0, y: 0, width: 0, height: 10 } }],
    ["a zero pixel width", { width_px: 0, height_px: 10 }],
    ["a missing image", { image_url: undefined, crop: { x: 0, y: 0, width: 10, height: 10 } }],
    ["an http image", { image_url: "http://cdn.example.com/a.png", crop: { x: 0, y: 0, width: 10, height: 10 } }],
  ])("refuses %s", (_label, form) => {
    expect(CropImageInputSchema.safeParse({ image_url: IMG, ...form }).success).toBe(false);
  });

  it("accepts a rectangle that exactly reaches the edges", () => {
    expect(ok(CropImageInputSchema, { image_url: IMG, crop: { x: 50, y: 50, width: 50, height: 50 } })).toBe(true);
  });

  it("returns the cropped image", () => {
    expect(ok(CropImageOutputSchema, { image: { url: IMG, width: 1024, height: 512 } })).toBe(true);
    expect(ok(CropImageOutputSchema, { image: { url: "not a url" } })).toBe(false);
  });
});

describe("merge_videos", () => {
  const video = (i: number) => `https://cdn.example.com/clip-${i}.mp4`;

  it("joins 2 to 100 videos in the given order, with no transition by default", () => {
    expect(MergeVideosInputSchema.parse({ video_urls: [video(2), video(1)] })).toEqual({ video_urls: [video(2), video(1)], transition: "none" });
    expect(ok(MergeVideosInputSchema, { video_urls: Array.from({ length: 100 }, (_, i) => video(i)) })).toBe(true);
    for (const transition of ["none", "fade", "dissolve"]) expect(ok(MergeVideosInputSchema, { video_urls: [video(1), video(2)], transition })).toBe(true);
  });

  it.each([
    ["one video", { video_urls: [video(1)] }],
    ["101 videos", { video_urls: Array.from({ length: 101 }, (_, i) => video(i)) }],
    ["an unknown transition", { video_urls: [video(1), video(2)], transition: "wipe" }],
    ["an http video", { video_urls: [video(1), "http://cdn.example.com/b.mp4"] }],
    ["no videos", {}],
  ])("refuses %s", (_label, value) => {
    expect(ok(MergeVideosInputSchema, value)).toBe(false);
  });

  it("returns the merged video", () => {
    expect(ok(MergeVideosOutputSchema, { video: { url: "https://cdn.example.com/out.mp4", mimeType: "video/mp4", durationMs: 20_022 } })).toBe(true);
  });
});

describe("extra fields the model adds", () => {
  it("are dropped, not passed on", () => {
    expect(GptImage2InputSchema.parse({ mode: "text", prompt: "x", style: "vivid", api_key: "nope" })).not.toHaveProperty("style");
    expect(MergeVideosInputSchema.parse({ video_urls: ["https://a.test/1.mp4", "https://a.test/2.mp4"], speed: 2 })).not.toHaveProperty("speed");
  });
});
