export const PG_BOSS_JOB_METADATA = "PG_BOSS_JOB_METADATA";

/**
 * The DI token the started pg-boss instance is provided under. pg-boss 12 is
 * a named class export (`PgBoss`), not the module namespace pg-boss 10 was,
 * so the instance gets a token of its own instead of using the import as one
 * (plan 117 DESIGN D6). Inject it with `@Inject(PG_BOSS_INSTANCE)`.
 */
export const PG_BOSS_INSTANCE = "PG_BOSS_INSTANCE";
