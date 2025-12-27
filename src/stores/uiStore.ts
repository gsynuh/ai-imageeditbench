import { map } from "nanostores";

export const $uiState = map({
  collapsedMessageIds: new Set<string>(),
  collapsedBlockIds: new Set<string>(),
  hiddenMessageIds: new Set<string>(),
  historySearch: "",
  historyOffset: 0,
  historyHasMore: true,
  soloModelIds: new Set<string>(),
});

export function setHistorySearch(value: string) {
  $uiState.set({ ...$uiState.get(), historySearch: value });
}

export function toggleCollapsedMessage(messageId: string, collapsed?: boolean) {
  const state = $uiState.get();
  const next = new Set(state.collapsedMessageIds);
  const shouldCollapse = collapsed ?? !next.has(messageId);
  if (shouldCollapse) next.add(messageId);
  else next.delete(messageId);
  $uiState.set({ ...state, collapsedMessageIds: next });
}

export function toggleCollapsedBlock(blockId: string, collapsed?: boolean) {
  const state = $uiState.get();
  const next = new Set(state.collapsedBlockIds);
  const shouldCollapse = collapsed ?? !next.has(blockId);
  if (shouldCollapse) next.add(blockId);
  else next.delete(blockId);
  $uiState.set({ ...state, collapsedBlockIds: next });
}

export function resetHistoryPagination() {
  $uiState.set({ ...$uiState.get(), historyOffset: 0, historyHasMore: true });
}

export function advanceHistoryOffset(amount: number) {
  const state = $uiState.get();
  $uiState.set({ ...state, historyOffset: state.historyOffset + amount });
}

export function setHistoryHasMore(value: boolean) {
  $uiState.set({ ...$uiState.get(), historyHasMore: value });
}

export function toggleSoloModel(modelId: string) {
  const state = $uiState.get();
  const next = new Set(state.soloModelIds);
  if (next.has(modelId)) {
    next.delete(modelId);
  } else {
    next.add(modelId);
  }
  $uiState.set({ ...state, soloModelIds: next });
}

export function pruneSoloModels(validModelIds: string[]) {
  const state = $uiState.get();
  const valid = new Set(validModelIds);
  const next = new Set<string>();
  state.soloModelIds.forEach((id) => {
    if (valid.has(id)) next.add(id);
  });
  if (next.size === state.soloModelIds.size) return;
  $uiState.set({ ...state, soloModelIds: next });
}

export function toggleHiddenMessage(messageId: string, hidden?: boolean) {
  const state = $uiState.get();
  const next = new Set(state.hiddenMessageIds);
  const shouldHide = hidden ?? !next.has(messageId);
  if (shouldHide) next.add(messageId);
  else next.delete(messageId);
  $uiState.set({ ...state, hiddenMessageIds: next });
}
