import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dockerEndpoint,
  loadAllocation,
  NotInitialisedError,
  pickDriver,
  PORT_RESOURCES,
  type Allocation,
} from '../lib/allocation.js';

// The full set of emit.env keys wt.yaml declares, at slot 3 off the
// registered band bases.
const HOOK_ENV: Record<string, string> = {
  MINI_INFRA_SLUG: 'tunnel-retry',
  MINI_INFRA_SLOT: '3',
  MINI_INFRA_VM: 'mini-infra-tunnel-retry-3',
  COMPOSE_PROJECT_NAME: 'mini-infra-tunnel-retry-3',
  EGRESS_POOL_CIDR: '172.30.8.0/22',
  UI_PORT: '9203',
  REGISTRY_PORT: '9213',
  VAULT_PORT: '9223',
  DOCKER_PORT: '9233',
  HAPROXY_HTTP_PORT: '9243',
  HAPROXY_HTTPS_PORT: '9253',
  HAPROXY_STATS_PORT: '9263',
  HAPROXY_DATAPLANE_PORT: '9273',
  NATS_CLIENT_PORT: '9283',
  NATS_MONITOR_PORT: '9293',
};

const TOUCHED = [...Object.keys(HOOK_ENV), 'MINI_INFRA_DRIVER'];
let saved: Record<string, string | undefined> = {};

function setHookEnv(overrides: Record<string, string | undefined> = {}): void {
  for (const [k, v] of Object.entries({ ...HOOK_ENV, ...overrides })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED) delete process.env[k];
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('loadAllocation from the hook environment', () => {
  it('reads every resource', () => {
    setHookEnv();
    const a = loadAllocation('/nonexistent');
    expect(a).toEqual<Allocation>({
      slug: 'tunnel-retry',
      slot: 3,
      vm: 'mini-infra-tunnel-retry-3',
      composeProject: 'mini-infra-tunnel-retry-3',
      egressPoolCidr: '172.30.8.0/22',
      uiPort: 9203,
      registryPort: 9213,
      vaultPort: 9223,
      dockerPort: 9233,
      haproxyHttpPort: 9243,
      haproxyHttpsPort: 9253,
      haproxyStatsPort: 9263,
      haproxyDataplanePort: 9273,
      natsClientPort: 9283,
      natsMonitorPort: 9293,
    });
  });

  it('declares one env key per port resource', () => {
    for (const r of PORT_RESOURCES) {
      expect(HOOK_ENV).toHaveProperty(`${r.toUpperCase()}_PORT`);
    }
  });

  // A shell that inherited some of the keys must not be treated as a hook
  // environment: the two sources are never mixed, so a partial environment
  // falls through to the descriptor (absent here) and refuses.
  it.each(Object.keys(HOOK_ENV))('refuses when %s is missing rather than half-filling', (key) => {
    setHookEnv({ [key]: undefined });
    expect(() => loadAllocation('/nonexistent')).toThrow(NotInitialisedError);
  });

  it('names `wt init` when there is no allocation at all', () => {
    expect(() => loadAllocation('/nonexistent')).toThrow(/wt init/);
  });
});

describe('dockerEndpoint', () => {
  const alloc = { vm: 'mini-infra-alpha-1', dockerPort: 9231 } as Allocation;

  it('is the profile socket under colima', () => {
    const { dockerHost, dockerSocket } = dockerEndpoint(alloc, 'colima');
    expect(dockerHost).toBe(`unix://${dockerSocket}`);
    expect(dockerSocket).toContain('/.colima/mini-infra-alpha-1/docker.sock');
  });

  it('is the allocated tcp port under wsl', () => {
    expect(dockerEndpoint(alloc, 'wsl')).toEqual({
      dockerHost: 'tcp://localhost:9231',
      dockerSocket: '',
    });
  });
});

describe('pickDriver', () => {
  it('honours an explicit MINI_INFRA_DRIVER', () => {
    process.env.MINI_INFRA_DRIVER = 'wsl';
    expect(pickDriver()).toBe('wsl');
  });

  it('warns and falls back on an unknown value', () => {
    process.env.MINI_INFRA_DRIVER = 'podman';
    const warnings: string[] = [];
    expect(pickDriver((m) => warnings.push(m))).toBe(
      process.platform === 'darwin' ? 'colima' : 'wsl',
    );
    expect(warnings).toHaveLength(1);
  });
});
