import { create } from 'zustand';
import { tauriApi } from '../lib/tauri';
import type { SplitBranch, SplitDirection, SplitLeaf, SplitNode } from '../types/split';
import type { TabStatus } from '../types/terminal';

type PaneSplitDirection = 'right' | 'left' | 'down' | 'up';

type PaneRuntime = {
  connectionId: string;
  sessionId?: string;
  cwd?: string;
  status?: TabStatus;
};

function disconnectPaneSessions(runtimes: Array<PaneRuntime | undefined>) {
  for (const runtime of runtimes) {
    if (!runtime?.sessionId) continue;

    if (runtime.connectionId === 'local') {
      void tauriApi.localShellDisconnect(runtime.sessionId).catch(() => {});
    } else {
      void tauriApi.sshDisconnect(runtime.sessionId).catch(() => {});
    }
  }
}

interface SplitState {
  splitTrees: Record<string, SplitNode>;
  focusedPaneIdByTabId: Record<string, string | null>;
  paneRuntimeById: Record<string, PaneRuntime>;
  initSplit: (tabId: string, connectionId: string) => void;
  removeSplit: (tabId: string) => void;
  splitPane: (tabId: string, paneId: string, direction: PaneSplitDirection) => void;
  splitPaneWithConnection: (tabId: string, paneId: string, direction: PaneSplitDirection, connectionId: string) => void;
  mergePaneIntoTab: (sourceTabId: string, sourcePaneId: string, targetTabId: string, targetPaneId: string, direction: PaneSplitDirection) => string | null;
  closePane: (tabId: string, paneId: string) => void;
  updateRatio: (tabId: string, path: number[], ratio: number) => void;
  setFocusedPane: (tabId: string, paneId: string | null) => void;
  setPaneSessionId: (paneId: string, sessionId?: string) => void;
  setPaneCwd: (paneId: string, cwd: string) => void;
  setPaneStatus: (paneId: string, status: TabStatus) => void;
  getSplitTree: (tabId: string) => SplitNode | null;
  getAllPaneIds: (tabId: string) => string[];
  getFocusedPaneId: (tabId: string) => string | null;
}

function createLeaf(tabId: string, connectionId: string, id?: string): SplitLeaf {
  return {
    type: 'leaf',
    id: id ?? crypto.randomUUID(),
    connectionId,
    tabId,
  };
}

function collectPaneIds(node: SplitNode): string[] {
  if (node.type === 'leaf') {
    return [node.id];
  }

  return [...collectPaneIds(node.first), ...collectPaneIds(node.second)];
}

export function getPrimaryPaneId(node: SplitNode): string {
  if (node.type === 'leaf') {
    return node.id;
  }

  return getPrimaryPaneId(node.first);
}

function createBranch(direction: PaneSplitDirection, original: SplitLeaf, nextLeaf: SplitLeaf): SplitBranch {
  if (direction === 'right') {
    return {
      type: 'branch',
      direction: 'horizontal',
      ratio: 0.5,
      first: original,
      second: nextLeaf,
    };
  }

  if (direction === 'left') {
    return {
      type: 'branch',
      direction: 'horizontal',
      ratio: 0.5,
      first: nextLeaf,
      second: original,
    };
  }

  if (direction === 'down') {
    return {
      type: 'branch',
      direction: 'vertical',
      ratio: 0.5,
      first: original,
      second: nextLeaf,
    };
  }

  return {
    type: 'branch',
    direction: 'vertical',
    ratio: 0.5,
    first: nextLeaf,
    second: original,
  };
}

function splitNode(node: SplitNode, paneId: string, direction: PaneSplitDirection, tabId: string): SplitNode {
  if (node.type === 'leaf') {
    if (node.id !== paneId) {
      return node;
    }

    const nextLeaf = createLeaf(tabId, node.connectionId);
    return createBranch(direction, node, nextLeaf);
  }

  return {
    ...node,
    first: splitNode(node.first, paneId, direction, tabId),
    second: splitNode(node.second, paneId, direction, tabId),
  };
}

function splitNodeWithConnection(node: SplitNode, paneId: string, direction: PaneSplitDirection, tabId: string, connectionId: string): SplitNode {
  if (node.type === 'leaf') {
    if (node.id !== paneId) {
      return node;
    }

    const nextLeaf = createLeaf(tabId, connectionId);
    return createBranch(direction, node, nextLeaf);
  }

  return {
    ...node,
    first: splitNodeWithConnection(node.first, paneId, direction, tabId, connectionId),
    second: splitNodeWithConnection(node.second, paneId, direction, tabId, connectionId),
  };
}

function closeNode(node: SplitNode, paneId: string): SplitNode | null {
  if (node.type === 'leaf') {
    return node.id === paneId ? null : node;
  }

  const nextFirst = closeNode(node.first, paneId);
  const nextSecond = closeNode(node.second, paneId);

  if (!nextFirst && !nextSecond) {
    return null;
  }

  if (!nextFirst) {
    return nextSecond;
  }

  if (!nextSecond) {
    return nextFirst;
  }

  return {
    ...node,
    first: nextFirst,
    second: nextSecond,
  };
}

function updateNodeRatio(node: SplitNode, path: number[], ratio: number): SplitNode {
  if (path.length === 0) {
    if (node.type === 'leaf') {
      return node;
    }

    return {
      ...node,
      ratio,
    };
  }

  if (node.type === 'leaf') {
    return node;
  }

  const [segment, ...rest] = path;

  if (segment === 0) {
    return {
      ...node,
      first: updateNodeRatio(node.first, rest, ratio),
    };
  }

  return {
    ...node,
    second: updateNodeRatio(node.second, rest, ratio),
  };
}

function replaceTabId(node: SplitNode, tabId: string): SplitNode {
  if (node.type === 'leaf') {
    return {
      ...node,
      tabId,
    };
  }

  return {
    ...node,
    first: replaceTabId(node.first, tabId),
    second: replaceTabId(node.second, tabId),
  };
}

function extractLeaf(node: SplitNode, paneId: string): { leaf: SplitLeaf | null; tree: SplitNode | null } {
  if (node.type === 'leaf') {
    return node.id === paneId ? { leaf: node, tree: null } : { leaf: null, tree: node };
  }

  const left = extractLeaf(node.first, paneId);
  if (left.leaf) {
    if (!left.tree) {
      return { leaf: left.leaf, tree: node.second };
    }

    return {
      leaf: left.leaf,
      tree: {
        ...node,
        first: left.tree,
      },
    };
  }

  const right = extractLeaf(node.second, paneId);
  if (right.leaf) {
    if (!right.tree) {
      return { leaf: right.leaf, tree: node.first };
    }

    return {
      leaf: right.leaf,
      tree: {
        ...node,
        second: right.tree,
      },
    };
  }

  return { leaf: null, tree: node };
}

function insertExistingLeaf(node: SplitNode, paneId: string, direction: PaneSplitDirection, incomingLeaf: SplitLeaf): SplitNode {
  if (node.type === 'leaf') {
    if (node.id !== paneId) {
      return node;
    }

    return createBranch(direction, node, incomingLeaf);
  }

  return {
    ...node,
    first: insertExistingLeaf(node.first, paneId, direction, incomingLeaf),
    second: insertExistingLeaf(node.second, paneId, direction, incomingLeaf),
  };
}

function clampRatio(ratio: number) {
  return Math.min(0.85, Math.max(0.15, ratio));
}

export const useSplitStore = create<SplitState>((set, get) => ({
  splitTrees: {},
  focusedPaneIdByTabId: {},
  paneRuntimeById: {},

  initSplit: (tabId, connectionId) => {
    set((state) => {
      if (state.splitTrees[tabId]) {
        return state;
      }

      const root = createLeaf(tabId, connectionId, tabId);

      return {
        splitTrees: {
          ...state.splitTrees,
          [tabId]: root,
        },
        focusedPaneIdByTabId: {
          ...state.focusedPaneIdByTabId,
          [tabId]: root.id,
        },
        paneRuntimeById: {
          ...state.paneRuntimeById,
          [root.id]: {
            connectionId,
          },
        },
      };
    });
  },

  removeSplit: (tabId) => {
    set((state) => {
      const tree = state.splitTrees[tabId];

      if (!tree) {
        return state;
      }

      const paneIds = collectPaneIds(tree);
      disconnectPaneSessions(paneIds.map((paneId) => state.paneRuntimeById[paneId]));

      const nextTrees = { ...state.splitTrees };
      delete nextTrees[tabId];

      const nextFocusedPaneIdByTabId = { ...state.focusedPaneIdByTabId };
      delete nextFocusedPaneIdByTabId[tabId];

      const nextPaneRuntimeById = { ...state.paneRuntimeById };
      paneIds.forEach((paneId) => {
        delete nextPaneRuntimeById[paneId];
      });

      return {
        splitTrees: nextTrees,
        focusedPaneIdByTabId: nextFocusedPaneIdByTabId,
        paneRuntimeById: nextPaneRuntimeById,
      };
    });
  },

  splitPane: (tabId, paneId, direction) => {
    set((state) => {
      const tree = state.splitTrees[tabId];

      if (!tree) {
        return state;
      }

      const nextTree = splitNode(tree, paneId, direction, tabId);
      const nextPaneIds = collectPaneIds(nextTree);
      const previousPaneIds = new Set(collectPaneIds(tree));
      const newPaneId = nextPaneIds.find((id) => !previousPaneIds.has(id)) ?? paneId;
      const sourceRuntime = state.paneRuntimeById[paneId] ?? { connectionId: 'local' };

      return {
        splitTrees: {
          ...state.splitTrees,
          [tabId]: nextTree,
        },
        focusedPaneIdByTabId: {
          ...state.focusedPaneIdByTabId,
          [tabId]: newPaneId,
        },
        paneRuntimeById: {
          ...state.paneRuntimeById,
          [newPaneId]: {
            connectionId: sourceRuntime.connectionId,
            cwd: sourceRuntime.cwd,
          },
        },
      };
    });
  },

  splitPaneWithConnection: (tabId, paneId, direction, connectionId) => {
    set((state) => {
      const tree = state.splitTrees[tabId];

      if (!tree) {
        return state;
      }

      const nextTree = splitNodeWithConnection(tree, paneId, direction, tabId, connectionId);
      const nextPaneIds = collectPaneIds(nextTree);
      const previousPaneIds = new Set(collectPaneIds(tree));
      const newPaneId = nextPaneIds.find((id) => !previousPaneIds.has(id)) ?? paneId;

      return {
        splitTrees: {
          ...state.splitTrees,
          [tabId]: nextTree,
        },
        focusedPaneIdByTabId: {
          ...state.focusedPaneIdByTabId,
          [tabId]: newPaneId,
        },
        paneRuntimeById: {
          ...state.paneRuntimeById,
          [newPaneId]: {
            connectionId,
          },
        },
      };
    });
  },

  mergePaneIntoTab: (sourceTabId, sourcePaneId, targetTabId, targetPaneId, direction) => {
    let mergedPaneId: string | null = null;

    set((state) => {
      const sourceTree = state.splitTrees[sourceTabId];
      const targetTree = state.splitTrees[targetTabId];

      if (!sourceTree || !targetTree || sourceTabId === targetTabId) {
        return state;
      }

      const extracted = extractLeaf(sourceTree, sourcePaneId);
      if (!extracted.leaf) {
        return state;
      }

      const movedLeaf = replaceTabId(extracted.leaf, targetTabId) as SplitLeaf;
      const nextTargetTree = insertExistingLeaf(targetTree, targetPaneId, direction, movedLeaf);
      mergedPaneId = movedLeaf.id;

      const nextSplitTrees = {
        ...state.splitTrees,
        [targetTabId]: nextTargetTree,
      };

      const nextFocusedPaneIdByTabId = {
        ...state.focusedPaneIdByTabId,
        [targetTabId]: movedLeaf.id,
      };

      const nextPaneRuntimeById = { ...state.paneRuntimeById };
      nextPaneRuntimeById[movedLeaf.id] = {
        ...(state.paneRuntimeById[movedLeaf.id] ?? { connectionId: movedLeaf.connectionId }),
        connectionId: movedLeaf.connectionId,
      };

      if (extracted.tree) {
        nextSplitTrees[sourceTabId] = extracted.tree;
        const remainingSourcePaneIds = collectPaneIds(extracted.tree);
        nextFocusedPaneIdByTabId[sourceTabId] = remainingSourcePaneIds[0] ?? null;

        const sourcePaneIds = collectPaneIds(sourceTree);
        const sourceRemovedPaneIds = sourcePaneIds.filter((paneId) => !remainingSourcePaneIds.includes(paneId));
        sourceRemovedPaneIds.forEach((paneId) => {
          if (paneId !== movedLeaf.id) {
            delete nextPaneRuntimeById[paneId];
          }
        });
      } else {
        delete nextSplitTrees[sourceTabId];
        delete nextFocusedPaneIdByTabId[sourceTabId];
      }

      return {
        splitTrees: nextSplitTrees,
        focusedPaneIdByTabId: nextFocusedPaneIdByTabId,
        paneRuntimeById: nextPaneRuntimeById,
      };
    });

    return mergedPaneId;
  },

  closePane: (tabId, paneId) => {
    set((state) => {
      const tree = state.splitTrees[tabId];

      if (!tree || tree.type === 'leaf') {
        return state;
      }

      const nextTree = closeNode(tree, paneId);

      if (!nextTree) {
        return state;
      }

      disconnectPaneSessions([state.paneRuntimeById[paneId]]);

      const nextPaneIds = collectPaneIds(nextTree);
      const nextPaneRuntimeById = { ...state.paneRuntimeById };
      delete nextPaneRuntimeById[paneId];

      return {
        splitTrees: {
          ...state.splitTrees,
          [tabId]: nextTree,
        },
        focusedPaneIdByTabId: {
          ...state.focusedPaneIdByTabId,
          [tabId]: state.focusedPaneIdByTabId[tabId] === paneId ? nextPaneIds[0] ?? null : state.focusedPaneIdByTabId[tabId],
        },
        paneRuntimeById: nextPaneRuntimeById,
      };
    });
  },

  updateRatio: (tabId, path, ratio) => {
    set((state) => {
      const tree = state.splitTrees[tabId];

      if (!tree) {
        return state;
      }

      return {
        splitTrees: {
          ...state.splitTrees,
          [tabId]: updateNodeRatio(tree, path, clampRatio(ratio)),
        },
      };
    });
  },

  setFocusedPane: (tabId, paneId) => {
    set((state) => ({
      focusedPaneIdByTabId: {
        ...state.focusedPaneIdByTabId,
        [tabId]: paneId,
      },
    }));
  },

  setPaneSessionId: (paneId, sessionId) => {
    set((state) => ({
      paneRuntimeById: {
        ...state.paneRuntimeById,
        [paneId]: {
          ...(state.paneRuntimeById[paneId] ?? { connectionId: 'local' }),
          sessionId,
        },
      },
    }));
  },

  setPaneCwd: (paneId, cwd) => {
    set((state) => ({
      paneRuntimeById: {
        ...state.paneRuntimeById,
        [paneId]: {
          ...(state.paneRuntimeById[paneId] ?? { connectionId: 'local' }),
          cwd,
        },
      },
    }));
  },

  setPaneStatus: (paneId, status) => {
    set((state) => ({
      paneRuntimeById: {
        ...state.paneRuntimeById,
        [paneId]: {
          ...(state.paneRuntimeById[paneId] ?? { connectionId: 'local' }),
          status,
        },
      },
    }));
  },

  getSplitTree: (tabId) => get().splitTrees[tabId] ?? null,

  getAllPaneIds: (tabId) => {
    const tree = get().splitTrees[tabId];
    return tree ? collectPaneIds(tree) : [];
  },

  getFocusedPaneId: (tabId) => get().focusedPaneIdByTabId[tabId] ?? null,
}));

export type { PaneRuntime, PaneSplitDirection, SplitDirection };
