import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { DEV_TENANTS, type DevTenantId } from '../db/seed';
import { decimalToMinorUnits } from '../modules/integrations/money';
import { signPlatformA } from '../modules/integrations/platform-a/platform-a.platform';
import { signPlatformB } from '../modules/integrations/platform-b/platform-b.platform';
import { issuePlayerToken } from '../modules/players/player-token';

/*
 * The casino side of the integration, for demos and manual testing: lets plain HTTP clients make a casino send a
 * signed deposit webhook to MIO, or issue a player session token, without implementing HMAC or JWT themselves.
 */

interface DepositRequest {
  playerId?: unknown;
  amount?: unknown;
  status?: unknown;
  eventId?: unknown;
}

function depositWebhook(
  tenantId: DevTenantId,
  d: { playerId: string; amount: string; failed: boolean; eventId: string },
) {
  const tenant = DEV_TENANTS[tenantId];
  const now = Math.floor(Date.now() / 1000);
  if (tenant.platform === 'platform-a') {
    const raw = JSON.stringify({
      event_id: d.eventId,
      event_type: 'deposit',
      player_id: d.playerId,
      amount_cents: decimalToMinorUnits(d.amount),
      currency: tenant.currency,
      status: d.failed ? 'FAILED' : 'SUCCESS',
    });
    return { raw, headers: signPlatformA(raw, tenant.webhookSecret, now) };
  }
  const raw = JSON.stringify({
    notificationId: d.eventId,
    timestamp: now,
    type: 'PAYMENT',
    data: {
      operation: 'DEPOSIT',
      state: d.failed ? 3 : 2,
      amount: d.amount,
      currency: tenant.currency,
      customer: { ref: d.playerId },
    },
  });
  return { raw, headers: signPlatformB(raw, tenant.webhookSecret) };
}

export function addCasinoSimulator(app: Express, options: { mioUrl: string }): void {
  const tenantOf = (id: string): DevTenantId | undefined =>
    Object.hasOwn(DEV_TENANTS, id) ? (id as DevTenantId) : undefined;

  app.post('/__simulate/:tenantId/deposit', async (req, res) => {
    const tenantId = tenantOf(req.params.tenantId);
    const {
      playerId,
      amount = '25.00',
      status = 'SUCCESS',
      eventId = randomUUID(),
    } = (req.body ?? {}) as DepositRequest;
    if (!tenantId) return void res.status(404).json({ error: 'UNKNOWN_TENANT' });
    if (typeof playerId !== 'string' || typeof amount !== 'string' || typeof eventId !== 'string') {
      return void res.status(400).json({ error: 'playerId (string) is required; amount is a decimal string' });
    }

    const webhook = depositWebhook(tenantId, { playerId, amount, failed: status === 'FAILED', eventId });
    const mio = await fetch(`${options.mioUrl}/v1/integrations/${tenantId}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...webhook.headers },
      body: webhook.raw,
    });
    res.json({ sent: JSON.parse(webhook.raw), mio: { status: mio.status, body: await mio.json() } });
  });

  app.post('/__simulate/:tenantId/player-token', (req, res) => {
    const tenantId = tenantOf(req.params.tenantId);
    const playerId = (req.body ?? {}).playerId;
    if (!tenantId) return void res.status(404).json({ error: 'UNKNOWN_TENANT' });
    if (typeof playerId !== 'string') return void res.status(400).json({ error: 'playerId (string) is required' });
    res.json({ token: issuePlayerToken(tenantId, playerId, DEV_TENANTS[tenantId].playerTokenSecret) });
  });
}
