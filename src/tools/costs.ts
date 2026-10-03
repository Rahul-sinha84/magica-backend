// What tools cost, in app credits (the UI shows millions as "M"). One app credit is one Magica credit
// (PROVIDER_CREDIT_RATE). A finished Magica call is charged exactly what Magica reports it used (its `creditUsed`); the
// numbers here are the estimates made before the call, from Magica's published prices (GET /v1/models/{model}/pricing):
// the credits held while it runs and what a spend approval adds up. Model calls cost nothing (the free router is free).

/** App credits per Magica credit: one of ours is one of Magica's. */
export const PROVIDER_CREDIT_RATE = 1;

/** Magica prices models in USD and charges credits at this rate (0.00588 USD = 7,644 credits, as its runs report). */
export const MAGICA_CREDITS_PER_USD = 1_300_000;

/** GPT Image 2's price per image, in USD, by quality and size (text and edit are priced the same; "auto" is 1024x1024). */
const GPT_IMAGE_2_USD = {
  low: { "1024x1024": 0.00588, "1536x1024": 0.00474, "1024x1536": 0.00474, "2048x2048": 0.01191, "2048x1152": 0.00471, "3840x2160": 0.01113, "2160x3840": 0.01113 },
  medium: { "1024x1024": 0.05268, "1536x1024": 0.04116, "1024x1536": 0.04116, "2048x2048": 0.10704, "2048x1152": 0.04239, "3840x2160": 0.10008, "2160x3840": 0.10008 },
  high: { "1024x1024": 0.21072, "1536x1024": 0.16464, "1024x1536": 0.16464, "2048x2048": 0.42816, "2048x1152": 0.1695, "3840x2160": 0.40026, "2160x3840": 0.40026 },
} as const;
type ImageQuality = keyof typeof GPT_IMAGE_2_USD;
type PricedSize = keyof (typeof GPT_IMAGE_2_USD)["low"];

/** What a GPT Image 2 call will cost: Magica's price for its quality and size, per image. */
export function gptImage2Estimate({ quality, size, n }: { quality: ImageQuality; size: PricedSize | "auto"; n: number }): number {
  return Math.round(GPT_IMAGE_2_USD[quality][size === "auto" ? "1024x1024" : size] * MAGICA_CREDITS_PER_USD) * n;
}

/**
 * Merge Videos is priced per minute of output (prorated): 40,000, plus 10,000 for each video after the first. The input
 * has no durations, so the estimate assumes one minute; a longer merge is charged its real, larger cost.
 */
export const MERGE_ESTIMATE_MINUTES = 1;
export function mergeVideosEstimate(videos: number): number {
  return (40_000 + 10_000 * Math.max(0, videos - 1)) * MERGE_ESTIMATE_MINUTES;
}

/** Crop Image is a flat 5,000 per crop. */
export const CROP_IMAGE_COST = 5_000;

/** What a call of each paid tool will cost, from its validated input: the one place estimates are made (the agent's
 *  tool definitions and the public API's standalone runs both use it). */
export const ESTIMATES = {
  gpt_image_2: (input: { quality: ImageQuality; size: PricedSize | "auto"; n: number }) => gptImage2Estimate(input),
  crop_image: () => CROP_IMAGE_COST,
  merge_videos: (input: { video_urls: readonly unknown[] }) => mergeVideosEstimate(input.video_urls.length),
};

/**
 * Each tool's typical cost, for when there is no input to price yet (a plan's steps) and to tell paid tools from free
 * ones. A real call is estimated from its input (see each tool's `estimate`): GPT Image 2 at its default quality and
 * size (medium, 1024x1024), and a merge of two videos.
 */
export const TOOL_CREDIT_COSTS = {
  load_skill: 0,
  read_skill_asset: 0,
  gpt_image_2: gptImage2Estimate({ quality: "medium", size: "auto", n: 1 }),
  crop_image: CROP_IMAGE_COST,
  merge_videos: mergeVideosEstimate(2),
  propose_plan: 0,
} as const satisfies Record<string, number>;
