import { z } from "zod";
import {
  CropImageInputSchema,
  CropImageOutputSchema,
  GptImage2InputSchema,
  GptImage2OutputSchema,
  MergeVideosInputSchema,
  MergeVideosOutputSchema,
  type CropImageInput,
  type GptImage2Input,
} from "#src/contracts/index.js";
import { MagicaError, resolveInput, type MagicaClient, type MagicaRun, type WaitOptions } from "#src/lib/magica.js";
import { ESTIMATES, TOOL_CREDIT_COSTS } from "#src/tools/costs.js";
import { defineTool, type ToolDefinition } from "#src/tools/registry.js";

// The three Magica tools. Each maps our contract (simple, lowercase choices the model can get right) onto the model's
// real input fields (checked against its live schema at call time), and reads the model's own output shape back.

const noResult = (label: string) => new MagicaError("BAD_RESPONSE", `${label} finished but returned no result.`, "completed run had no usable output");

const ImageResultSchema = z.object({
  result: z.array(z.url()).min(1),
  resultMetadata: z.array(z.object({ width: z.number().optional(), height: z.number().optional(), mimeType: z.string().optional() })).optional(),
});

export const gptImage2Tool = defineTool({
  name: "gpt_image_2",
  description: "Create a new image from a description (mode text), or change existing images (mode edit, with image_urls). Load the image-generation or image-editing skill first.",
  input: GptImage2InputSchema,
  output: GptImage2OutputSchema,
  kind: "magica",
  creditCost: TOOL_CREDIT_COSTS.gpt_image_2,
  estimate: ESTIMATES.gpt_image_2,
  mediaUrls: (input) => input.image_urls ?? [],
  displayResult: (output) => {
    const [first] = output.images;
    return { url: first?.url, ...(output.images.length > 1 && { urls: output.images.map((image) => image.url) }), ...(first?.width && { width: first.width }), ...(first?.height && { height: first.height }), ...(first?.mimeType && { mimeType: first.mimeType }) };
  },
  assets: (output, input?: GptImage2Input) =>
    output.images.map((image) => ({
      type: "image" as const,
      url: image.url,
      model: "GPT Image 2",
      ...(input?.prompt && { prompt: input.prompt }),
      ...(image.mimeType && { mimeType: image.mimeType }),
      ...(image.width && { width: image.width }),
      ...(image.height && { height: image.height }),
    })),
  magica: {
    nodeType: "gpt_image_2",
    label: "Image generation",
    subModelId: (input: GptImage2Input) => (input.mode === "edit" ? "gpt-image-2-edit" : "gpt-image-2-text"),
    toInput: (input: GptImage2Input) => ({
      prompt: input.prompt,
      ...(input.mode === "edit" && { uploadedImages: input.image_urls }),
      size: input.size,
      quality: input.quality,
      background: input.background,
      n: input.n,
      output_format: input.output_format,
    }),
    fromOutput: (output) => {
      const parsed = ImageResultSchema.safeParse(output);
      if (!parsed.success) throw noResult("Image generation");
      const meta = parsed.data.resultMetadata ?? [];
      return { images: parsed.data.result.map((url, i) => ({ url, ...meta[i] })) };
    },
  },
});

/** The crop in Magica's fields: percent (`*_percent`) or pixels (`*_px`). */
export function cropFields(input: CropImageInput): Record<string, number | undefined> {
  if (input.crop) {
    const { x, y, width, height, unit } = input.crop;
    return unit === "pixel" ? { x_px: x, y_px: y, width_px: width, height_px: height } : { x_percent: x, y_percent: y, width_percent: width, height_percent: height };
  }
  if (input.width_percent !== undefined) return { x_percent: input.x_percent, y_percent: input.y_percent, width_percent: input.width_percent, height_percent: input.height_percent };
  return { x_px: input.x_px, y_px: input.y_px, width_px: input.width_px, height_px: input.height_px };
}

export const cropImageTool = defineTool({
  name: "crop_image",
  description:
    'Cut out part of an image (keep only a rectangle). Give the rectangle as crop {x, y, width, height}: in percent of the image (0-100) unless you add "unit": "pixel". Load the image-editing skill first.',
  input: CropImageInputSchema,
  output: CropImageOutputSchema,
  kind: "magica",
  creditCost: TOOL_CREDIT_COSTS.crop_image,
  estimate: ESTIMATES.crop_image,
  mediaUrls: (input) => [input.image_url],
  displayResult: (output) => ({ ...output.image }),
  assets: (output) => [{ type: "image" as const, url: output.image.url, model: "Crop Image", ...(output.image.width && { width: output.image.width }), ...(output.image.height && { height: output.image.height }) }],
  magica: {
    nodeType: "crop_image",
    label: "Cropping",
    toInput: (input: CropImageInput) => ({ image_url: input.image_url, ...cropFields(input) }),
    fromOutput: (output) => {
      const parsed = z.object({ image_url: z.url(), width: z.number().optional(), height: z.number().optional() }).safeParse(output);
      if (!parsed.success) throw noResult("Cropping");
      return { image: { url: parsed.data.image_url, ...(parsed.data.width && { width: parsed.data.width }), ...(parsed.data.height && { height: parsed.data.height }) } };
    },
  },
});

export const mergeVideosTool = defineTool({
  name: "merge_videos",
  description: "Join 2 to 100 videos into one, in the order given, with an optional transition. Load the video-merging skill first.",
  input: MergeVideosInputSchema,
  output: MergeVideosOutputSchema,
  kind: "magica",
  creditCost: TOOL_CREDIT_COSTS.merge_videos,
  estimate: ESTIMATES.merge_videos,
  mediaUrls: (input) => input.video_urls,
  displayResult: (output) => ({ ...output.video }),
  assets: (output) => [{ type: "video" as const, url: output.video.url, model: "Merge Videos", ...(output.video.mimeType && { mimeType: output.video.mimeType }), ...(output.video.width && { width: output.video.width }), ...(output.video.height && { height: output.video.height }) }],
  magica: {
    nodeType: "merge_videos",
    label: "Video merging",
    toInput: (input) => ({ video_urls: input.video_urls, transition: input.transition }),
    fromOutput: (output) => {
      const parsed = z.object({ video_url: z.url(), mimeType: z.string().optional(), duration: z.number().optional(), width: z.number().optional(), height: z.number().optional() }).safeParse(output);
      if (!parsed.success) throw noResult("Video merging");
      const { video_url, mimeType, duration, width, height } = parsed.data;
      return { video: { url: video_url, ...(mimeType && { mimeType }), ...(duration !== undefined && { durationMs: Math.round(duration * 1000) }), ...(width && { width }), ...(height && { height }) } };
    },
  },
});

export const MAGICA_TOOLS: ToolDefinition[] = [gptImage2Tool, cropImageTool, mergeVideosTool];

export interface MagicaCallHooks extends Pick<WaitOptions, "signal" | "onStatus" | "onStatusError"> {
  /** Called with the input as it will be sent, once it passed the live schema, just before the run is started. */
  beforeStart?: () => Promise<void> | void;
  /** Called with Magica's run id as soon as the run is accepted. */
  onStarted?: (runId: string) => Promise<void> | void;
  /** Resume a run that was already started (its id was saved): never start another. */
  resumeRunId?: string;
  maxWaitMs?: number;
}

export interface MagicaCallResult {
  output: unknown;
  run: MagicaRun;
}

/**
 * One Magica tool call: check the input against the model's live schema, start the run (or resume it), wait, and read
 * the output. Every failure is a MagicaError with a safe message.
 */
export async function callMagicaTool(tool: ToolDefinition, input: unknown, client: MagicaClient, hooks: MagicaCallHooks = {}): Promise<MagicaCallResult> {
  const spec = tool.magica;
  if (!spec) throw new Error(`${tool.name} is not a Magica tool`);
  const subModelId = spec.subModelId?.(input);

  let runId = hooks.resumeRunId;
  if (!runId) {
    const schema = await client.getModelSchema(subModelId ?? spec.nodeType, hooks.signal);
    const magicaInput = resolveInput(schema, spec.toInput(input));
    await hooks.beforeStart?.();
    runId = await client.startRun(spec.nodeType, { input: magicaInput, ...(subModelId && { subModelId }) }, hooks.signal);
    await hooks.onStarted?.(runId);
  }
  const run = await client.waitForRun(runId, {
    label: spec.label,
    ...(hooks.signal && { signal: hooks.signal }),
    ...(hooks.maxWaitMs !== undefined && { maxWaitMs: hooks.maxWaitMs }),
    ...(hooks.onStatus && { onStatus: hooks.onStatus }),
    ...(hooks.onStatusError && { onStatusError: hooks.onStatusError }),
  });
  return { output: spec.fromOutput(run.output), run };
}
