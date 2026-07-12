import '@xterm/xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCw, Network } from 'lucide-react';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { useSSH } from '../../hooks/useSSH';
import { useTerminalCopyPaste } from '../../hooks/useTerminalCopyPaste';
import { useTerminalStore } from '../../stores/terminalStore';
import { useSplitStore } from '../../stores/splitStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { TunnelManager } from '../tunnels/TunnelManager';
import type { TabStatus } from '../../types/terminal';

export interface TerminalCopyPasteHandle {
  copySelection: () => void;
  pasteClipboard: () => Promise<void>;
  hasSelection: () => boolean;
}

interface Props {
  connectionId: string;
  tabId: string;
  paneId?: string;
  reportTabState?: boolean;
  isFocusedPane?: boolean;
  onStatusChange?: (status: TabStatus) => void;
  onSessionChange?: (sessionId?: string) => void;
  onCopyPasteReady?: (handle: TerminalCopyPasteHandle) => void;
}

function getTerminalTheme() {
  const styles = getComputedStyle(document.documentElement);

  return {
    background: styles.getPropertyValue('--color-terminal-bg').trim() || styles.getPropertyValue('--color-bg-primary').trim(),
    foreground: styles.getPropertyValue('--color-terminal-fg').trim() || styles.getPropertyValue('--color-text-primary').trim(),
    cursor: styles.getPropertyValue('--color-terminal-cursor').trim() || styles.getPropertyValue('--color-text-primary').trim(),
    selectionBackground: styles.getPropertyValue('--color-terminal-selection').trim() || styles.getPropertyValue('--color-hover').trim(),
  };
}

export function TerminalView({
  connectionId,
  tabId,
  paneId = tabId,
  reportTabState = true,
  isFocusedPane = true,
  onStatusChange,
  onSessionChange,
  onCopyPasteReady,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const encoderRef = useRef(new TextEncoder());
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCwdRef = useRef<string | null>(null);
  const mountedSessionIdRef = useRef<string | null>(null);
  const connectingRef = useRef(false);
  const statusChangeRef = useRef<(status: TabStatus) => void>(() => {});
  const sessionChangeRef = useRef<(sessionId?: string) => void>(() => {});
  const [tunnelPanelOpen, setTunnelPanelOpen] = useState(false);

  const { connect, attach, disconnect, cancelConnect, write, resize, connectionState, error } = useSSH();
  const { updateTabStatus, setTabSessionId, activeTabId: currentActiveTabId } = useTerminalStore();
  const paneRuntime = useSplitStore((state) => state.paneRuntimeById[paneId] ?? null);
  const { setPaneSessionId, setPaneCwd, setPaneStatus } = useSplitStore();
  const { terminalFont, terminalFontSize, cursorStyle, cursorBlink, scrollbackBuffer, autoReconnect, theme } = useSettingsStore();

  const { copySelection, pasteClipboard, hasSelection, attach: attachCopyPaste } = useTerminalCopyPaste({
    terminalRef,
    sessionIdRef,
    encoderRef,
    writeFn: write,
  });

  useEffect(() => {
    onCopyPasteReady?.({ copySelection, pasteClipboard, hasSelection });
  }, [copySelection, pasteClipboard, hasSelection, onCopyPasteReady]);

  useEffect(() => {
    statusChangeRef.current = onStatusChange ?? (reportTabState ? (status) => updateTabStatus(tabId, status) : () => {});
  }, [onStatusChange, reportTabState, tabId, updateTabStatus]);

  useEffect(() => {
    sessionChangeRef.current = onSessionChange ?? (reportTabState ? (sessionId) => setTabSessionId(tabId, sessionId) : () => {});
  }, [onSessionChange, reportTabState, setTabSessionId, tabId]);

  const emitStatusChange = useCallback((status: TabStatus) => {
    statusChangeRef.current(status);
  }, []);

  const emitSessionChange = useCallback((sessionId?: string) => {
    sessionChangeRef.current(sessionId);
  }, []);

  const handleStreamData = useCallback((data: number[]) => {
    const bytes = new Uint8Array(data);
    terminalRef.current?.write(bytes);

    const text = new TextDecoder().decode(bytes);
    const osc7Match = text.match(/\x1b\]7;file:\/\/[^/]*(\/[^\x07\x1b]*)/);
    if (osc7Match?.[1]) {
      lastCwdRef.current = decodeURIComponent(osc7Match[1]);
      setPaneCwd(paneId, lastCwdRef.current);
    }
  }, [paneId, setPaneCwd]);

  useEffect(() => {
    const terminalHost = terminalHostRef.current;
    if (!terminalHost) {
      return;
    }

    const terminal = new Terminal({
      allowTransparency: true,
      cursorBlink,
      cursorStyle,
      fontFamily: terminalFont,
      fontSize: terminalFontSize,
      scrollback: scrollbackBuffer,
      theme: getTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(new WebLinksAddon((_event, uri) => {
      void shellOpen(uri);
    }));
    terminal.open(terminalHost);
    attachCopyPaste(terminal);

    try {
      terminal.loadAddon(new WebglAddon());
    } catch {}

    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    const handleTerminalData = terminal.onData((value) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) {
        return;
      }

      const data = Array.from(encoderRef.current.encode(value));
      void write(sessionId, data).catch((writeError) => {
        console.error('Failed to write terminal data:', writeError);
      });
    });

    let lastCols = terminal.cols;
    let lastRows = terminal.rows;
    let disposed = false;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    const syncRemoteSize = () => {
      if (disposed) return;
      if (resizeTimer) clearTimeout(resizeTimer);

      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        if (disposed) return;

        const currentTerminal = terminalRef.current;
        const currentSessionId = sessionIdRef.current;
        const currentFitAddon = fitAddonRef.current;
        if (!currentTerminal || !currentSessionId || !currentFitAddon) {
          return;
        }

        currentFitAddon.fit();
        if (currentTerminal.cols === lastCols && currentTerminal.rows === lastRows) {
          return;
        }

        lastCols = currentTerminal.cols;
        lastRows = currentTerminal.rows;
        void resize(currentSessionId, currentTerminal.cols, currentTerminal.rows).catch(() => {});
      }, 50);
    };

    const resizeObserver = new ResizeObserver(syncRemoteSize);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    window.addEventListener('resize', syncRemoteSize);

    return () => {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      window.removeEventListener('resize', syncRemoteSize);
      resizeObserver.disconnect();
      handleTerminalData.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [attachCopyPaste, cursorBlink, cursorStyle, resize, scrollbackBuffer, terminalFont, terminalFontSize, write]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) {
      return;
    }

    terminal.options.cursorBlink = cursorBlink;
    terminal.options.cursorStyle = cursorStyle;
    terminal.options.fontFamily = terminalFont;
    terminal.options.fontSize = terminalFontSize;
    terminal.options.scrollback = scrollbackBuffer;

    requestAnimationFrame(() => {
      if (terminalRef.current) {
        terminalRef.current.options.theme = getTerminalTheme();
        terminalRef.current.refresh(0, terminalRef.current.rows - 1);
      }
    });

    fitAddon.fit();
  }, [cursorBlink, cursorStyle, scrollbackBuffer, terminalFont, terminalFontSize, theme]);

  const isActive = currentActiveTabId === tabId;
  const wasActiveRef = useRef(isActive);

  useEffect(() => {
    if (isActive && isFocusedPane && !wasActiveRef.current) {
      requestAnimationFrame(() => {
        const terminal = terminalRef.current;
        const fitAddon = fitAddonRef.current;
        if (!terminal || !fitAddon) return;
        fitAddon.fit();
        terminal.refresh(0, terminal.rows - 1);
        terminal.focus();
      });
    }
    wasActiveRef.current = isActive;
  }, [isActive, isFocusedPane]);

  useEffect(() => {
    if (!isActive || !isFocusedPane) {
      return;
    }

    requestAnimationFrame(() => {
      terminalRef.current?.focus();
    });
  }, [isActive, isFocusedPane]);

  const doConnect = useCallback(async () => {
    const terminal = terminalRef.current;
    if (!terminal || connectingRef.current) return;

    connectingRef.current = true;
    emitStatusChange('connecting');
    setPaneStatus(paneId, 'connecting');

    try {
      const initialCols = terminal.cols || 80;
      const initialRows = terminal.rows || 24;
      const existingSessionId = paneRuntime?.sessionId;

      let sessionId: string | undefined;
      if (existingSessionId) {
        try {
          sessionId = await attach(existingSessionId, handleStreamData, initialCols, initialRows);
        } catch {
          setPaneSessionId(paneId, undefined);
          sessionId = await connect(connectionId, handleStreamData, initialCols, initialRows);
        }
      } else {
        sessionId = await connect(connectionId, handleStreamData, initialCols, initialRows);
      }

      // Cancelled while connect/attach was in-flight.
      if (!sessionId) return;

      // Pane closed while connect was in-flight.
      if (!useSplitStore.getState().paneRuntimeById[paneId]) {
        void disconnect(sessionId).catch(() => {});
        return;
      }

      sessionIdRef.current = sessionId;
      mountedSessionIdRef.current = sessionId;
      setPaneSessionId(paneId, sessionId);
      emitSessionChange(sessionId);
      emitStatusChange('connected');
      setPaneStatus(paneId, 'connected');
      reconnectAttemptRef.current = 0;
    } catch (connectError) {
      console.error('Failed to connect SSH terminal:', connectError);
    } finally {
      connectingRef.current = false;
    }
  }, [attach, connect, connectionId, disconnect, emitSessionChange, emitStatusChange, handleStreamData, paneId, paneRuntime?.sessionId, setPaneSessionId, setPaneStatus]);

  const handleReconnect = useCallback(() => {
    const oldSessionId = sessionIdRef.current;
    sessionIdRef.current = null;
    emitSessionChange(undefined);
    if (oldSessionId) {
      void disconnect(oldSessionId).catch(() => {});
    }
    terminalRef.current?.write('\r\n\x1b[33mReconnecting...\x1b[0m\r\n');
    void doConnect();
  }, [disconnect, doConnect, emitSessionChange]);

  const doConnectRef = useRef(doConnect);
  useEffect(() => {
    doConnectRef.current = doConnect;
  }, [doConnect]);

  const disconnectRef = useRef(disconnect);
  useEffect(() => {
    disconnectRef.current = disconnect;
  }, [disconnect]);

  const cancelConnectRef = useRef(cancelConnect);
  useEffect(() => {
    cancelConnectRef.current = cancelConnect;
  }, [cancelConnect]);

  useEffect(() => {
    if (mountedSessionIdRef.current || sessionIdRef.current) return;
    void doConnectRef.current();

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      const paneStillExists = Boolean(useSplitStore.getState().paneRuntimeById[paneId]);
      if (paneStillExists) return;

      const sessionId = mountedSessionIdRef.current ?? sessionIdRef.current;
      mountedSessionIdRef.current = null;
      sessionIdRef.current = null;

      if (sessionId) {
        void disconnectRef.current(sessionId).catch(() => {});
      } else {
        // In-flight connect: cancel so resolve path disconnects the new session.
        cancelConnectRef.current();
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId]);

  useEffect(() => {
    if (connectionState !== 'disconnected' || !autoReconnect) return;
    if (!sessionIdRef.current && reconnectAttemptRef.current === 0) return;

    const attempt = reconnectAttemptRef.current + 1;
    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
    reconnectAttemptRef.current = attempt;

    terminalRef.current?.write(`\r\n\x1b[33mAuto-reconnect in ${delay / 1000}s (attempt ${attempt})...\x1b[0m\r\n`);

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      handleReconnect();
    }, delay);

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [connectionState, autoReconnect, handleReconnect]);

  useEffect(() => {
    setPaneStatus(paneId, connectionState);

    if (connectionState === 'error') {
      emitStatusChange('error');
      return;
    }
    if (connectionState === 'connected') {
      emitStatusChange('connected');
      return;
    }
    if (connectionState === 'connecting') {
      emitStatusChange('connecting');
      return;
    }
    emitStatusChange('disconnected');
  }, [connectionState, emitStatusChange, paneId, setPaneStatus]);

  useEffect(() => {
    if (!reportTabState) {
      return;
    }

    emitStatusChange(connectionState);
    emitSessionChange(sessionIdRef.current ?? undefined);
  }, [connectionState, emitSessionChange, emitStatusChange, reportTabState]);

  return (
    <div ref={containerRef} data-pane-id={paneId} className="relative flex h-full w-full min-h-0 flex-1 bg-[var(--color-terminal-bg)]">
      <div className="relative flex h-full min-w-0 flex-1 flex-col">
        <div ref={terminalHostRef} className="flex-1 min-h-0 overflow-hidden pl-1 pt-1" />

        {connectionState === 'connected' && (
          <button
            type="button"
            onClick={() => setTunnelPanelOpen((prev) => !prev)}
            className={`absolute right-2 top-2 z-10 rounded p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-hover)] hover:text-[var(--color-text-primary)] ${tunnelPanelOpen ? 'bg-[var(--color-hover)] text-[var(--color-text-primary)]' : ''}`}
            title="Toggle tunnels panel"
          >
            <Network className="h-4 w-4" />
          </button>
        )}

        {connectionState === 'connecting' && (
          <div className="absolute inset-0 flex items-center justify-center bg-[color-mix(in_srgb,var(--color-bg-primary)_82%,transparent)]">
            <div className="flex flex-col items-center gap-3 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-6 py-4 text-sm text-[var(--color-text-secondary)] shadow-lg">
              <span>Connecting...</span>
              <button
                type="button"
                onClick={cancelConnect}
                className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-hover)] hover:text-[var(--color-text-primary)]"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {connectionState === 'disconnected' && !error && (
          <div className="absolute inset-0 flex items-center justify-center bg-[color-mix(in_srgb,var(--color-bg-primary)_78%,transparent)]">
            <div className="flex flex-col items-center gap-3 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-6 py-4 shadow-lg">
              <span className="text-sm text-[var(--color-text-muted)]">Disconnected</span>
              <button
                type="button"
                onClick={handleReconnect}
                className="inline-flex items-center gap-2 rounded bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
              >
                <RotateCw className="h-4 w-4" />
                Reconnect
              </button>
              {autoReconnect && <span className="text-xs text-[var(--color-text-muted)]">Auto-reconnect is enabled</span>}
            </div>
          </div>
        )}

        {error && (
          <div className="absolute inset-x-4 top-4 z-10 flex items-center justify-between rounded border border-[var(--color-error)] bg-[color-mix(in_srgb,var(--color-error)_10%,var(--color-bg-secondary))] px-4 py-3 shadow-lg">
            <span className="text-sm text-[var(--color-error)]">{error}</span>
            <button
              type="button"
              onClick={handleReconnect}
              className="ml-4 inline-flex items-center gap-1.5 rounded bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
            >
              <RotateCw className="h-3.5 w-3.5" />
              Retry
            </button>
          </div>
        )}
      </div>

      {tunnelPanelOpen && <TunnelManager sessionId={sessionIdRef.current} />}
    </div>
  );
}
