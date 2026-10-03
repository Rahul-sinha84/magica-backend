import { afterAll, vi } from "vitest";
import { closeServers } from "./http.js";

vi.mock("#src/auth/clerk.js", async () => (await import("./clerkMock.js")).clerkModule);
vi.mock("#src/lib/trigger.js", async () => (await import("./triggerMock.js")).triggerModule);
// webhook deliveries are handed to Trigger.dev here: recorded instead (tests deliver them themselves)
vi.mock("#src/webhooks/dispatch.js", async () => (await import("./webhookMock.js")).dispatchModule);

afterAll(closeServers);
