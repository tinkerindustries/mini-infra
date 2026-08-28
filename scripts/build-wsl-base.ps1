# Build the cached Alpine + dockerd WSL2 base tarball used by the
# per-worktree dev flow on Windows. Produces ~\.mini-infra\wsl-base.tar.
#
# Re-run any time you want to refresh Alpine/dockerd versions.
#
# Usage:
#   .\scripts\build-wsl-base.ps1                       # default Alpine version
#   .\scripts\build-wsl-base.ps1 -AlpineVersion 3.22.1
#   .\scripts\build-wsl-base.ps1 -Force                # rebuild even if cached
#
# Requires: WSL2 enabled (`wsl --status`), internet access.

[CmdletBinding()]
param(
    [string]$AlpineVersion = '3.21.0',
    [string]$Architecture = 'x86_64',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Write-Step  { param($Msg) Write-Host "[base] $Msg" -ForegroundColor Cyan }
function Write-Ok    { param($Msg) Write-Host "[base] $Msg" -ForegroundColor Green }
function Write-WarnX { param($Msg) Write-Host "[base] $Msg" -ForegroundColor Yellow }

$MiniInfraHome = if ($env:MINI_INFRA_HOME) { $env:MINI_INFRA_HOME } else { Join-Path $env:USERPROFILE '.mini-infra' }
$BaseTarball   = Join-Path $MiniInfraHome 'wsl-base.tar'
$WorkDir       = Join-Path $env:TEMP "mini-infra-wsl-base-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$BuilderName   = 'mini-infra-builder'

if ((Test-Path $BaseTarball) -and -not $Force) {
    Write-WarnX "Base tarball already exists at $BaseTarball"
    Write-WarnX 'Pass -Force to rebuild.'
    exit 0
}

# Sanity check WSL is available
try {
    $wslVersion = & wsl.exe --version 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'wsl --version returned non-zero' }
} catch {
    Write-Error 'WSL2 is not available. Run `wsl --install` (admin) and reboot, then re-run this script.'
    exit 1
}

# `wsl --list --quiet` writes UTF-16 LE on Windows. Decode it ourselves so
# regex matches don't get tripped up by interleaved null bytes.
function Get-WslDistroNames {
    $proc = Start-Process -FilePath 'wsl.exe' -ArgumentList '--list', '--quiet' `
        -RedirectStandardOutput "$env:TEMP\wsl-list.tmp" -NoNewWindow -Wait -PassThru
    $bytes = [System.IO.File]::ReadAllBytes("$env:TEMP\wsl-list.tmp")
    Remove-Item "$env:TEMP\wsl-list.tmp" -Force -ErrorAction SilentlyContinue
    $text = [System.Text.Encoding]::Unicode.GetString($bytes)
    return $text -split "[`r`n]+" | ForEach-Object { $_.Trim() } | Where-Object { $_ }
}

# Clean up any stale builder distro from a previous failed run
if (Get-WslDistroNames | Where-Object { $_ -eq $BuilderName }) {
    Write-WarnX "Stale builder distro '$BuilderName' found — unregistering"
    & wsl.exe --unregister $BuilderName | Out-Null
}

New-Item -ItemType Directory -Path $MiniInfraHome -Force | Out-Null
New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null

try {
    # 1. Download minirootfs + checksum
    $base = "https://dl-cdn.alpinelinux.org/alpine/v$($AlpineVersion.Substring(0, $AlpineVersion.LastIndexOf('.')))/releases/$Architecture"
    $rootfsName = "alpine-minirootfs-$AlpineVersion-$Architecture.tar.gz"
    $rootfsUrl  = "$base/$rootfsName"
    $shaUrl     = "$rootfsUrl.sha256"
    $rootfsPath = Join-Path $WorkDir $rootfsName
    $shaPath    = "$rootfsPath.sha256"

    Write-Step "Downloading $rootfsUrl"
    Invoke-WebRequest -Uri $rootfsUrl -OutFile $rootfsPath -UseBasicParsing
    Invoke-WebRequest -Uri $shaUrl    -OutFile $shaPath    -UseBasicParsing

    $expectedHash = (Get-Content $shaPath -Raw).Split()[0].Trim().ToLower()
    $actualHash   = (Get-FileHash -Algorithm SHA256 $rootfsPath).Hash.ToLower()
    if ($expectedHash -ne $actualHash) {
        throw "SHA256 mismatch — expected $expectedHash, got $actualHash. Refusing to import a tampered rootfs."
    }
    Write-Ok 'Rootfs checksum verified'

    # 2. Import as builder distro
    $builderInstallDir = Join-Path $WorkDir 'builder-vhdx'
    New-Item -ItemType Directory -Path $builderInstallDir -Force | Out-Null

    Write-Step "Importing $BuilderName"
    & wsl.exe --import $BuilderName $builderInstallDir $rootfsPath
    if ($LASTEXITCODE -ne 0) { throw 'wsl --import failed' }

    # 3. Provision: write script to a host-side path and run it inside the distro.
    # Uses a heredoc-style here-string with literal markers so $-vars in the
    # script aren't expanded by PowerShell.
    $provisioning = @'
#!/bin/sh
set -eu

apk update
apk add --no-cache docker iptables ip6tables ipset ca-certificates procps util-linux

# Alpine 3.18+ ships nf_tables-backed iptables by default; dockerd's bridge
# networking needs the legacy backend. Symlink it as the default iptables.
if [ -e /sbin/iptables-legacy ]; then
  ln -sf /sbin/iptables-legacy  /sbin/iptables
  ln -sf /sbin/ip6tables-legacy /sbin/ip6tables
fi

mkdir -p /etc/mini-infra /var/log/mini-infra

# dockerd starter, called by lib/wsl.ts via `wsl -d <distro> -- /etc/mini-infra/start-dockerd.sh <port>`.
# Uses `setsid -f` (from util-linux) to reparent dockerd to init so it
# survives after the wsl-session shell exits. Idempotent — re-running while
# dockerd is already up is a no-op.
cat > /etc/mini-infra/start-dockerd.sh <<'STARTEOF'
#!/bin/sh
set -eu
PORT="${1:?docker port required}"
mkdir -p /var/run /var/log/mini-infra
if pgrep -x dockerd >/dev/null 2>&1; then
  exit 0
fi
: > /var/log/mini-infra/dockerd.log
setsid -f sh -c "dockerd -H tcp://0.0.0.0:${PORT} -H unix:///var/run/docker.sock --iptables=true >/var/log/mini-infra/dockerd.log 2>&1"
STARTEOF
chmod +x /etc/mini-infra/start-dockerd.sh

cat > /etc/mini-infra/dockerd-ready.sh <<'READYEOF'
#!/bin/sh
docker -H unix:///var/run/docker.sock info >/dev/null 2>&1
READYEOF
chmod +x /etc/mini-infra/dockerd-ready.sh

# /etc/wsl.conf — disable automount (we never need /mnt/c from a per-worktree
# distro) and Windows-PATH appending (otherwise WSL spams "Failed to translate"
# warnings for every Windows PATH entry on every wsl invocation).
cat > /etc/wsl.conf <<'WSLEOF'
[automount]
enabled = false

[interop]
enabled = false
appendWindowsPath = false

[network]
generateResolvConf = true
WSLEOF

dockerd --version
docker --version
echo '[base] provisioning complete'
'@

    $provisioningPath = Join-Path $WorkDir 'provision.sh'
    # UTF-8 without BOM, LF line endings — the distro is Linux.
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($provisioningPath, ($provisioning -replace "`r`n", "`n"), $utf8NoBom)

    # Translate the Windows path to its WSL2 mount path (`C:\foo\bar` →
    # `/mnt/c/foo/bar`). Doing this in PS avoids quoting headaches that
    # come up when relaying backslashed paths through wsl.exe to wslpath.
    $linuxPath = '/mnt/' + $provisioningPath.Substring(0,1).ToLower() + ($provisioningPath.Substring(2) -replace '\\','/')

    Write-Step "Running provisioning script inside builder distro ($linuxPath)"
    & wsl.exe -d $BuilderName -- sh $linuxPath
    if ($LASTEXITCODE -ne 0) { throw 'Provisioning script failed inside builder distro' }
    Write-Ok 'Builder distro provisioned'

    # 4. Shut the distro down cleanly so the export is consistent.
    Write-Step "Shutting down $BuilderName"
    & wsl.exe --terminate $BuilderName | Out-Null

    # 5. Export to the cache location.
    Write-Step "Exporting to $BaseTarball"
    if (Test-Path $BaseTarball) { Remove-Item $BaseTarball -Force }
    & wsl.exe --export $BuilderName $BaseTarball
    if ($LASTEXITCODE -ne 0) { throw 'wsl --export failed' }

    $sizeMb = [math]::Round((Get-Item $BaseTarball).Length / 1MB, 1)
    Write-Ok "Base tarball: $BaseTarball ($sizeMb MB)"
}
finally {
    # 6. Clean up the builder regardless of success.
    if (Get-WslDistroNames | Where-Object { $_ -eq $BuilderName }) {
        Write-Step "Unregistering builder distro"
        & wsl.exe --unregister $BuilderName | Out-Null
    }
    if (Test-Path $WorkDir) {
        Remove-Item -Recurse -Force $WorkDir -ErrorAction SilentlyContinue
    }
}

Write-Ok 'Done. Run `wt init --description "<what this worktree is for>"` next.'
