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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const QUEUE_OPTION = { text: { type: 'plain_text', text: 'Next queue slot' }, value: 'queue' };
const SCHEDULED_OPTION = { text: { type: 'plain_text', text: 'Specific time' }, value: 'scheduled' };

export function usableTimeZone(timeZone) {
  const tz = typeof timeZone === 'string' && timeZone.trim() ? timeZone.trim() : 'UTC';
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
    return tz;
  } catch {
    return 'UTC';
  }
}

function wallParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

function zonedWallToUtcMs(date, time, timeZone) {
  const wanted = Date.parse(`${date}T${time}:00Z`);
  if (Number.isNaN(wanted)) return null;
  let utcMs = wanted;
  for (let i = 0; i < 3; i += 1) {
    const wall = wallParts(utcMs, timeZone);
    const delta = wanted - Date.parse(`${wall.date}T${wall.time}:00Z`);
    if (delta === 0) break;
    utcMs += delta;
  }
  const wall = wallParts(utcMs, timeZone);
  if (wall.date !== date || wall.time !== time) return null;
  return utcMs;
}

function rfc3339(date, time, utcMs, timeZone) {
  if (timeZone === 'UTC' || timeZone === 'Etc/UTC') return `${date}T${time}:00Z`;
  const offsetMin = Math.round((Date.parse(`${date}T${time}:00Z`) - utcMs) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${date}T${time}:00${sign}${hh}:${mm}`;
}

export function dueAtParts(dueAt, timeZone = 'UTC') {
  if (!dueAt) return {};
  const ms = Date.parse(dueAt);
  if (Number.isNaN(ms)) return {};
  return wallParts(ms, usableTimeZone(timeZone));
}

export function combineDueAt(date, time, timeZone = 'UTC') {
  if (!DATE_RE.test(date ?? '') || !TIME_RE.test(time ?? '')) return null;
  const zone = usableTimeZone(timeZone);
  const utcMs = zonedWallToUtcMs(date, time, zone);
  if (utcMs == null) return null;
  return rfc3339(date, time, utcMs, zone);
}

// Decide the effective scheduling mode from what the owner did, not just what
// the select says.
//
// The date and time inputs are prefilled from an existing due_at, so "has a
// value" cannot mean "the owner chose it" -- the initial values are compared
// against to tell a real edit from an untouched prefill.
//
// Setting a date and time is a clear statement of intent, so it selects
// scheduling on the owner's behalf. That only applies while they left the
// Scheduling select alone: deliberately choosing the queue is itself intent,
// and overriding it would discard an explicit instruction. Choosing the queue
// AND editing the fields is a genuine contradiction, reported as a conflict
// rather than guessed at.
export function resolveSchedule({
  selectedMode,
  pickedDate = null,
  pickedTime = null,
  initialDate = null,
  initialTime = null,
  initialScheduleMode = 'queue',
}) {
  const mode = selectedMode === 'scheduled' ? 'scheduled' : 'queue';
  const touched = pickedDate !== initialDate || pickedTime !== initialTime;
  const modeTouched = mode !== (initialScheduleMode === 'scheduled' ? 'scheduled' : 'queue');

  if (mode !== 'scheduled' && touched && pickedDate && pickedTime && !modeTouched) {
    return { mode: 'scheduled', conflict: false };
  }
  if (mode !== 'scheduled' && touched && (pickedDate || pickedTime)) {
    return { mode, conflict: true };
  }
  return { mode, conflict: false };
}

export function dueAtForUpdate(scheduleMode, date, time, timeZone = 'UTC') {
  if (scheduleMode !== 'scheduled') return undefined;
  return combineDueAt(date, time, timeZone) ?? undefined;
}

export function editModal({ proposalId, revision, target, canonicalUrl, timeZone = 'UTC' }) {
  const zone = usableTimeZone(timeZone);
  const { date, time } = dueAtParts(target.due_at, zone);
  return {
    type: 'modal',
    callback_id: 'edit_target_submit',
    private_metadata: JSON.stringify({
      // The date and time inputs are prefilled from an existing due_at. Keeping
      // the prefilled values lets submit tell "the user typed a time" apart
      // from "the user left the prefill alone", so switching to queue does not
      // force them to clear two fields they never touched.
      initialDate: date ?? null,
      initialTime: time ?? null,
      initialScheduleMode: target.schedule_mode === 'scheduled' ? 'scheduled' : 'queue',
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
          initial_option: target.schedule_mode === 'scheduled' ? SCHEDULED_OPTION : QUEUE_OPTION,
          options: [QUEUE_OPTION, SCHEDULED_OPTION],
        },
      },
      {
        type: 'input',
        block_id: 'due_date',
        optional: true,
        label: { type: 'plain_text', text: 'Date' },
        hint: { type: 'plain_text', text: 'Used for Specific time.' },
        element: {
          type: 'datepicker',
          action_id: 'value',
          ...(date ? { initial_date: date } : {}),
        },
      },
      {
        type: 'input',
        block_id: 'due_time',
        optional: true,
        label: { type: 'plain_text', text: 'Time' },
        element: {
          type: 'timepicker',
          action_id: 'value',
          timezone: zone,
          ...(time ? { initial_time: time } : {}),
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
