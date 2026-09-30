import { afterAll, vi } from "vitest";
import { closeServers } from "./http.js";

vi.mock("#src/auth/clerk.js", async () => (await import("./clerkMock.js")).clerkModule);

afterAll(closeServers);
