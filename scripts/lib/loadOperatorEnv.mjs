/**
 * Loads the operator env for the spec 0010 scripts the way
 * scripts/migrate-tenants.ts does: the process env, then the root .env,
 * then worker/.dev.vars for whatever is still unset (dotenv never
 * overwrites a value already set). Never commit those files.
 */
import dotenv from 'dotenv';

/** @param {string[]} names @returns {Record<string, string>} */
export function loadOperatorEnv(names) {
  dotenv.config();
  if (names.some((name) => !process.env[name])) {
    dotenv.config({ path: 'worker/.dev.vars' });
  }
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(
        ', '
      )} not set: export them or put them in the local operator env file (never commit them).`
    );
  }
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}
