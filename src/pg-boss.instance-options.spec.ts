import type { DynamicModule, FactoryProvider } from "@nestjs/common";
import { PG_BOSS_INSTANCE } from "./pg-boss.constants";
import { PGBossModule } from "./pg-boss.module";

/**
 * ENG-9431 (plan 117 SP03) — `new PgBoss(...)` receives pg-boss's own
 * constructor options and none of this module's keys.
 *
 * `retryAttempts`, `retryDelay`, `toRetry` and `verboseRetryLog` drive this
 * module's CONNECTION retry; `queueDefaults` feeds `createQueue`. Before this,
 * the whole options object went to `new PgBoss`. pg-boss is replaced by a
 * class that records what its constructor was given, so the assertion is on
 * the exact key set, not on the absence of one key.
 */

const mockConstructed: Record<string, unknown>[] = [];

jest.mock("pg-boss", () => ({
  PgBoss: class {
    constructor(options: Record<string, unknown>) {
      mockConstructed.push(options);
    }

    start() {
      return Promise.resolve(this);
    }
  },
}));

const nestOnlyKeys = {
  retryAttempts: 2,
  retryDelay: 10,
  toRetry: () => false,
  verboseRetryLog: true,
  queueDefaults: { retryLimit: 3 },
};

const instanceFactory = (dynamic: DynamicModule) => {
  for (const candidate of dynamic.providers ?? []) {
    const provide = typeof candidate === "object" ? candidate.provide : null;
    if (provide === PG_BOSS_INSTANCE) {
      return (candidate as FactoryProvider).useFactory;
    }
  }
  throw new Error("the module registered no PG_BOSS_INSTANCE provider");
};

describe("PGBossModule — options handed to new PgBoss (ENG-9431)", () => {
  beforeEach(() => {
    mockConstructed.length = 0;
  });

  it("forRoot passes pg-boss only its own keys", async () => {
    const dynamic = PGBossModule.forRoot({
      host: "db.internal",
      ...nestOnlyKeys,
    });

    await instanceFactory(dynamic)();

    expect(mockConstructed).toHaveLength(1);
    expect(Object.keys(mockConstructed[0]).sort()).toEqual(["host"]);
    expect(mockConstructed[0].host).toBe("db.internal");
  });

  it("forRootAsync passes pg-boss only its own keys plus application_name", async () => {
    const dynamic = PGBossModule.forRootAsync({
      application_name: "eng-9431",
      useFactory: () => ({ host: "db.internal", ...nestOnlyKeys }),
    });

    await instanceFactory(dynamic)({ host: "db.internal", ...nestOnlyKeys });

    expect(mockConstructed).toHaveLength(1);
    expect(Object.keys(mockConstructed[0]).sort()).toEqual([
      "application_name",
      "host",
    ]);
    expect(mockConstructed[0]).toMatchObject({
      host: "db.internal",
      application_name: "eng-9431",
    });
  });
});
