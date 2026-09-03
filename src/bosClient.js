// Thin client for the BusinessOS social_publishing operator API. The bridge is
// an operator UI: it authenticates with the operator bearer token and records
// the approving Slack user as the actor.
import { config } from './config.js';

export class RevisionConflictError extends Error {
  constructor(body) {
    super('revision conflict');
    this.name = 'RevisionConflictError';
    this.body = body;
  }
}

export class BosApiError extends Error {
  constructor(status, body) {
    super(`BusinessOS API error ${status}: ${JSON.stringify(body).slice(0, 500)}`);
    this.name = 'BosApiError';
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, body) {
  const authorization = config.bosOperatorToken
    ? { authorization: `Bearer ${config.bosOperatorToken}` }
    : {};
  const response = await fetch(`${config.bosUrl}${path}`, {
    method,
    headers: {
      ...authorization,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  if (response.status === 409) throw new RevisionConflictError(parsed);
  if (!response.ok) throw new BosApiError(response.status, parsed);
  return parsed;
}

/** GET /api/social-publishing/proposals → SocialPublishingResponse */
export const listProposals = () => request('GET', '/api/social-publishing/proposals');

/**
 * POST /api/social-publishing/proposals/{id}/update
 * Replaces the full editable snapshot; must cover every configured channel.
 */
export const updateProposal = (proposalId, { canonicalUrl, targets, expectedRevision, idempotencyKey, actorId }) =>
  request('POST', `/api/social-publishing/proposals/${encodeURIComponent(proposalId)}/update`, {
    canonical_url: canonicalUrl,
    targets,
    expected_revision: expectedRevision,
    idempotency_key: idempotencyKey,
    actor_id: actorId,
  });

/** POST /api/social-publishing/proposals/{id}/action — approve or reject the exact revision. */
export const actOnProposal = (proposalId, { action, expectedRevision, idempotencyKey, actorId }) =>
  request('POST', `/api/social-publishing/proposals/${encodeURIComponent(proposalId)}/action`, {
    action,
    expected_revision: expectedRevision,
    idempotency_key: idempotencyKey,
    actor_id: actorId,
  });

/** Register published content through the bounded BusinessOS MCP tool. */
export async function ingestPublishedContent(arguments_) {
  const response = await request('POST', '/api/agent-mcp', {
    jsonrpc: '2.0',
    id: arguments_.idempotency_key,
    method: 'tools/call',
    params: {
      name: 'bos_social_published_content_ingest',
      arguments: arguments_,
    },
  });
  if (response?.error) throw new Error(`BusinessOS MCP error: ${JSON.stringify(response.error).slice(0, 500)}`);
  return response?.result;
}
