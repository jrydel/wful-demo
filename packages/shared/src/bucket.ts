import { Context } from "effect";

/** The part of Cloudflare's R2 bucket binding this project uses. */
export interface BucketObject {
  readonly etag: string;
}
export interface BucketObjectBody extends BucketObject {
  text(): Promise<string>;
}
export interface Bucket {
  head(key: string): Promise<BucketObject | null>;
  get(key: string): Promise<BucketObjectBody | null>;
  put(
    key: string,
    value: string,
    options?: { readonly httpMetadata?: { readonly contentType?: string } },
  ): Promise<unknown>;
}

/** The R2 bucket a Worker reads and writes, from its wrangler binding. */
export class DataBucket extends Context.Service<DataBucket, Bucket>()(
  "doctor-directory/DataBucket",
) {}

/** In-memory stand-in for an R2 bucket, for tests. Each put gets a new ETag, like R2. */
export function memoryBucket(): Bucket {
  const objects = new Map<string, { readonly text: string; readonly etag: string }>();
  let writes = 0;
  return {
    head: async (key) => objects.get(key) ?? null,
    get: async (key) => {
      const object = objects.get(key);
      return object ? { etag: object.etag, text: async () => object.text } : null;
    },
    put: async (key, value) => {
      writes++;
      objects.set(key, { text: value, etag: `etag-${writes}` });
    },
  };
}
