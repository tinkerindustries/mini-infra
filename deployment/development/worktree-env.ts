// worktree-env — the bring-up stages for this worktree's Mini Infra instance.
//
// Invoked via the root package.json script:
//   pnpm worktree-env <stage> [args...]
//
// Each stage is one worktree-manager hook. You do not normally run them by
// hand: `wt init` and `wt start` run them in order, with this worktree's
// allocation in the environment. Running one directly works too — the stage
// reads the same values back from the descriptor.
//
// Creating, listing and removing worktrees are worktree-manager's job:
//   wt init --description "<what this worktree is for>"
//   wt start
//   wt list
//   wt rm --slug <slug>
//
// See docs/wt.md.

import { parseArgs } from 'node:util';
import { logError } from './lib/log.js';
import { NotInitialisedError } from './lib/allocation.js';
import { DEFAULT_SEED_PROFILE, isSeedProfile, SEED_PROFILES, type SeedProfile } from './lib/paths.js';
import * as stages from './lib/stages.js';

type Stage = 'provision' | 'prepull' | 'build' | 'up' | 'seed' | 'health' | 'status' | 'down';

const STAGES: Stage[] = ['provision', 'prepull', 'build', 'up', 'seed', 'health', 'status', 'down'];

function usage(): void {
  console.log('Usage: pnpm worktree-env <stage> [options]');
  console.log('');
  console.log('Stages, in the order worktree-manager runs them:');
  console.log('  provision   Wait for this worktree\'s VM and sync host dependencies.  (install hook)');
  console.log('  prepull     Start the local registry and pull the base images.       (prepull hook)');
  console.log('  build       Build the sidecar images and the app image.              (build hook)');
  console.log('  up          Bring the compose stack up and wait for it.              (start hook)');
  console.log('  seed        Seed the instance via its API.                           (seed hook)');
  console.log('  health      Probe the app\'s health endpoint.                         (health hook)');
  console.log('');
  console.log('Extras:');
  console.log('  status      Print this worktree\'s endpoints.');
  console.log('  down        Stop the stack. --volumes also destroys its data.');
  console.log('');
  console.log('Options:');
  console.log(`  --seed-profile <${SEED_PROFILES.join('|')}>   seed only (default: ${DEFAULT_SEED_PROFILE}).`);
  console.log('  --force                          seed only: re-seed an already-seeded instance.');
  console.log('  --description <text>             seed only: short summary, recorded in environment-details.xml.');
  console.log('  --long-description <text>        seed only: longer summary.');
  console.log('  --volumes                        down only: also remove volumes.');
  console.log('');
  console.log('Worktrees themselves are created and removed with wt — see docs/wt.md.');
}

interface Options {
  seedProfile: SeedProfile;
  force: boolean;
  description?: string;
  longDescription?: string;
  volumes: boolean;
}

function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      'seed-profile': { type: 'string' },
      force: { type: 'boolean', default: false },
      description: { type: 'string' },
      'long-description': { type: 'string' },
      volumes: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const raw = values['seed-profile'] as string | undefined;
  if (raw !== undefined && !isSeedProfile(raw)) {
    logError(`Invalid --seed-profile '${raw}'. Valid values: ${SEED_PROFILES.join(', ')}`);
    process.exit(1);
  }

  return {
    seedProfile: (raw as SeedProfile | undefined) ?? DEFAULT_SEED_PROFILE,
    force: Boolean(values.force),
    description: values.description as string | undefined,
    longDescription: values['long-description'] as string | undefined,
    volumes: Boolean(values.volumes),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const stage = argv[0];

  if (!stage || stage === 'help' || stage === '--help' || stage === '-h') {
    usage();
    process.exit(stage ? 0 : 1);
  }
  if (!STAGES.includes(stage as Stage)) {
    logError(`Unknown stage: ${stage}`);
    usage();
    process.exit(1);
  }

  const opts = parseOptions(argv.slice(1));
  const ctx = stages.context();

  switch (stage as Stage) {
    case 'provision':
      await stages.provision(ctx);
      break;
    case 'prepull':
      await stages.prepull(ctx);
      break;
    case 'build':
      await stages.build(ctx);
      break;
    case 'up':
      await stages.up(ctx);
      break;
    case 'seed':
      await stages.seed(ctx, {
        seedProfile: opts.seedProfile,
        force: opts.force,
        shortDescription: opts.description,
        longDescription: opts.longDescription,
      });
      break;
    case 'health':
      await stages.health(ctx);
      stages.summary(ctx);
      break;
    case 'status':
      stages.summary(ctx);
      break;
    case 'down':
      stages.down(ctx, opts.volumes);
      break;
  }
}

main().catch((err) => {
  if (err instanceof NotInitialisedError) {
    logError(err.message);
    process.exit(4);
  }
  logError(err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
