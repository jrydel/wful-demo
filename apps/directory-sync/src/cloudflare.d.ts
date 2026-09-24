// The part of the Cloudflare Workflows runtime API this Worker uses
// (https://developers.cloudflare.com/workflows/build/workers-api/).
declare module "cloudflare:workers" {
  export interface WorkflowEvent<Params> {
    readonly payload: Readonly<Params>;
    readonly timestamp: Date;
    readonly instanceId: string;
  }

  export interface WorkflowStepConfig {
    readonly retries?: {
      readonly limit: number;
      readonly delay: string | number;
      readonly backoff?: "constant" | "linear" | "exponential";
    };
    readonly timeout?: string | number;
  }

  export interface WorkflowStep {
    do<T>(name: string, callback: () => Promise<T>): Promise<T>;
    do<T>(name: string, config: WorkflowStepConfig, callback: () => Promise<T>): Promise<T>;
  }

  export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected readonly env: Env;
    constructor(ctx: unknown, env: Env);
    abstract run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown>;
  }
}

declare module "cloudflare:workflows" {
  /** Fails the step without further retries. */
  export class NonRetryableError extends Error {
    constructor(message: string, name?: string);
  }
}
