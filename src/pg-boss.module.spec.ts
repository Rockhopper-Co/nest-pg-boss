import { INestApplication, Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Job, WorkHandler, WorkOptions } from "pg-boss";
import { HandlerScannerService } from "./handler-scanner.service";
import { createJob, JobService } from "./job.service";
import { PG_BOSS_INSTANCE } from "./pg-boss.constants";
import { PGBossModule } from "./pg-boss.module";
import { getJobToken } from "./utils";

/**
 * ENG-7256 — `Handle({ workers })` registers N `work()` loops on one queue.
 *
 * pg-boss 10 has no in-process concurrency option (`teamSize` is gone); the
 * documented way to run jobs from one queue concurrently is to call `work()`
 * several times. Before this, `setupWorkers` called it exactly once per
 * handler, and pg-boss silently ignores option keys it does not know, so a
 * `workers` key reached pg-boss and did nothing.
 *
 * The module, the decorator and the handler scanner are all real here. Only
 * the pg-boss instance is faked, so no database is needed and every `work()`
 * call the module makes is recorded.
 *
 * ENG-9430 (plan 117 SP02): the instance is provided under the string token
 * `PG_BOSS_INSTANCE`, and a handler always receives the batch as `Job[]`.
 */

interface LaneJobData {
  fileId: string;
}

const MultiJob = createJob<LaneJobData>("multi-lane");
const SingleJob = createJob<LaneJobData>("single-lane");
const DisabledJob = createJob<LaneJobData>("disabled-lane");
const PlainJob = createJob<LaneJobData>("plain-lane");

@Injectable()
class LaneHandlers {
  public readonly handled: Job<LaneJobData>[][] = [];

  @MultiJob.Handle({ batchSize: 1, workers: 3 })
  async handleMulti(jobs?: Job<LaneJobData>[]) {
    this.handled.push(jobs ?? []);
  }

  @SingleJob.Handle({ batchSize: 1 })
  async handleSingle(jobs?: Job<LaneJobData>[]) {
    this.handled.push(jobs ?? []);
  }

  @DisabledJob.Handle({ batchSize: 1, workers: 3, disabled: true })
  async handleDisabled(jobs?: Job<LaneJobData>[]) {
    this.handled.push(jobs ?? []);
  }

  // No options at all: pg-boss 12 hands every handler an array. Under the
  // pg-boss 9 typing this decorator demanded a single-job handler and the
  // method below did not compile.
  @PlainJob.Handle()
  async handlePlain(jobs: Job<LaneJobData>[]) {
    this.handled.push(jobs);
  }
}

type WorkCall = [string, WorkOptions, WorkHandler<unknown>];

describe("PGBossModule — Handle({ workers })", () => {
  let app: INestApplication;
  let workerSeq = 0;
  const work = jest.fn<Promise<string>, WorkCall>(() => {
    workerSeq += 1;
    return Promise.resolve(`worker-${workerSeq}`);
  });
  // `createQueue` because `JobService`'s constructor calls it for every job.
  const fakeBoss = {
    work,
    createQueue: jest.fn(() => Promise.resolve()),
    stop: jest.fn(() => Promise.resolve()),
  };

  const callsFor = (jobName: string): WorkCall[] =>
    work.mock.calls.filter(([name]) => name === jobName);

  beforeEach(async () => {
    work.mockClear();
    workerSeq = 0;
    const moduleRef = await Test.createTestingModule({
      imports: [
        PGBossModule.forRoot({
          connectionString: "postgres://never-connected/eng-7256",
        }),
        PGBossModule.forJobs([MultiJob, SingleJob, DisabledJob, PlainJob]),
      ],
      providers: [LaneHandlers],
    })
      .overrideProvider(PG_BOSS_INSTANCE)
      .useValue(fakeBoss)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("registers exactly `workers` loops, each with the work options minus `workers`", () => {
    const calls = callsFor("multi-lane");

    expect(calls).toHaveLength(3);
    for (const [, options] of calls) {
      expect(options).toEqual({ batchSize: 1 });
      expect(options).not.toHaveProperty("workers");
    }
  });

  it("gives every loop the same callback, and that callback is the handler", async () => {
    const callbacks = callsFor("multi-lane").map(([, , callback]) => callback);

    expect(callbacks).toHaveLength(3);
    expect(new Set(callbacks).size).toBe(1);

    // Positive control: the shared callback really is the decorated method.
    const job = { id: "j1", name: "multi-lane", data: { fileId: "f1" } };
    await callbacks[0]([job] as unknown as Job<unknown>[]);
    const handlers = app.get(LaneHandlers);
    expect(handlers.handled).toEqual([[job]]);
  });

  it("registers one loop when `workers` is not given — behaviour unchanged", () => {
    const calls = callsFor("single-lane");

    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ batchSize: 1 });
  });

  it("registers no loop for a disabled handler, however many workers it asks for", () => {
    // Positive control: the scanner FOUND the disabled handler and read its
    // worker count, so the zero below is a skip, not a handler nobody saw.
    const scanned = app
      .get(HandlerScannerService)
      .getJobHandlers()
      .find((handler) => handler.metadata.jobName === "disabled-lane");
    expect(scanned?.metadata).toMatchObject({ disabled: true, workers: 3 });
    expect(scanned?.metadata.workOptions).toEqual({ batchSize: 1 });

    // And the fake is wired: other handlers on the same boss were registered.
    expect(callsFor("single-lane")).toHaveLength(1);
    expect(callsFor("disabled-lane")).toHaveLength(0);
  });

  it("provides the started instance under PG_BOSS_INSTANCE, and every JobService gets that instance", () => {
    // Identity, not "is defined": the fake is the only object that can pass.
    expect(app.get(PG_BOSS_INSTANCE)).toBe(fakeBoss);
    const jobService = app.get<JobService<LaneJobData>>(
      getJobToken("multi-lane"),
    );
    expect(jobService.boss).toBe(fakeBoss);
    expect(jobService.jobName).toBe("multi-lane");
  });

  it("hands a handler declared with no options the batch as an array", async () => {
    const calls = callsFor("plain-lane");
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({});

    const job = { id: "j2", name: "plain-lane", data: { fileId: "f2" } };
    await calls[0][2]([job] as unknown as Job<unknown>[]);
    expect(app.get(LaneHandlers).handled).toEqual([[job]]);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "refuses workers=%p when the handler is declared, rather than registering no loop",
    (workers) => {
      expect(() => MultiJob.Handle({ batchSize: 1, workers })).toThrow(
        /workers must be a positive integer/,
      );
    },
  );
});
