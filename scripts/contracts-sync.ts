import { join, resolve } from "node:path";
import { assertFrontendRepo, syncContracts } from "./lib/syncContracts.js";

// Pushes src/contracts into the frontend repo: `pnpm contracts:sync` (FRONTEND_REPO_PATH overrides the default).
// Paths come from this file's location, so it behaves the same whatever directory it is started from.
const backend = resolve(import.meta.dirname, "..");

try {
  const frontend = assertFrontendRepo(resolve(process.env.FRONTEND_REPO_PATH ?? join(backend, "../magica-frontend")), backend);
  const { changed, removed, lock } = syncContracts({
    sourceDir: join(backend, "src/contracts"),
    destDir: join(frontend, "contracts"),
    lockFile: join(frontend, "contracts.lock.json"),
  });

  for (const file of changed) console.log(`updated  ${file}`);
  for (const file of removed) console.log(`removed  ${file}`);
  console.log(`${Object.keys(lock).length} contract files in sync (${changed.length} changed) -> ${frontend}`);
  console.log("Next, in the frontend repo: pnpm contracts:check");
} catch (error) {
  console.error(`contracts:sync failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Set FRONTEND_REPO_PATH to the magica-frontend checkout if it is not next to this repo.");
  process.exit(1);
}
