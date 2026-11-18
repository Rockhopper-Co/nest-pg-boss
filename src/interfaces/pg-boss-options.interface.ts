import type { ConstructorOptions, Queue } from "pg-boss";

// TODO: Figure at "name", "application_name", "instanceName"

/**
 * pg-boss's own `ConstructorOptions`, plus the keys below, which belong to
 * this module and are removed before `new PgBoss(...)`.
 */
export type PGBossModuleOptions = {
  /**
   * Number of times to retry connecting
   * Default: 10
   */
  retryAttempts?: number;
  /**
   * Delay between CONNECTION retry attempts, in milliseconds.
   * Default: 3000
   *
   * Not a job retry: a job's retry delay is the queue option `retryDelay`, in
   * seconds, set through `queueDefaults` or `createJob(name, options)`.
   */
  retryDelay?: number;
  /**
   * Function that determines whether the module should
   * attempt to connect upon failure.
   *
   * @param err error that was thrown
   * @returns whether to retry connection or not
   */
  toRetry?: (err: any) => boolean;
  /**
   * If `true`, will show verbose error messages on each connection retry.
   */
  verboseRetryLog?: boolean;
  /**
   * Queue options every queue is created with, under each job's own options
   * from `createJob(name, options)`, which win key by key.
   */
  queueDefaults?: Omit<Queue, "name">;
} & ConstructorOptions;
