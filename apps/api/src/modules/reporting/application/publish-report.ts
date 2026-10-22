import { KPI_CATALOG, type ReporterEnv } from '../domain/kpi-catalog.js';
import { validateMeasurementBatch } from '../domain/measurement-batch.js';
import {
  publishMeasurements,
  readCentralPublisherConfig,
  type PublisherDeps,
  type PublishResult,
} from '../infrastructure/central-measurement-publisher.js';

export interface PublicationReceipt {
  ok: boolean;
  verified: boolean;
  reason?: string;
  publication?: PublishResult;
}

/** Publica todos los KPIs del catálogo y comprueba identidad y valores mediante lecturas propias. */
export async function publishReport(
  rows: unknown,
  env: ReporterEnv,
  deps: PublisherDeps = {},
): Promise<PublicationReceipt> {
  const validation = validateMeasurementBatch(rows);
  if (!validation.ok || validation.rows.length !== KPI_CATALOG.length) {
    return { ok: false, verified: false, reason: 'invalid-batch' };
  }
  const first = validation.rows[0]!;
  if (first.env !== env) return { ok: false, verified: false, reason: 'env-mismatch' };

  const configured = readCentralPublisherConfig(deps.env);
  if (!configured.ok) return { ok: false, verified: false, reason: configured.reason };

  const { config } = configured;
  const origin = new URL(config.endpoint).origin;
  const fetchFn = deps.fetchFn ?? fetch;
  const headers = {
    apikey: config.publishableKey,
    'X-Project-Key': config.projectKey,
    'Content-Type': 'application/json',
  };
  const options = () => ({
    headers,
    redirect: 'error' as const,
    signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
  });

  try {
    const response = await fetchFn(`${origin}/rest/v1/rpc/current_project`, {
      ...options(),
      method: 'POST',
      body: '{}',
    });
    const projects: unknown = response.ok ? await response.json() : null;
    if (
      !Array.isArray(projects) ||
      projects.length !== 1 ||
      projects[0]?.team_number !== 5 ||
      projects[0]?.env !== env
    ) {
      return { ok: false, verified: false, reason: 'identity-mismatch' };
    }
  } catch {
    return { ok: false, verified: false, reason: 'identity-check-failed' };
  }

  const publication = await publishMeasurements(validation.rows, deps);
  if (!publication.ok)
    return { ok: false, verified: false, reason: publication.reason, publication };

  try {
    const query = new URLSearchParams({
      select: 'kpi_id,date,env,value,run_id',
      date: `eq.${first.date}`,
      env: `eq.${env}`,
    });
    const response = await fetchFn(`${origin}/rest/v1/measurement?${query}`, options());
    const received: unknown = response.ok ? await response.json() : null;
    const checked = validateMeasurementBatch(received);
    const verified =
      checked.ok &&
      checked.rows.length === validation.rows.length &&
      validation.rows.every((row) =>
        checked.rows.some(
          (stored) =>
            stored.kpi_id === row.kpi_id &&
            stored.date === row.date &&
            stored.env === row.env &&
            stored.value === row.value &&
            stored.run_id === row.run_id,
        ),
      );
    return verified
      ? { ok: true, verified: true, publication }
      : { ok: false, verified: false, reason: 'received-values-mismatch', publication };
  } catch {
    return { ok: false, verified: false, reason: 'verification-failed', publication };
  }
}
