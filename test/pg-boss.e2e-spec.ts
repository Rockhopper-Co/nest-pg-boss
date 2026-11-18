import { INestApplication, Injectable } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import type { Job, PgBoss } from "pg-boss";
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { JobService, PG_BOSS_INSTANCE, PGBossModule, createJob } from "../src";

/**
 * ENG-9432 (plan 117 SP04) — the module against a real pg-boss 12 database.
 *
 * Two jobs: one registered with no queue options, which therefore gets the
 * module's `queueDefaults` alone, and one with its own options, which win key
 * by key. The second handler asks for two workers. One job is sent to each
 * queue, and each handler must receive exactly that job's `data`. pg-boss 12
 * hands every handler an ARRAY of jobs, so a handler reading `job.data` off
 * the argument records `undefined` and the by-value assertion fails.
 *
 * This suite runs in the publish job, after the unit specs and before
 * `npm publish` (DESIGN D11), so a wrapper that cannot boot, create queues or
 * deliver a job against a real database is never published.
 */

interface SingleData {
  kind: "single";
  n: number;
}

interface PairData {
  kind: "pair";
  tags: string[];
}

const SingleJob = createJob<SingleData>("e2e-single");
const PairJob = createJob<PairData>("e2e-pair", { retryLimit: 1 });

const queueDefaults = { retryLimit: 4, retryDelay: 7 };

const singleSent: SingleData = { kind: "single", n: 41 };
const pairSent: PairData = { kind: "pair", tags: ["a", "b"] };

@Injectable()
class Handlers {
  public readonly single: SingleData[] = [];
  public readonly pair: PairData[] = [];

  constructor(
    @SingleJob.Inject()
    readonly singleJobs: JobService<SingleData>,
    @PairJob.Inject()
    readonly pairJobs: JobService<PairData>,
  ) {}

  @SingleJob.Handle()
  async handleSingle(jobs: Job<SingleData>[]) {
    this.single.push(...jobs.map((job) => job.data));
  }

  @PairJob.Handle({ workers: 2 })
  async handlePair(jobs: Job<PairData>[]) {
    this.pair.push(...jobs.map((job) => job.data));
  }

  received(): boolean {
    return this.single.length > 0 && this.pair.length > 0;
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls until `done()` holds or 30 seconds pass; the caller asserts after. */
const waitFor = async (done: () => boolean) => {
  const deadline = Date.now() + 30_000;
  while (!done() && Date.now() < deadline) {
    await sleep(250);
  }
};

describe("PGBossModule on pg-boss 12 (e2e)", () => {
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;
  let handlers: Handlers;
  let boss: PgBoss;

  beforeAll(async () => {
    // Production runs PostgreSQL 14 (14.22); pg-boss 12 needs 13 or later.
    postgres = await new PostgreSqlContainer("postgres:14-alpine").start();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PGBossModule.forRoot({
          host: postgres.getHost(),
          port: postgres.getPort(),
          database: postgres.getDatabase(),
          user: postgres.getUsername(),
          password: postgres.getPassword(),
          queueDefaults,
        }),
        PGBossModule.forJobs([SingleJob, PairJob]),
      ],
      providers: [Handlers],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    handlers = app.get(Handlers);
    boss = app.get<PgBoss>(PG_BOSS_INSTANCE);
  }, 120_000);

  afterAll(async () => {
    // pg-boss 12's `stop()` (called from the module's `onModuleDestroy`)
    // awaits its workers and closes its pool, so the database can stop next.
    if (app) {
      await app.close();
    }
    if (postgres) {
      await postgres.stop();
    }
  });

  it("creates both queues at boot, with queueDefaults under each job's own options", async () => {
    await handlers.singleJobs.queueInstance;
    await handlers.pairJobs.queueInstance;

    const single = await boss.getQueue("e2e-single");
    const pair = await boss.getQueue("e2e-pair");

    expect(single).toMatchObject({
      name: "e2e-single",
      retryLimit: 4,
      retryDelay: 7,
    });
    // The job's own `retryLimit` wins; the default `retryDelay` still applies.
    expect(pair).toMatchObject({
      name: "e2e-pair",
      retryLimit: 1,
      retryDelay: 7,
    });
  });

  it("runs Handle({ workers: 2 }) as two workers from one work() call", () => {
    const wip = boss.getWipData();
    const pairWorkers = wip.filter((w) => w.name === "e2e-pair");
    const singleWorkers = wip.filter((w) => w.name === "e2e-single");

    expect(pairWorkers).toHaveLength(2);
    // One `work()` call: every worker it spawned shares the first one's id.
    expect(new Set(pairWorkers.map((w) => w.workId)).size).toBe(1);
    // Control: a handler without `workers` gets pg-boss's default, one.
    expect(singleWorkers).toHaveLength(1);
  });

  it("delivers each job's data, by value, to its own handler", async () => {
    const singleId = await handlers.singleJobs.send(singleSent, {});
    const pairId = await handlers.pairJobs.send(pairSent, {});

    // Both sends landed: pg-boss returns an id, or null when it refused.
    expect(singleId).toEqual(expect.any(String));
    expect(pairId).toEqual(expect.any(String));

    await waitFor(() => handlers.received());

    expect(handlers.single).toEqual([singleSent]);
    expect(handlers.pair).toEqual([pairSent]);
  });
});
