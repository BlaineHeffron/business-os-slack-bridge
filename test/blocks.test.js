import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposalCard, editModal, deliveryLine, dueAtParts, combineDueAt, dueAtForUpdate } from '../src/blocks.js';

const target = {
  target_id: 't1',
  channel_id: 'ch_linkedin',
  channel_name: 'Example Co',
  platform: 'linkedin',
  text: 'New blog: https://example.com/blog/x?utm_source=linkedin',
  tracked_url: 'https://example.com/blog/x?utm_source=linkedin',
  image_url: 'https://example.com/img/x.jpg',
  utm: { source: 'linkedin' },
  schedule_mode: 'queue',
  due_at: null,
  outbox_job: null,
};

const entry = {
  proposal: {
    proposal_id: 'social_1',
    canonical_url: 'https://example.com/blog/x',
    status: 'staged',
    targets: [target],
    approved_by: null,
  },
  revision: 3,
};

test('staged card carries approve/reject with exact revision', () => {
  const blocks = proposalCard(entry, { liveEnabled: true });
  const actions = blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements);
  const approve = actions.find((a) => a.action_id === 'approve_proposal');
  assert.ok(approve);
  assert.deepEqual(JSON.parse(approve.value), { proposalId: 'social_1', revision: 3 });
  assert.ok(actions.find((a) => a.action_id === 'reject_proposal'));
  assert.ok(actions.find((a) => a.action_id === 'edit_target'));
});

test('approved card has no buttons', () => {
  const approved = {
    ...entry,
    proposal: { ...entry.proposal, status: 'approved', approved_by: 'slack:U1' },
  };
  const blocks = proposalCard(approved, { liveEnabled: true });
  assert.equal(blocks.filter((b) => b.type === 'actions').length, 0);
});

test('edit modal prefills current target', () => {
  const modal = editModal({ proposalId: 'social_1', revision: 3, target, canonicalUrl: entry.proposal.canonical_url });
  const textInput = modal.blocks.find((b) => b.block_id === 'text');
  assert.equal(textInput.element.initial_value, target.text);
  assert.equal(JSON.parse(modal.private_metadata).revision, 3);
  const scheduling = modal.blocks.find((b) => b.block_id === 'schedule_mode');
  assert.equal(scheduling.element.initial_option.value, 'queue');
  assert.equal(scheduling.element.initial_option.text.text, 'Next queue slot');
  assert.deepEqual(
    scheduling.element.options.map((o) => [o.value, o.text.text]),
    [
      ['queue', 'Next queue slot'],
      ['scheduled', 'Specific time'],
    ],
  );
  const dueDate = modal.blocks.find((b) => b.block_id === 'due_date');
  const dueTime = modal.blocks.find((b) => b.block_id === 'due_time');
  assert.equal(dueDate.element.type, 'datepicker');
  assert.equal(dueTime.element.type, 'timepicker');
  assert.equal(dueTime.element.timezone, 'UTC');
  assert.equal(dueDate.element.initial_date, undefined);
  assert.equal(dueTime.element.initial_time, undefined);
  assert.equal(modal.blocks.some((b) => b.block_id === 'due_at'), false);
});

test('scheduled edit modal prefills UTC date and time pickers', () => {
  const modal = editModal({
    proposalId: 'social_1',
    revision: 3,
    target: { ...target, schedule_mode: 'scheduled', due_at: '2026-08-20T14:00:00-04:00' },
    canonicalUrl: entry.proposal.canonical_url,
  });
  const scheduling = modal.blocks.find((b) => b.block_id === 'schedule_mode');
  assert.equal(scheduling.element.initial_option.value, 'scheduled');
  assert.equal(scheduling.element.initial_option.text.text, 'Specific time');
  assert.equal(modal.blocks.find((b) => b.block_id === 'due_date').element.initial_date, '2026-08-20');
  assert.equal(modal.blocks.find((b) => b.block_id === 'due_time').element.initial_time, '18:00');
});

test('due_at pickers combine to RFC3339 UTC and queue drops them', () => {
  assert.deepEqual(dueAtParts('2026-08-20T14:00:00Z'), { date: '2026-08-20', time: '14:00' });
  assert.equal(combineDueAt('2026-08-20', '14:00'), '2026-08-20T14:00:00Z');
  assert.equal(combineDueAt('2026-02-30', '14:00'), null);
  assert.equal(dueAtForUpdate('scheduled', '2026-08-20', '14:00'), '2026-08-20T14:00:00Z');
  assert.equal(dueAtForUpdate('queue', '2026-08-20', '14:00'), undefined);
  assert.equal(dueAtForUpdate('scheduled', '2026-08-20', undefined), undefined);
});

test('America/Chicago pickers emit offset and round-trip across DST', () => {
  const zone = 'America/Chicago';
  assert.equal(combineDueAt('2026-08-20', '14:00', zone), '2026-08-20T14:00:00-05:00');
  assert.equal(combineDueAt('2026-01-20', '14:00', zone), '2026-01-20T14:00:00-06:00');
  assert.deepEqual(dueAtParts('2026-08-20T19:00:00Z', zone), { date: '2026-08-20', time: '14:00' });
  assert.deepEqual(dueAtParts('2026-01-20T20:00:00Z', zone), { date: '2026-01-20', time: '14:00' });
  assert.equal(dueAtForUpdate('scheduled', '2026-08-20', '14:00', zone), '2026-08-20T14:00:00-05:00');
  assert.equal(dueAtForUpdate('queue', '2026-08-20', '14:00', zone), undefined);

  const modal = editModal({
    proposalId: 'social_1',
    revision: 3,
    target: { ...target, schedule_mode: 'scheduled', due_at: '2026-08-20T19:00:00Z' },
    canonicalUrl: entry.proposal.canonical_url,
    timeZone: zone,
  });
  assert.equal(modal.blocks.find((b) => b.block_id === 'due_time').element.timezone, zone);
  assert.equal(modal.blocks.find((b) => b.block_id === 'due_date').element.initial_date, '2026-08-20');
  assert.equal(modal.blocks.find((b) => b.block_id === 'due_time').element.initial_time, '14:00');
});

test('Instagram without media stays editable but cannot be approved', () => {
  const instagram = {
    ...target,
    channel_id: 'ch_instagram',
    channel_name: 'Royall Stays Instagram',
    platform: 'instagram',
    image_url: null,
  };
  const instagramEntry = {
    ...entry,
    proposal: { ...entry.proposal, targets: [instagram] },
  };
  const blocks = proposalCard(instagramEntry, { liveEnabled: true });
  const actions = blocks.filter((block) => block.type === 'actions').flatMap((block) => block.elements);
  assert.equal(actions.some((action) => action.action_id === 'approve_proposal'), false);
  assert.equal(actions.some((action) => action.action_id === 'edit_target'), true);
  assert.equal(actions.some((action) => action.action_id === 'reject_proposal'), true);
  assert.match(JSON.stringify(blocks), /Instagram needs a public HTTPS image/);

  const modal = editModal({
    proposalId: 'social_1',
    revision: 3,
    target: instagram,
    canonicalUrl: entry.proposal.canonical_url,
  });
  const imageInput = modal.blocks.find((block) => block.block_id === 'image_url');
  assert.equal(imageInput.optional, false);
  assert.equal(JSON.parse(modal.private_metadata).platform, 'instagram');
});

test('Google Business uses a recognizable platform marker', () => {
  const googleBusiness = {
    ...target,
    channel_id: 'ch_google',
    channel_name: 'Royall Stays Google Business',
    platform: 'googlebusiness',
  };
  const blocks = proposalCard(
    { ...entry, proposal: { ...entry.proposal, targets: [googleBusiness] } },
    { liveEnabled: true },
  );
  assert.match(JSON.stringify(blocks), /:round_pushpin:/);
});

test('delivery line flags unknown outcomes loudly', () => {
  const line = deliveryLine({
    ...target,
    outbox_job: { job_id: 'j1', status: 'delivery_outcome_unknown', attempts: 1 },
  });
  assert.match(line, /rotating_light/);
  assert.match(line, /will not auto-retry/);
});

test('dry-run delivery is labeled', () => {
  const line = deliveryLine({
    ...target,
    outbox_job: { job_id: 'j1', status: 'delivered', attempts: 1, dry_run: true },
  });
  assert.match(line, /dry-run — nothing posted/);
});
