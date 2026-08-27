// Slack approval bridge for BusinessOS social publishing.
//
// Poller mirrors staged proposals into one Block Kit card each; Approve /
// Reject / Edit act through the BusinessOS operator API with the exact
// revision shown on the card, so a stale card can never approve content the
// owner has not seen (the server 409s and the card refreshes). Delivery
// receipts are threaded under the card.
import pkg from '@slack/bolt';
import { config } from './config.js';
import { listProposals, updateProposal, actOnProposal, RevisionConflictError } from './bosClient.js';
import { loadState, getProposalState, setProposalState } from './state.js';
import { proposalCard, editModal, deliveryLine } from './blocks.js';
import { startReadinessServer } from './readiness.js';

const { App } = pkg;

const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  socketMode: true,
});

const isApprover = (userId) => config.approverUserIds.includes(userId);

const actorFor = (userId) => `slack:${userId}`;

async function denyEphemeral(client, body) {
  await client.chat.postEphemeral({
    channel: config.slackChannelId,
    user: body.user.id,
    text: 'Only the configured approver can act on social proposals.',
  });
}

// ---------------------------------------------------------------------------
// Poller
// ---------------------------------------------------------------------------

let polling = false;
let lastPollSucceededAt = 0;

function cardFingerprint(entry, liveEnabled) {
  return `${entry.revision}:${entry.proposal.status}:${liveEnabled}`;
}

function deliveryFingerprint(entry) {
  return entry.proposal.targets
    .map((t) => {
      const j = t.outbox_job;
      return j ? `${t.channel_id}=${j.status}:${j.attempts}:${j.dry_run ?? ''}` : `${t.channel_id}=`;
    })
    .join('|');
}

async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    const response = await listProposals();
    const liveEnabled = response.buffer_live_enabled;
    for (const entry of response.proposals) {
      await syncProposal(entry, liveEnabled);
    }
    lastPollSucceededAt = Date.now();
  } catch (error) {
    console.error('poll failed:', error.message);
  } finally {
    polling = false;
  }
}

async function syncProposal(entry, liveEnabled) {
  const { proposal } = entry;
  const known = getProposalState(proposal.proposal_id);
  const fingerprint = cardFingerprint(entry, liveEnabled);
  const blocks = proposalCard(entry, { liveEnabled });
  const fallback = `Social proposal ${proposal.proposal_id} (${proposal.status}) for ${proposal.canonical_url}`;

  let messageTs = known?.messageTs;
  if (!messageTs) {
    // Never seen: only announce proposals that still need attention. Old
    // approved/rejected history from before the bridge existed stays silent.
    if (proposal.status !== 'staged') {
      setProposalState(proposal.proposal_id, { messageTs: null, fingerprint, delivery: deliveryFingerprint(entry) });
      return;
    }
    const posted = await app.client.chat.postMessage({
      channel: config.slackChannelId,
      text: fallback,
      blocks,
      unfurl_links: false,
    });
    messageTs = posted.ts;
    setProposalState(proposal.proposal_id, { messageTs, fingerprint, delivery: '' });
  } else if (known.fingerprint !== fingerprint) {
    await app.client.chat.update({
      channel: config.slackChannelId,
      ts: messageTs,
      text: fallback,
      blocks,
    });
    setProposalState(proposal.proposal_id, { fingerprint });
  }

  if (!messageTs) return;
  const delivery = deliveryFingerprint(entry);
  if (delivery && delivery !== (known?.delivery ?? '')) {
    const lines = proposal.targets.map(deliveryLine).filter(Boolean);
    if (lines.length > 0) {
      const needsAttention = proposal.targets.some((t) =>
        ['delivery_outcome_unknown', 'failed_terminal'].includes(t.outbox_job?.status)
      );
      await app.client.chat.postMessage({
        channel: config.slackChannelId,
        thread_ts: messageTs,
        reply_broadcast: needsAttention,
        text: `Delivery update:\n${lines.join('\n')}`,
      });
    }
    setProposalState(proposal.proposal_id, { delivery });
  }
}

// ---------------------------------------------------------------------------
// Approve / Reject
// ---------------------------------------------------------------------------

async function handleAction(action, body, client) {
  const { proposalId, revision } = JSON.parse(body.actions[0].value);
  try {
    await actOnProposal(proposalId, {
      action,
      expectedRevision: revision,
      idempotencyKey: `slack:${proposalId}:${revision}:${action}`,
      actorId: actorFor(body.user.id),
    });
    await pollOnce();
  } catch (error) {
    if (error instanceof RevisionConflictError) {
      await client.chat.postEphemeral({
        channel: config.slackChannelId,
        user: body.user.id,
        text: 'That card was stale — the proposal changed underneath it. Card refreshed; please review again.',
      });
      await pollOnce();
      return;
    }
    console.error(`${action} failed:`, error.message);
    await client.chat.postEphemeral({
      channel: config.slackChannelId,
      user: body.user.id,
      text: `${action} failed: ${error.message}`,
    });
  }
}

app.action('approve_proposal', async ({ ack, body, client }) => {
  await ack();
  if (!isApprover(body.user.id)) return denyEphemeral(client, body);
  await handleAction('approve', body, client);
});

app.action('reject_proposal', async ({ ack, body, client }) => {
  await ack();
  if (!isApprover(body.user.id)) return denyEphemeral(client, body);
  await handleAction('reject', body, client);
});

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

app.action('edit_target', async ({ ack, body, client }) => {
  await ack();
  if (!isApprover(body.user.id)) return denyEphemeral(client, body);
  const { proposalId, channelId } = JSON.parse(body.actions[0].value);
  // Always open the modal against the latest revision, not the card's.
  const response = await listProposals();
  const entry = response.proposals.find((e) => e.proposal.proposal_id === proposalId);
  const target = entry?.proposal.targets.find((t) => t.channel_id === channelId);
  if (!entry || !target || entry.proposal.status !== 'staged') {
    await client.chat.postEphemeral({
      channel: config.slackChannelId,
      user: body.user.id,
      text: 'This proposal is no longer editable.',
    });
    await pollOnce();
    return;
  }
  await client.views.open({
    trigger_id: body.trigger_id,
    view: editModal({
      proposalId,
      revision: entry.revision,
      target,
      canonicalUrl: entry.proposal.canonical_url,
    }),
  });
});

const modalValue = (view, blockId) => view.state.values[blockId]?.value;

app.view('edit_target_submit', async ({ ack, body, view }) => {
  if (!isApprover(body.user.id)) {
    await ack({
      response_action: 'errors',
      errors: { text: 'Only the configured approver can edit proposals.' },
    });
    return;
  }
  const meta = JSON.parse(view.private_metadata);
  const text = modalValue(view, 'text')?.value?.trim() ?? '';
  const imageUrl = modalValue(view, 'image_url')?.value?.trim() || null;
  const scheduleMode = modalValue(view, 'schedule_mode')?.selected_option?.value ?? 'queue';
  const dueAt = modalValue(view, 'due_at')?.value?.trim() || null;

  if (scheduleMode === 'scheduled' && !dueAt) {
    await ack({ response_action: 'errors', errors: { due_at: 'Scheduled mode needs a due-at time.' } });
    return;
  }
  if (imageUrl && !imageUrl.startsWith('https://')) {
    await ack({ response_action: 'errors', errors: { image_url: 'Image URL must be https.' } });
    return;
  }
  if (meta.platform === 'instagram' && !imageUrl) {
    await ack({ response_action: 'errors', errors: { image_url: 'Instagram requires a public HTTPS image.' } });
    return;
  }

  // Re-fetch and rebuild the full target set: the update endpoint replaces the
  // whole snapshot and must cover every configured channel.
  const response = await listProposals();
  const entry = response.proposals.find((e) => e.proposal.proposal_id === meta.proposalId);
  if (!entry || entry.proposal.status !== 'staged' || entry.revision !== meta.revision) {
    await ack({
      response_action: 'errors',
      errors: { text: 'Proposal changed while the modal was open. Close and edit again from the refreshed card.' },
    });
    await pollOnce();
    return;
  }
  const targets = entry.proposal.targets.map((t) => {
    const edited = t.channel_id === meta.channelId;
    return {
      channel_id: t.channel_id,
      text: edited ? text : t.text,
      image_url: (edited ? imageUrl : t.image_url) ?? undefined,
      utm: t.utm,
      schedule_mode: edited ? scheduleMode : t.schedule_mode,
      due_at:
        (edited
          ? scheduleMode === 'scheduled'
            ? dueAt
            : undefined
          : t.schedule_mode === 'scheduled'
            ? t.due_at
            : undefined) ?? undefined,
    };
  });

  try {
    await updateProposal(meta.proposalId, {
      canonicalUrl: entry.proposal.canonical_url,
      targets,
      expectedRevision: entry.revision,
      idempotencyKey: `slack:${meta.proposalId}:${entry.revision}:update`,
      actorId: actorFor(body.user.id),
    });
  } catch (error) {
    const message =
      error instanceof RevisionConflictError
        ? 'Edited by someone else at the same time — reopen from the refreshed card.'
        : `Save failed: ${error.message}`;
    await ack({ response_action: 'errors', errors: { text: message } });
    await pollOnce();
    return;
  }
  await ack();
  await pollOnce();
});

// ---------------------------------------------------------------------------

(async () => {
  loadState();
  await app.start();
  const maxPollAge = Math.max(60000, config.pollIntervalMs * 3);
  const readiness = startReadinessServer({
    port: config.readinessPort,
    isReady: () => lastPollSucceededAt > 0 && Date.now() - lastPollSucceededAt <= maxPollAge,
  });
  readiness.on('error', (error) => {
    console.error('readiness server failed:', error.message);
    process.exit(1);
  });
  console.log(`slack-approval-bridge running; polling ${config.bosUrl} every ${config.pollIntervalMs}ms`);
  await pollOnce();
  setInterval(pollOnce, config.pollIntervalMs);
})();
