import * as fs from 'node:fs';

import type { SeedProfile } from './paths.js';

export interface XmlAdminDetails {
  email?: string;
  password?: string;
  apiKey?: string;
  vaultPassphrase?: string;
}

export interface EnvironmentDetailsSummary {
  seeded: boolean;
  admin: XmlAdminDetails;
  description?: { short?: string; long?: string };
  seedProfile?: SeedProfile;
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractTag(xml: string, tag: string, parent?: string): string | undefined {
  let scope = xml;
  if (parent) {
    const parentMatch = new RegExp(`<${parent}>([\\s\\S]*?)<\\/${parent}>`).exec(xml);
    if (!parentMatch) return undefined;
    scope = parentMatch[1];
  }
  const m = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(scope);
  if (!m) return undefined;
  return xmlUnescape(m[1]);
}

export function readEnvironmentDetails(filePath: string): EnvironmentDetailsSummary | null {
  if (!fs.existsSync(filePath)) return null;
  const xml = fs.readFileSync(filePath, 'utf8');
  const seeded = (extractTag(xml, 'seeded') || '').trim().toLowerCase() === 'true';
  const profileTag = (extractTag(xml, 'seedProfile') || '').trim();
  const seedProfile: SeedProfile | undefined =
    profileTag === 'minimal' || profileTag === 'full' ? profileTag : undefined;
  return {
    seeded,
    admin: {
      email: extractTag(xml, 'email', 'admin'),
      password: extractTag(xml, 'password', 'admin'),
      apiKey: extractTag(xml, 'apiKey', 'admin'),
      vaultPassphrase: extractTag(xml, 'vaultPassphrase', 'admin'),
    },
    description: {
      short: extractTag(xml, 'short', 'description'),
      long: extractTag(xml, 'long', 'description'),
    },
    seedProfile,
  };
}

export interface MinimalEnvironmentDetailsInput {
  profile: string;
  projectRoot: string;
  dockerHost: string;
  dockerSocket: string;
  composeProject: string;
  uiPort: number;
  registryPort: number;
  vaultPort: number;
  natsClientPort: number;
  natsMonitorPort: number;
  egressPool: string;
  agentSidecarImageTag: string;
  shortDescription?: string;
  longDescription?: string;
  seedProfile?: SeedProfile;
}

function isoWithUtcOffset(): string {
  // Match Python's datetime.now(timezone.utc).isoformat(timespec='seconds').
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

function buildDescriptionBlock(short?: string, long?: string): string {
  if (!short && !long) return '';
  const t = (v: string | undefined): string => xmlEscape(v || '');
  const lines = ['  <description>'];
  if (short) lines.push(`    <short>${t(short)}</short>`);
  if (long) lines.push(`    <long>${t(long)}</long>`);
  lines.push('  </description>');
  return lines.join('\n') + '\n';
}

export function writeMinimalEnvironmentDetails(
  filePath: string,
  input: MinimalEnvironmentDetailsInput,
): void {
  const descBlock = buildDescriptionBlock(input.shortDescription, input.longDescription);
  const profileLine = input.seedProfile ? `  <seedProfile>${xmlEscape(input.seedProfile)}</seedProfile>\n` : '';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<environment>
  <generated>${xmlEscape(isoWithUtcOffset())}</generated>
${descBlock}${profileLine}  <seeded>false</seeded>
  <worktree>
    <profile>${xmlEscape(input.profile)}</profile>
    <path>${xmlEscape(input.projectRoot)}</path>
    <dockerHost>${xmlEscape(input.dockerHost)}</dockerHost>
    <dockerSocket>${xmlEscape(input.dockerSocket)}</dockerSocket>
    <composeProject>${xmlEscape(input.composeProject)}</composeProject>
  </worktree>
  <endpoints>
    <ui>http://localhost:${input.uiPort}</ui>
    <registry>localhost:${input.registryPort}</registry>
    <vault>http://localhost:${input.vaultPort}</vault>
    <natsClient>nats://localhost:${input.natsClientPort}</natsClient>
    <natsMonitor>http://localhost:${input.natsMonitorPort}</natsMonitor>
  </endpoints>
  <egressPool>${xmlEscape(input.egressPool)}</egressPool>
  <images>
    <agentSidecar>${xmlEscape(input.agentSidecarImageTag)}</agentSidecar>
  </images>
</environment>
`;
  fs.writeFileSync(filePath, xml);
}

export interface StackSummary {
  id?: string;
  name?: string;
  status?: string;
  lastAppliedAt?: string;
}

export interface LocalEnvironmentSummary {
  id?: string;
  name?: string;
  type?: string;
  networkType?: string;
}

export interface FullEnvironmentDetailsInput {
  profile: string;
  projectRoot: string;
  dockerHost: string;
  composeProject: string;
  uiPort: number;
  registryPort: number;
  vaultPort: number;
  natsClientPort: number;
  natsMonitorPort: number;
  egressPool: string;
  agentSidecarImageTag: string;
  adminEmail: string;
  adminPassword: string;
  apiKey: string;
  vaultPassphrase: string;
  azureConfigured: boolean;
  cloudflareConfigured: boolean;
  githubConfigured: boolean;
  tailscaleConfigured: boolean;
  localEnvironment: LocalEnvironmentSummary | null;
  stacks: StackSummary[];
  shortDescription?: string;
  longDescription?: string;
  seedProfile?: SeedProfile;
}

export function writeFullEnvironmentDetails(
  filePath: string,
  input: FullEnvironmentDetailsInput,
): void {
  // Downstream skills (test-dev, fix-and-validate, diagnose-dev,
  // owasp-zap-guide) read this file via xmllint — keep tag names and nesting
  // stable.
  const t = (v: string | undefined): string => xmlEscape(v || '');

  const stacksXml = input.stacks
    .map(
      (s) =>
        `    <stack>\n` +
        `      <id>${t(s.id)}</id>\n` +
        `      <name>${t(s.name)}</name>\n` +
        `      <status>${t(s.status)}</status>\n` +
        `      <lastAppliedAt>${t(s.lastAppliedAt)}</lastAppliedAt>\n` +
        `    </stack>`,
    )
    .join('\n');

  const localEnvBlock = input.localEnvironment
    ? `  <localEnvironment>\n` +
      `    <id>${t(input.localEnvironment.id)}</id>\n` +
      `    <name>${t(input.localEnvironment.name)}</name>\n` +
      `    <type>${t(input.localEnvironment.type)}</type>\n` +
      `    <networkType>${t(input.localEnvironment.networkType)}</networkType>\n` +
      `  </localEnvironment>`
    : '';

  const descBlock = buildDescriptionBlock(input.shortDescription, input.longDescription);
  const profileLine = input.seedProfile ? `  <seedProfile>${t(input.seedProfile)}</seedProfile>\n` : '';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<environment>
  <generated>${t(isoWithUtcOffset())}</generated>
${descBlock}${profileLine}  <seeded>true</seeded>
  <worktree>
    <profile>${t(input.profile)}</profile>
    <path>${t(input.projectRoot)}</path>
    <dockerHost>${t(input.dockerHost)}</dockerHost>
    <composeProject>${t(input.composeProject)}</composeProject>
  </worktree>
  <endpoints>
    <ui>http://localhost:${input.uiPort}</ui>
    <registry>localhost:${input.registryPort}</registry>
    <vault>http://localhost:${input.vaultPort}</vault>
    <natsClient>nats://localhost:${input.natsClientPort}</natsClient>
    <natsMonitor>http://localhost:${input.natsMonitorPort}</natsMonitor>
  </endpoints>
  <egressPool>${t(input.egressPool)}</egressPool>
  <images>
    <agentSidecar>${t(input.agentSidecarImageTag)}</agentSidecar>
  </images>
  <admin>
    <email>${t(input.adminEmail)}</email>
    <password>${t(input.adminPassword)}</password>
    <apiKey>${t(input.apiKey)}</apiKey>
    <vaultPassphrase>${t(input.vaultPassphrase)}</vaultPassphrase>
  </admin>
  <connectedServices>
    <azure configured="${input.azureConfigured}"/>
    <cloudflare configured="${input.cloudflareConfigured}"/>
    <github configured="${input.githubConfigured}"/>
    <tailscale configured="${input.tailscaleConfigured}"/>
  </connectedServices>
${localEnvBlock}
  <stacks>
${stacksXml}
  </stacks>
</environment>
`;
  fs.writeFileSync(filePath, xml);
}
