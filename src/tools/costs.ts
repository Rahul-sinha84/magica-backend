// What one successful call of each tool costs, in app credits (the UI shows millions as "M"). Kept in one place so
// prices can change without touching the tools. Model calls themselves cost nothing (the free router is free).
export const TOOL_CREDIT_COSTS = {
  load_skill: 0,
  read_skill_asset: 0,
  gpt_image_2: 1_000_000,
  crop_image: 200_000,
  merge_videos: 500_000,
} as const satisfies Record<string, number>;
