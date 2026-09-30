import { afterAll, vi } from "vitest";
import { closeServers } from "./http.js";

vi.mock("#src/auth/clerk.js", async () => (await import("./clerkMock.js")).clerkModule);
vi.mock("#src/lib/trigger.js", async () => (await import("./triggerMock.js")).triggerModule);

afterAll(closeServers);
