import {
  DynamicModule,
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { MetadataScanner, ModuleRef } from "@nestjs/core";
import { PgBoss } from "pg-boss";
import { defer, lastValueFrom } from "rxjs";
import { handleRetry } from "./utils";
import { PGBossJobModule } from "./pg-boss-job.module";
import { HandlerScannerService } from "./handler-scanner.service";
import { PGBossModuleOptions } from "./interfaces/pg-boss-options.interface";
import { Job, JobService } from "./job.service";
import { PG_BOSS_INSTANCE } from "./pg-boss.constants";
import {
  ASYNC_OPTIONS_TYPE,
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN,
  OPTIONS_TYPE,
} from "./pg-boss.module-definition";

@Global()
@Module({
  providers: [MetadataScanner, HandlerScannerService],
})
export class PGBossModule
  extends ConfigurableModuleClass
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(this.constructor.name);
  private instance: PgBoss;

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly handlerScannerService: HandlerScannerService,
    @Optional()
    @Inject(MODULE_OPTIONS_TOKEN)
    private readonly options?: PGBossModuleOptions,
  ) {
    super();
  }

  static forRoot(options: typeof OPTIONS_TYPE): DynamicModule {
    const instanceProvider = {
      provide: PG_BOSS_INSTANCE,
      useFactory: async () => await this.createInstanceFactory(options),
    };

    const dynamicModule = super.forRoot(options);
    if (!dynamicModule.providers) {
      dynamicModule.providers = [];
    }
    dynamicModule.providers.push(instanceProvider);
    dynamicModule.exports ||= [];
    dynamicModule.exports.push(instanceProvider);

    return dynamicModule;
  }

  static forRootAsync(options: ASYNC_OPTIONS_TYPE): DynamicModule {
    const instanceProvider = {
      provide: PG_BOSS_INSTANCE,
      useFactory: async (pgBossModuleOptions: PGBossModuleOptions) => {
        if (options.application_name) {
          return await this.createInstanceFactory({
            ...pgBossModuleOptions,
            application_name: options.application_name,
          });
        }
        return await this.createInstanceFactory(pgBossModuleOptions);
      },
      inject: [MODULE_OPTIONS_TOKEN],
    };

    const dynamicModule = super.forRootAsync(options);
    if (!dynamicModule.providers) {
      dynamicModule.providers = [];
    }
    dynamicModule.providers.push(instanceProvider);
    if (!dynamicModule.exports) {
      dynamicModule.exports = [];
    }
    dynamicModule.exports.push(instanceProvider);

    return dynamicModule;
  }

  /**
   * The retry keys drive this module's connection retry and `queueDefaults`
   * feeds `createQueue`; none of them is a pg-boss constructor option, so
   * pg-boss receives everything else and nothing of these.
   */
  private static async createInstanceFactory(options: PGBossModuleOptions) {
    const {
      retryAttempts,
      retryDelay,
      verboseRetryLog,
      toRetry,
      queueDefaults, // eslint-disable-line @typescript-eslint/no-unused-vars -- removed, read in onModuleInit
      ...constructorOptions
    } = options;
    const pgBoss = await lastValueFrom(
      defer(async () => new PgBoss(constructorOptions).start()).pipe(
        handleRetry(retryAttempts, retryDelay, verboseRetryLog, toRetry),
      ),
    );

    return pgBoss;
  }

  static forJobs(jobs: Job[]) {
    return {
      module: PGBossJobModule,
      providers: jobs.map((job) => job.ServiceProvider),
      exports: jobs.map((job) => job.ServiceProvider.provide),
    };
  }

  /**
   * Creates every registered queue before any `onApplicationBootstrap` hook
   * runs: Nest awaits every `onModuleInit` first, and bootstrap hooks are
   * where workers and crons start and where other providers may send. pg-boss
   * 12 refuses a send to a queue that does not exist (DESIGN D2).
   */
  async onModuleInit(): Promise<void> {
    this.instance = this.moduleRef.get<PgBoss>(PG_BOSS_INSTANCE);
    await this.createQueues();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.setupWorkers();
  }

  async onModuleDestroy(): Promise<void> {
    try {
      if (this.instance) {
        await this.instance.stop();
      }
    } catch (e) {
      this.logger.error(e?.message);
    }
  }

  private async setupWorkers() {
    if (!this.instance) {
      throw new Error(
        "setupWorkers must be called after onApplicationBootstrap",
      );
    }

    const jobHandlers = this.handlerScannerService.getJobHandlers();

    await Promise.all(
      jobHandlers.map(async (handler) => {
        if (handler.metadata.disabled) {
          this.logger.log(
            { jobName: handler.metadata.jobName },
            "Skipped disabled handler",
          );
          return;
        }

        // One `work()` call; pg-boss 12 spawns `localConcurrency` workers.
        const { jobName, workOptions, workers } = handler.metadata;
        const options =
          workers === undefined
            ? workOptions
            : { ...workOptions, localConcurrency: workers };
        const workerID = await this.instance.work(
          jobName,
          options,
          handler.callback,
        );
        this.logger.log({ workerID, jobName, workers }, "Registered Worker");
      }),
    );
  }

  /**
   * One `createQueue` per distinct name, in registration order, each awaited
   * before the next starts: concurrent `create_queue` calls deadlocked the
   * backend at boot (ENG-2053). A failure stops the boot with the queue named,
   * and every job service whose queue was not created rejects its
   * `queueInstance` with the reason.
   */
  private async createQueues(): Promise<void> {
    const byName = new Map<string, JobService<object>[]>();
    for (const service of this.handlerScannerService.getJobServices()) {
      byName.set(service.jobName, [
        ...(byName.get(service.jobName) ?? []),
        service,
      ]);
    }
    const queues = [...byName.entries()];
    const defaults = this.options?.queueDefaults ?? {};

    for (const [index, [name, services]] of queues.entries()) {
      const queueOptions = { ...defaults, ...services[0].queueOptions };
      const first = JSON.stringify(services[0].queueOptions);
      if (services.some((s) => JSON.stringify(s.queueOptions) !== first)) {
        this.logger.warn(
          { jobName: name, queueOptions },
          "Queue registered more than once with different options; created with the first",
        );
      }
      try {
        await this.instance.createQueue(name, queueOptions);
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        const error = new Error(
          `pg-boss could not create queue "${name}": ${reason}`,
          { cause },
        );
        services.forEach((service) => service.markQueueFailed(error));
        for (const [skipped, rest] of queues.slice(index + 1)) {
          const notReached = new Error(
            `pg-boss: queue "${skipped}" was not created because queue "${name}" failed first`,
            { cause: error },
          );
          rest.forEach((service) => service.markQueueFailed(notReached));
        }
        throw error;
      }
      services.forEach((service) => service.markQueueCreated());
      this.logger.log({ jobName: name }, "Created queue");
    }
  }
}
