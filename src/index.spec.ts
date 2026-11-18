import {
  createJob,
  getJobToken,
  HandlerMetadata,
  PG_BOSS_INSTANCE,
  PG_BOSS_JOB_METADATA,
} from ".";

/**
 * ENG-9430 (plan 117 SP02, DESIGN D6) — the package root exports the job
 * token helper, the handler metadata key and type, and the instance token.
 * The backend reads the first two today by deep-requiring `dist/` files; the
 * strings must stay byte-identical so those readers keep matching.
 */
describe("package exports", () => {
  it("exports getJobToken, and it builds the same token createJob provides", () => {
    expect(getJobToken("x")).toBe("JobService(x)");
    // Positive control: the token a real job registers under is this one.
    expect(createJob("x").ServiceProvider.provide).toBe(getJobToken("x"));
  });

  it("exports the metadata key and the instance token with their exact values", () => {
    expect(PG_BOSS_JOB_METADATA).toBe("PG_BOSS_JOB_METADATA");
    expect(PG_BOSS_INSTANCE).toBe("PG_BOSS_INSTANCE");
  });

  it("exports HandlerMetadata, the shape Handle() records", () => {
    const Lane = createJob<{ fileId: string }>("lane");
    class Handlers {
      @Lane.Handle({ batchSize: 2, workers: 2 })
      async handle() {}
    }
    const recorded: HandlerMetadata = Reflect.getMetadata(
      PG_BOSS_JOB_METADATA,
      Handlers.prototype.handle,
    );
    expect(recorded).toEqual({
      token: "JobService(lane)",
      jobName: "lane",
      workOptions: { batchSize: 2 },
      disabled: undefined,
      workers: 2,
    });
  });
});
