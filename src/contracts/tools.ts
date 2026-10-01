import { z } from "zod";

// The agent's tools: what the model may send each one, and what each returns. The backend owns these; the frontend
// reads them to label and render tool activity. Every input is checked against its schema before anything runs.

// Media the tools read must be public https URLs (the media service fetches them itself).
const MediaUrlSchema = z.url({ protocol: /^https$/, error: "must be a public https URL" }).max(2048);
const SkillNameSchema = z.string().trim().min(1).max(64);

// ---- load_skill ----

export const LoadSkillInputSchema = z.object({
  name: SkillNameSchema.describe("The skill to load, exactly as listed under available skills."),
});
export const LoadSkillOutputSchema = z.object({
  skill: z.string(),
  instructions: z.string(),
});

// ---- read_skill_asset ----

export const ReadSkillAssetInputSchema = z.object({
  skill: SkillNameSchema.describe("The skill the file belongs to."),
  path: z.string().trim().min(1).max(200).describe("The file's path inside that skill's folder, for example examples/presets.md."),
});
export const ReadSkillAssetOutputSchema = z.object({
  skill: z.string(),
  path: z.string(),
  content: z.string(),
});

// ---- gpt_image_2 ----

export const IMAGE_SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536", "2048x2048", "2048x1152", "3840x2160", "2160x3840"] as const;

export const GptImage2InputSchema = z
  .object({
    mode: z.enum(["text", "edit"]).describe("text: create a new image from the prompt. edit: change the image(s) in image_urls as the prompt says."),
    prompt: z.string().trim().min(1).max(4000).describe("What to create, or how to change the image."),
    image_urls: z.array(MediaUrlSchema).min(1).max(10).optional().describe("Edit mode only: the image(s) to start from."),
    size: z.enum(IMAGE_SIZES).default("auto"),
    quality: z.enum(["low", "medium", "high"]).default("medium").describe("Higher quality is slower."),
    background: z.enum(["auto", "opaque", "transparent"]).default("auto"),
    n: z.int().min(1).max(4).default(1).describe("How many images to make."),
    output_format: z.enum(["png", "jpeg", "webp"]).default("png"),
  })
  .superRefine((input, ctx) => {
    if (input.mode === "edit" && !input.image_urls?.length) {
      ctx.addIssue({ code: "custom", path: ["image_urls"], message: "edit mode needs at least one image URL" });
    }
    if (input.mode === "text" && input.image_urls?.length) {
      ctx.addIssue({ code: "custom", path: ["image_urls"], message: "text mode creates a new image; use edit mode to change an existing one" });
    }
    if (input.background === "transparent" && input.output_format === "jpeg") {
      ctx.addIssue({ code: "custom", path: ["output_format"], message: "a transparent background needs png or webp" });
    }
  });

const GeneratedImageSchema = z.object({
  url: z.url(),
  width: z.number().optional(),
  height: z.number().optional(),
  mimeType: z.string().optional(),
});
export const GptImage2OutputSchema = z.object({ images: z.array(GeneratedImageSchema).min(1) });

// ---- crop_image ----

// A crop is given in exactly one of three forms: percentages, exact pixels, or a `crop` rectangle with its unit.
const percent = z.number().min(0).max(100);
const pixel = z.int().min(0);

export const CropImageInputSchema = z
  .object({
    image_url: MediaUrlSchema.describe("The image to crop."),
    crop: z
      .object({
        x: z.number().min(0),
        y: z.number().min(0),
        width: z.number().positive(),
        height: z.number().positive(),
        unit: z.enum(["percent", "pixel"]).default("percent"),
      })
      .optional()
      .describe("The rectangle to keep: top-left corner (x, y) and size, in percent of the image (default) or pixels."),
    x_percent: percent.optional(),
    y_percent: percent.optional(),
    width_percent: percent.optional(),
    height_percent: percent.optional(),
    x_px: pixel.optional(),
    y_px: pixel.optional(),
    width_px: z.int().min(1).optional(),
    height_px: z.int().min(1).optional(),
  })
  .superRefine((input, ctx) => {
    const percentFields = [input.x_percent, input.y_percent, input.width_percent, input.height_percent];
    const pixelFields = [input.x_px, input.y_px, input.width_px, input.height_px];
    const forms = [input.crop !== undefined, percentFields.some((v) => v !== undefined), pixelFields.some((v) => v !== undefined)].filter(Boolean).length;
    if (forms !== 1) {
      ctx.addIssue({ code: "custom", message: "give the crop in exactly one form: crop, the *_percent fields, or the *_px fields" });
      return;
    }
    const rectangle = (x: number, y: number, width: number, height: number, path: (string | number)[]) => {
      if (width <= 0 || height <= 0) ctx.addIssue({ code: "custom", path, message: "width and height must be greater than 0" });
      if (x + width > 100) ctx.addIssue({ code: "custom", path, message: "x + width must not exceed 100%" });
      if (y + height > 100) ctx.addIssue({ code: "custom", path, message: "y + height must not exceed 100%" });
    };
    if (input.crop) {
      const { x, y, width, height, unit } = input.crop;
      if (unit === "percent") {
        if ([x, y, width, height].some((v) => v > 100)) ctx.addIssue({ code: "custom", path: ["crop"], message: "percent values must be between 0 and 100" });
        else rectangle(x, y, width, height, ["crop"]);
      } else if (![x, y, width, height].every(Number.isInteger)) {
        ctx.addIssue({ code: "custom", path: ["crop"], message: "pixel values must be whole numbers" });
      }
    } else if (percentFields.some((v) => v !== undefined)) {
      if (percentFields.some((v) => v === undefined)) {
        ctx.addIssue({ code: "custom", message: "a percent crop needs all four of x_percent, y_percent, width_percent and height_percent" });
        return;
      }
      rectangle(input.x_percent ?? 0, input.y_percent ?? 0, input.width_percent ?? 0, input.height_percent ?? 0, []);
    } else {
      if (input.width_px === undefined || input.height_px === undefined) ctx.addIssue({ code: "custom", message: "a pixel crop needs width_px and height_px" });
      if ((input.x_px === undefined) !== (input.y_px === undefined)) ctx.addIssue({ code: "custom", message: "give both x_px and y_px, or neither (to centre the crop)" });
    }
  });

export const CropImageOutputSchema = z.object({ image: GeneratedImageSchema });

// ---- merge_videos ----

export const MergeVideosInputSchema = z.object({
  video_urls: z.array(MediaUrlSchema).min(2).max(100).describe("The videos to join, in the order they should play."),
  transition: z.enum(["none", "fade", "dissolve"]).default("none").describe("The effect between clips."),
});
export const MergeVideosOutputSchema = z.object({
  video: z.object({
    url: z.url(),
    mimeType: z.string().optional(),
    durationMs: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
  }),
});

export const TOOL_NAMES = ["load_skill", "read_skill_asset", "gpt_image_2", "crop_image", "merge_videos"] as const;
export const ToolNameSchema = z.enum(TOOL_NAMES);

/** How each tool is named in the UI (the tool card, the step list). */
export const TOOL_LABELS: Readonly<Record<(typeof TOOL_NAMES)[number], string>> = {
  load_skill: "Load skill",
  read_skill_asset: "Read skill file",
  gpt_image_2: "GPT Image 2",
  crop_image: "Crop Image",
  merge_videos: "Merge Videos",
};

/**
 * What a media tool's card shows of its result: the output's link at the top level (`url`), plus its size and, for
 * several images, every link. The model itself gets the full result.
 */
export const MediaResultDisplaySchema = z.object({
  url: z.url(),
  urls: z.array(z.url()).optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  mimeType: z.string().optional(),
  durationMs: z.number().optional(),
});
export type MediaResultDisplay = z.infer<typeof MediaResultDisplaySchema>;

export type ToolName = z.infer<typeof ToolNameSchema>;
export type LoadSkillInput = z.infer<typeof LoadSkillInputSchema>;
export type LoadSkillOutput = z.infer<typeof LoadSkillOutputSchema>;
export type ReadSkillAssetInput = z.infer<typeof ReadSkillAssetInputSchema>;
export type ReadSkillAssetOutput = z.infer<typeof ReadSkillAssetOutputSchema>;
export type GptImage2Input = z.infer<typeof GptImage2InputSchema>;
export type GptImage2Output = z.infer<typeof GptImage2OutputSchema>;
export type CropImageInput = z.infer<typeof CropImageInputSchema>;
export type CropImageOutput = z.infer<typeof CropImageOutputSchema>;
export type MergeVideosInput = z.infer<typeof MergeVideosInputSchema>;
export type MergeVideosOutput = z.infer<typeof MergeVideosOutputSchema>;
