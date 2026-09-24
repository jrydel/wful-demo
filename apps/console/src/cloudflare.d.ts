// The console's bindings. Declared by hand instead of generated Workers types, which would clash
// with the DOM types the React code needs.
declare module "cloudflare:workers" {
  interface Service {
    fetch(request: Request): Promise<Response>;
  }

  interface R2Bucket {
    get(key: string): Promise<{ text(): Promise<string> } | null>;
    put(
      key: string,
      value: string,
      options?: { httpMetadata?: { contentType?: string } },
    ): Promise<unknown>;
  }

  export const env: {
    readonly DATA: R2Bucket;
    readonly TELEMETRY: Service;
    readonly SYNC: Service;
    readonly LOOKUP: Service;
    readonly SYNC_TOKEN?: string;
    /** Cloudflare API token with Account Analytics: Read, for usage and cost. */
    readonly CF_ANALYTICS_TOKEN?: string;
    /** Reads conversation costs and token usage. */
    readonly ELEVENLABS_API_KEY?: string;
  };
}
