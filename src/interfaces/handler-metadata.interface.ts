import type { WorkOptions } from "pg-boss";

export interface HandlerMetadata {
  token: string;
  jobName: string;
  workOptions: WorkOptions;
  disabled?: boolean;
  /**
   * How many workers this process runs on this queue, passed to pg-boss as
   * `localConcurrency` on one `work()` call. Absent means pg-boss's default, 1.
   */
  workers?: number;
}
