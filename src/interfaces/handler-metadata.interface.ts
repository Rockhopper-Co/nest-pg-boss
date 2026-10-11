import type { WorkOptions } from "pg-boss";

export interface HandlerMetadata {
  token: string;
  jobName: string;
  workOptions: WorkOptions;
  disabled?: boolean;
  /** How many `work()` loops to register on this queue. Absent means 1. */
  workers?: number;
}
