import {
  INestApplication,
  Injectable,
  Module,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Job } from "pg-boss";
import { createJob, JobService } from "./job.service";
import { PG_BOSS_INSTANCE } from "./pg-boss.constants";
import { PGBossModule } from "./pg-boss.module";
import { getJobToken } from "./utils";

/**
 * ENG-9431 (plan 117 SP03, DESIGN D2) — the module creates every registered
 * queue itself, once per name, one at a time, awaited, in `onModuleInit`.
 *
 * pg-boss 12 throws `Queue X does not exist` on a send to a queue that has not
 * been created (12.38.2 `dist/manager.js:1052`), and Nest runs every
 * `onApplicationBootstrap` hook (where crons and workers start) only after
 * every `onModuleInit` hook. So creation in `onModuleInit` means every queue
 * exists before anything can send to it or work it.
 *
 * Only the pg-boss instance is faked. It writes every call into ONE ordered
 * log, and each `createQueue` yields to the event loop between its start and
 * its end, so an overlapping second create would show up as two starts in a
 * row. Order is asserted on that log, never on a call count alone.
 */

interface LaneJobData {
  fileId: string;
}

const QueueA = createJob<LaneJobData>("queue-a");
const QueueB = createJob<LaneJobData>("queue-b", {
  policy: "short",
  retentionSeconds: 60,
});

const makeFakeBoss = (failOn?: string) => {
  const log: string[] = [];
  const created = new Set<string>();
  const createQueue = jest.fn<Promise<void>, [string, object?]>(
    async (name) => {
      log.push(`create:start:${name}`);
      await new Promise((resolve) => setImmediate(resolve));
      if (name === failOn) {
        log.push(`create:fail:${name}`);
        throw new Error("permission denied for schema pgboss");
      }
      created.add(name);
      log.push(`create:end:${name}`);
    },
  );
  const work = jest.fn<Promise<string>, [string, object, unknown]>(
    async (name) => {
      log.push(`work:${name}`);
      return `worker-${name}`;
    },
  );
  // Behaves like pg-boss 12: a send to a queue not yet created throws.
  const send = jest.fn<Promise<string>, [string, object, object]>(
    async (name) => {
      if (!created.has(name)) {
        throw new Error(`Queue ${name} does not exist`);
      }
      log.push(`send:${name}`);
      return "job-id";
    },
  );
  const stop = jest.fn(() => Promise.resolve());
  return { log, boss: { createQueue, work, send, stop } };
};

/** A provider in ANOTHER module that sends from its bootstrap hook. */
@Injectable()
class BootSender implements OnApplicationBootstrap {
  public sent: string | null = null;
  constructor(
    @QueueA.Inject() public readonly queueA: JobService<LaneJobData>,
  ) {}

  async onApplicationBootstrap() {
    this.sent = await this.queueA.send({ fileId: "f1" }, {});
  }
}

// Registers queue-a a second time, the way the backend registers
// `smartsheet-derive` in two modules.
@Module({
  imports: [PGBossModule.forJobs([QueueA])],
  providers: [BootSender],
})
class SenderModule {}

@Injectable()
class Handlers {
  @QueueB.Handle({ batchSize: 2, workers: 4 })
  async handleB(jobs: Job<LaneJobData>[]) {
    return jobs.length;
  }

  @QueueA.Handle({ disabled: true })
  async handleA(jobs: Job<LaneJobData>[]) {
    return jobs.length;
  }
}

const build = async (failOn?: string) => {
  const fake = makeFakeBoss(failOn);
  const moduleRef = await Test.createTestingModule({
    imports: [
      PGBossModule.forRoot({
        connectionString: "postgres://never-connected/eng-9431",
        queueDefaults: { retryLimit: 3, retentionSeconds: 3600 },
      }),
      PGBossModule.forJobs([QueueA, QueueB]),
      SenderModule,
    ],
    providers: [Handlers],
  })
    .overrideProvider(PG_BOSS_INSTANCE)
    .useValue(fake.boss)
    .compile();
  return { fake, app: moduleRef.createNestApplication() };
};

describe("PGBossModule — queue creation (ENG-9431)", () => {
  let app: INestApplication;
  let fake: ReturnType<typeof makeFakeBoss>;

  describe("when every create succeeds", () => {
    beforeEach(async () => {
      ({ app, fake } = await build());
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    it("creates each distinct queue once, in registration order, the second only after the first ended", () => {
      expect(fake.boss.createQueue.mock.calls.map(([name]) => name)).toEqual([
        "queue-a",
        "queue-b",
      ]);
      expect(fake.log.slice(0, 4)).toEqual([
        "create:start:queue-a",
        "create:end:queue-a",
        "create:start:queue-b",
        "create:end:queue-b",
      ]);
    });

    it("registered queue-a twice, as two job services, and still created it once", () => {
      // Positive control for the line above: there really are two services.
      const rootA = app.get<JobService<LaneJobData>>(getJobToken("queue-a"));
      const senderA = app.get(BootSender).queueA;
      expect(senderA).not.toBe(rootA);
      expect(senderA.jobName).toBe("queue-a");
      expect(
        fake.boss.createQueue.mock.calls.filter(([n]) => n === "queue-a"),
      ).toHaveLength(1);
    });

    it("merges the module's queueDefaults under each job's own queue options", () => {
      const options = new Map(fake.boss.createQueue.mock.calls);
      expect(options.get("queue-a")).toEqual({
        retryLimit: 3,
        retentionSeconds: 3600,
      });
      expect(options.get("queue-b")).toEqual({
        retryLimit: 3,
        retentionSeconds: 60,
        policy: "short",
      });
    });

    it("calls work() only after the last createQueue resolved", () => {
      const firstWork = fake.log.findIndex((e) => e.startsWith("work:"));
      expect(fake.log[firstWork]).toBe("work:queue-b");
      expect(firstWork).toBeGreaterThan(
        fake.log.indexOf("create:end:queue-b"),
      );
    });

    it("lets a provider in another module send from onApplicationBootstrap", () => {
      expect(app.get(BootSender).sent).toBe("job-id");
      expect(fake.log.indexOf("send:queue-a")).toBeGreaterThan(
        fake.log.indexOf("create:end:queue-a"),
      );
    });

    it("resolves queueInstance on every job service of a created queue", async () => {
      const rootA = app.get<JobService<LaneJobData>>(getJobToken("queue-a"));
      const senderA = app.get(BootSender).queueA;
      const rootB = app.get<JobService<LaneJobData>>(getJobToken("queue-b"));
      for (const service of [rootA, senderA, rootB]) {
        await expect(service.queueInstance).resolves.toBeUndefined();
      }
    });
  });

  describe("when a create fails", () => {
    beforeEach(async () => {
      ({ app, fake } = await build("queue-a"));
    });

    it("fails the boot with an error naming the queue, and creates nothing after it", async () => {
      await expect(app.init()).rejects.toThrow(
        /could not create queue "queue-a": permission denied/,
      );
      expect(fake.boss.createQueue.mock.calls.map(([name]) => name)).toEqual([
        "queue-a",
      ]);
      expect(fake.boss.work).not.toHaveBeenCalled();
      await app.close();
    });

    it("rejects queueInstance on the failed queue and on every queue never reached", async () => {
      await expect(app.init()).rejects.toThrow(/queue-a/);
      const rootA = app.get<JobService<LaneJobData>>(getJobToken("queue-a"));
      const rootB = app.get<JobService<LaneJobData>>(getJobToken("queue-b"));
      await expect(rootA.queueInstance).rejects.toThrow(
        /could not create queue "queue-a"/,
      );
      await expect(rootB.queueInstance).rejects.toThrow(
        /queue "queue-b" was not created because queue "queue-a" failed/,
      );
      await app.close();
    });
  });
});
