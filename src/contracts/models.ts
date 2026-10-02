import { z } from "zod";
import { IsoDateTimeSchema } from "./common.js";

// The models the agent can use. Only OpenRouter's free router is allowed (paid models are refused at startup), so
// there is one, chosen for the user; the list shape leaves room for more.
export const ModelInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.literal("openrouter"),
  // always true: the backend refuses to start with anything else
  free: z.literal(true),
  isDefault: z.boolean(),
});

// How the free model has been doing lately, from the turns that ended in the last few minutes:
// - available: answering normally
// - degraded: some recent turns hit rate limits or outages
// - unavailable: the most recent turns all failed because of the model
// - unknown: no recent turns to judge by
export const ModelHealthSchema = z.enum(["available", "degraded", "unavailable", "unknown"]);

export const ModelsResponseSchema = z.object({
  models: z.array(ModelInfoSchema),
  defaultModelId: z.string(),
  status: z.object({
    health: ModelHealthSchema,
    // the free router picks a real model per request; this is the one that answered the latest turn
    lastRoutedModel: z.string().nullable(),
    // why it is unavailable, when there is something specific to say (e.g. the free daily limit is used up); safe to show
    reason: z.string().nullable(),
    checkedAt: IsoDateTimeSchema,
  }),
});

export type ModelInfo = z.infer<typeof ModelInfoSchema>;
export type ModelHealth = z.infer<typeof ModelHealthSchema>;
export type ModelsResponse = z.infer<typeof ModelsResponseSchema>;
