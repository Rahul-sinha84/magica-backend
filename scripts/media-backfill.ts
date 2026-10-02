import { prisma } from "../src/db/client.js";
import { addGeneratedMedia } from "../src/services/media.js";
import { agentTools } from "../src/tools/index.js";

// One-off: adds media the agent generated before the media library existed (completed Magica tool calls with no
// library entry yet) to their owners' libraries: `pnpm media:backfill`. Each call's media comes from its tool's own
// `assets` mapping, exactly as a new completion records it. Safe to run again: calls that already have entries are
// skipped. Reads DATABASE_URL from .env.local (or the environment, e.g. to run it against production once).

const calls = await prisma.toolInvocation.findMany({
  where: { status: "COMPLETED", mediaAssets: { none: {} }, toolName: { in: ["gpt_image_2", "crop_image", "merge_videos"] } },
  select: { id: true, toolName: true, input: true, output: true },
  orderBy: { completedAt: "asc" },
});

let added = 0;
let skipped = 0;
for (const call of calls) {
  const tool = agentTools.get(call.toolName);
  const output = tool?.output.safeParse(call.output);
  if (!tool?.assets || !output?.success) {
    skipped++;
    continue;
  }
  const input = tool.input.safeParse(call.input);
  const assets = tool.assets(output.data, input.success ? input.data : undefined);
  added += await prisma.$transaction((tx) => addGeneratedMedia(tx, call.id, assets));
}
console.log(`${calls.length} completed tool calls without library entries: ${added} media added, ${skipped} skipped (unreadable output).`);
await prisma.$disconnect();
