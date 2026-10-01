import { createMagicaClient, MagicaError } from "../src/lib/magica.js";
import { callMagicaTool, cropImageTool, gptImage2Tool, mergeVideosTool } from "../src/tools/magicaTools.js";
import type { ToolDefinition } from "../src/tools/registry.js";

// Runs each Magica tool once against the real API, through the same code the agent's child task uses (live schema
// check, start, adaptive polling, output mapping): `pnpm magica:try`. Uses the cheapest settings and real credits
// (well under 0.1 of a trial balance). Reads MAGICA_API_KEY and MAGICA_BASE_URL from .env.local.

const { MAGICA_API_KEY: apiKey, MAGICA_BASE_URL: baseUrl } = process.env;
if (!apiKey || !baseUrl) {
  console.error("Set MAGICA_API_KEY and MAGICA_BASE_URL in .env.local");
  process.exit(2);
}
const client = createMagicaClient({ baseUrl, apiKey });
const SAMPLE_VIDEOS = [
  "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4",
  "https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4",
];

async function attempt(label: string, tool: ToolDefinition, rawInput: unknown): Promise<unknown> {
  const input = tool.input.parse(rawInput);
  const started = Date.now();
  process.stdout.write(`… ${label}`);
  try {
    const { output, run } = await callMagicaTool(tool, input, client, { onStatus: (r) => void process.stdout.write(` ${r.status.toLowerCase()}`) });
    const checked = tool.output.parse(output);
    console.log(`\n✔ ${label} in ${Math.round((Date.now() - started) / 1000)} s, Magica credits used: ${run.creditUsed ?? "?"}`);
    console.log(`  ${JSON.stringify(checked)}`);
    return checked;
  } catch (error) {
    console.log(`\n✘ ${label}: ${error instanceof MagicaError ? `${error.message} (${error.failure})` : String(error)}`);
    process.exitCode = 1;
    return null;
  }
}

const generated = (await attempt("GPT Image 2 (text, low quality)", gptImage2Tool, { mode: "text", prompt: "A small red fox sitting in fresh snow, simple flat illustration", quality: "low", size: "1024x1024" })) as { images: { url: string }[] } | null;
const image = generated?.images[0]?.url;
if (image) {
  await attempt("GPT Image 2 (edit, low quality)", gptImage2Tool, { mode: "edit", prompt: "Make it night time with stars", image_urls: [image], quality: "low", size: "1024x1024" });
  await attempt("Crop Image (top half)", cropImageTool, { image_url: image, crop: { x: 0, y: 0, width: 100, height: 50 } });
}
await attempt("Merge Videos (two 10 s clips)", mergeVideosTool, { video_urls: SAMPLE_VIDEOS, transition: "none" });
