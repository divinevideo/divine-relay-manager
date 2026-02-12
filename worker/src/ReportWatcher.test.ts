// ABOUTME: Tests for ReportWatcher Durable Object
// ABOUTME: Tests start/stop/status and WebSocket functionality

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReportWatcher, type ReportWatcherEnv, type ReportEvent } from './ReportWatcher';

// Mock WebSocket instances created during tests
let mockWebSockets: MockWebSocket[] = [];

// Mock WebSocket class
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  url: string;

  private listeners: Map<string, Array<(event: unknown) => void>> = new Map();

  constructor(url: string) {
    this.url = url;
    mockWebSockets.push(this);

    // Simulate async connection
    setTimeout(() => {
      if (this.readyState === MockWebSocket.CONNECTING) {
        this.readyState = MockWebSocket.OPEN;
        this.emit('open', {});
      }
    }, 0);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)!.push(listener);
  }

  send = vi.fn();

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', { code: 1000, reason: 'Normal closure' });
  }

  // Test helpers
  emit(type: string, event: unknown): void {
    const handlers = this.listeners.get(type) || [];
    for (const handler of handlers) {
      handler(event);
    }
  }

  simulateMessage(data: string): void {
    this.emit('message', { data });
  }

  simulateClose(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', { code, reason });
  }
}

// Mock DurableObjectState
function createMockState() {
  const storage = new Map<string, unknown>();
  let alarmTime: number | null = null;

  return {
    id: { toString: () => 'test-id' },
    storage: {
      get: vi.fn(async <T>(key: string) => storage.get(key) as T | undefined),
      put: vi.fn(async (key: string, value: unknown) => {
        storage.set(key, value);
      }),
      delete: vi.fn(async (key: string) => storage.delete(key)),
      list: vi.fn(async () => storage),
      setAlarm: vi.fn(async (time: number) => {
        alarmTime = time;
      }),
      getAlarm: vi.fn(async () => alarmTime),
      deleteAlarm: vi.fn(async () => {
        alarmTime = null;
      }),
    },
    blockConcurrencyWhile: vi.fn(async (fn: () => Promise<void>) => {
      await fn();
    }),
    waitUntil: vi.fn(),
  } as unknown as DurableObjectState;
}

// Mock environment
function createMockEnv(overrides: Partial<ReportWatcherEnv> = {}): ReportWatcherEnv {
  return {
    // Valid test nsec (DO NOT USE IN PRODUCTION - this is a throwaway test key)
    NOSTR_NSEC: 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5',
    // Funnelcake serves NIP-86 at root path
    MANAGEMENT_PATH: '/',
    RELAY_URL: 'wss://relay.test.com',
    AUTO_HIDE_ENABLED: 'false',
    ...overrides,
  };
}

// Get the last created mock WebSocket
function getLastMockWebSocket(): MockWebSocket | null {
  return mockWebSockets.length > 0 ? mockWebSockets[mockWebSockets.length - 1] : null;
}

describe('ReportWatcher', () => {
  let watcher: ReportWatcher;
  let mockState: DurableObjectState;
  let mockEnv: ReportWatcherEnv;
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    // Clear mock WebSockets
    mockWebSockets = [];

    // Save original WebSocket and replace with mock
    originalWebSocket = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket as unknown as typeof WebSocket;

    mockState = createMockState();
    mockEnv = createMockEnv();
    watcher = new ReportWatcher(mockState, mockEnv);
  });

  afterEach(() => {
    // Restore original WebSocket
    globalThis.WebSocket = originalWebSocket;
  });

  describe('fetch /status', () => {
    it('should return initial status when not started', async () => {
      const request = new Request('https://do/status', { method: 'GET' });
      const response = await watcher.fetch(request);

      expect(response.status).toBe(200);

      const body = await response.json() as { success: boolean; status: { running: boolean; connected: boolean } };
      expect(body.success).toBe(true);
      expect(body.status.running).toBe(false);
      expect(body.status.connected).toBe(false);
      expect(body.status.connectedAt).toBeNull();
      expect(body.status.lastEventAt).toBeNull();
      expect(body.status.eventsProcessed).toBe(0);
      expect(body.status.autoHideEnabled).toBe(false);
      expect(body.status.reconnectAttempts).toBe(0);
    });

    it('should reflect AUTO_HIDE_ENABLED from env', async () => {
      mockEnv = createMockEnv({ AUTO_HIDE_ENABLED: 'true' });
      watcher = new ReportWatcher(mockState, mockEnv);

      const request = new Request('https://do/status', { method: 'GET' });
      const response = await watcher.fetch(request);
      const body = await response.json() as { status: { autoHideEnabled: boolean } };

      expect(body.status.autoHideEnabled).toBe(true);
    });
  });

  describe('fetch /start', () => {
    it('should start the watcher', async () => {
      const request = new Request('https://do/start', { method: 'POST' });
      const response = await watcher.fetch(request);

      expect(response.status).toBe(200);

      const body = await response.json() as { success: boolean; message: string; status: { running: boolean } };
      expect(body.success).toBe(true);
      expect(body.message).toBe('Started');
      expect(body.status.running).toBe(true);
    });

    it('should create WebSocket connection', async () => {
      await watcher.fetch(new Request('https://do/start', { method: 'POST' }));

      const ws = getLastMockWebSocket();
      expect(ws).not.toBeNull();
      expect(ws!.url).toBe('wss://relay.test.com');
    });

    it('should persist state after starting', async () => {
      const request = new Request('https://do/start', { method: 'POST' });
      await watcher.fetch(request);

      expect(mockState.storage.put).toHaveBeenCalledWith('watcherState', expect.objectContaining({
        running: true,
      }));
    });

    it('should schedule health check alarm', async () => {
      await watcher.fetch(new Request('https://do/start', { method: 'POST' }));

      expect(mockState.storage.setAlarm).toHaveBeenCalled();
    });

    it('should return already running if called twice', async () => {
      const startRequest = new Request('https://do/start', { method: 'POST' });
      await watcher.fetch(startRequest);

      const response = await watcher.fetch(startRequest);
      const body = await response.json() as { message: string };

      expect(body.message).toBe('Already running');
    });
  });

  describe('fetch /stop', () => {
    it('should stop the watcher', async () => {
      // First start it
      const startRequest = new Request('https://do/start', { method: 'POST' });
      await watcher.fetch(startRequest);

      // Then stop it
      const stopRequest = new Request('https://do/stop', { method: 'POST' });
      const response = await watcher.fetch(stopRequest);

      expect(response.status).toBe(200);

      const body = await response.json() as { success: boolean; message: string; status: { running: boolean } };
      expect(body.success).toBe(true);
      expect(body.message).toBe('Stopped');
      expect(body.status.running).toBe(false);
      expect(body.status.connected).toBe(false);
    });

    it('should close WebSocket connection', async () => {
      await watcher.fetch(new Request('https://do/start', { method: 'POST' }));

      // Wait for connection
      await new Promise(resolve => setTimeout(resolve, 10));

      // Get reference to WebSocket before stopping
      const ws = getLastMockWebSocket();

      await watcher.fetch(new Request('https://do/stop', { method: 'POST' }));

      expect(ws?.readyState).toBe(MockWebSocket.CLOSED);
    });

    it('should return already stopped if not running', async () => {
      const request = new Request('https://do/stop', { method: 'POST' });
      const response = await watcher.fetch(request);
      const body = await response.json() as { message: string };

      expect(body.message).toBe('Already stopped');
    });

    it('should persist state after stopping', async () => {
      // Start first
      await watcher.fetch(new Request('https://do/start', { method: 'POST' }));

      // Then stop
      await watcher.fetch(new Request('https://do/stop', { method: 'POST' }));

      // Check the last call to put was with stopped state
      const putCalls = (mockState.storage.put as ReturnType<typeof vi.fn>).mock.calls;
      const lastCall = putCalls[putCalls.length - 1];
      expect(lastCall[1]).toMatchObject({
        running: false,
      });
    });
  });

  describe('fetch unknown path', () => {
    it('should return 404 for unknown paths', async () => {
      const request = new Request('https://do/unknown', { method: 'GET' });
      const response = await watcher.fetch(request);

      expect(response.status).toBe(404);

      const body = await response.json() as { error: string };
      expect(body.error).toBe('Not found');
    });
  });

  describe('WebSocket subscription', () => {
    it('should subscribe to kind 1984 on connection', async () => {
      await watcher.fetch(new Request('https://do/start', { method: 'POST' }));

      // Wait for connection and subscription
      await new Promise(resolve => setTimeout(resolve, 10));

      const ws = getLastMockWebSocket();
      expect(ws!.send).toHaveBeenCalledWith(
        expect.stringContaining('"kinds":[1984]')
      );
    });

    it('should send CLOSE on disconnect', async () => {
      await watcher.fetch(new Request('https://do/start', { method: 'POST' }));
      await new Promise(resolve => setTimeout(resolve, 10));

      // Manually set readyState to OPEN for test
      const ws = getLastMockWebSocket();
      ws!.readyState = MockWebSocket.OPEN;

      await watcher.fetch(new Request('https://do/stop', { method: 'POST' }));

      expect(ws!.send).toHaveBeenCalledWith(
        expect.stringContaining('CLOSE')
      );
    });
  });

  describe('message handling', () => {
    it('should process report events', async () => {
      await watcher.fetch(new Request('https://do/start', { method: 'POST' }));
      await new Promise(resolve => setTimeout(resolve, 10));

      const ws = getLastMockWebSocket();
      const reportEvent: ReportEvent = {
        id: 'abc123',
        pubkey: 'reporter_pubkey_here',
        kind: 1984,
        content: 'This is CSAM',
        tags: [
          ['e', 'target_event_id'],
          ['p', 'target_pubkey'],
          ['report', 'sexual_minors'],
        ],
        created_at: Math.floor(Date.now() / 1000),
      };

      ws!.simulateMessage(JSON.stringify([
        'EVENT',
        'auto-hide-reports',
        reportEvent,
      ]));

      // Check status shows events processed
      const response = await watcher.fetch(new Request('https://do/status', { method: 'GET' }));
      const body = await response.json() as { status: { eventsProcessed: number; lastEventAt: number } };

      expect(body.status.eventsProcessed).toBe(1);
      expect(body.status.lastEventAt).toBeGreaterThan(0);
    });

    it('should process report events with NIP-32 label tags', async () => {
      await watcher.fetch(new Request('https://do/start', { method: 'POST' }));
      await new Promise(resolve => setTimeout(resolve, 10));

      const ws = getLastMockWebSocket();
      // NIP-32 label format: ["L", "MOD"], ["l", "<category>", "MOD"]
      const reportEvent: ReportEvent = {
        id: 'def456',
        pubkey: 'reporter_pubkey_here',
        kind: 1984,
        content: 'This is CSAM (label format)',
        tags: [
          ['e', 'target_event_id'],
          ['p', 'target_pubkey'],
          ['L', 'MOD'],
          ['l', 'sexual_minors', 'MOD'],
        ],
        created_at: Math.floor(Date.now() / 1000),
      };

      ws!.simulateMessage(JSON.stringify([
        'EVENT',
        'auto-hide-reports',
        reportEvent,
      ]));

      // Check status shows events processed
      const response = await watcher.fetch(new Request('https://do/status', { method: 'GET' }));
      const body = await response.json() as { status: { eventsProcessed: number; lastEventAt: number } };

      expect(body.status.eventsProcessed).toBe(1);
      expect(body.status.lastEventAt).toBeGreaterThan(0);
    });

    it('should ignore events for other subscriptions', async () => {
      await watcher.fetch(new Request('https://do/start', { method: 'POST' }));
      await new Promise(resolve => setTimeout(resolve, 10));

      const ws = getLastMockWebSocket();
      ws!.simulateMessage(JSON.stringify([
        'EVENT',
        'other-subscription',
        { id: 'abc', kind: 1984, pubkey: 'x', content: '', tags: [], created_at: 0 },
      ]));

      const response = await watcher.fetch(new Request('https://do/status', { method: 'GET' }));
      const body = await response.json() as { status: { eventsProcessed: number } };

      expect(body.status.eventsProcessed).toBe(0);
    });
  });

  describe('state restoration', () => {
    it('should restore running state from storage', async () => {
      // Pre-populate storage
      const storedState = {
        running: true,
        eventsProcessed: 42,
      };
      (mockState.storage.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(storedState);

      // Create new watcher (triggers restore)
      const restoredWatcher = new ReportWatcher(mockState, mockEnv);

      // Wait for blockConcurrencyWhile to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      // Check status
      const request = new Request('https://do/status', { method: 'GET' });
      const response = await restoredWatcher.fetch(request);
      const body = await response.json() as { status: { running: boolean; eventsProcessed: number } };

      expect(body.status.running).toBe(true);
      expect(body.status.eventsProcessed).toBe(42);
    });

    it('should reconnect on restoration if was running', async () => {
      const storedState = {
        running: true,
        eventsProcessed: 0,
      };
      (mockState.storage.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(storedState);

      // Create new watcher (triggers restore and reconnect)
      new ReportWatcher(mockState, mockEnv);

      // Wait for blockConcurrencyWhile to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      // Should have created a WebSocket
      expect(getLastMockWebSocket()).not.toBeNull();
    });
  });

  describe('alarm handler', () => {
    it('should reconnect if connection lost', async () => {
      await watcher.fetch(new Request('https://do/start', { method: 'POST' }));
      await new Promise(resolve => setTimeout(resolve, 10));

      // Simulate connection loss
      const oldWs = getLastMockWebSocket();
      oldWs!.readyState = MockWebSocket.CLOSED;

      // Trigger alarm
      await watcher.alarm();

      // Should have created a new WebSocket
      expect(getLastMockWebSocket()).not.toBe(oldWs);
    });

    it('should skip alarm if not running', async () => {
      const wsCountBefore = mockWebSockets.length;

      // Trigger alarm without starting
      await watcher.alarm();

      // Should not have created a WebSocket
      expect(mockWebSockets.length).toBe(wsCountBefore);
    });
  });

  describe('auto-hide logic', () => {
    let mockFetch: ReturnType<typeof vi.fn>;
    let mockDbRun: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: true }),
      });
      vi.stubGlobal('fetch', mockFetch);

      mockDbRun = vi.fn().mockResolvedValue({ success: true });
      mockEnv.DB = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            run: mockDbRun,
            first: vi.fn().mockResolvedValue(null), // Default: no existing decision
          }),
        }),
      } as unknown as D1Database;
    });

    it('should skip auto-hide when AUTO_HIDE_ENABLED is false', async () => {
      mockEnv.AUTO_HIDE_ENABLED = 'false';

      await watcher.fetch(new Request('https://do/start', { method: 'POST' }));
      await new Promise(resolve => setTimeout(resolve, 10));

      const ws = getLastMockWebSocket();
      const reportEvent: ReportEvent = {
        id: 'report123',
        pubkey: 'reporter_pubkey',
        kind: 1984,
        content: 'CSAM report',
        tags: [
          ['e', 'target_event_id'],
          ['report', 'sexual_minors'],
        ],
        created_at: Math.floor(Date.now() / 1000),
      };

      ws!.simulateMessage(JSON.stringify(['EVENT', 'auto-hide-reports', reportEvent]));
      await new Promise(resolve => setTimeout(resolve, 10));

      // Should NOT have called fetch (banevent)
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should skip auto-hide for non-qualifying categories', async () => {
      mockEnv.AUTO_HIDE_ENABLED = 'true';

      await watcher.fetch(new Request('https://do/start', { method: 'POST' }));
      await new Promise(resolve => setTimeout(resolve, 10));

      const ws = getLastMockWebSocket();
      const reportEvent: ReportEvent = {
        id: 'report123',
        pubkey: 'reporter_pubkey',
        kind: 1984,
        content: 'Spam report',
        tags: [
          ['e', 'target_event_id'],
          ['report', 'spam'],  // Not in auto-hide categories
        ],
        created_at: Math.floor(Date.now() / 1000),
      };

      ws!.simulateMessage(JSON.stringify(['EVENT', 'auto-hide-reports', reportEvent]));
      await new Promise(resolve => setTimeout(resolve, 10));

      // Should NOT have called fetch (banevent)
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should call banevent when enabled for qualifying category from trusted client', async () => {
      mockEnv.AUTO_HIDE_ENABLED = 'true';

      await watcher.fetch(new Request('https://do/start', { method: 'POST' }));
      await new Promise(resolve => setTimeout(resolve, 10));

      const ws = getLastMockWebSocket();
      const reportEvent: ReportEvent = {
        id: 'report123',
        pubkey: 'reporter_pubkey',
        kind: 1984,
        content: 'CSAM report',
        tags: [
          ['e', 'target_event_id_12345'],
          ['report', 'sexual_minors'],
          ['client', 'diVine'],
        ],
        created_at: Math.floor(Date.now() / 1000),
      };

      ws!.simulateMessage(JSON.stringify(['EVENT', 'auto-hide-reports', reportEvent]));
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should have called fetch (banevent)
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      // Funnelcake serves NIP-86 at root path
      expect(url).toBe('https://relay.test.com/');
      expect(options.method).toBe('POST');

      const body = JSON.parse(options.body);
      expect(body.method).toBe('banevent');
      expect(body.params[0]).toBe('target_event_id_12345');
    });

    it('should log decision to D1 on successful auto-hide', async () => {
      mockEnv.AUTO_HIDE_ENABLED = 'true';

      await watcher.fetch(new Request('https://do/start', { method: 'POST' }));
      await new Promise(resolve => setTimeout(resolve, 10));

      const ws = getLastMockWebSocket();
      const reportEvent: ReportEvent = {
        id: 'report456',
        pubkey: 'reporter_pubkey_abc',
        kind: 1984,
        content: 'CSAM report',
        tags: [
          ['e', 'target_event_xyz'],
          ['l', 'sexual_minors', 'MOD'],
          ['client', 'diVine'],
        ],
        created_at: Math.floor(Date.now() / 1000),
      };

      ws!.simulateMessage(JSON.stringify(['EVENT', 'auto-hide-reports', reportEvent]));
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should have logged to D1
      expect(mockEnv.DB!.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO moderation_decisions')
      );
      expect(mockDbRun).toHaveBeenCalled();
    });

    it('should increment eventsAutoHidden counter on success', async () => {
      mockEnv.AUTO_HIDE_ENABLED = 'true';

      await watcher.fetch(new Request('https://do/start', { method: 'POST' }));
      await new Promise(resolve => setTimeout(resolve, 10));

      const ws = getLastMockWebSocket();
      const reportEvent: ReportEvent = {
        id: 'report789',
        pubkey: 'reporter',
        kind: 1984,
        content: 'CSAM',
        tags: [
          ['e', 'target_event'],
          ['report', 'sexual_minors'],
          ['client', 'diVine'],
        ],
        created_at: Math.floor(Date.now() / 1000),
      };

      ws!.simulateMessage(JSON.stringify(['EVENT', 'auto-hide-reports', reportEvent]));
      await new Promise(resolve => setTimeout(resolve, 50));

      // Check status shows eventsAutoHidden
      const response = await watcher.fetch(new Request('https://do/status', { method: 'GET' }));
      const body = await response.json() as { status: { eventsAutoHidden: number } };

      expect(body.status.eventsAutoHidden).toBe(1);
    });

    it('should log failure when banevent fails', async () => {
      mockEnv.AUTO_HIDE_ENABLED = 'true';
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await watcher.fetch(new Request('https://do/start', { method: 'POST' }));
      await new Promise(resolve => setTimeout(resolve, 10));

      const ws = getLastMockWebSocket();
      const reportEvent: ReportEvent = {
        id: 'report_fail',
        pubkey: 'reporter',
        kind: 1984,
        content: 'CSAM',
        tags: [
          ['e', 'target_event'],
          ['report', 'sexual_minors'],
          ['client', 'diVine'],
        ],
        created_at: Math.floor(Date.now() / 1000),
      };

      ws!.simulateMessage(JSON.stringify(['EVENT', 'auto-hide-reports', reportEvent]));
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should have logged failure to D1
      expect(mockDbRun).toHaveBeenCalled();

      // eventsAutoHidden should still be 0
      const response = await watcher.fetch(new Request('https://do/status', { method: 'GET' }));
      const body = await response.json() as { status: { eventsAutoHidden: number } };
      expect(body.status.eventsAutoHidden).toBe(0);
    });

    it('should skip processing if event is already auto-hidden (deduplication)', async () => {
      mockEnv.AUTO_HIDE_ENABLED = 'true';

      // Mock D1: no human resolution, but already auto-hidden
      mockEnv.DB = {
        prepare: vi.fn().mockImplementation((sql: string) => ({
          bind: vi.fn().mockReturnValue({
            run: mockDbRun,
            first: vi.fn().mockResolvedValue(
              sql.includes('moderation_targets') ? null : { 1: 1 }
            ),
          }),
        })),
      } as unknown as D1Database;

      await watcher.fetch(new Request('https://do/start', { method: 'POST' }));
      await new Promise(resolve => setTimeout(resolve, 10));

      const ws = getLastMockWebSocket();
      const reportEvent: ReportEvent = {
        id: 'duplicate_report',
        pubkey: 'reporter',
        kind: 1984,
        content: 'Duplicate CSAM report',
        tags: [
          ['e', 'already_hidden_event'],
          ['report', 'sexual_minors'],
          ['client', 'diVine'],
        ],
        created_at: Math.floor(Date.now() / 1000),
      };

      ws!.simulateMessage(JSON.stringify(['EVENT', 'auto-hide-reports', reportEvent]));
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should NOT have called fetch (banevent) - event already hidden
      expect(mockFetch).not.toHaveBeenCalled();

      // eventsAutoHidden should be 0 (no new events hidden)
      const response = await watcher.fetch(new Request('https://do/status', { method: 'GET' }));
      const body = await response.json() as { status: { eventsAutoHidden: number } };
      expect(body.status.eventsAutoHidden).toBe(0);
    });

    it('should skip auto-hide for reports without a client tag', async () => {
      mockEnv.AUTO_HIDE_ENABLED = 'true';

      await watcher.fetch(new Request('https://do/start', { method: 'POST' }));
      await new Promise(resolve => setTimeout(resolve, 10));

      const ws = getLastMockWebSocket();
      const reportEvent: ReportEvent = {
        id: 'no_client_report',
        pubkey: 'reporter',
        kind: 1984,
        content: 'CSAM report without client tag',
        tags: [
          ['e', 'target_event'],
          ['report', 'sexual_minors'],
          // No client tag
        ],
        created_at: Math.floor(Date.now() / 1000),
      };

      ws!.simulateMessage(JSON.stringify(['EVENT', 'auto-hide-reports', reportEvent]));
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should NOT have called fetch (banevent)
      expect(mockFetch).not.toHaveBeenCalled();

      // Should have logged a skip decision to D1
      expect(mockDbRun).toHaveBeenCalled();
    });

    it('should skip auto-hide for reports from untrusted clients', async () => {
      mockEnv.AUTO_HIDE_ENABLED = 'true';

      await watcher.fetch(new Request('https://do/start', { method: 'POST' }));
      await new Promise(resolve => setTimeout(resolve, 10));

      const ws = getLastMockWebSocket();
      const reportEvent: ReportEvent = {
        id: 'untrusted_client_report',
        pubkey: 'reporter',
        kind: 1984,
        content: 'CSAM report from unknown client',
        tags: [
          ['e', 'target_event'],
          ['report', 'sexual_minors'],
          ['client', 'some-random-app'],
        ],
        created_at: Math.floor(Date.now() / 1000),
      };

      ws!.simulateMessage(JSON.stringify(['EVENT', 'auto-hide-reports', reportEvent]));
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should NOT have called fetch (banevent)
      expect(mockFetch).not.toHaveBeenCalled();

      // Should have logged a skip decision to D1
      expect(mockDbRun).toHaveBeenCalled();
    });

    it('should accept reports from all configured trusted clients', async () => {
      mockEnv.AUTO_HIDE_ENABLED = 'true';

      for (const clientName of ['diVine', 'divine-web', 'divine-mobile']) {
        // Reset mocks for each iteration
        mockFetch.mockClear();
        mockFetch.mockResolvedValue({
          ok: true,
          json: async () => ({ result: true }),
        });
        mockDbRun.mockClear();
        mockEnv.DB = {
          prepare: vi.fn().mockReturnValue({
            bind: vi.fn().mockReturnValue({
              run: mockDbRun,
              first: vi.fn().mockResolvedValue(null),
            }),
          }),
        } as unknown as D1Database;

        // Create fresh watcher for each client
        watcher = new ReportWatcher(mockState, mockEnv);
        await watcher.fetch(new Request('https://do/start', { method: 'POST' }));
        await new Promise(resolve => setTimeout(resolve, 10));

        const ws = getLastMockWebSocket();
        const reportEvent: ReportEvent = {
          id: `report_${clientName}`,
          pubkey: 'reporter',
          kind: 1984,
          content: 'CSAM report',
          tags: [
            ['e', `target_${clientName}`],
            ['report', 'sexual_minors'],
            ['client', clientName],
          ],
          created_at: Math.floor(Date.now() / 1000),
        };

        ws!.simulateMessage(JSON.stringify(['EVENT', 'auto-hide-reports', reportEvent]));
        await new Promise(resolve => setTimeout(resolve, 50));

        // Should have called fetch (banevent) for each trusted client
        expect(mockFetch).toHaveBeenCalledTimes(1);
      }
    });

    it('should skip auto-hide when target has human resolution', async () => {
      mockEnv.AUTO_HIDE_ENABLED = 'true';

      // Mock D1: moderation_targets returns a row (human reviewed),
      // moderation_decisions returns null (not already auto-hidden)
      mockEnv.DB = {
        prepare: vi.fn().mockImplementation((sql: string) => ({
          bind: vi.fn().mockReturnValue({
            run: mockDbRun,
            first: vi.fn().mockResolvedValue(
              sql.includes('moderation_targets') ? { 1: 1 } : null
            ),
          }),
        })),
      } as unknown as D1Database;

      await watcher.fetch(new Request('https://do/start', { method: 'POST' }));
      await new Promise(resolve => setTimeout(resolve, 10));

      const ws = getLastMockWebSocket();
      const reportEvent: ReportEvent = {
        id: 'report_human_reviewed',
        pubkey: 'reporter',
        kind: 1984,
        content: 'CSAM report on already-reviewed content',
        tags: [
          ['e', 'previously_reviewed_event'],
          ['report', 'sexual_minors'],
          ['client', 'diVine'],
        ],
        created_at: Math.floor(Date.now() / 1000),
      };

      ws!.simulateMessage(JSON.stringify(['EVENT', 'auto-hide-reports', reportEvent]));
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should NOT have called fetch (banevent) — human decision stands
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should proceed with auto-hide when no human resolution exists', async () => {
      mockEnv.AUTO_HIDE_ENABLED = 'true';

      // Mock D1: moderation_targets returns null (no human review),
      // moderation_decisions returns null (not already auto-hidden)
      mockEnv.DB = {
        prepare: vi.fn().mockImplementation((sql: string) => ({
          bind: vi.fn().mockReturnValue({
            run: mockDbRun,
            first: vi.fn().mockResolvedValue(null),
          }),
        })),
      } as unknown as D1Database;

      await watcher.fetch(new Request('https://do/start', { method: 'POST' }));
      await new Promise(resolve => setTimeout(resolve, 10));

      const ws = getLastMockWebSocket();
      const reportEvent: ReportEvent = {
        id: 'report_no_human_review',
        pubkey: 'reporter',
        kind: 1984,
        content: 'CSAM report on fresh content',
        tags: [
          ['e', 'never_reviewed_event'],
          ['report', 'sexual_minors'],
          ['client', 'diVine'],
        ],
        created_at: Math.floor(Date.now() / 1000),
      };

      ws!.simulateMessage(JSON.stringify(['EVENT', 'auto-hide-reports', reportEvent]));
      await new Promise(resolve => setTimeout(resolve, 50));

      // SHOULD have called fetch (banevent) — no human decision, proceed
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should proceed with auto-hide when DB is unavailable (fail open)', async () => {
      mockEnv.AUTO_HIDE_ENABLED = 'true';
      mockEnv.DB = undefined as unknown as D1Database;

      await watcher.fetch(new Request('https://do/start', { method: 'POST' }));
      await new Promise(resolve => setTimeout(resolve, 10));

      const ws = getLastMockWebSocket();
      const reportEvent: ReportEvent = {
        id: 'report_no_db',
        pubkey: 'reporter',
        kind: 1984,
        content: 'CSAM report with no DB',
        tags: [
          ['e', 'target_no_db'],
          ['report', 'sexual_minors'],
          ['client', 'diVine'],
        ],
        created_at: Math.floor(Date.now() / 1000),
      };

      ws!.simulateMessage(JSON.stringify(['EVENT', 'auto-hide-reports', reportEvent]));
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should still call banevent — fail open for enforcement
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should proceed with auto-hide when hasHumanResolution query fails (fail open)', async () => {
      mockEnv.AUTO_HIDE_ENABLED = 'true';

      // Mock D1: moderation_targets query throws, moderation_decisions returns null
      mockEnv.DB = {
        prepare: vi.fn().mockImplementation((sql: string) => ({
          bind: vi.fn().mockReturnValue({
            run: mockDbRun,
            first: vi.fn().mockImplementation(() => {
              if (sql.includes('moderation_targets')) {
                return Promise.reject(new Error('D1 query failed'));
              }
              return Promise.resolve(null);
            }),
          }),
        })),
      } as unknown as D1Database;

      await watcher.fetch(new Request('https://do/start', { method: 'POST' }));
      await new Promise(resolve => setTimeout(resolve, 10));

      const ws = getLastMockWebSocket();
      const reportEvent: ReportEvent = {
        id: 'report_db_error',
        pubkey: 'reporter',
        kind: 1984,
        content: 'CSAM report with DB error',
        tags: [
          ['e', 'target_db_error'],
          ['report', 'sexual_minors'],
          ['client', 'diVine'],
        ],
        created_at: Math.floor(Date.now() / 1000),
      };

      ws!.simulateMessage(JSON.stringify(['EVENT', 'auto-hide-reports', reportEvent]));
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should still call banevent — fail open for enforcement
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should respect custom TRUSTED_CLIENTS config', async () => {
      mockEnv.AUTO_HIDE_ENABLED = 'true';
      mockEnv.TRUSTED_CLIENTS = 'custom-app,another-app';

      await watcher.fetch(new Request('https://do/start', { method: 'POST' }));
      await new Promise(resolve => setTimeout(resolve, 10));

      const ws = getLastMockWebSocket();

      // Report from default client (diVine) should be rejected with custom config
      const reportEvent: ReportEvent = {
        id: 'divine_report',
        pubkey: 'reporter',
        kind: 1984,
        content: 'CSAM',
        tags: [
          ['e', 'target_event'],
          ['report', 'sexual_minors'],
          ['client', 'diVine'],
        ],
        created_at: Math.floor(Date.now() / 1000),
      };

      ws!.simulateMessage(JSON.stringify(['EVENT', 'auto-hide-reports', reportEvent]));
      await new Promise(resolve => setTimeout(resolve, 50));

      // diVine is NOT in custom trusted list
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
