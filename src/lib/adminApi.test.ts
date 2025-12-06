// ABOUTME: Tests for the Divine Relay Admin API client
// ABOUTME: Covers signing, publishing, moderation actions, and NIP-86 RPC

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getWorkerInfo,
  publishEvent,
  moderateAction,
  deleteEvent,
  banPubkeyViaModerate,
  allowPubkey,
  callRelayRpc,
  banPubkey,
  unbanPubkey,
  listBannedPubkeys,
  listBannedEvents,
  publishLabel,
  publishLabelAndBan,
  markAsReviewed,
  moderateMedia,
  logDecision,
  getDecisions,
  extractMediaHashes,
  type UnsignedEvent,
  type ApiResponse,
  type LabelParams,
  type ModerationAction,
} from './adminApi';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('adminApi', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('apiRequest (via getWorkerInfo)', () => {
    it('should make GET request with correct headers', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, pubkey: 'abc123' }),
      });

      await getWorkerInfo();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/info'),
        expect.objectContaining({
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    it('should make POST request with correct headers and body', async () => {
      const event: UnsignedEvent = { kind: 1, content: 'test' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await publishEvent(event);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/publish'),
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
        })
      );
    });

    it('should throw ApiError on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({}),
      });

      await expect(getWorkerInfo()).rejects.toThrow('HTTP 404: Not Found');
    });

    it('should parse JSON response', async () => {
      const mockData = { success: true, pubkey: 'test123', npub: 'npub123' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockData,
      });

      const result = await getWorkerInfo();

      expect(result).toEqual(mockData);
    });
  });

  describe('getWorkerInfo', () => {
    it('should call /api/info endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, pubkey: 'abc' }),
      });

      await getWorkerInfo();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/info'),
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should return info response with pubkey and npub', async () => {
      const mockInfo = { success: true, pubkey: 'abc123', npub: 'npub123', relay: 'wss://relay.test' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockInfo,
      });

      const result = await getWorkerInfo();

      expect(result).toEqual(mockInfo);
    });
  });

  describe('publishEvent', () => {
    it('should POST to /api/publish with event data', async () => {
      const event: UnsignedEvent = {
        kind: 1,
        content: 'Hello world',
        tags: [['t', 'test']],
        created_at: 1234567890,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, event: { id: 'event123' } }),
      });

      await publishEvent(event);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/publish'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(event),
        })
      );
    });

    it('should throw ApiError on unsuccessful response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: false, error: 'Invalid event' }),
      });

      await expect(publishEvent({ kind: 1, content: 'test' })).rejects.toThrow('Invalid event');
    });

    it('should return successful response', async () => {
      const mockResponse: ApiResponse = { success: true, event: { id: 'abc123' } };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await publishEvent({ kind: 1, content: 'test' });

      expect(result).toEqual(mockResponse);
    });
  });

  describe('moderateAction', () => {
    it('should POST to /api/moderate', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await moderateAction({ action: 'delete_event', eventId: 'event123' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/moderate'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should include action, eventId, pubkey, reason', async () => {
      const params = {
        action: 'ban_pubkey' as const,
        pubkey: 'pubkey123',
        reason: 'Spam',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await moderateAction(params);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: JSON.stringify(params),
        })
      );
    });

    it('should throw on unsuccessful response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: false, error: 'Unauthorized' }),
      });

      await expect(moderateAction({ action: 'delete_event', eventId: 'event123' })).rejects.toThrow(
        'Unauthorized'
      );
    });
  });

  describe('deleteEvent', () => {
    it('should call moderateAction with delete_event action', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await deleteEvent('event123', 'Inappropriate content');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/moderate'),
        expect.objectContaining({
          body: JSON.stringify({
            action: 'delete_event',
            eventId: 'event123',
            reason: 'Inappropriate content',
          }),
        })
      );
    });
  });

  describe('banPubkeyViaModerate', () => {
    it('should call moderateAction with ban_pubkey action', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await banPubkeyViaModerate('pubkey123', 'Spam bot');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/moderate'),
        expect.objectContaining({
          body: JSON.stringify({
            action: 'ban_pubkey',
            pubkey: 'pubkey123',
            reason: 'Spam bot',
          }),
        })
      );
    });
  });

  describe('allowPubkey', () => {
    it('should call moderateAction with allow_pubkey action', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await allowPubkey('pubkey123');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/moderate'),
        expect.objectContaining({
          body: JSON.stringify({
            action: 'allow_pubkey',
            pubkey: 'pubkey123',
          }),
        })
      );
    });
  });

  describe('callRelayRpc', () => {
    it('should POST to /api/relay-rpc with method and params', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, result: 'done' }),
      });

      await callRelayRpc('testmethod', ['param1', 123]);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/relay-rpc'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ method: 'testmethod', params: ['param1', 123] }),
        })
      );
    });

    it('should throw ApiError on unsuccessful RPC response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: false, error: 'Method not found' }),
      });

      await expect(callRelayRpc('invalidmethod')).rejects.toThrow('Method not found');
    });

    it('should return result from successful RPC call', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, result: ['pubkey1', 'pubkey2'] }),
      });

      const result = await callRelayRpc<string[]>('listbannedpubkeys');

      expect(result).toEqual(['pubkey1', 'pubkey2']);
    });
  });

  describe('banPubkey', () => {
    it('should call banpubkey RPC method with pubkey and reason', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, result: null }),
      });

      await banPubkey('pubkey123', 'Spam');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/relay-rpc'),
        expect.objectContaining({
          body: JSON.stringify({ method: 'banpubkey', params: ['pubkey123', 'Spam'] }),
        })
      );
    });

    it('should use default reason if not provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, result: null }),
      });

      await banPubkey('pubkey123');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: JSON.stringify({ method: 'banpubkey', params: ['pubkey123', 'Banned via admin'] }),
        })
      );
    });
  });

  describe('unbanPubkey', () => {
    it('should call allowpubkey RPC method', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, result: null }),
      });

      await unbanPubkey('pubkey123');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/relay-rpc'),
        expect.objectContaining({
          body: JSON.stringify({ method: 'allowpubkey', params: ['pubkey123'] }),
        })
      );
    });
  });

  describe('listBannedPubkeys', () => {
    it('should call listbannedpubkeys RPC method', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, result: ['pubkey1', 'pubkey2'] }),
      });

      const result = await listBannedPubkeys();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/relay-rpc'),
        expect.objectContaining({
          body: JSON.stringify({ method: 'listbannedpubkeys', params: [] }),
        })
      );
      expect(result).toEqual(['pubkey1', 'pubkey2']);
    });
  });

  describe('listBannedEvents', () => {
    it('should call listbannedevents RPC method', async () => {
      const bannedEvents = [
        { id: 'event1', reason: 'Spam' },
        { id: 'event2', reason: 'Inappropriate' },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, result: bannedEvents }),
      });

      const result = await listBannedEvents();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/relay-rpc'),
        expect.objectContaining({
          body: JSON.stringify({ method: 'listbannedevents', params: [] }),
        })
      );
      expect(result).toEqual(bannedEvents);
    });
  });

  describe('publishLabel', () => {
    it('should construct correct NIP-32 tag structure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const params: LabelParams = {
        targetType: 'event',
        targetValue: 'event123',
        namespace: 'content-warning',
        labels: ['nsfw', 'violence'],
        comment: 'Graphic content',
      };

      await publishLabel(params);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/publish'),
        expect.objectContaining({
          body: JSON.stringify({
            kind: 1985,
            content: 'Graphic content',
            tags: [
              ['L', 'content-warning'],
              ['l', 'nsfw', 'content-warning'],
              ['l', 'violence', 'content-warning'],
              ['e', 'event123'],
            ],
          }),
        })
      );
    });

    it('should include L namespace tag', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await publishLabel({
        targetType: 'pubkey',
        targetValue: 'pubkey123',
        namespace: 'test-namespace',
        labels: ['label1'],
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.tags).toContainEqual(['L', 'test-namespace']);
    });

    it('should include l label tags with namespace', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await publishLabel({
        targetType: 'event',
        targetValue: 'event123',
        namespace: 'moderation',
        labels: ['spam', 'scam'],
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.tags).toContainEqual(['l', 'spam', 'moderation']);
      expect(callBody.tags).toContainEqual(['l', 'scam', 'moderation']);
    });

    it('should include e tag for event target', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await publishLabel({
        targetType: 'event',
        targetValue: 'event123',
        namespace: 'test',
        labels: ['test'],
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.tags).toContainEqual(['e', 'event123']);
    });

    it('should include p tag for pubkey target', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await publishLabel({
        targetType: 'pubkey',
        targetValue: 'pubkey123',
        namespace: 'test',
        labels: ['test'],
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.tags).toContainEqual(['p', 'pubkey123']);
    });

    it('should use empty content when comment not provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await publishLabel({
        targetType: 'event',
        targetValue: 'event123',
        namespace: 'test',
        labels: ['test'],
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.content).toBe('');
    });
  });

  describe('publishLabelAndBan', () => {
    it('should publish label only when shouldBan is false', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });

      const result = await publishLabelAndBan({
        targetType: 'pubkey',
        targetValue: 'pubkey123',
        namespace: 'spam',
        labels: ['scam'],
        shouldBan: false,
      });

      expect(result).toEqual({ labelPublished: true, banned: false });
      expect(mockFetch).toHaveBeenCalledTimes(1); // Only publish, no ban
    });

    it('should publish label and ban when shouldBan is true for pubkey', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, result: null }),
      });

      const result = await publishLabelAndBan({
        targetType: 'pubkey',
        targetValue: 'pubkey123',
        namespace: 'spam',
        labels: ['scam', 'fraud'],
        shouldBan: true,
      });

      expect(result).toEqual({ labelPublished: true, banned: true });
      expect(mockFetch).toHaveBeenCalledTimes(2); // Publish + ban

      // Check ban call
      const banCall = mockFetch.mock.calls[1];
      const banBody = JSON.parse(banCall[1].body);
      expect(banBody.method).toBe('banpubkey');
      expect(banBody.params).toEqual(['pubkey123', 'Labeled: scam, fraud']);
    });

    it('should not ban when targetType is event', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });

      const result = await publishLabelAndBan({
        targetType: 'event',
        targetValue: 'event123',
        namespace: 'spam',
        labels: ['spam'],
        shouldBan: true,
      });

      expect(result).toEqual({ labelPublished: true, banned: false });
      expect(mockFetch).toHaveBeenCalledTimes(1); // Only publish, no ban for events
    });
  });

  describe('markAsReviewed', () => {
    it('should publish label with moderation/resolution namespace', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await markAsReviewed('event', 'event123', 'reviewed');

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.tags).toContainEqual(['L', 'moderation/resolution']);
    });

    it('should include status as label value', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await markAsReviewed('pubkey', 'pubkey123', 'dismissed', 'False alarm');

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.tags).toContainEqual(['l', 'dismissed', 'moderation/resolution']);
      expect(callBody.content).toBe('False alarm');
    });

    it('should use default comment when not provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await markAsReviewed('event', 'event123', 'no-action');

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.content).toBe('Marked as no-action by moderator');
    });

    it('should default to reviewed status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await markAsReviewed('event', 'event123');

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.tags).toContainEqual(['l', 'reviewed', 'moderation/resolution']);
    });
  });

  describe('moderateMedia', () => {
    it('should POST to /api/moderate-media with sha256, action, reason', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const sha256 = 'abc123def456';
      const action: ModerationAction = 'AGE_RESTRICTED';
      const reason = 'Adult content';

      await moderateMedia(sha256, action, reason);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/moderate-media'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ sha256, action, reason }),
        })
      );
    });

    it('should throw on unsuccessful response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: false, error: 'Invalid hash' }),
      });

      await expect(moderateMedia('badhash', 'SAFE')).rejects.toThrow('Invalid hash');
    });

    it('should handle all moderation actions', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });

      const actions: ModerationAction[] = ['SAFE', 'REVIEW', 'AGE_RESTRICTED', 'PERMANENT_BAN'];

      for (const action of actions) {
        await moderateMedia('hash123', action);
        const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
        const callBody = JSON.parse(lastCall[1].body);
        expect(callBody.action).toBe(action);
      }
    });
  });

  describe('logDecision', () => {
    it('should POST decision to /api/decisions', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await logDecision({
        targetType: 'event',
        targetId: 'event123',
        action: 'deleted',
        reason: 'Spam',
        moderatorPubkey: 'modpubkey',
        reportId: 'report123',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/decisions'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            targetType: 'event',
            targetId: 'event123',
            action: 'deleted',
            reason: 'Spam',
            moderatorPubkey: 'modpubkey',
            reportId: 'report123',
          }),
        })
      );
    });

    it('should handle optional fields', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await logDecision({
        targetType: 'media',
        targetId: 'hash123',
        action: 'banned',
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.targetType).toBe('media');
      expect(callBody.targetId).toBe('hash123');
      expect(callBody.action).toBe('banned');
    });
  });

  describe('getDecisions', () => {
    it('should GET decisions for a target', async () => {
      const mockDecisions = [
        {
          id: 1,
          target_type: 'event' as const,
          target_id: 'event123',
          action: 'deleted',
          reason: 'Spam',
          created_at: '2024-01-01T00:00:00Z',
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, decisions: mockDecisions }),
      });

      const result = await getDecisions('event123');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/decisions/event123'),
        expect.objectContaining({ method: 'GET' })
      );
      expect(result).toEqual(mockDecisions);
    });

    it('should return empty array when no decisions found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const result = await getDecisions('event123');

      expect(result).toEqual([]);
    });
  });

  describe('extractMediaHashes', () => {
    it('should extract sha256 from x tags', () => {
      const tags = [
        ['x', 'abc123def4567890abc123def4567890abc123def4567890abc123def4567890'],
        ['other', 'value'],
      ];

      const hashes = extractMediaHashes('', tags);

      expect(hashes).toContain('abc123def4567890abc123def4567890abc123def4567890abc123def4567890');
    });

    it('should extract hashes from imeta tags', () => {
      const tags = [
        ['imeta', 'url https://cdn.test.com/abc123def4567890abc123def4567890abc123def4567890abc123def4567890.mp4'],
      ];

      const hashes = extractMediaHashes('', tags);

      expect(hashes).toContain('abc123def4567890abc123def4567890abc123def4567890abc123def4567890');
    });

    it('should extract hashes from content URLs', () => {
      const content = 'Check out https://blossom.test.com/sha256/fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

      const hashes = extractMediaHashes(content, []);

      expect(hashes).toContain('fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210');
    });

    it('should extract from divine.video URLs', () => {
      const content = 'https://divine.video/1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef.mp4';

      const hashes = extractMediaHashes(content, []);

      expect(hashes).toContain('1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');
    });

    it('should handle content with no media', () => {
      const content = 'Just some plain text with no hashes';
      const tags = [['t', 'hashtag']];

      const hashes = extractMediaHashes(content, tags);

      expect(hashes).toEqual([]);
    });

    it('should extract multiple hashes and deduplicate', () => {
      const content = 'https://cdn.test.com/abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234.jpg';
      const tags = [
        ['x', 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234'], // Duplicate
        ['x', 'efef5678efef5678efef5678efef5678efef5678efef5678efef5678efef5678'], // Unique
      ];

      const hashes = extractMediaHashes(content, tags);

      expect(hashes).toHaveLength(2);
      expect(hashes).toContain('abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234');
      expect(hashes).toContain('efef5678efef5678efef5678efef5678efef5678efef5678efef5678efef5678');
    });

    it('should normalize hashes to lowercase', () => {
      const tags = [
        ['x', 'ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234'],
      ];

      const hashes = extractMediaHashes('', tags);

      expect(hashes).toContain('abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234');
    });

    it('should handle url tags', () => {
      const tags = [
        ['url', 'https://cdn.test.com/9876543210987654321098765432109876543210987654321098765432109876.png'],
      ];

      const hashes = extractMediaHashes('', tags);

      expect(hashes).toContain('9876543210987654321098765432109876543210987654321098765432109876');
    });

    it('should only extract valid 64-character hex hashes', () => {
      const content = 'Short hash: abc123 and invalid: zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
      const tags = [['x', 'tooshort']];

      const hashes = extractMediaHashes(content, tags);

      expect(hashes).toEqual([]);
    });
  });
});
