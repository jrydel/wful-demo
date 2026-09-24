/**
 * Operator switches stored as one small R2 object in the data bucket. The console writes them;
 * doctor-lookup reads them. Plain types, so the console needs no Effect for this.
 */
export const CONTROL_KEY = "control/flags.json";

export interface ControlFlags {
  /** Answer every lookup as if the data were unreachable, to rehearse escalations. */
  readonly simulateOutage: boolean;
  /** ISO time of the last change. */
  readonly changedAt: string;
}

export const DEFAULT_FLAGS: ControlFlags = { simulateOutage: false, changedAt: "" };
