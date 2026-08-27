const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return value;
};

export const config = {
  slackBotToken: required('SLACK_BOT_TOKEN'),
  slackAppToken: required('SLACK_APP_TOKEN'),
  slackChannelId: required('SLACK_CHANNEL_ID'),
  approverUserIds: required('SLACK_APPROVER_USER_IDS')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
  bosUrl: required('BOS_URL').replace(/\/+$/, ''),
  bosOperatorToken: process.env.BOS_OPERATOR_TOKEN?.trim() || '',
  pollIntervalMs: Math.max(3000, Number(process.env.POLL_INTERVAL_MS ?? 15000)),
  stateFile: process.env.STATE_FILE?.trim() || './state.json',
  readinessPort: Math.max(1, Number(process.env.READINESS_PORT ?? 8091)),
};

const bosHost = new URL(config.bosUrl).hostname;
const openDev = process.env.BOS_ALLOW_OPEN_DEV === '1';
if (!config.bosOperatorToken && (!openDev || !['127.0.0.1', 'localhost', '[::1]'].includes(bosHost))) {
  console.error('BOS_OPERATOR_TOKEN is required unless BOS_ALLOW_OPEN_DEV=1 targets loopback');
  process.exit(1);
}
