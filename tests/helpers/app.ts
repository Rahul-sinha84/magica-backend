import { createApp } from "#src/app.js";
import { api } from "./http.js";

export const app = createApp();

/** Requests made as a signed-in test user (see clerkMock.ts). */
export function as(userId: string) {
  const auth = `Bearer test:${userId}`;
  return {
    get: (path: string) => api(app).get(path).set("Authorization", auth),
    post: (path: string) => api(app).post(path).set("Authorization", auth),
    patch: (path: string) => api(app).patch(path).set("Authorization", auth),
    delete: (path: string) => api(app).delete(path).set("Authorization", auth),
  };
}

/** Requests with no credentials at all. */
export const anonymous = () => api(app);
