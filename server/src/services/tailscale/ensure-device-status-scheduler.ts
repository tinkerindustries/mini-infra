import type { PrismaClient } from "../../generated/prisma/client";
import { getLogger } from "../../lib/logger-factory";
import { TailscaleDeviceStatusScheduler } from "./tailscale-device-status-scheduler";
import { TailscaleService } from "./tailscale-service";

const logger = getLogger("integrations", "tailscale-device-status-scheduler");

/**
 * Idempotently align the singleton `TailscaleDeviceStatusScheduler` with the
 * current state of the Tailscale OAuth credentials.
 *
 * Why this exists: the scheduler used to be wired up only at server boot. In
 * the dev worktree startup flow (and any deployment where Tailscale gets
 * configured *after* the app is already running), boot ran while the
 * credentials were still null — the scheduler was skipped, and the panel kept
 * showing 0 devices forever because nothing re-ran the init when the
 * `/api/settings/tailscale` POST landed afterwards.
 *
 * Behaviour:
 *  - credentials present + no scheduler running → start a fresh scheduler.
 *  - credentials present + scheduler already running → no-op (avoids
 *    double-starting the polling timer).
 *  - credentials absent + scheduler running → stop and clear the singleton so
 *    `GET /api/tailscale/devices` reflects "not configured".
 *  - credentials absent + no scheduler → no-op.
 *
 * Best-effort: any failure is logged and swallowed. Scheduler health is not
 * critical-path — the route handlers that depend on it already render an
 * empty-state when `getInstance()` returns `null`.
 */
export async function ensureTailscaleDeviceStatusScheduler(
  prisma: PrismaClient,
): Promise<void> {
  try {
    const tailscaleService = new TailscaleService(prisma);
    const clientId = await tailscaleService.getClientId();
    const clientSecret = await tailscaleService.getClientSecret();
    const isConfigured = !!(clientId && clientSecret);

    const existing = TailscaleDeviceStatusScheduler.getInstance();

    if (isConfigured && !existing) {
      const scheduler = new TailscaleDeviceStatusScheduler(tailscaleService);
      TailscaleDeviceStatusScheduler.setInstance(scheduler);
      await scheduler.start();
      logger.info("Tailscale device-status scheduler started");
      return;
    }

    if (!isConfigured && existing) {
      existing.stop();
      TailscaleDeviceStatusScheduler.setInstance(null);
      logger.info(
        "Tailscale credentials removed, device-status scheduler stopped",
      );
    }
  } catch (error) {
    logger.warn(
      { error },
      "Failed to reconcile Tailscale device-status scheduler",
    );
  }
}
