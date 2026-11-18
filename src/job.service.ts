import {
  FactoryProvider,
  Inject,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import type {
  CommandResponse,
  ConnectionOptions,
  FetchOptions,
  FindJobsOptions,
  JobInsert,
  JobWithMetadata,
  PgBoss,
  Queue,
  ScheduleOptions,
  SendOptions,
  WorkHandlerFor,
  WorkOptions,
} from "pg-boss";
import { HandlerMetadata } from "./interfaces/handler-metadata.interface";
import { PG_BOSS_INSTANCE, PG_BOSS_JOB_METADATA } from "./pg-boss.constants";
import { getJobToken } from "./utils";

/** pg-boss 12's queue options: policy, retries, expiry, retention, and so on. */
export type JobQueueOptions = Omit<Queue, "name">;

/** pg-boss 12.38.2 `dist/attorney.js:87-89`, checked here at declaration. */
const QUEUE_NAME_RULE = /^[\w.\-/]+$/;

@Injectable()
export class JobService<JobData extends object> {
  private readonly created: Promise<void>;
  private settle: { resolve: () => void; reject: (error: Error) => void };

  /**
   * The service does not create its queue. `PGBossModule` creates every
   * registered queue in its `onModuleInit`, one at a time, before any
   * `onApplicationBootstrap` hook runs (plan 117 DESIGN D2).
   */
  constructor(
    private readonly name: string,
    private readonly pgBoss: PgBoss,
    private readonly options: JobQueueOptions = {},
  ) {
    this.created = new Promise<void>((resolve, reject) => {
      this.settle = { resolve, reject };
    });
    // A failed creation fails the boot from `onModuleInit`. Without this, a
    // service nobody awaited would also raise an unhandled rejection; a caller
    // that awaits `queueInstance` still receives the rejection.
    this.created.catch(() => undefined);
  }

  /**
   * Resolves once this queue exists; rejects, naming the queue, if it could
   * not be created. Never await it inside an `onModuleInit` hook: the module
   * creates queues in its own `onModuleInit`, which may run after yours.
   */
  get queueInstance(): Promise<void> {
    return this.created;
  }

  /** The queue options from `createJob`, before the module's `queueDefaults`. */
  get queueOptions(): JobQueueOptions {
    return this.options;
  }

  /** Called by `PGBossModule` once it has created this queue. */
  markQueueCreated(): void {
    this.settle.resolve();
  }

  /** Called by `PGBossModule` when this queue was not created. */
  markQueueFailed(error: Error): void {
    this.settle.reject(error);
  }

  get boss() {
    return this.pgBoss;
  }

  get jobName() {
    return this.name;
  }

  async send(data: JobData, options: SendOptions): Promise<string | null> {
    return this.pgBoss.send(this.name, data, options);
  }

  async sendAfter(
    data: JobData,
    options: SendOptions,
    date: Date | string | number,
  ): Promise<string | null> {
    // sendAfter has three overloads for all date variants we accept
    return this.pgBoss.sendAfter(this.name, data, options, date as any);
  }

  async sendThrottled(
    data: JobData,
    options: SendOptions,
    seconds: number,
    key?: string,
  ): Promise<string | null> {
    if (key != undefined) {
      return this.pgBoss.sendThrottled(this.name, data, options, seconds, key);
    }
    return this.pgBoss.sendThrottled(this.name, data, options, seconds);
  }

  async sendDebounced(
    data: JobData,
    options: SendOptions,
    seconds: number,
    key?: string,
  ): Promise<string | null> {
    if (key != undefined) {
      return this.pgBoss.sendDebounced(this.name, data, options, seconds, key);
    }
    return this.pgBoss.sendDebounced(this.name, data, options, seconds);
  }

  /** pg-boss 12 takes the queue name as an argument; a job carries none. */
  async insert(jobs: JobInsert<JobData>[]): Promise<string[] | null> {
    return this.pgBoss.insert(this.name, jobs);
  }

  async schedule(cron: string, data: JobData, options: ScheduleOptions) {
    return this.pgBoss.schedule(this.name, cron, data, options);
  }

  async unschedule(): Promise<void> {
    return this.pgBoss.unschedule(this.name);
  }

  /**
   * pg-boss 12 has no archive table, so there is no `includeArchive`.
   * pg-boss marks this deprecated in favour of `findJobs`; both are here.
   */
  async getJobById(
    id: string,
    options?: ConnectionOptions,
  ): Promise<JobWithMetadata<JobData> | null> {
    return this.pgBoss.getJobById<JobData>(this.name, id, options);
  }

  async findJobs(
    options?: FindJobsOptions,
  ): Promise<JobWithMetadata<JobData>[]> {
    return this.pgBoss.findJobs<JobData>(this.name, options);
  }

  async cancel(
    id: string,
    options?: ConnectionOptions,
  ): Promise<CommandResponse> {
    return this.pgBoss.cancel(this.name, id, options);
  }

  async fetch(
    options: FetchOptions & {
      includeMetadata: true;
    },
  ): Promise<JobWithMetadata<JobData>[]> {
    return this.pgBoss.fetch<JobData>(this.name, options);
  }
}

/**
 * `Method` is the decorated method's own type, constrained to the handler
 * pg-boss demands. A descriptor's type is invariant, so typing it as the
 * handler itself refused any method that is a valid handler without being
 * that exact type, such as one declaring fewer parameters.
 */
interface MethodDecorator<PropertyType> {
  <Class, Method extends PropertyType>(
    target: Class,
    propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<Method>,
  ): TypedPropertyDescriptor<Method>;
}

export interface HandleOptions extends WorkOptions {
  /**
   * When true, this handler won't be registered as a worker.
   * The job will remain in the queue for other workers to handle.
   */
  disabled?: boolean;
  /**
   * How many workers this process runs on this queue. Default 1. The module
   * passes it to pg-boss 12 as `localConcurrency` on ONE `work()` call, which
   * spawns that many workers, each polling independently (plan 117 DESIGN
   * D3). Give this or `localConcurrency`, not both.
   */
  workers?: number;
}

/**
 * pg-boss 12 hands every handler an array of jobs, whatever `batchSize` is.
 * The handler type is pg-boss's own `WorkHandlerFor`, resolved from the
 * options as written, so `includeMetadata: true` or `perJobResults: true`
 * demand the handler pg-boss would demand from `work()`.
 */
interface HandleDecorator<JobData extends object> {
  <Options extends HandleOptions>(
    options?: Options,
  ): MethodDecorator<WorkHandlerFor<Options, JobData>>;
}

export interface Job<JobData extends object = any> {
  ServiceProvider: FactoryProvider<JobService<JobData>>;
  Inject: () => ParameterDecorator;
  Handle: HandleDecorator<JobData>;
}

/**
 * `queueOptions` reach `createQueue` merged over the module's `queueDefaults`.
 * The name is checked here, at declaration, against the rule pg-boss 12
 * applies, so a bad name fails where it is written, not at boot.
 */
export const createJob = <JobData extends object>(
  name: string,
  queueOptions: JobQueueOptions = {},
): Job<JobData> => {
  if (!QUEUE_NAME_RULE.test(name)) {
    throw new Error(
      `Job "${name}": a queue name may contain only letters, digits, underscores, hyphens, periods and forward slashes`,
    );
  }
  const token = getJobToken(name);

  return {
    ServiceProvider: {
      provide: token,
      useFactory: (pgBoss: PgBoss) =>
        new JobService<JobData>(name, pgBoss, queueOptions),
      inject: [PG_BOSS_INSTANCE],
    },
    Inject: () => Inject(token),
    Handle: (options: HandleOptions = {}) => {
      const { disabled, workers, ...workOptions } = options;
      // Refused here, at declaration, because a count that starts no worker
      // would leave the queue silently unserved. `disabled` is the way to
      // register none.
      if (
        workers !== undefined &&
        !(Number.isInteger(workers) && workers >= 1)
      ) {
        throw new Error(
          `Job "${name}": workers must be a positive integer, got ${workers}`,
        );
      }
      if (workers !== undefined && workOptions.localConcurrency !== undefined) {
        throw new Error(
          `Job "${name}": give workers or localConcurrency, not both`,
        );
      }
      return SetMetadata<string, HandlerMetadata>(PG_BOSS_JOB_METADATA, {
        token,
        jobName: name,
        workOptions,
        disabled,
        workers,
      });
    },
  };
};
