import { homedir } from "node:os";
import { join } from "node:path";

/**
 * DB location: $XDG_STATE_HOME/reflex/reflex.db, defaulting to
 * ~/.local/state/reflex/reflex.db (spec FR-1). State, not config — the DB
 * is daemon runtime state, never user-edited.
 */
export function defaultDbPath(env: Record<string, string | undefined> = process.env): string {
  const stateHome = env.XDG_STATE_HOME && env.XDG_STATE_HOME !== "" ? env.XDG_STATE_HOME : join(homedir(), ".local/state");
  return join(stateHome, "reflex", "reflex.db");
}

/** The daemon's DB: `<state_dir>/reflex.db` when the config sets one, else
 * `defaultDbPath()` (reflex#36). */
export function dbPathFor(
  cfg: { stateDir?: string },
  env: Record<string, string | undefined> = process.env,
): string {
  return cfg.stateDir ? join(cfg.stateDir, "reflex.db") : defaultDbPath(env);
}
