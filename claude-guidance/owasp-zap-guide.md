# OWASP ZAP Docker Penetration Testing Guide

This guide covers how to use OWASP ZAP (Zed Attack Proxy) CLI from Docker to perform security testing on web applications.

## Prerequisites

- Docker installed and running
- Target website/application to test
- Appropriate authorization to perform security testing

**⚠️ IMPORTANT**: Only perform penetration testing on systems you own or have explicit written permission to test. Unauthorized security testing may be illegal.

## Quick Start

### 1. Baseline Scan (Passive Scanning)
The fastest option - spiders your site and runs passive scans only:

```bash
docker run --rm -t ghcr.io/zaproxy/zaproxy:stable zap-baseline.py -t https://your-website.com
```

### 2. Full Scan (Active Scanning)
More thorough but takes longer - includes active attack simulations:

```bash
docker run --rm -t ghcr.io/zaproxy/zaproxy:stable zap-full-scan.py -t https://your-website.com
```

### 3. API Scan
For testing REST APIs with OpenAPI/Swagger definitions:

```bash
docker run --rm -t ghcr.io/zaproxy/zaproxy:stable zap-api-scan.py \
  -t https://your-website.com/api \
  -f openapi
```

## Scan Types Explained

### Baseline Scan
- **Speed**: Fast (minutes)
- **Coverage**: Passive scanning only
- **Risk**: Low risk of breaking things
- **Use Case**: Quick security checks, CI/CD integration

### Full Scan
- **Speed**: Slow (hours)
- **Coverage**: Active + passive scanning
- **Risk**: May trigger security alerts, can affect application
- **Use Case**: Comprehensive security assessment

### API Scan
- **Speed**: Medium
- **Coverage**: API-specific attacks
- **Risk**: Medium
- **Use Case**: REST API security testing

## Generating Reports

### Create Reports Directory

**Linux/Mac/Git Bash:**
```bash
mkdir -p ./zap-reports
```

**Windows PowerShell:**
```powershell
mkdir zap-reports -ErrorAction SilentlyContinue
```

### HTML Report

**Linux/Mac/Git Bash:**
```bash
docker run --rm -v $(pwd)/zap-reports:/zap/wrk:rw \
  -t ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py \
  -t https://your-website.com \
  -r report.html
```

**Windows PowerShell:**
```powershell
docker run --rm -v ${PWD}/zap-reports:/zap/wrk:rw `
  -t ghcr.io/zaproxy/zaproxy:stable `
  zap-baseline.py `
  -t https://your-website.com `
  -r report.html
```

### JSON Report

```bash
docker run --rm -v $(pwd)/zap-reports:/zap/wrk:rw \
  -t ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py \
  -t https://your-website.com \
  -J report.json
```

### Multiple Report Formats

**Linux/Mac/Git Bash:**
```bash
docker run --rm -v $(pwd)/zap-reports:/zap/wrk:rw \
  -t ghcr.io/zaproxy/zaproxy:stable \
  zap-full-scan.py \
  -t https://your-website.com \
  -r scan-report.html \
  -J scan-report.json \
  -x scan-report.xml
```

**Windows PowerShell:**
```powershell
docker run --rm -v ${PWD}/zap-reports:/zap/wrk:rw `
  -t ghcr.io/zaproxy/zaproxy:stable `
  zap-full-scan.py `
  -t https://your-website.com `
  -r scan-report.html `
  -J scan-report.json `
  -x scan-report.xml
```

## Testing Local Services

### Testing Localhost Applications

When testing Mini Infra on your host machine, resolve the current dev URL from `environment-details.xml` at the project root rather than hardcoding a port:

**Linux/Mac:**
```bash
MINI_INFRA_URL=$(xmllint --xpath 'string(//environment/endpoints/ui)' environment-details.xml)
docker run --rm --network host \
  -v $(pwd)/zap-reports:/zap/wrk:rw \
  -t ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py \
  -t "$MINI_INFRA_URL"
```

**Windows:**
```powershell
# Swap localhost for host.docker.internal so the ZAP container can reach the host.
$port = ([xml](Get-Content environment-details.xml)).environment.endpoints.ui -replace '^http://localhost:', ''
$target = "http://host.docker.internal:$port"
docker run --rm -v ${PWD}/zap-reports:/zap/wrk:rw `
  -t ghcr.io/zaproxy/zaproxy:stable `
  zap-baseline.py `
  -t $target
```

### Testing Mini Infra Application

Resolve the dev URL from `environment-details.xml` at the project root (written by the seeder during `wt start`) instead of hardcoding a port — each worktree instance listens on a different host port.

**Development Environment:**
```bash
# Linux/Mac
MINI_INFRA_URL=$(xmllint --xpath 'string(//environment/endpoints/ui)' environment-details.xml)
docker run --rm --network host \
  -v $(pwd)/zap-reports:/zap/wrk:rw \
  -t ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py \
  -t "$MINI_INFRA_URL" \
  -r mini-infra-scan.html
```

```powershell
# Windows — swap localhost for host.docker.internal so the ZAP container can reach the host
$port = ([xml](Get-Content environment-details.xml)).environment.endpoints.ui -replace '^http://localhost:', ''
$target = "http://host.docker.internal:$port"
docker run --rm -v ${PWD}/zap-reports:/zap/wrk:rw `
  -t ghcr.io/zaproxy/zaproxy:stable `
  zap-baseline.py `
  -t $target `
  -r mini-infra-scan.html
```

## Advanced Options

### Common ZAP CLI Options

- `-t <target>` - Target URL to scan (required)
- `-r <filename>` - HTML report filename
- `-J <filename>` - JSON report filename
- `-x <filename>` - XML report filename
- `-m <filename>` - Markdown report filename
- `-g <config>` - Generate default configuration file
- `-d` - Show debug messages
- `-P <port>` - Port for ZAP proxy (default: random)
- `-l <level>` - Minimum alert level to report (PASS, IGNORE, INFO, WARN, FAIL)
- `-n <context>` - Context file for authentication
- `-U <user>` - Username for authenticated scans
- `-z <args>` - ZAP command line options

### Setting Alert Threshold

Only report warnings and failures:
```bash
docker run --rm -v $(pwd)/zap-reports:/zap/wrk:rw \
  -t ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py \
  -t https://your-website.com \
  -l WARN \
  -r report.html
```

### Debug Mode

Show detailed debug output:
```bash
docker run --rm -v $(pwd)/zap-reports:/zap/wrk:rw \
  -t ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py \
  -t https://your-website.com \
  -d
```

### Custom Configuration

Add custom ZAP options:
```bash
docker run --rm -v $(pwd)/zap-reports:/zap/wrk:rw \
  -t ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py \
  -t https://your-website.com \
  -z "-config api.addrs.addr.name=.* -config api.addrs.addr.regex=true"
```

## Authentication

### Basic Authentication

For sites with HTTP Basic Auth:
```bash
docker run --rm -v $(pwd)/zap-reports:/zap/wrk:rw \
  -t ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py \
  -t https://your-website.com \
  -z "-config connection.timeoutInSecs=60"
```

### Form-Based Authentication

For complex authentication, you'll need to create a context file. Create `auth-context.context` with your authentication setup, then:

```bash
docker run --rm \
  -v $(pwd)/zap-reports:/zap/wrk:rw \
  -v $(pwd)/auth-context.context:/zap/wrk/auth-context.context:ro \
  -t ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py \
  -t https://your-website.com \
  -n auth-context.context
```

## CI/CD Integration

### Exit Codes

ZAP scans exit with different codes based on findings:
- `0` - No alerts found
- `1` - Alerts found at or above threshold
- `2` - ZAP error occurred

### Example GitHub Actions

```yaml
name: ZAP Security Scan

on:
  pull_request:
  schedule:
    - cron: '0 2 * * 1'  # Weekly on Mondays

jobs:
  zap_scan:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Run ZAP Baseline Scan
        run: |
          mkdir -p zap-reports
          docker run --rm -v $(pwd)/zap-reports:/zap/wrk:rw \
            -t ghcr.io/zaproxy/zaproxy:stable \
            zap-baseline.py \
            -t ${{ secrets.TARGET_URL }} \
            -r scan-report.html \
            -J scan-report.json

      - name: Upload ZAP Reports
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: zap-reports
          path: zap-reports/
```

## Best Practices

### 1. Start with Baseline Scans
- Run baseline scans first to understand the security posture
- Less intrusive, safe for production environments
- Good for regular automated scanning

### 2. Schedule Full Scans Carefully
- Run full scans during maintenance windows
- Active scanning can trigger security alerts
- May affect application performance

### 3. Review Reports Regularly
- Don't just collect reports - review and act on findings
- Prioritize high and medium severity issues
- Track remediation progress over time

### 4. Use in Staging First
- Test scanning on staging/development environments first
- Understand false positives before production scanning
- Tune configurations based on your application

### 5. Keep ZAP Updated
- Pull the latest image regularly: `docker pull ghcr.io/zaproxy/zaproxy:stable`
- New vulnerability checks are added frequently
- Security tools need to stay current

## Troubleshooting

### Scan Takes Too Long

Reduce scan scope:
```bash
docker run --rm -v $(pwd)/zap-reports:/zap/wrk:rw \
  -t ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py \
  -t https://your-website.com \
  -z "-config spider.maxDuration=10"  # Limit spider to 10 minutes
```

### Connection Timeouts

Increase timeout:
```bash
docker run --rm -v $(pwd)/zap-reports:/zap/wrk:rw \
  -t ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py \
  -t https://your-website.com \
  -z "-config connection.timeoutInSecs=120"
```

### Too Many False Positives

Adjust alert threshold:
```bash
docker run --rm -v $(pwd)/zap-reports:/zap/wrk:rw \
  -t ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py \
  -t https://your-website.com \
  -l WARN  # Only show warnings and failures
```

### Cannot Access Local Services

Make sure you're using the correct network configuration:
- **Linux/Mac**: Use `--network host`
- **Windows**: Use `host.docker.internal` instead of `localhost`

## Example Scan Scripts

### Quick Security Check Script

Create `quick-scan.sh`:
```bash
#!/bin/bash
# Default target resolves from environment-details.xml; override with $1 if needed.
TARGET=${1:-$(xmllint --xpath 'string(//environment/endpoints/ui)' environment-details.xml)}
REPORT_DIR="./zap-reports"

mkdir -p "$REPORT_DIR"

echo "Running ZAP baseline scan against $TARGET..."
docker run --rm -v "$(pwd)/$REPORT_DIR:/zap/wrk:rw" \
  -t ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py \
  -t "$TARGET" \
  -r baseline-$(date +%Y%m%d-%H%M%S).html \
  -J baseline-$(date +%Y%m%d-%H%M%S).json

echo "Scan complete! Reports saved to $REPORT_DIR"
```

Usage:
```bash
chmod +x quick-scan.sh
./quick-scan.sh https://your-website.com
```

### Windows PowerShell Script

Create `quick-scan.ps1`:
```powershell
param(
    # Default: convert localhost URL from environment-details.xml to host.docker.internal
    # so the ZAP container can reach the host — override with -Target if needed.
    [string]$Target = $(
        $port = ([xml](Get-Content environment-details.xml)).environment.endpoints.ui -replace '^http://localhost:', ''
        "http://host.docker.internal:$port"
    )
)

$ReportDir = "./zap-reports"
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"

# Create reports directory
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null

Write-Host "Running ZAP baseline scan against $Target..." -ForegroundColor Cyan

docker run --rm -v "${PWD}/$ReportDir:/zap/wrk:rw" `
  -t ghcr.io/zaproxy/zaproxy:stable `
  zap-baseline.py `
  -t $Target `
  -r "baseline-$Timestamp.html" `
  -J "baseline-$Timestamp.json"

Write-Host "Scan complete! Reports saved to $ReportDir" -ForegroundColor Green
```

Usage:
```powershell
.\quick-scan.ps1 -Target "https://your-website.com"
```

## Resources

- **Official Documentation**: https://www.zaproxy.org/docs/docker/
- **Docker Hub**: https://github.com/zaproxy/zaproxy/pkgs/container/zaproxy
- **Automation Framework**: https://www.zaproxy.org/docs/desktop/addons/automation-framework/
- **Community Scripts**: https://github.com/zaproxy/community-scripts

## Security Disclaimer

This tool is for authorized security testing only. Ensure you have:
- Written permission to test the target
- Understanding of your organization's security testing policies
- Awareness that active scanning can affect production systems
- Proper authorization before testing third-party services

Unauthorized penetration testing is illegal and unethical.
