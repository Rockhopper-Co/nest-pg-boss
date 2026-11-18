# `@rockhopper-co/nest-pg-boss`

<p align="center">
    Use <a href="https://github.com/timgit/pg-boss" target="_blank">pg-boss</a> in your Nest.js service!
<p align="center">

A fork of [`@apricote/nest-pg-boss`](https://github.com/apricote/nest-pg-boss),
published to GitHub Packages. Version 3 runs on pg-boss 12; the 2.2.x line
stays published for pg-boss 10. Every breaking change is in the
[CHANGELOG](CHANGELOG.md).

## Installation

Requires Node 26.12 or later and pg-boss 12.38.2 or later. pg-boss 12 needs
PostgreSQL 13 or later.

The package is on GitHub Packages, so point the scope at it in `.npmrc`:

```
@rockhopper-co:registry=https://npm.pkg.github.com
```

Then install it with its peers. `@opentelemetry/api` is a peer of pg-boss 12,
so it must be installed beside it:

```bash
npm install @rockhopper-co/nest-pg-boss pg-boss @opentelemetry/api
```

## Usage

### Setup

To begin using `@rockhopper-co/nest-pg-boss`, initialize the root module:

```ts
import { PGBossModule } from "@rockhopper-co/nest-pg-boss";

// app.module.ts
@Module({
  imports: [
    PGBossModule.forRootAsync({
      application_name: "default",
      useFactory: (config: ConfigService) => ({
        // Connection details
        host: config.get<string>("DB_HOST"),
        user: config.get<string>("DB_USERNAME"),
        password: config.get<string>("DB_PASSWORD"),
        database: config.get<string>("DB_DATABASE"),
        schema: "public",
        max: config.get<number>("DB_POOL_MAX"),
        // Options every queue is created with (see "Jobs" below).
        queueDefaults: { retryLimit: 3, retryDelay: 30 },
      }),
      inject: [ConfigService],
    }),
  ],
})
export class AppModule {}
```

Every key except the five below goes to `new PgBoss(...)` unchanged; for those,
check the [pg-boss constructor docs](https://pgboss.io/api/constructor). These
five belong to this module and are removed first:

| Key | Meaning |
|---|---|
| `retryAttempts` | How many times to try CONNECTING at start. Default 9. |
| `retryDelay` | Milliseconds between those connection attempts. Default 3000. |
| `toRetry` | `(err) => boolean`: whether a failed connection attempt is retried. |
| `verboseRetryLog` | Log each connection error's message on retry. |
| `queueDefaults` | pg-boss queue options every queue is created with. |

**`retryDelay` here is not a job retry.** The module option is the delay
between connection attempts at start, in milliseconds. pg-boss's own
`retryDelay`, the delay before a failed JOB is retried, is a queue option in
SECONDS: set it in `queueDefaults` or in `createJob(name, options)`.

### The pg-boss instance

The started instance is provided under the token `PG_BOSS_INSTANCE`, exported
from the package root. pg-boss 12's `PgBoss` is a class, not the module
namespace pg-boss 10 exported, so the class is no longer the token:

```ts
import { Inject } from "@nestjs/common";
import type { PgBoss } from "pg-boss";
import { PG_BOSS_INSTANCE } from "@rockhopper-co/nest-pg-boss";

constructor(@Inject(PG_BOSS_INSTANCE) private readonly boss: PgBoss) {}
```

A `JobService` also exposes it as `.boss`. The package root also exports
`PG_BOSS_JOB_METADATA` (the metadata key `Handle()` records under), the
`HandlerMetadata` type it records, and `getJobToken(name)` (the provider token
of a job's `JobService`).

### Jobs

```typescript
// jobs.ts
import { createJob } from "@rockhopper-co/nest-pg-boss"

interface IFoobarJobData {
  foo: string
  bar: boolean
}

const FoobarJob = createJob<IFoobarJobData>("foobar")
```

A queue name may contain only letters, digits, underscores, hyphens, periods
and forward slashes (pg-boss 12's rule); `createJob` refuses any other name.
The optional second argument, `createJob(name, queueOptions)`, is pg-boss 12's
[queue options](https://pgboss.io/api/queues) without
`name`: policy, retries, expiry, retention. They are merged over the module's
`queueDefaults`, and the job's own options win key by key:

```typescript
PGBossModule.forRoot({ /* connection */, queueDefaults: { retryLimit: 3 } })

// Created with { retryLimit: 3, policy: "short" }.
const FoobarJob = createJob<IFoobarJobData>("foobar", { policy: "short" })
```

pg-boss 12 refuses a send to a queue that does not exist, so the module
creates every registered queue itself, once per name, one at a time (each
awaited before the next), in its `onModuleInit`. Every queue therefore exists
before any `onApplicationBootstrap` hook runs, which is where workers start and
where your own providers may send. If one creation fails the boot fails, naming
the queue. When one name is registered twice with different options, the
first registration's options are used and a warning is logged.

`queueInstance` on a `JobService` resolves once its queue exists and rejects,
naming the queue, if it could not be created. Do not await it inside your own
`onModuleInit`: that hook may run before the module's.

#### Create new Jobs

```typescript
// module.ts
import { PGBossModule } from "@rockhopper-co/nest-pg-boss";
import { FoobarService } from "./service.ts";

@Module({
  imports: PGBossModule.forJobs([FoobarJob]),
  providers: [FoobarService]
})
class FoobarModule {}

```

```typescript
// service.ts
import { JobService } from "@rockhopper-co/nest-pg-boss";
import { FoobarJob, IFoobarJobData } from "./jobs.ts";

@Injectable()
class FoobarService {
  constructor(
    @FoobarJob.Inject()
    private readonly foobarJobService: JobService<IFoobarJobData>,
  ) {}

  async sendJob() {
    await this.foobarJobService.send({ foo: "oof", bar: true }, {});
  }
}
```

#### Process Jobs

Jobs can be processed by using the `@FoobarJob.Handle()` decorator. pg-boss 12
always hands a handler an ARRAY of jobs, whatever `batchSize` is, so the
handler takes `Job[]`:

```typescript
// service.ts
import type { Job } from "pg-boss";

@Injectable()
class FoobarService {
  /* ... */

  @FoobarJob.Handle()
  async handleJobs(jobs: Job<IFoobarJobData>[]) {
    for (const job of jobs) {
      // do something with job.data
    }
  }
}
```

The handler's type is pg-boss's own `WorkHandlerFor`, so options such as
`includeMetadata: true` or `perJobResults: true` demand the handler `work()`
would demand.

You can optionally pass pg-boss's [work options](https://pgboss.io/api/workers#work-name-options-handler) to `.Handle()`:

```typescript
@FoobarJob.Handle({ batchSize: 1, pollingIntervalSeconds: 2 })
```

To handle several jobs from one queue at once in one process, ask for several
workers with `workers` (default 1). The module makes ONE `work()` call with
pg-boss 12's `localConcurrency` set to that number, and pg-boss spawns that many
workers, each polling independently. `workers` itself is never passed to
pg-boss; give `workers` or `localConcurrency`, not both. `disabled: true`
registers none.

```typescript
@FoobarJob.Handle({ batchSize: 1, workers: 3 })
```

## Test

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

The e2e suite starts a `postgres:14-alpine` container through Testcontainers,
so it needs Docker. The publish workflow runs it after the unit specs and
before every publish.

## License

`@rockhopper-co/nest-pg-boss` is [MIT licensed](LICENSE).
