import { INestApplication, Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as PGBoss from "pg-boss";
import { HandlerScannerService } from "./handler-scanner.service";
import { createJob } from "./job.service";
import { PGBossModule } from "./pg-boss.module";

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
 */

interface LaneJobData {
  fileId: string;
}

const MultiJob = createJob<LaneJobData>("multi-lane");
const SingleJob = createJob<LaneJobData>("single-lane");
const DisabledJob = createJob<LaneJobData>("disabled-lane");

@Injectable()
class LaneHandlers {
  public readonly handled: PGBoss.Job<LaneJobData>[][] = [];

  @MultiJob.Handle({ batchSize: 1, workers: 3 })
  async handleMulti(jobs?: PGBoss.Job<LaneJobData>[]) {
    this.handled.push(jobs ?? []);
  }

  @SingleJob.Handle({ batchSize: 1 })
  async handleSingle(jobs?: PGBoss.Job<LaneJobData>[]) {
    this.handled.push(jobs ?? []);
  }

  @DisabledJob.Handle({ batchSize: 1, workers: 3, disabled: true })
  async handleDisabled(jobs?: PGBoss.Job<LaneJobData>[]) {
    this.handled.push(jobs ?? []);
  }
}

type WorkCall = [string, PGBoss.WorkOptions, PGBoss.WorkHandler<unknown>];

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
        PGBossModule.forJobs([MultiJob, SingleJob, DisabledJob]),
      ],
      providers: [LaneHandlers],
    })
      .overrideProvider(PGBoss)
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
    await callbacks[0]([job] as unknown as PGBoss.Job<unknown>[]);
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

  it.each([0, -1, 1.5, Number.NaN])(
    "refuses workers=%p when the handler is declared, rather than registering no loop",
    (workers) => {
      expect(() => MultiJob.Handle({ batchSize: 1, workers })).toThrow(
        /workers must be a positive integer/,
      );
    },
  );
});
