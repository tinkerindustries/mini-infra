// The worktree's resource allocation, as worktree-manager resolved it.
//
// This module replaces the port allocator that used to live in registry.ts.
// Nothing here decides anything: wt owns the slot, the ports, the VM name,
// the compose project and the egress CIDR, and this reads them back.
//
// Two sources, in order:
//
//   1. The hook environment. `wt init` and `wt start` export the spec's
//      emit.env keys into every hook process, so a stage invoked as a hook
//      already has all of them.
//   2. `wt show --json`. A developer running `pnpm worktree-env <stage>` by
//      hand has no hook environment, so the descriptor is read directly.
//
// Both carry the same values — the descriptor is what the .env managed block
// and the hook environment are both rendered from.

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

/** The names of the ten port resources in wt.yaml, in declaration order. */
export const PORT_RESOURCES = [
  'ui',
  'registry',
  'vault',
  'docker',
  'haproxy_http',
  'haproxy_https',
  'haproxy_stats',
  'haproxy_dataplane',
  'nats_client',
  'nats_monitor',
] as const;

export type PortResource = (typeof PORT_RESOURCES)[number];

export interface Allocation {
  /** The worktree slug — wt's identity for this tree. */
  slug: string;
  /** The slot index. Slot 0 is the primary checkout and is never allocated. */
  slot: number;
  /** The Colima profile (macOS) or WSL2 distro (Windows) name. */
  vm: string;
  /** The compose project name. */
  composeProject: string;
  /** This worktree's /22 out of the egress pool. */
  egressPoolCidr: string;
  uiPort: number;
  registryPort: number;
  vaultPort: number;
  dockerPort: number;
  haproxyHttpPort: number;
  haproxyHttpsPort: number;
  haproxyStatsPort: number;
  haproxyDataplanePort: number;
  natsClientPort: number;
  natsMonitorPort: number;
}

/**
 * The error thrown when neither source has an allocation. The message names
 * the command that fixes it, because the only cause is an un-initialised
 * worktree.
 */
export class NotInitialisedError extends Error {
  constructor(detail: string) {
    super(
      `This worktree has no environment yet (${detail}).\n` +
        `Run:  wt init --description "<what this worktree is for>"\n` +
        `See docs/wt.md for the full flow.`,
    );
    this.name = 'NotInitialisedError';
  }
}

interface DescriptorShape {
  found?: boolean;
  reason?: string;
  descriptor?: {
    app?: string;
    slug?: string;
    slot?: number;
    resources?: Record<string, { type?: string; value?: string | number }>;
    params?: Record<string, string>;
  };
}

function readDescriptor(cwd: string): DescriptorShape['descriptor'] | null {
  const res = spawnSync('wt', ['show', '--json', '--cwd', cwd], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0 || !res.stdout.trim()) return null;
  try {
    const parsed = JSON.parse(res.stdout) as DescriptorShape;
    if (!parsed.found || !parsed.descriptor) return null;
    return parsed.descriptor;
  } catch {
    return null;
  }
}

function requireNumber(raw: string | number | undefined, name: string): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new NotInitialisedError(`resource '${name}' resolved to '${raw}'`);
  }
  return n;
}

function requireString(raw: string | number | undefined, name: string): string {
  const s = String(raw ?? '').trim();
  if (!s) throw new NotInitialisedError(`resource '${name}' is empty`);
  return s;
}

/**
 * Read the allocation for the worktree rooted at `projectRoot`.
 *
 * The hook environment wins when it is complete. A partial environment — a
 * shell that inherited two of the keys from somewhere — falls through to the
 * descriptor rather than filling the gaps, so the two sources are never
 * mixed.
 */
export function loadAllocation(projectRoot: string): Allocation {
  const env = process.env;
  const fromEnv =
    env.MINI_INFRA_SLUG &&
    env.MINI_INFRA_VM &&
    env.COMPOSE_PROJECT_NAME &&
    env.EGRESS_POOL_CIDR &&
    PORT_RESOURCES.every((r) => env[`${r.toUpperCase()}_PORT`]);

  if (fromEnv) {
    return {
      slug: requireString(env.MINI_INFRA_SLUG, 'slug'),
      slot: requireNumber(env.MINI_INFRA_SLOT, 'slot'),
      vm: requireString(env.MINI_INFRA_VM, 'vm'),
      composeProject: requireString(env.COMPOSE_PROJECT_NAME, 'compose'),
      egressPoolCidr: requireString(env.EGRESS_POOL_CIDR, 'egress'),
      uiPort: requireNumber(env.UI_PORT, 'ui'),
      registryPort: requireNumber(env.REGISTRY_PORT, 'registry'),
      vaultPort: requireNumber(env.VAULT_PORT, 'vault'),
      dockerPort: requireNumber(env.DOCKER_PORT, 'docker'),
      haproxyHttpPort: requireNumber(env.HAPROXY_HTTP_PORT, 'haproxy_http'),
      haproxyHttpsPort: requireNumber(env.HAPROXY_HTTPS_PORT, 'haproxy_https'),
      haproxyStatsPort: requireNumber(env.HAPROXY_STATS_PORT, 'haproxy_stats'),
      haproxyDataplanePort: requireNumber(env.HAPROXY_DATAPLANE_PORT, 'haproxy_dataplane'),
      natsClientPort: requireNumber(env.NATS_CLIENT_PORT, 'nats_client'),
      natsMonitorPort: requireNumber(env.NATS_MONITOR_PORT, 'nats_monitor'),
    };
  }

  const d = readDescriptor(projectRoot);
  if (!d) throw new NotInitialisedError('no hook environment and no descriptor');
  const r = d.resources || {};
  const val = (name: string): string | number | undefined => r[name]?.value;

  // The compose project is not a resource — it lives inside the worktree's own
  // VM, so nothing can collide with it. wt.yaml resolves the same name into
  // COMPOSE_PROJECT_NAME from {app}, {slug} and {slot}; this is that template
  // evaluated against the descriptor, so both paths produce one name.
  const slug = requireString(d.slug, 'slug');
  const slot = requireNumber(d.slot, 'slot');
  const app = requireString(d.app, 'app');

  return {
    slug,
    slot,
    vm: requireString(val('vm'), 'vm'),
    composeProject: `${app}-${slug}-${slot}`,
    egressPoolCidr: requireString(val('egress'), 'egress'),
    uiPort: requireNumber(val('ui'), 'ui'),
    registryPort: requireNumber(val('registry'), 'registry'),
    vaultPort: requireNumber(val('vault'), 'vault'),
    dockerPort: requireNumber(val('docker'), 'docker'),
    haproxyHttpPort: requireNumber(val('haproxy_http'), 'haproxy_http'),
    haproxyHttpsPort: requireNumber(val('haproxy_https'), 'haproxy_https'),
    haproxyStatsPort: requireNumber(val('haproxy_stats'), 'haproxy_stats'),
    haproxyDataplanePort: requireNumber(val('haproxy_dataplane'), 'haproxy_dataplane'),
    natsClientPort: requireNumber(val('nats_client'), 'nats_client'),
    natsMonitorPort: requireNumber(val('nats_monitor'), 'nats_monitor'),
  };
}

export type Driver = 'colima' | 'wsl';

/**
 * The VM driver for this platform. `MINI_INFRA_DRIVER` overrides it; anything
 * else falls back to the platform default. wt's machine driver makes the same
 * choice — this is the TypeScript side agreeing with it, not a second
 * decision.
 */
export function pickDriver(warn?: (msg: string) => void): Driver {
  const env = process.env.MINI_INFRA_DRIVER;
  if (env === 'colima' || env === 'wsl') return env;
  if (env && warn) warn(`Unknown MINI_INFRA_DRIVER='${env}' — falling back to platform default`);
  return process.platform === 'darwin' ? 'colima' : 'wsl';
}

export interface DockerEndpoint {
  /** The DOCKER_HOST value for this worktree's daemon. */
  dockerHost: string;
  /** The host-side unix socket path, or '' under the WSL2 driver. */
  dockerSocket: string;
}

/**
 * Where this worktree's dockerd is reached.
 *
 * DOCKER_HOST is deliberately not an emit.env key: Colima exposes a host-side
 * unix socket under the VM's name and WSL2 exposes only TCP on the allocated
 * docker port, and a static template in wt.yaml cannot branch on the driver.
 * The allocation carries both inputs and this derives the endpoint.
 */
export function dockerEndpoint(alloc: Allocation, driver: Driver): DockerEndpoint {
  if (driver === 'colima') {
    const sock = path.join(process.env.HOME || '', '.colima', alloc.vm, 'docker.sock');
    return { dockerHost: `unix://${sock}`, dockerSocket: sock };
  }
  return { dockerHost: `tcp://localhost:${alloc.dockerPort}`, dockerSocket: '' };
}
