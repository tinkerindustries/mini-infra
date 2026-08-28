---
title: Connected Services Health Monitoring
description: How to configure and monitor external service connections in Mini Infra.
tags:
  - connectivity
  - health-checks
  - docker
  - storage
  - cloudflare
  - github
  - monitoring
---

# Connected Services Health Monitoring

Mini Infra integrates with four external service categories: Docker, Storage, Cloudflare, and GitHub. The **Connected Services** section in the sidebar has a page for each, where you configure credentials and verify connectivity.

## Docker

**Page:** [/connectivity-docker](/connectivity-docker)

Configure how Mini Infra connects to the Docker daemon.

### Configuration fields

| Field | Description |
|-------|-------------|
| **Docker Host URL** | Connection URL for the Docker daemon |
| **Docker API Version** | Docker API version to use (e.g., `1.41`) |
| **Docker Host IP Address** | IPv4 address of the Docker host, used for creating DNS A records |

### Docker Host URL examples

| Environment | URL |
|-------------|-----|
| Local socket (Linux/Mac) | `unix:///var/run/docker.sock` |
| Remote Docker daemon | `tcp://host:2376` |
| Docker Desktop (Windows) | `npipe:////./pipe/dockerDesktopLinuxEngine` |

Click **Validate & Save** (green button) to test the connection and save if successful.

---

## Storage

**Page:** [/connectivity-storage](/connectivity-storage)

Configure a storage backend for PostgreSQL backups, self-backups, and TLS certificate storage. Mini Infra supports multiple providers; pick the active one with the **Storage Provider** picker at the top of the page. All three system locations (postgres backups, self-backup, TLS certificates) use the active provider.

### Azure

When the active provider is **Azure Blob Storage**, configure:

| Field | Description |
|-------|-------------|
| **Connection String** | Azure Storage Account connection string from the Azure portal |

Find the connection string in the Azure portal under **Storage Account → Access Keys**.

Click **Validate & Save** to test and save. If connected, a list of available containers appears below the form, and you can pick a **Default Postgres Backup Location**, **Self-Backup Location**, and **TLS Certificate Location**.

### Google Drive

Mini Infra can use a Google Drive folder as the active storage backend. Drive uses **OAuth 2.0** with operator-supplied client credentials — you create an OAuth client in your own Google Cloud project, paste the Client ID + Client Secret into Mini Infra, and click **Connect** to authorize.

#### Prerequisite: System Public URL

Google requires the OAuth redirect URI to be reachable on the public internet (not `localhost`). Configure **System → Public URL** before starting the Drive flow — Mini Infra builds the redirect URI as `<public_url>/api/storage/google-drive/oauth/callback` and registers it with Google.

If your Mini Infra instance is not yet exposed publicly, set up a Cloudflare tunnel for it and use the tunnel URL as the public URL.

#### Step 1 — Create the Google Cloud OAuth client

1. Open [Google Cloud Console → APIs & Services](https://console.cloud.google.com/apis/dashboard) and select (or create) a project.
2. Under **OAuth consent screen**, configure the consent screen for an **Internal** or **External** user type and save.
3. Under **Credentials → Create Credentials → OAuth client ID**, pick **Web application**.
4. In **Authorized redirect URIs**, paste `<public_url>/api/storage/google-drive/oauth/callback` (e.g. `https://infra.example.com/api/storage/google-drive/oauth/callback`). It must match the public URL you configured in Mini Infra exactly.
5. Save. Google shows the **Client ID** and **Client Secret** — copy both.

#### Step 2 — Connect Mini Infra to Google Drive

1. Go to **Connectivity → Storage**.
2. Pick **Google Drive** in the storage provider picker.
3. Paste the **Client ID** and **Client Secret** from step 1 and click **Save credentials**.
4. Click **Connect to Google Drive** — Mini Infra redirects you to Google to authorize the app.
5. After approving, Google sends you back to Mini Infra and the connection is recorded as **Connected**.

#### Step 3 — Pick or create a folder

Mini Infra requests the **`drive.file`** scope only — Google Drive only sees folders/files **created by Mini Infra** or that you've explicitly granted via the picker. It can't read or list folders you have in Drive that it didn't create.

You have two ways to give it a destination:

- **Paste a folder ID.** Open the folder in Drive, copy the URL (`https://drive.google.com/drive/folders/<ID>`), and paste it into the folder field. Mini Infra extracts the ID. Note: the folder must already be visible to the `drive.file` scope (typically because Mini Infra created it earlier, or you shared it specifically with this client).
- **Create folder via Mini Infra.** Click the **Create folder** button and enter a name. Mini Infra creates the folder under your My Drive root and uses it for the active storage location. This is the most reliable path for first-time setup.

Once a folder is selected, the **Default Postgres Backup Location**, **Self-Backup Location**, and **TLS Certificate Location** controls work the same way as for Azure.

#### Permissions and what to expect

- The OAuth scope is `drive.file` — Mini Infra **cannot see** any folders or files outside of the ones it created (or the one you handed it).
- The connection uses a long-lived refresh token stored encrypted in the Mini Infra database. Access tokens are minted on demand and never persisted.
- Disconnecting in Mini Infra clears the stored tokens. To fully revoke access, also revoke Mini Infra in your [Google Account → Security → Third-party access](https://myaccount.google.com/connections).

#### Worktree dev gotcha

Each Mini Infra worktree (`wt start`) listens on a different host port (9200–9203, one per slot), and Google Cloud Console does **not** accept wildcards in the **Authorized redirect URIs** field. The reliable workaround for dev:

1. Set up a stable Cloudflare tunnel hostname pointed at your worktree's UI port (or use a single shared dev hostname and re-point the tunnel between worktrees).
2. Register that one stable URL in your Google Cloud Console once.
3. Set the same URL as **System → Public URL** inside the worktree before clicking **Connect**.

If you skip this and use raw `http://localhost:3100/api/storage/google-drive/oauth/callback`, Google rejects the callback with `redirect_uri_mismatch`.

#### Troubleshooting Google Drive

| Error | What to do |
|-------|-----------|
| `redirect_uri_mismatch` | The redirect URI in your Google Cloud OAuth client must match `<public_url>/api/storage/google-drive/oauth/callback` exactly — including the scheme. Confirm the **Public URL** under **System** matches the URI registered with Google. |
| `PUBLIC_URL_NOT_CONFIGURED` | Set **System → Public URL** before clicking **Connect**. Mini Infra refuses to send Google a `localhost` callback. |
| `FOLDER_NOT_ACCESSIBLE` | The folder ID you pasted is not visible to the `drive.file` scope. Either share it specifically with this OAuth client, or use **Create folder via Mini Infra** to make a new app-scoped folder. |
| `invalid_grant` after a previous-good connection | The refresh token was revoked (e.g., user removed the app from their Google account). Click **Disconnect Google Drive**, then **Connect to Google Drive** again. |

---

## Switching the active storage provider

The **Storage Provider** picker at the top of `/connectivity-storage` switches the active backend for new postgres backups, self-backups, and TLS certificate material. Switching is gated behind a confirmation modal that runs a precheck on the current state. The modal surfaces three things:

| Section | Meaning |
|---------|---------|
| **Switch blocked** (red) | One or more hard-block conditions are tripped — `Confirm Switch` is disabled. |
| **Warnings** (amber) | Switching is allowed, but a follow-up action is required. You must tick **I understand** before `Confirm Switch` enables. |
| **What changes** (informational) | The list of consequences once you proceed (history rows, ACME key regeneration, location re-pick). |

### Hard-block conditions

The switch is refused while any of the following are true:

- A backup, restore, or certificate issuance/renewal is **in flight** (status `pending` or `running`).
- A TLS certificate is in `PENDING` or `RENEWING` state — an ACME challenge is mid-flight on the current provider, and switching now would orphan the order.

Wait for the in-flight operation(s) to finish (or cancel them) and re-open the modal.

### Hard warnings

- Any active TLS certificate is within **30 days of expiry**. Switching providers regenerates the ACME account key, so the auto-renewal scheduled on the *old* provider stops running. Plan to re-issue the cert under the new provider before its renewal window opens.

### What restoring still works

When you switch from Azure → Google Drive (or back), the postgres backup and self-backup rows that were originally written to the *old* provider remain in the database with `storageProviderAtCreation` set to that provider. Restores still work for those rows **as long as the old provider's credentials are still configured in Mini Infra**.

The Storage page shows a separate panel — **Other Configured Providers** — for any provider that still holds credentials but is not active. The list view in **Self-Backup History** tags non-active rows with a small `stored in Azure` / `stored in Google Drive` badge so you can see at a glance which backend will be hit during a restore.

### Disconnecting a non-active provider entirely

The **Disconnect entirely** button under **Other Configured Providers** wipes the credentials for that provider. After this:

- Backups originally written to the disconnected provider can no longer be restored through Mini Infra.
- The backup files themselves are not deleted from the cloud — only the link is severed. You can still download them out-of-band from the provider's UI.

The action is destructive: a confirmation dialog shows the orphan count (postgres backups + self-backups still pointing at that provider) before you can proceed. Re-pasting the credentials later does not magically re-link the rows; treat **Disconnect entirely** as a permanent goodbye.

---

## Cloudflare

**Page:** [/connectivity-cloudflare](/connectivity-cloudflare)

Configure Cloudflare API access for tunnel monitoring and DNS management.

### Configuration fields

| Field | Description |
|-------|-------------|
| **API Token** | Cloudflare API token with Cloudflare Tunnel:Edit, Zone:Read, and DNS:Edit permissions |
| **Account ID** | Your 32-character Cloudflare Account ID |

Generate an API token at `https://dash.cloudflare.com/profile/api-tokens`. Find your Account ID in the URL when logged into the Cloudflare dashboard.

---

## GitHub

**Page:** [/connectivity-github](/connectivity-github)

Connect Mini Infra to GitHub using a GitHub App for browsing packages, repositories, and workflow runs.

### Setup flow

GitHub connectivity uses a GitHub App installation:

1. Click **Connect to GitHub** — you are redirected to GitHub to review and approve the app's permissions.
2. After approval, return to Mini Infra and the setup completes automatically.
3. If the app needs to be installed on your account or organization, follow the install prompt.

### Permissions requested

The GitHub App requests **read-only** permissions for:
- Packages
- Actions
- Contents
- Metadata

### Additional tokens

Once connected, you can optionally configure:

| Token | Purpose |
|-------|---------|
| **Package Access Token** | Personal access token with `read:packages` scope — required to browse GitHub Container Registry (GHCR) packages |
| **Assistant Access Token** | Personal access token for AI agent GitHub access; can be `Read Only` or `Full Access` |

### Data visible once connected

- **Packages tab** — container images in GHCR
- **Repositories tab** — all repositories accessible to the GitHub App
- **Actions tab** — GitHub Actions workflow runs (select a repository from the dropdown)

---

## Connection validation

Each service page shows a **Validate & Save** button that tests the connection before saving. If validation fails, an error message describes the problem.

After validation, a success alert confirms the connection is active.

## What to watch out for

- Credentials are **stored encrypted** in the Mini Infra database.
- Changing connection credentials (e.g., regenerating a storage access key) requires re-entering and re-validating them in Mini Infra.
- All features that depend on a service (backups, tunnels, deployments with DNS) stop working if that service's connection is removed or becomes invalid.
- GitHub App tokens expire. If the GitHub connection stops working, try **Test Connection** or disconnect and reconnect.
