// The machine-global paths the dev flow reads, and the seed profile type.
//
// This file is what is left of the old lib/registry.ts once worktree-manager
// took over allocation. There is no per-worktree registry here any more:
// ~/.mini-infra/worktrees.yaml is gone, and the slot, ports, VM name, compose
// project and egress CIDR all come from lib/allocation.ts.
//
// Everything named here is deliberately shared by every worktree — see the
// `shared:` block in wt.yaml and docs/wt.md.

import * as os from 'node:os';
import * as path from 'node:path';

/** The shared Mini Infra dotfile directory. */
export const MINI_INFRA_HOME =
  process.env.MINI_INFRA_HOME || path.join(os.homedir(), '.mini-infra');

/**
 * The seeder's credentials: admin login plus the Azure, Cloudflare, GitHub
 * and Tailscale tokens. One file for every worktree on the machine, so every
 * seeded instance shares the same admin account and the same external
 * tenants.
 */
export const DEV_ENV_FILE = path.join(MINI_INFRA_HOME, 'dev.env');

/**
 * Seed profile — how much of the stack the seeder brings up. `full` seeds
 * everything (vault+nats, egress-fw-agent, local env, HAProxy); `minimal`
 * stops after the admin user and connected services, so a worktree working
 * on parts of the app that need none of those does not have to host them.
 *
 * The value is chosen on first `wt init` and persisted by worktree-manager as
 * the seed hook's sticky `seed_profile` parameter, so later runs reuse it.
 */
export type SeedProfile = 'minimal' | 'full';
export const DEFAULT_SEED_PROFILE: SeedProfile = 'full';
export const SEED_PROFILES: readonly SeedProfile[] = ['minimal', 'full'];

export function isSeedProfile(value: string): value is SeedProfile {
  return (SEED_PROFILES as readonly string[]).includes(value);
}
