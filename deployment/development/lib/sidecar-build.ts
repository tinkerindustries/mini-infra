// Sidecar image builder.
//
// The three sidecar images (agent-sidecar, egress-gateway, egress-fw-agent)
// don't depend on the per-worktree Colima/WSL VM at build time — only at
// runtime, where mini-infra-server pulls them from `localhost:<registryPort>`.
// That lets us pre-build them on a host docker daemon (Docker Desktop on Mac)
// in parallel with VM boot, write each image to a docker-loadable tarball,
// then import them into the per-worktree daemon and push to the per-worktree
// registry once the VM is up.
//
// Falls back to building directly on the per-worktree daemon (still in
// parallel across the three images) when no host context is available.
//
// The default builder cache on the host context is reused across worktrees,
// so a second bring-up typically hits cached layers and finishes
// the build phase in seconds.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logInfo, logOk, logWarn } from './log.js';
import { MINI_INFRA_HOME } from './paths.js';

const NEEDS_SHELL = process.platform === 'win32';

export interface SidecarBuildSpec {
  name: string;
  dockerfile: string;
  contextDir: string;
  tag: string;
}

export interface SidecarTarball {
  name: string;
  tag: string;
  tarPath: string;
  durationMs: number;
}

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function runCapture(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...(env || {}) },
      shell: NEEDS_SHELL,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => resolve({ stdout, stderr, status: code ?? 1 }));
    child.on('error', (err) => resolve({ stdout, stderr: stderr + err.message, status: 1 }));
  });
}

function dockerContextExists(name: string): boolean {
  const res = spawnSync('docker', ['context', 'inspect', name], {
    encoding: 'utf8',
    shell: NEEDS_SHELL,
  });
  return res.status === 0;
}

// Returns the docker context to use for host-side sidecar builds, or null if
// none is available. Override with MINI_INFRA_BUILD_CONTEXT. Set
// MINI_INFRA_BUILD_CONTEXT=disabled to force the per-worktree fallback.
export function detectHostBuildContext(): string | null {
  const override = process.env.MINI_INFRA_BUILD_CONTEXT;
  if (override === 'disabled') return null;
  if (override) return dockerContextExists(override) ? override : null;
  const candidates = process.platform === 'darwin' ? ['desktop-linux'] : ['default', 'desktop-linux'];
  for (const c of candidates) {
    if (dockerContextExists(c)) return c;
  }
  return null;
}

export function ensureBuildOutputDir(): string {
  const dir = path.join(MINI_INFRA_HOME, 'build-output');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Builds a single sidecar to a docker-loadable tarball. Reuses whatever the
// host context's default builder caches in its daemon, so cross-worktree
// re-runs hit warm layers.
async function buildOneToTarball(
  spec: SidecarBuildSpec,
  context: string,
  outputDir: string,
): Promise<SidecarTarball> {
  const start = Date.now();
  const tarPath = path.join(outputDir, `${spec.name}.tar`);
  const args = [
    '--context',
    context,
    'buildx',
    'build',
    '-t',
    spec.tag,
    '-f',
    spec.dockerfile,
    '--output',
    `type=docker,dest=${tarPath}`,
    spec.contextDir,
  ];
  const res = await runCapture('docker', args);
  if (res.status !== 0) {
    throw new Error(
      `docker buildx build failed for ${spec.name} (exit ${res.status}). ` +
        `Last stderr lines:\n${tailLines(res.stderr, 30)}`,
    );
  }
  return {
    name: spec.name,
    tag: spec.tag,
    tarPath,
    durationMs: Date.now() - start,
  };
}

export async function buildSidecarsToTarballs(
  specs: SidecarBuildSpec[],
  context: string,
  outputDir: string,
): Promise<SidecarTarball[]> {
  for (const s of specs) logInfo(`Starting host build for ${s.name} (context=${context})`);
  const promises = specs.map((s) => buildOneToTarball(s, context, outputDir));
  const tarballs = await Promise.all(promises);
  for (const t of tarballs) {
    logOk(`Built ${t.name} on host (${(t.durationMs / 1000).toFixed(1)}s) → ${path.basename(t.tarPath)}`);
  }
  return tarballs;
}

// Loads each prebuilt tarball into the per-worktree daemon (the tarball
// preserves the tag baked in at build time) and pushes it to the per-worktree
// registry. Runs in parallel across images.
export async function loadAndPushSidecars(
  tarballs: SidecarTarball[],
  dockerHost: string,
): Promise<void> {
  const env = { DOCKER_HOST: dockerHost };
  const promises = tarballs.map(async (t) => {
    const start = Date.now();
    const load = await runCapture('docker', ['load', '-i', t.tarPath], env);
    if (load.status !== 0) {
      throw new Error(
        `docker load failed for ${t.name} (exit ${load.status}):\n${tailLines(load.stderr, 30)}`,
      );
    }
    const push = await runCapture('docker', ['push', t.tag], env);
    if (push.status !== 0) {
      throw new Error(
        `docker push failed for ${t.name} (exit ${push.status}):\n${tailLines(push.stderr, 30)}`,
      );
    }
    logOk(`Mirrored ${t.name} → per-worktree registry (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  });
  await Promise.all(promises);
}

// Fallback path: build + push directly on the per-worktree daemon. Still
// runs the three builds in parallel.
export async function buildAndPushOnPerWorktree(
  specs: SidecarBuildSpec[],
  dockerHost: string,
): Promise<void> {
  const env = { DOCKER_HOST: dockerHost };
  for (const s of specs) logInfo(`Starting per-worktree build for ${s.name}`);
  const promises = specs.map(async (s) => {
    const start = Date.now();
    const build = await runCapture(
      'docker',
      ['build', '-t', s.tag, '-f', s.dockerfile, s.contextDir],
      env,
    );
    if (build.status !== 0) {
      throw new Error(
        `docker build failed for ${s.name} (exit ${build.status}):\n${tailLines(build.stderr, 30)}`,
      );
    }
    const push = await runCapture('docker', ['push', s.tag], env);
    if (push.status !== 0) {
      throw new Error(
        `docker push failed for ${s.name} (exit ${push.status}):\n${tailLines(push.stderr, 30)}`,
      );
    }
    logOk(`Built + pushed ${s.name} on per-worktree (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  });
  await Promise.all(promises);
}

function tailLines(s: string, n: number): string {
  const lines = s.split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

// Convenience: choose host or per-worktree path. Awaits an already-running
// host build promise if one was started before VM boot; otherwise falls back
// to building on the per-worktree daemon.
export async function finalizeSidecarImages(
  specs: SidecarBuildSpec[],
  hostBuildPromise: Promise<SidecarTarball[]> | null,
  dockerHost: string,
): Promise<void> {
  if (hostBuildPromise) {
    try {
      const tarballs = await hostBuildPromise;
      logInfo('Loading sidecar images into per-worktree daemon...');
      await loadAndPushSidecars(tarballs, dockerHost);
      return;
    } catch (err) {
      logWarn(
        `Host build failed; falling back to per-worktree build: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  logInfo('Building sidecars on per-worktree daemon (parallel)...');
  await buildAndPushOnPerWorktree(specs, dockerHost);
}
