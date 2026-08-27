// Durable bridge state: which Slack message renders each proposal, at which
// revision, and the last delivery status threaded per channel. Single-instance,
// low-volume — a JSON file is enough.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { config } from './config.js';

let state = { proposals: {} };

export function loadState() {
  try {
    state = JSON.parse(readFileSync(config.stateFile, 'utf8'));
    if (!state.proposals) state.proposals = {};
  } catch {
    state = { proposals: {} };
  }
  return state;
}

function persist() {
  const tmp = `${config.stateFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, config.stateFile);
}

export const getProposalState = (proposalId) => state.proposals[proposalId];

export function setProposalState(proposalId, patch) {
  state.proposals[proposalId] = { ...state.proposals[proposalId], ...patch };
  persist();
}
