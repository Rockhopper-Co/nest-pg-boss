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
  ScheduleOptions,
  SendOptions,
  WorkHandlerFor,
  WorkOptions,
} from "pg-boss";
import { HandlerMetadata } from "./interfaces/handler-metadata.interface";
import { PG_BOSS_INSTANCE, PG_BOSS_JOB_METADATA } from "./pg-boss.constants";
import { getJobToken } from "./utils";

@Injectable()
export class JobService<JobData extends object> {
  private readonly queue: any;
  constructor(
    private readonly name: string,
    private readonly pgBoss: PgBoss,
  ) {
    this.queue = pgBoss.createQueue(name);
  }

  get queueInstance() {
    return this.queue;
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

  async unschedule() {
    this.pgBoss.unschedule(this.name);
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

interface MethodDecorator<PropertyType> {
  <Class>(
    target: Class,
    propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<PropertyType>,
  ): TypedPropertyDescriptor<PropertyType>;
}

export interface HandleOptions extends WorkOptions {
  /**
   * When true, this handler won't be registered as a worker.
   * The job will remain in the queue for other workers to handle.
   */
  disabled?: boolean;
  /**
   * How many `work()` loops to register on this queue, all with the same
   * options and the same handler. Default 1. pg-boss 10 has no in-process
   * concurrency option; calling `work()` several times is how one process
   * handles several jobs from one queue at once. Never passed to pg-boss.
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

export const createJob = <JobData extends object>(
  name: string,
): Job<JobData> => {
  const token = getJobToken(name);

  return {
    ServiceProvider: {
      provide: token,
      useFactory: (pgBoss: PgBoss) => new JobService<JobData>(name, pgBoss),
      inject: [PG_BOSS_INSTANCE],
    },
    Inject: () => Inject(token),
    Handle: (options: HandleOptions = {}) => {
      const { disabled, workers, ...workOptions } = options;
      // Refused here, at declaration, because a count that registers no loop
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
