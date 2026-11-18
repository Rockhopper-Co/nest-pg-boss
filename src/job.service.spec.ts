import type { Job, PgBoss } from "pg-boss";
import { createJob, JobService } from "./job.service";

/**
 * ENG-9430 (plan 117 SP02) — `JobService` calls pg-boss 12 with pg-boss 12's
 * signatures and hands back what pg-boss returns.
 *
 * pg-boss 12 takes the queue name as `insert`'s first argument (a job carries
 * no `name`), dropped `includeArchive` from `getJobById` (there is no archive
 * table), added `findJobs`, and answers `cancel` with a `CommandResponse`.
 * Only the pg-boss instance is faked; every call it receives is recorded, and
 * each returned value is a unique object, so `toBe` proves pass-through.
 */

interface LaneJobData {
  fileId: string;
}

const insertResult = ["id-1", "id-2"];
const jobById = { id: "id-1", name: "lane", data: { fileId: "f1" } };
const foundJobs = [jobById];
const cancelResult = { jobs: ["id-1"], requested: 1, affected: 1 };
const unscheduleFailure = new Error("schedule table is locked");

const makeFakeBoss = () => ({
  createQueue: jest.fn(() => Promise.resolve()),
  insert: jest.fn(() => Promise.resolve(insertResult)),
  getJobById: jest.fn(() => Promise.resolve(jobById)),
  findJobs: jest.fn(() => Promise.resolve(foundJobs)),
  cancel: jest.fn(() => Promise.resolve(cancelResult)),
  unschedule: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
});

describe("JobService on pg-boss 12", () => {
  let fakeBoss: ReturnType<typeof makeFakeBoss>;
  let service: JobService<LaneJobData>;

  beforeEach(() => {
    fakeBoss = makeFakeBoss();
    service = new JobService<LaneJobData>(
      "lane",
      fakeBoss as unknown as PgBoss,
    );
  });

  it("insert passes the queue name first and the jobs unchanged, and returns pg-boss's result", async () => {
    const jobs = [{ data: { fileId: "f1" } }, { data: { fileId: "f2" } }];

    const result = await service.insert(jobs);

    expect(fakeBoss.insert).toHaveBeenCalledTimes(1);
    const [name, inserted] = fakeBoss.insert.mock.calls[0] as unknown[];
    expect(name).toBe("lane");
    expect(inserted).toBe(jobs);
    // pg-boss 12's JobInsert has no `name`; the queue is the first argument.
    for (const job of inserted as object[]) {
      expect(job).not.toHaveProperty("name");
    }
    expect(result).toBe(insertResult);
  });

  it("getJobById passes the name, the id and the connection options, never includeArchive", async () => {
    const db = { executeSql: jest.fn(() => Promise.resolve({ rows: [] })) };

    const result = await service.getJobById("id-1", { db });

    expect(fakeBoss.getJobById).toHaveBeenCalledTimes(1);
    const [name, id, options] = fakeBoss.getJobById.mock.calls[0] as unknown[];
    expect(name).toBe("lane");
    expect(id).toBe("id-1");
    expect(options).toEqual({ db });
    expect(options).not.toHaveProperty("includeArchive");
    expect(result).toBe(jobById);
  });

  it("getJobById no longer accepts includeArchive", () => {
    // Type-level: under the pg-boss 10 signature this compiled, so the
    // directive below was unused and ts-jest failed the file.
    const call = () => {
      // @ts-expect-error pg-boss 12 has no archive, so no includeArchive
      return service.getJobById("id-1", { includeArchive: true });
    };
    expect(typeof call).toBe("function");
  });

  it("findJobs passes the name and the options through and returns pg-boss's result", async () => {
    const options = { key: "file-1", queued: true };

    const result = await service.findJobs(options);

    expect(fakeBoss.findJobs).toHaveBeenCalledTimes(1);
    const [name, passed] = fakeBoss.findJobs.mock.calls[0] as unknown[];
    expect(name).toBe("lane");
    expect(passed).toBe(options);
    expect(result).toBe(foundJobs);
  });

  it("cancel returns pg-boss 12's command response, not void", async () => {
    const result = await service.cancel("id-1");

    expect(fakeBoss.cancel).toHaveBeenCalledTimes(1);
    const [name, id] = fakeBoss.cancel.mock.calls[0] as unknown[];
    expect(name).toBe("lane");
    expect(id).toBe("id-1");
    expect(result).toBe(cancelResult);
    expect(result.affected).toBe(1);
  });
});

/**
 * ENG-9431 (plan 117 SP03) — the queue is no longer created by the service.
 * The module creates it at init (see pg-boss.queue-creation.spec.ts); the
 * service carries the queue options `createJob` was given.
 */
describe("JobService and createJob — queue creation, options, names (ENG-9431)", () => {
  it("does not call createQueue when constructed", () => {
    const fakeBoss = makeFakeBoss();
    const service = new JobService<LaneJobData>(
      "lane",
      fakeBoss as unknown as PgBoss,
    );
    // Positive control: the service was built, on this fake.
    expect(service.jobName).toBe("lane");
    expect(service.boss).toBe(fakeBoss);
    expect(fakeBoss.createQueue).toHaveBeenCalledTimes(0);
  });

  it("carries the queue options createJob was given to the service it provides", async () => {
    const boss = makeFakeBoss() as unknown as PgBoss;
    const short = createJob<LaneJobData>("lane", { policy: "short" });
    const plain = createJob<LaneJobData>("plain");

    const shortService = await short.ServiceProvider.useFactory(boss);
    const plainService = await plain.ServiceProvider.useFactory(boss);

    expect(shortService.queueOptions).toEqual({ policy: "short" });
    expect(plainService.queueOptions).toEqual({});
  });

  it.each(["bad name!", "", "lane:1", "semi;colon"])(
    "refuses the queue name %p, naming it",
    (name) => {
      expect(() => createJob(name)).toThrow(
        `Job "${name}": a queue name may contain only letters, digits, underscores, hyphens, periods and forward slashes`,
      );
    },
  );

  it("accepts every character pg-boss 12 accepts in a queue name", () => {
    // Positive control for the refusals above: pg-boss 12.38.2 allows
    // /^[\w.\-/]+$/ (dist/attorney.js:87-89).
    expect(createJob("a/b.c-d_e").ServiceProvider.provide).toBe(
      "JobService(a/b.c-d_e)",
    );
  });

  it("still refuses a handler whose parameter is not the job batch", () => {
    const Lane = createJob<LaneJobData>("typed-lane");
    class Wrong {
      // @ts-expect-error a handler must accept Job<LaneJobData>[]
      @Lane.Handle()
      async handle(jobs: string) {
        return jobs.length;
      }
    }
    class Right {
      @Lane.Handle()
      async handle(jobs: Job<LaneJobData>[]) {
        return jobs.length;
      }
    }
    expect(typeof Wrong).toBe("function");
    expect(typeof Right).toBe("function");
  });
});

/**
 * Outside SP03's listed scope, fixed in the same pull request: `unschedule`
 * neither awaited nor returned pg-boss's promise, so a failure was lost.
 */
describe("JobService.unschedule", () => {
  it("passes the queue name and resolves when pg-boss does", async () => {
    const fakeBoss = makeFakeBoss();
    const service = new JobService<LaneJobData>(
      "lane",
      fakeBoss as unknown as PgBoss,
    );

    await expect(service.unschedule()).resolves.toBeUndefined();
    expect(fakeBoss.unschedule).toHaveBeenCalledTimes(1);
    expect(fakeBoss.unschedule.mock.calls[0][0]).toBe("lane");
  });

  it("rejects with pg-boss's own error instead of losing it", async () => {
    const fakeBoss = makeFakeBoss();
    fakeBoss.unschedule.mockRejectedValueOnce(unscheduleFailure);
    const service = new JobService<LaneJobData>(
      "lane",
      fakeBoss as unknown as PgBoss,
    );

    await expect(service.unschedule()).rejects.toBe(unscheduleFailure);
  });
});
