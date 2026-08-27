// Block Kit builders for proposal cards and delivery updates.

const PLATFORM_EMOJI = {
  linkedin: ':briefcase:',
  twitter: ':bird:',
  x: ':bird:',
  facebook: ':thumbsup:',
  instagram: ':camera:',
  googlebusiness: ':round_pushpin:',
};

const truncate = (text, max = 2900) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

function scheduleLine(target) {
  return target.schedule_mode === 'scheduled'
    ? `:calendar: scheduled ${target.due_at}`
    : ':inbox_tray: Buffer queue';
}

function targetBlocks(proposal, revision, target, { editable }) {
  const emoji = PLATFORM_EMOJI[target.platform] ?? ':speech_balloon:';
  const section = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `${emoji} *${target.channel_name}* (${target.platform}) — ${scheduleLine(target)}\n${truncate(target.text)}`,
    },
  };
  if (target.image_url) {
    section.accessory = {
      type: 'image',
      image_url: target.image_url,
      alt_text: `${target.channel_name} image`,
    };
  }
  const blocks = [section];
  if (editable) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: `Edit ${target.channel_name}` },
          action_id: 'edit_target',
          value: JSON.stringify({
            proposalId: proposal.proposal_id,
            channelId: target.channel_id,
            revision,
          }),
        },
      ],
    });
  }
  return blocks;
}

export function proposalCard(entry, { liveEnabled }) {
  const { proposal, revision } = entry;
  const staged = proposal.status === 'staged';
  const instagramNeedsImage = proposal.targets.some(
    (target) => target.platform === 'instagram' && !target.image_url
  );
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Social post proposal', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `<${proposal.canonical_url}|${proposal.canonical_url}>`,
      },
    },
    { type: 'divider' },
    ...proposal.targets.flatMap((target) =>
      targetBlocks(proposal, revision, target, { editable: staged })
    ),
    ...(instagramNeedsImage
      ? [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':warning: *Instagram needs a public HTTPS image before approval.* Edit the Instagram target to add one.',
            },
          },
        ]
      : []),
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `\`${proposal.proposal_id}\` · rev ${revision} · status *${proposal.status}*${
            proposal.approved_by ? ` by ${proposal.approved_by}` : ''
          }${liveEnabled ? '' : ' · :warning: Buffer live writes OFF (dry-run)'}`,
        },
      ],
    },
  ];
  if (staged) {
    const elements = [];
    if (!instagramNeedsImage) {
      elements.push({
        type: 'button',
        style: 'primary',
        text: { type: 'plain_text', text: liveEnabled ? 'Approve & publish' : 'Approve (dry-run)' },
        action_id: 'approve_proposal',
        value: JSON.stringify({ proposalId: proposal.proposal_id, revision }),
        confirm: {
          title: { type: 'plain_text', text: 'Approve this exact revision?' },
          text: {
            type: 'mrkdwn',
            text: liveEnabled
              ? `Revision ${revision} will be queued to Buffer for ${proposal.targets.length} channel(s).`
              : `Revision ${revision} will run as a dry-run (no real posts).`,
          },
          confirm: { type: 'plain_text', text: 'Approve' },
          deny: { type: 'plain_text', text: 'Cancel' },
        },
      });
    }
    elements.push({
      type: 'button',
      style: 'danger',
      text: { type: 'plain_text', text: 'Reject' },
      action_id: 'reject_proposal',
      value: JSON.stringify({ proposalId: proposal.proposal_id, revision }),
    });
    blocks.push({
      type: 'actions',
      elements,
    });
  }
  return blocks;
}

export function editModal({ proposalId, revision, target, canonicalUrl }) {
  return {
    type: 'modal',
    callback_id: 'edit_target_submit',
    private_metadata: JSON.stringify({
      proposalId,
      revision,
      channelId: target.channel_id,
      platform: target.platform,
      canonicalUrl,
    }),
    title: { type: 'plain_text', text: `Edit ${target.channel_name}`.slice(0, 24) },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'text',
        label: { type: 'plain_text', text: 'Post text (must keep the tracked link)' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          multiline: true,
          initial_value: target.text,
        },
      },
      {
        type: 'input',
        block_id: 'image_url',
        optional: target.platform !== 'instagram',
        label: {
          type: 'plain_text',
          text:
            target.platform === 'instagram'
              ? 'Image URL (https, required)'
              : 'Image URL (https, optional)',
        },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          initial_value: target.image_url ?? '',
        },
      },
      {
        type: 'input',
        block_id: 'schedule_mode',
        label: { type: 'plain_text', text: 'Scheduling' },
        element: {
          type: 'static_select',
          action_id: 'value',
          initial_option: {
            text: {
              type: 'plain_text',
              text: target.schedule_mode === 'scheduled' ? 'Scheduled time' : 'Buffer queue',
            },
            value: target.schedule_mode,
          },
          options: [
            { text: { type: 'plain_text', text: 'Buffer queue' }, value: 'queue' },
            { text: { type: 'plain_text', text: 'Scheduled time' }, value: 'scheduled' },
          ],
        },
      },
      {
        type: 'input',
        block_id: 'due_at',
        optional: true,
        label: { type: 'plain_text', text: 'Due at (RFC3339, e.g. 2026-08-20T14:00:00Z)' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          initial_value: target.due_at ?? '',
        },
      },
    ],
  };
}

const STATUS_EMOJI = {
  pending: ':hourglass_flowing_sand:',
  delivered: ':white_check_mark:',
  failed_terminal: ':x:',
  delivery_outcome_unknown: ':rotating_light:',
};

export function deliveryLine(target) {
  const job = target.outbox_job;
  if (!job) return null;
  const emoji = STATUS_EMOJI[job.status] ?? ':grey_question:';
  let line = `${emoji} *${target.channel_name}*: ${job.status}`;
  if (job.dry_run) line += ' (dry-run — nothing posted)';
  if (job.provider_object_id) line += ` · Buffer post \`${job.provider_object_id}\``;
  if (job.status === 'delivery_outcome_unknown') {
    line += ' — check Buffer manually before retrying; BusinessOS will not auto-retry.';
  } else if (job.last_error) {
    line += ` · ${truncate(job.last_error, 200)}`;
  }
  return line;
}
