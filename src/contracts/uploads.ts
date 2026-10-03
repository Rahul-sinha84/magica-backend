import { z } from "zod";
import { IsoDateTimeSchema, NO_NUL_MESSAGE, noNul } from "./common.js";
import { MediaAssetSchema } from "./media.js";

// Direct uploads go through Transloadit (Community plan). The backend owns these limits; the frontend checks against
// the same numbers so a bad file is refused before it is sent, and the server checks again (it never trusts the client).

/** Files one message may carry. */
export const MAX_ATTACHMENTS = 10;
/** Transloadit's Community-plan cap per file (0.5 GB, counted in decimal bytes to stay under it). */
export const MAX_UPLOAD_BYTES = 500_000_000;
/** The Community plan's monthly allowance, shared by the whole app. */
export const MONTHLY_UPLOAD_BYTES = 5_000_000_000;
/** Transloadit deletes its copies after 24 hours; a file counts as expired an hour earlier, so a link never dies mid-turn. */
export const UPLOAD_LIFETIME_MS = 23 * 60 * 60 * 1000;

// The image, video and audio types magica.com accepts, each with the file extensions that may carry it. Browsers name
// some types differently (a .wav is audio/wav in one, audio/x-wav in another), so each spelling is listed.
export const UPLOAD_TYPES = {
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
  "image/heic": ["heic"],
  "image/apng": ["apng", "png"],
  "video/mp4": ["mp4"],
  "video/quicktime": ["mov"],
  "video/webm": ["webm"],
  "audio/mpeg": ["mp3"],
  "audio/wav": ["wav"],
  "audio/x-wav": ["wav"],
  "audio/wave": ["wav"],
  "audio/mp4": ["m4a"],
  "audio/x-m4a": ["m4a"],
} as const satisfies Record<string, readonly string[]>;
export type UploadMimeType = keyof typeof UPLOAD_TYPES;

const extensionOf = (name: string) => /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";

// What the user calls the file, cleaned up: control characters (including NUL) are removed rather than refused, since
// they're invisible and come from odd file systems; what's left must be a real name of reasonable length.
const FileNameSchema = z
  .string()
  .max(1000)
  .transform((name) => name.replace(/\p{Cc}/gu, "").trim())
  .pipe(z.string().min(1, { error: "The file needs a name." }).max(255, { error: "File names can be at most 255 characters." }).refine(noNul, { error: NO_NUL_MESSAGE }));

export const UploadFileSchema = z
  .strictObject({
    name: FileNameSchema,
    size: z
      .number()
      .int()
      .min(1, { error: "This file is empty." })
      .max(MAX_UPLOAD_BYTES, { error: "Files can be at most 500 MB." }),
    // compared without case or parameters ("Audio/WAV; codecs=1" is audio/wav)
    mimeType: z.preprocess(
      (type) => (typeof type === "string" ? type.split(";")[0]?.trim().toLowerCase() : type),
      z.enum(Object.keys(UPLOAD_TYPES) as [UploadMimeType, ...UploadMimeType[]], { error: "Only images, videos and audio can be attached." }),
    ),
  })
  .refine((file) => (UPLOAD_TYPES[file.mimeType] as readonly string[]).includes(extensionOf(file.name)), {
    path: ["name"],
    error: "This file's name doesn't match its type.",
  });

export const CreateUploadsBodySchema = z.strictObject({
  files: z
    .array(UploadFileSchema)
    .min(1, { error: "Choose at least one file." })
    .max(MAX_ATTACHMENTS, { error: `A message can carry at most ${MAX_ATTACHMENTS} files.` }),
});

// One signed Transloadit assembly per file, in the order the files were given. `params` is the exact JSON string that
// was signed and must be sent to Transloadit unchanged (Uppy's `assemblyOptions` accepts it as a string).
export const CreateUploadsResponseSchema = z.object({
  uploads: z.array(
    z.object({
      uploadId: z.string(),
      params: z.string(),
      signature: z.string(),
      // after this the signature is refused and the upload must be signed again
      expiresAt: IsoDateTimeSchema,
    }),
  ),
});

// The browser says which Transloadit assembly carried an upload once it finished; the server checks it with Transloadit.
export const CompleteUploadBodySchema = z.strictObject({
  assemblyId: z.string().regex(/^[0-9a-f]{32}$/, { error: "That isn't an upload id from the upload service." }),
});

// Where an upload stands. `pending`: Transloadit is still working (ask again shortly). `completed`: the file is in the
// library (`asset`). `failed`: it can't be used (`errorMessage` says why, safe to show).
export const UploadResultSchema = z.object({
  upload: z.object({
    id: z.string(),
    status: z.enum(["pending", "completed", "failed"]),
    errorMessage: z.string().nullable(),
    asset: MediaAssetSchema.nullable(),
  }),
});

export type UploadFile = z.infer<typeof UploadFileSchema>;
export type CreateUploadsBody = z.infer<typeof CreateUploadsBodySchema>;
export type CreateUploadsResponse = z.infer<typeof CreateUploadsResponseSchema>;
export type UploadResult = z.infer<typeof UploadResultSchema>;
