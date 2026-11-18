# Changelog

## 3.0.0 (unreleased; prereleases `3.0.<run>-pgboss12.<run>` on dist-tag `pgboss12`)

Ports the module to pg-boss 12 (plan 117). The 2.2.x line stays published for
pg-boss 10. Version numbers are `3.0.<workflow run number>`, published to
GitHub Packages on merge to `main`.

### ⚠ BREAKING CHANGES

* **Node 26.12 or later** (`engines.node`); 2.2.x ran on Node 20.
* **Peer `pg-boss` is `^12.38.2`** (was `^10.1.5`), and **`@opentelemetry/api`
  `^1.9.0` is a new peer**, because pg-boss 12 requires it.
* **The pg-boss instance is provided under the token `PG_BOSS_INSTANCE`**,
  exported from the package root. 2.x provided it under the pg-boss default
  export; pg-boss 12 has no default export, and `PgBoss` is a class. Replace
  `@Inject(PGBoss)` with `@Inject(PG_BOSS_INSTANCE)`.
* **Handlers receive `Job[]`**, always, whatever `batchSize` is (pg-boss 12's
  `work()`). A handler written as `(job: Job<T>)` reading `job.data` now
  compiles to a type error. The handler type is pg-boss's own `WorkHandlerFor`,
  so `includeMetadata: true` and `perJobResults: true` demand the handler
  pg-boss demands. The `WorkHandler` and `WorkHandlerBatch` interfaces this
  package exported are removed; use pg-boss's.
* **Queues are created by the module, not by each `JobService`.** Every
  registered queue is created once per name, one at a time, each awaited, in
  `PGBossModule.onModuleInit`, before any `onApplicationBootstrap` hook. A failed
  creation fails the boot, naming the queue. `queueInstance` now resolves to
  `void` once the queue exists (and rejects if it could not be created) instead
  of holding the un-awaited `createQueue` promise.
* **`createJob(name)` refuses a name pg-boss 12 would refuse**: only letters,
  digits, underscores, hyphens, periods and forward slashes. It throws where
  the job is declared.
* **`Handle({ workers: N })` is one `work()` call with `localConcurrency: N`**,
  not N `work()` calls. pg-boss spawns N workers, each polling independently.
  Giving both `workers` and `localConcurrency` throws.
* **Module-only options are no longer passed to `new PgBoss(...)`**:
  `retryAttempts`, `retryDelay`, `toRetry`, `verboseRetryLog` and the new
  `queueDefaults` are removed first. The module's `retryDelay` is the delay
  between CONNECTION attempts in milliseconds; a job's retry delay is the queue
  option `retryDelay`, in seconds.
* **`JobService.insert(jobs)`** calls pg-boss 12's `insert(name, jobs)`; a job
  carries no `name`, and the result is `string[] | null` (was `any`).
* **`JobService.getJobById(id, options)`** has no `includeArchive`: pg-boss 12
  has no archive table.
* **`JobService.cancel(id, options)`** resolves to pg-boss's `CommandResponse`
  (was `void`).
* **`JobService.fetch(options)`** resolves to `JobWithMetadata<T>[]` (was
  `Job<object>[] | null`).
* **`JobService.unschedule()`** returns pg-boss's promise, so a failure
  rejects instead of being lost.

### Features

* `createJob(name, queueOptions)`: pg-boss 12 queue options (policy, retries,
  expiry, retention) per job.
* `queueDefaults` module option: queue options every queue is created with,
  under each job's own options, which win key by key.
* `JobService.findJobs(options)`.
* Root exports `PG_BOSS_INSTANCE`, `PG_BOSS_JOB_METADATA`, `getJobToken` and the
  `HandlerMetadata` type.
* A queue registered more than once with different options is created with the
  first registration's options and logs a warning.

### Build

* The e2e suite runs against a real pg-boss 12 database (`postgres:14-alpine`)
  in the publish job, after the unit specs and before `npm publish`.

## [2.1.0](https://github.com/apricote/nest-pg-boss/compare/v2.0.0...v2.1.0) (2023-09-16)


### Features

* support Nest.js 10 ([#27](https://github.com/apricote/nest-pg-boss/issues/27)) ([7ac149c](https://github.com/apricote/nest-pg-boss/commit/7ac149cda0d56f8d703606aa9f6f6ab2df483ebc))

## [2.0.0](https://github.com/apricote/nest-pg-boss/compare/v1.2.0...v2.0.0) (2023-05-06)


### ⚠ BREAKING CHANGES

* stricter decorator typing ([#18](https://github.com/apricote/nest-pg-boss/issues/18))

### Features

* stricter decorator typing ([#18](https://github.com/apricote/nest-pg-boss/issues/18)) ([d4d024a](https://github.com/apricote/nest-pg-boss/commit/d4d024af073c43288e082e8714c932cf1cd551fd))

## [1.2.0](https://github.com/apricote/nest-pg-boss/compare/v1.1.0...v1.2.0) (2023-05-05)


### Features

* add work options to .Handle() ([#16](https://github.com/apricote/nest-pg-boss/issues/16)) ([9460b44](https://github.com/apricote/nest-pg-boss/commit/9460b44ce951d46ccacf96e01e3dc6b6e7e2636c))

## [1.1.0](https://github.com/apricote/nest-pg-boss/compare/v1.0.0...v1.1.0) (2023-04-29)


### Features

* batch job inserts ([d38448e](https://github.com/apricote/nest-pg-boss/commit/d38448eee8f74b6f9783b0774922997cc98e4635))

## 1.0.0 (2023-03-06)


### Features

* setup nest-pg-boss ([94a3adf](https://github.com/apricote/nest-pg-boss/commit/94a3adfd748a45dd42f4e7df30ddddbbcaf529b7))


### Bug Fixes

* **ci:** add PAT for release-please ([122c541](https://github.com/apricote/nest-pg-boss/commit/122c54159f2aa5ab2462d6c0a978b433b092a174))
* **ci:** building fails ([cbb8269](https://github.com/apricote/nest-pg-boss/commit/cbb826953a729c75da059428ac4782e3a1386034))
* **ci:** public publishing ([4b62528](https://github.com/apricote/nest-pg-boss/commit/4b62528f0820d0ad23be8174df863a119d309812))
