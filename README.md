# business-os-slack-bridge

A Slack-native approval surface for [BusinessOS](https://github.com/BlaineHeffron/business-os)
`social_publishing` proposals.

The owner reviews, edits, approves, or rejects each staged social post from a
Block Kit card in Slack, and the bridge relays those actions to the BusinessOS
operator API. A publishing agent can only *ingest* published content — it never
approves or publishes. That invariant lives in BusinessOS; this bridge is one
more operator UI beside the web frontend.

The bridge runs as a separate process next to `bos-server` and talks to it over
loopback HTTP. It is a companion program, not a module loaded into the server.

## Flow

1. Blog post published → the agent calls the
   `bos_social_published_content_ingest` MCP tool with the canonical URL →
   BusinessOS drafts per-channel copy and stages a proposal.
2. The bridge poller sees the `staged` proposal and posts one card: per-channel
   preview (text, image, schedule), an Edit button per channel, Approve /
   Re-draft / Reject. Re-draft rejects the card and has BusinessOS draft the
   source again under the channels configured now; a new card follows. Instagram proposals without their required public image stay
   editable but cannot be approved.
3. Edit opens a modal prefilled with the current text. Saving replaces the
   snapshot with `expected_revision`, so concurrent edits 409 instead of
   clobbering each other.
4. Approve sends the exact revision shown on the card. A stale card 409s, the
   card refreshes, and the owner re-confirms. Approval fans out one Buffer
   outbox job per channel inside BusinessOS. Approve as Buffer draft first
   switches every channel to draft mode, then approves: Buffer saves drafts
   and nothing publishes until someone schedules them in Buffer.
5. Delivery receipts (`delivered`, dry-run, `failed_terminal`,
   `delivery_outcome_unknown`) are threaded under the card.
   `delivery_outcome_unknown` is broadcast because it needs manual
   reconciliation in Buffer.

## Optional sitemap discovery

The bridge can detect new published pages in one marked sitemap section. This
feature is disabled unless `SITEMAP_URL` is set. The first successful scan
saves the current paths without ingesting them. A later path starts the
bounded `bos_social_published_content_ingest` tool. BusinessOS still drafts the
social text, and an approver must approve every proposal.

These are the Royall Stays values:

```bash
SITEMAP_URL=https://book.royallstays.com/sitemap.xml
SITEMAP_START_MARKER=Begin Blogs Endpoints
SITEMAP_END_MARKER=Begin Listing Endpoints
SITEMAP_PUBLIC_BASE_URL=https://book.royallstays.com
```

The watcher stops that scan when a marker is missing or the section is empty.
It saves a path only after BusinessOS accepts the ingest request. This behavior
retries temporary page or BusinessOS failures without creating duplicate
sources.

The ingest request includes the public blog URL. BusinessOS adds the tracked
form of that URL to every generated social post before approval.

## Requirements

- Node.js 20 or newer
- A reachable `bos-server` with an operator token
- A Slack workspace where you can install an app

## Setup

1. Create the Slack app from `slack-app-manifest.yaml`, enable Socket Mode,
   generate an app-level token (`connections:write`), and install it to the
   workspace. Invite the bot to the approvals channel.
2. `cp env.example .env` and fill it in (`set -a; source .env`, or bake the
   variables into your service manager). `SLACK_APPROVER_USER_IDS` must list
   the approvers' Slack user ids — clicks from anyone else are refused.
3. `BOS_OPERATOR_TOKEN` is the `bos-server` operator bearer token. `BOS_URL` is
   normally `http://127.0.0.1:8080` on the same host.
4. `npm install && npm start`.

Socket Mode means the bridge needs no public ingress. It opens outbound
connections to Slack only.

The process exposes `GET http://127.0.0.1:8091/ready` for deployment checks. It
reports ready only after a recent successful BusinessOS poll. Set
`READINESS_PORT` only when another local service already uses port 8091.

## Local development

`scripts/run-local.sh` runs the bridge through the Slack CLI against a loopback
`bos-server` on `127.0.0.1:4410`, with state under `.local/`. It requires
`SLACK_CHANNEL_ID` and `SLACK_APPROVER_USER_IDS` in the environment and has no
defaults for them, so a stray run cannot post into someone else's channel.

```bash
export SLACK_CHANNEL_ID=C0123456789
export SLACK_APPROVER_USER_IDS=U0AAAAAAA
./scripts/run-local.sh --app A0123456789
```

The script enables open development auth only for a loopback BusinessOS URL.
Buffer writes stay controlled by BusinessOS; keep them disabled for a first
end-to-end rehearsal.

```bash
npm test
```

## Releases

Pushing a `v*` tag builds `business-os-slack-bridge-<version>.tar.gz` with
production `node_modules` included and publishes it, plus a `.sha256` sidecar,
to an immutable GitHub release. The archive has no native modules, so it is
architecture-independent.

Deployments are expected to verify the archive against a signed manifest rather
than trusting the release itself.

## Notes

- Single-instance by design. Message and delivery bookkeeping live in
  `STATE_FILE` (JSON). Deleting it re-posts cards for still-staged proposals
  and stays silent about already-decided ones.
- The approving Slack user is recorded as actor `slack:<user id>` in BusinessOS
  receipts.
- While `BOS_BUFFER_WRITE_ENABLED` is off, cards say so and approvals run as
  auditable dry-runs.
- Post text must keep the tracked URL. BusinessOS rejects an edit that drops
  it, and the modal surfaces the error.
- Sitemap discovery uses the configured public base URL. It never follows a
  page host supplied by the sitemap.

## License

Apache-2.0
