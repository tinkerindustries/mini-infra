// The bring-up stages for one worktree's Mini Infra instance.
//
// Each exported stage is one worktree-manager hook, in the order wt runs
// them: provision (install) → prepull → build → up (start) → seed → health.
// The stages share one context, built once per process from the worktree's
// allocation.
//
// Nothing here allocates. The slot, the ten host ports, the VM name, the
// compose project and the egress CIDR all come from wt via lib/allocation.ts;
// this file only orchestrates Docker, the images and the seeder against them.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logInfo, logOk, logWarn, logError } from './log.js';
import {
  loadAllocation,
  pickDriver,
  dockerEndpoint,
  type Allocation,
  type Driver,
} from './allocation.js';
import { DEV_ENV_FILE, MINI_INFRA_HOME, type SeedProfile } from './paths.js';
import { readEnvironmentDetails, writeMinimalEnvironmentDetails } from './env-details.js';
import {
  assertWslAvailable,
  defaultBaseTarballPath,
  defaultInstallDir,
  distroExists,
  ensureDockerReady,
  importDistro,
  isDistroRunning,
  startDocker as startWslDocker,
} from './wsl.js';
import { seed as runSeeder, ensureVaultUnlocked } from './seeder.js';
import { ApiClient } from './api.js';
import {
  buildSidecarsToTarballs,
  detectHostBuildContext,
  ensureBuildOutputDir,
  finalizeSidecarImages,
  type SidecarBuildSpec,
} from './sidecar-build.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEV_DIR = path.resolve(SCRIPT_DIR, '..');
export const PROJECT_ROOT = path.resolve(DEV_DIR, '..', '..');
export const COMPOSE_FILE = path.join(DEV_DIR, 'docker-compose.worktree.yaml');

// The VM sizing Mini Infra needs. worktree-manager's machine driver creates
// the Colima profile with the platform's own defaults (2 CPU, 2 GiB), which
// is not enough to build and run the stack, so the provision stage resizes an
// under-provisioned VM once, on first bring-up.
const COLIMA_CPUS = 2;
const COLIMA_MEMORY_GIB = 8;

// On Windows, spawnSync without `shell:true` only resolves .exe — it can't
// find .cmd shims like corepack.cmd or pnpm.cmd. Enabling shell on Windows
// routes through cmd.exe which respects PATHEXT.
const NEEDS_SHELL = process.platform === 'win32';

export interface StageContext {
  alloc: Allocation;
  driver: Driver;
  dockerHost: string;
  dockerSocket: string;
  /** The environment every docker/compose invocation runs with. */
  stackEnv: NodeJS.ProcessEnv;
  /** The four locally-built images, tagged into this worktree's registry. */
  images: {
    agentSidecar: string;
    egressGateway: string;
    egressGatewayPush: string;
    egressFwAgent: string;
    egressFwAgentPush: string;
    pgBackup: string;
    pgBackupPush: string;
  };
  sidecarSpecs: SidecarBuildSpec[];
  detailsFile: string;
}

/** Build the stage context from this worktree's allocation. */
export function context(): StageContext {
  const alloc = loadAllocation(PROJECT_ROOT);
  const driver = pickDriver(logWarn);
  const { dockerHost, dockerSocket } = dockerEndpoint(alloc, driver);
  const reg = alloc.registryPort;

  // Image tags are derivable from the registry port alone.
  //
  // EGRESS_GATEWAY_IMAGE_TAG, EGRESS_FW_AGENT_IMAGE_TAG and
  // PG_BACKUP_TEMPLATE_IMAGE are consumed by their stack templates'
  // `dockerImage` fields, and the template appends its own `:latest` — so
  // those values must NOT carry a tag. The `*Push` variants do, because that
  // is what `docker push` needs.
  const images = {
    agentSidecar: `localhost:${reg}/mini-infra-agent-sidecar:latest`,
    egressGateway: `localhost:${reg}/mini-infra-egress-gateway`,
    egressGatewayPush: `localhost:${reg}/mini-infra-egress-gateway:latest`,
    egressFwAgent: `localhost:${reg}/mini-infra-egress-fw-agent`,
    egressFwAgentPush: `localhost:${reg}/mini-infra-egress-fw-agent:latest`,
    pgBackup: `localhost:${reg}/mini-infra-pg-backup`,
    pgBackupPush: `localhost:${reg}/mini-infra-pg-backup:latest`,
  };

  const stackEnv: NodeJS.ProcessEnv = {
    DOCKER_HOST: dockerHost,
    COMPOSE_PROJECT_NAME: alloc.composeProject,
    UI_PORT: String(alloc.uiPort),
    REGISTRY_PORT: String(reg),
    AGENT_SIDECAR_IMAGE_TAG: images.agentSidecar,
    EGRESS_GATEWAY_IMAGE_TAG: images.egressGateway,
    EGRESS_FW_AGENT_IMAGE_TAG: images.egressFwAgent,
    // Phase 4 (MINI-53): the pg-az-backup template substitutes the image and
    // tag separately. The legacy full-string PG_BACKUP_IMAGE_TAG stays set so
    // the restore-executor's still-direct-spawn path resolves the same
    // locally-built image.
    PG_BACKUP_TEMPLATE_IMAGE: images.pgBackup,
    PG_BACKUP_TEMPLATE_TAG: 'latest',
    PG_BACKUP_IMAGE_TAG: images.pgBackupPush,
    EGRESS_POOL_CIDR: alloc.egressPoolCidr,
    PROJECT_ROOT,
    PROFILE: alloc.slug,
  };

  const sidecarSpecs: SidecarBuildSpec[] = [
    {
      name: 'agent-sidecar',
      dockerfile: path.join(PROJECT_ROOT, 'agent-sidecar', 'Dockerfile'),
      contextDir: PROJECT_ROOT,
      tag: images.agentSidecar,
    },
    {
      name: 'egress-gateway',
      dockerfile: path.join(PROJECT_ROOT, 'egress-gateway', 'Dockerfile'),
      contextDir: PROJECT_ROOT,
      tag: images.egressGatewayPush,
    },
    {
      name: 'egress-fw-agent',
      dockerfile: path.join(PROJECT_ROOT, 'egress-fw-agent', 'Dockerfile'),
      contextDir: PROJECT_ROOT,
      tag: images.egressFwAgentPush,
    },
    {
      name: 'pg-az-backup',
      dockerfile: path.join(PROJECT_ROOT, 'pg-az-backup', 'Dockerfile'),
      contextDir: path.join(PROJECT_ROOT, 'pg-az-backup'),
      tag: images.pgBackupPush,
    },
  ];

  return {
    alloc,
    driver,
    dockerHost,
    dockerSocket,
    stackEnv,
    images,
    sidecarSpecs,
    detailsFile: path.join(PROJECT_ROOT, 'environment-details.xml'),
  };
}

// ---- small helpers ---------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url: string, attempts: number, label: string): Promise<boolean> {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // swallow — expected during startup
    }
    if (i % 10 === 0) logInfo(`Still waiting... (${i}s elapsed) — ${label}`);
    await sleep(1000);
  }
  return false;
}

function commandExists(cmd: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [cmd] : ['-v', cmd];
  const opts = process.platform === 'win32' ? {} : { shell: '/bin/bash' };
  return spawnSync(probe, args, opts).status === 0;
}

function exec(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; stdio?: 'inherit' | 'pipe' } = {},
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env || {}) },
    cwd: opts.cwd,
    stdio: opts.stdio || 'pipe',
    shell: NEEDS_SHELL,
  });
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function compose(
  args: string[],
  env: NodeJS.ProcessEnv,
  stdio: 'inherit' | 'pipe' = 'inherit',
): number {
  const res = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    env: { ...process.env, ...env },
    stdio,
    shell: NEEDS_SHELL,
  });
  return res.status ?? 1;
}

interface ColimaInstance {
  name?: string;
  status?: string;
  cpus?: number;
  memory?: number;
}

function colimaInstance(name: string): ColimaInstance | null {
  const res = spawnSync('colima', ['list', '--json'], { encoding: 'utf8' });
  if (res.status !== 0) return null;
  const stdout = res.stdout || '';
  // Some colima versions emit one JSON object per line, others a JSON array.
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as ColimaInstance | ColimaInstance[];
      const list = Array.isArray(obj) ? obj : [obj];
      const hit = list.find((e) => e?.name === name);
      if (hit) return hit;
    } catch {
      // fall through to the next line
    }
  }
  return null;
}

// ---- provision (the install hook) -----------------------------------------

/**
 * Wait for this worktree's VM to be usable, and make sure it is big enough.
 *
 * worktree-manager's machine driver has already created and started the VM by
 * the time this runs — under Colima with the platform's default sizing, which
 * is too small for Mini Infra, so an under-provisioned profile is restarted
 * once at the size the stack needs. Under WSL2 the driver only starts a
 * distro that already exists, so the import from the cached base tarball
 * happens here.
 */
export async function provision(ctx: StageContext): Promise<void> {
  const { alloc, driver } = ctx;
  logInfo(`Worktree '${alloc.slug}' — slot ${alloc.slot}, VM '${alloc.vm}', driver ${driver}`);

  if (!commandExists('docker')) {
    const hint =
      driver === 'wsl'
        ? 'Install the Docker CLI: https://download.docker.com/win/static/stable/'
        : 'Install with: brew install docker';
    logError(`docker CLI is not installed. ${hint}`);
    process.exit(1);
  }
  if (!commandExists('corepack')) {
    logError('corepack is not available. Install a recent Node.js (>=16.9) or run: npm install -g corepack');
    process.exit(1);
  }

  // Host-side node modules. Idempotent; fast on warm installs.
  logInfo('Syncing host-side Node dependencies via pnpm...');
  if (exec('corepack', ['prepare', '--activate'], { cwd: PROJECT_ROOT, stdio: 'inherit' }).status !== 0) {
    logError('corepack prepare failed — is your Node version recent enough?');
    process.exit(1);
  }
  if (exec('pnpm', ['install', '--frozen-lockfile'], { cwd: PROJECT_ROOT, stdio: 'inherit' }).status !== 0) {
    logError('pnpm install failed');
    process.exit(1);
  }
  logOk('Host dependencies synced');

  fs.mkdirSync(MINI_INFRA_HOME, { recursive: true });

  if (driver === 'colima') {
    await provisionColima(ctx);
  } else {
    await provisionWsl(ctx);
  }
}

/**
 * Wait for a Colima profile to exist and stop changing state.
 *
 * The machine driver's `colima start` runs detached, so this hook can arrive
 * before the profile is listed at all. Two waits, in order: for the profile
 * to appear, then for it to leave the transitional states. A profile that
 * settles as Stopped is still a usable answer — the caller starts it at the
 * size Mini Infra needs.
 */
async function waitForColimaProfile(
  name: string,
  appearSeconds = 300,
  settleSeconds = 900,
): Promise<ColimaInstance | null> {
  let inst = colimaInstance(name);
  for (let i = 0; !inst && i < appearSeconds; i++) {
    if (i === 0) logInfo(`Waiting for the machine driver to create Colima profile '${name}'...`);
    else if (i % 30 === 0) logInfo(`Still waiting for profile '${name}'... (${i}s)`);
    await sleep(1000);
    inst = colimaInstance(name);
  }
  if (!inst) return null;

  for (let i = 0; i < settleSeconds; i++) {
    const status = (inst?.status || '').toLowerCase();
    if (status === 'running' || status === 'stopped') return inst;
    if (i % 30 === 0) logInfo(`Profile '${name}' is ${inst?.status || 'unknown'}... (${i}s)`);
    await sleep(1000);
    inst = colimaInstance(name);
    if (!inst) return null;
  }
  return inst;
}

async function provisionColima(ctx: StageContext): Promise<void> {
  const { alloc, dockerSocket } = ctx;
  if (!commandExists('colima')) {
    logError('colima is not installed. Install with: brew install colima');
    process.exit(1);
  }

  const wantMemoryBytes = COLIMA_MEMORY_GIB * 1024 * 1024 * 1024;

  // worktree-manager's machine driver launches `colima start` and returns
  // without waiting — a cold VM takes minutes, and blocking materialisation
  // on it would stall `wt init`. So the profile is very likely still being
  // created when this hook runs: wait for it to appear and settle rather
  // than reading `colima list` once and giving up.
  const inst = await waitForColimaProfile(alloc.vm);
  if (!inst) {
    logError(
      `Colima profile '${alloc.vm}' never appeared. worktree-manager's machine driver creates it ` +
        `in the background — check 'wt doctor', then 'colima start ${alloc.vm}' by hand to see why.`,
    );
    process.exit(1);
  }

  const underProvisioned =
    (inst.cpus ?? 0) < COLIMA_CPUS || (inst.memory ?? 0) < wantMemoryBytes;
  const running = (inst.status || '').toLowerCase() === 'running';

  // The machine driver runs a bare `colima start`, which takes Colima's own
  // defaults — 2 GiB of memory, which is not enough to build and run the
  // stack. Restart it once, at the size Mini Infra needs. A profile that is
  // merely stopped gets the same treatment, which is what starts it.
  if (underProvisioned || !running) {
    if (underProvisioned) {
      logInfo(
        `Colima profile '${alloc.vm}' is under-provisioned ` +
          `(${inst.cpus ?? '?'} CPU, ${Math.round((inst.memory ?? 0) / 1024 ** 3)}G) — ` +
          `restarting at ${COLIMA_CPUS} CPU / ${COLIMA_MEMORY_GIB}G...`,
      );
    } else {
      logInfo(`Colima profile '${alloc.vm}' is ${inst.status || 'not running'} — starting it...`);
    }
    spawnSync('colima', ['stop', alloc.vm], { stdio: 'inherit' });
    const startArgs = [
      'start',
      alloc.vm,
      '--cpu',
      String(COLIMA_CPUS),
      '--memory',
      String(COLIMA_MEMORY_GIB),
    ];
    // vz + virtiofs is much faster where the host supports it; fall back to
    // the portable defaults when it does not.
    const vz = spawnSync('colima', [...startArgs, '--vm-type', 'vz', '--mount-type', 'virtiofs'], {
      stdio: ['inherit', 'inherit', 'pipe'],
    });
    if (vz.status !== 0) {
      const fallback = spawnSync('colima', startArgs, { stdio: 'inherit' });
      if (fallback.status !== 0) {
        logError(`colima start failed for profile '${alloc.vm}'`);
        process.exit(1);
      }
    }
    logOk(`Colima profile '${alloc.vm}' running at ${COLIMA_CPUS} CPU / ${COLIMA_MEMORY_GIB}G`);
  }

  // The machine driver starts the VM in the background, so the socket can
  // take minutes to appear on a cold boot.
  logInfo(`Waiting for dockerd in '${alloc.vm}'...`);
  for (let i = 0; i < 600; i++) {
    if (fs.existsSync(dockerSocket)) break;
    if (i > 0 && i % 30 === 0) logInfo(`Still waiting for ${dockerSocket}... (${i}s)`);
    await sleep(1000);
  }
  if (!fs.existsSync(dockerSocket)) {
    logError(`Colima socket never appeared at ${dockerSocket}`);
    logError(`Check the VM with: colima status ${alloc.vm}`);
    process.exit(1);
  }

  const ping = exec('docker', ['version', '--format', '{{.Server.Version}}'], { env: ctx.stackEnv });
  if (ping.status !== 0) {
    logError(`dockerd in '${alloc.vm}' is not answering on ${ctx.dockerHost}`);
    process.stderr.write(ping.stderr);
    process.exit(1);
  }
  logOk(`dockerd ready in '${alloc.vm}' (server ${ping.stdout.trim()})`);
}

async function provisionWsl(ctx: StageContext): Promise<void> {
  const { alloc } = ctx;
  try {
    assertWslAvailable();
  } catch (err) {
    logError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // worktree-manager's WSL2 machine driver starts an existing distro but does
  // not import one, so a first bring-up lands here with nothing registered.
  if (!distroExists(alloc.vm)) {
    const baseTar = defaultBaseTarballPath(MINI_INFRA_HOME);
    if (!fs.existsSync(baseTar)) {
      logError(`Base tarball not found at ${baseTar}.`);
      logError('Run scripts\\build-wsl-base.ps1 from the project root first.');
      process.exit(1);
    }
    logInfo(`Importing WSL distro '${alloc.vm}' from ${baseTar}...`);
    importDistro({
      name: alloc.vm,
      baseTarball: baseTar,
      installDir: defaultInstallDir(MINI_INFRA_HOME, alloc.slug),
    });
    logOk(`WSL distro '${alloc.vm}' imported`);
  } else {
    logInfo(`WSL distro '${alloc.vm}' already exists`);
  }

  if (!isDistroRunning(alloc.vm)) {
    logInfo(`Starting dockerd inside '${alloc.vm}' on tcp port ${alloc.dockerPort}...`);
  }
  startWslDocker({ name: alloc.vm, dockerPort: alloc.dockerPort });
  const ready = await ensureDockerReady(alloc.dockerPort, 60);
  if (!ready) {
    logError(`dockerd in '${alloc.vm}' did not become ready on port ${alloc.dockerPort} within 60s`);
    logError(`Check the daemon log: wsl -d ${alloc.vm} -- cat /var/log/mini-infra/dockerd.log`);
    process.exit(1);
  }
  logOk(`dockerd ready at tcp://localhost:${alloc.dockerPort}`);
}

// ---- prepull ---------------------------------------------------------------

/**
 * Start this worktree's image registry and pull the base images the stack
 * reconciler spawns on demand. The registry has to be up before the build
 * stage can push the sidecar images into it.
 */
export async function prepull(ctx: StageContext): Promise<void> {
  const { alloc, stackEnv } = ctx;

  logInfo('Ensuring local Docker registry is running...');
  if (compose(['up', '-d', 'registry'], stackEnv) !== 0) {
    logError('Failed to start registry container');
    process.exit(1);
  }
  const ok = await waitForHttp(`http://localhost:${alloc.registryPort}/v2/`, 15, 'registry');
  if (!ok) {
    logError(`Local registry failed to become ready on port ${alloc.registryPort} after 15s`);
    compose(['logs', '--tail=30', 'registry'], stackEnv);
    process.exit(1);
  }
  logOk(`Local registry is ready at localhost:${alloc.registryPort}`);

  logInfo('Pre-pulling alpine:latest (used by stack reconciler for ephemeral helpers)...');
  const pull = exec('docker', ['pull', 'alpine:latest'], { env: stackEnv });
  if (pull.status !== 0) {
    logError('Failed to pull alpine:latest');
    process.stderr.write(pull.stderr);
    process.exit(1);
  }
  logOk('alpine:latest ready');
}

// ---- build -----------------------------------------------------------------

/**
 * Build the four sidecar images and the app image.
 *
 * The sidecar Dockerfiles don't depend on the per-worktree VM at build time —
 * only at runtime — so they are built on an always-on host context where one
 * exists and loaded into this worktree's daemon afterwards. That is much
 * faster than building on a freshly-booted VM.
 */
export async function build(ctx: StageContext): Promise<void> {
  const { sidecarSpecs, dockerHost, stackEnv } = ctx;

  const hostBuildContext = detectHostBuildContext();
  let hostBuildPromise: Promise<Awaited<ReturnType<typeof buildSidecarsToTarballs>>> | null = null;
  if (hostBuildContext) {
    const outputDir = ensureBuildOutputDir();
    logInfo(`Pre-building sidecar images on host context '${hostBuildContext}'...`);
    hostBuildPromise = buildSidecarsToTarballs(sidecarSpecs, hostBuildContext, outputDir);
    hostBuildPromise.catch(() => {});
  } else {
    logInfo('No host docker context for pre-builds — sidecars will build on per-worktree daemon');
  }

  try {
    await finalizeSidecarImages(sidecarSpecs, hostBuildPromise, dockerHost);
    logOk('Sidecar images ready in per-worktree registry');
  } catch (err) {
    logError(`Sidecar image preparation failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  logInfo('Building the Mini Infra image...');
  if (compose(['build'], stackEnv) !== 0) {
    logError('docker compose build failed');
    process.exit(1);
  }
  logOk('Mini Infra image built');
}

// ---- up (the start hook) ---------------------------------------------------

/**
 * Bring the stack up and wait for the app container's own healthcheck.
 *
 * Networks the server joined at runtime (the vault stack's, for one) are not
 * in the compose file, so they are captured before the recreate and rejoined
 * after it.
 */
export async function up(ctx: StageContext): Promise<void> {
  const { alloc, stackEnv } = ctx;
  const miniInfraContainer = `${alloc.composeProject}-mini-infra-1`;

  const extraNetworks = captureExtraNetworks(ctx, miniInfraContainer);
  if (extraNetworks.length) {
    logInfo(`Will restore extra networks after rebuild: ${extraNetworks.join(' ')}`);
  }

  logInfo(`Starting Mini Infra (project=${alloc.composeProject})...`);
  if (compose(['up', '-d', '--wait'], stackEnv) !== 0) {
    logError('docker compose up failed');
    compose(['logs', '--tail=100', 'mini-infra'], stackEnv);
    process.exit(1);
  }

  for (const net of extraNetworks) {
    if (exec('docker', ['network', 'inspect', net], { env: stackEnv }).status !== 0) {
      logWarn(`Skipping network ${net} (no longer exists)`);
      continue;
    }
    const c = exec('docker', ['network', 'connect', net, miniInfraContainer], { env: stackEnv });
    if (c.status === 0) logOk(`Rejoined network: ${net}`);
    else logWarn(`Failed to rejoin network: ${net} (may already be connected)`);
  }

  logOk(`Mini Infra is up on http://localhost:${alloc.uiPort}`);
}

function captureExtraNetworks(ctx: StageContext, container: string): string[] {
  const { stackEnv } = ctx;
  if (exec('docker', ['inspect', container], { env: stackEnv }).status !== 0) return [];

  const composeNetworks = new Set<string>();
  const cfg = exec('docker', ['compose', '-f', COMPOSE_FILE, 'config', '--format', 'json'], {
    env: stackEnv,
  });
  if (cfg.status === 0) {
    try {
      const parsed = JSON.parse(cfg.stdout) as {
        name?: string;
        services?: Record<string, { networks?: Record<string, unknown> }>;
      };
      const projectName = parsed.name || '';
      const nets = new Set<string>(['default']);
      for (const svc of Object.values(parsed.services || {})) {
        for (const netName of Object.keys(svc.networks || {})) nets.add(netName);
      }
      for (const n of nets) composeNetworks.add(`${projectName}_${n}`);
    } catch {
      // best-effort — a parse failure just means nothing is treated as extra
    }
  }

  const current = exec(
    'docker',
    [
      'inspect',
      container,
      '--format',
      '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\\n"}}{{end}}',
    ],
    { env: stackEnv },
  );
  if (current.status !== 0) return [];
  return current.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((net) => !composeNetworks.has(net));
}

// ---- seed ------------------------------------------------------------------

export interface SeedOptions {
  seedProfile: SeedProfile;
  /** Re-run the seeder even when the instance is already seeded. */
  force?: boolean;
  shortDescription?: string;
  longDescription?: string;
}

/**
 * Seed the instance: admin user, connected services and — on the full profile
 * — the vault+nats stacks, the egress fw-agent, the local environment and
 * HAProxy. Idempotent: an already-seeded instance is left alone unless forced.
 */
export async function seed(ctx: StageContext, opts: SeedOptions): Promise<void> {
  const { alloc, detailsFile } = ctx;

  // The app has to be answering before the seeder can drive its API.
  const healthy = await waitForHttp(`http://localhost:${alloc.uiPort}/health`, 120, 'Mini Infra');
  if (!healthy) {
    logError(`Mini Infra is not healthy on port ${alloc.uiPort} — cannot seed`);
    process.exit(1);
  }

  const minimalDetailsInput = {
    profile: alloc.slug,
    projectRoot: PROJECT_ROOT,
    dockerHost: ctx.dockerHost,
    dockerSocket: ctx.dockerSocket,
    composeProject: alloc.composeProject,
    uiPort: alloc.uiPort,
    registryPort: alloc.registryPort,
    vaultPort: alloc.vaultPort,
    natsClientPort: alloc.natsClientPort,
    natsMonitorPort: alloc.natsMonitorPort,
    egressPool: alloc.egressPoolCidr,
    agentSidecarImageTag: ctx.images.agentSidecar,
    shortDescription: opts.shortDescription,
    longDescription: opts.longDescription,
    seedProfile: opts.seedProfile,
  };

  const existing = readEnvironmentDetails(detailsFile);
  const alreadySeeded = existing?.seeded ?? false;

  if (alreadySeeded && !opts.force) {
    logInfo('Instance already seeded — skipping (pass --force to re-run)');
    await reunlockVault(ctx, existing?.admin.apiKey);
    return;
  }

  if (!fs.existsSync(DEV_ENV_FILE)) {
    logWarn(`Skipping seed step — ${DEV_ENV_FILE} not found`);
    logWarn(`Copy ${path.join(DEV_DIR, 'dev.env.example')} to ${DEV_ENV_FILE} and fill in values.`);
    writeMinimalEnvironmentDetails(detailsFile, minimalDetailsInput);
    return;
  }

  logInfo(`Running seeder (profile: ${opts.seedProfile})...`);
  try {
    await runSeeder({
      uiPort: alloc.uiPort,
      registryPort: alloc.registryPort,
      vaultPort: alloc.vaultPort,
      natsClientPort: alloc.natsClientPort,
      natsMonitorPort: alloc.natsMonitorPort,
      haproxyHttpPort: alloc.haproxyHttpPort,
      haproxyHttpsPort: alloc.haproxyHttpsPort,
      haproxyStatsPort: alloc.haproxyStatsPort,
      haproxyDataplanePort: alloc.haproxyDataplanePort,
      profile: alloc.slug,
      projectRoot: PROJECT_ROOT,
      dockerHost: ctx.dockerHost,
      composeProject: alloc.composeProject,
      agentSidecarImageTag: ctx.images.agentSidecar,
      egressPoolCidr: alloc.egressPoolCidr,
      devEnvPath: DEV_ENV_FILE,
      detailsFile,
      shortDescription: opts.shortDescription,
      longDescription: opts.longDescription,
      seedProfile: opts.seedProfile,
    });
    logOk('Seeding complete — credentials are in environment-details.xml');
  } catch (err) {
    logError(`Seeder failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * Re-unlock Vault after a container restart.
 *
 * Every restart re-seals the operator passphrase, and downstream systems fail
 * quietly until it is unlocked again, so an already-seeded instance gets one
 * unlock attempt on every bring-up.
 */
async function reunlockVault(ctx: StageContext, apiKey: string | undefined): Promise<void> {
  if (!apiKey) return;
  const api = new ApiClient(`http://localhost:${ctx.alloc.uiPort}`, apiKey);
  try {
    await ensureVaultUnlocked(api);
  } catch (err) {
    logWarn(
      `Vault unlock attempt failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---- health ----------------------------------------------------------------

/** Probe the app's own health endpoint through this worktree's UI port. */
export async function health(ctx: StageContext): Promise<void> {
  const { alloc } = ctx;
  const ok = await waitForHttp(`http://localhost:${alloc.uiPort}/health`, 60, 'Mini Infra');
  if (!ok) {
    logError(`Mini Infra did not become healthy on port ${alloc.uiPort} within 60s`);
    logError('Last 100 lines of container logs:');
    compose(['logs', '--tail=100', 'mini-infra'], ctx.stackEnv);
    process.exit(1);
  }
  logOk(`Mini Infra is healthy at http://localhost:${alloc.uiPort}`);
}

// ---- summary ---------------------------------------------------------------

/** Print the worktree's endpoints. */
export function summary(ctx: StageContext): void {
  const { alloc, dockerHost } = ctx;
  console.log('');
  logOk(`Mini Infra dev instance for '${alloc.slug}' (slot ${alloc.slot})`);
  console.log('');
  console.log(`  URL:          http://localhost:${alloc.uiPort}`);
  console.log(`  Registry:     localhost:${alloc.registryPort}`);
  console.log(`  Vault:        http://localhost:${alloc.vaultPort}`);
  console.log(`  NATS:         nats://localhost:${alloc.natsClientPort}`);
  console.log(`  NATS monitor: http://localhost:${alloc.natsMonitorPort}`);
  console.log(
    `  HAProxy:      http://localhost:${alloc.haproxyHttpPort}  ` +
      `(https=${alloc.haproxyHttpsPort}, stats=${alloc.haproxyStatsPort}, dataplane=${alloc.haproxyDataplanePort})`,
  );
  console.log(`  Egress pool:  ${alloc.egressPoolCidr}`);
  console.log(`  VM:           ${alloc.vm}`);
  console.log(`  DOCKER_HOST:  ${dockerHost}`);
  console.log('');
  console.log(`  Logs:  DOCKER_HOST=${dockerHost} docker compose -f ${COMPOSE_FILE} -p ${alloc.composeProject} logs -f`);
  console.log(`  Stop:  DOCKER_HOST=${dockerHost} docker compose -f ${COMPOSE_FILE} -p ${alloc.composeProject} down`);
  console.log('  Rebuild:  wt start');
  console.log('  List all: wt list');
  console.log('');
}

/**
 * Tear the stack down without destroying the VM. `wt rm` deletes the VM
 * wholesale, so this exists for the narrower "give me a clean database"
 * case.
 */
export function down(ctx: StageContext, removeVolumes: boolean): void {
  const args = removeVolumes ? ['down', '-v'] : ['down'];
  logInfo(`Stopping ${ctx.alloc.composeProject}${removeVolumes ? ' and removing volumes' : ''}...`);
  compose(args, ctx.stackEnv);
  if (removeVolumes && fs.existsSync(ctx.detailsFile)) {
    fs.rmSync(ctx.detailsFile);
    logInfo('Removed environment-details.xml — the next seed will run from scratch');
  }
  logOk('Stopped');
}
