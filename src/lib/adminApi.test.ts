// ABOUTME: Tests for the Divine Relay Admin API client
// ABOUTME: Covers signing, publishing, moderation actions, and NIP-86 RPC

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getWorkerInfo,
  getAccountStatus,
  publishEvent,
  moderateAction,
  deleteEvent,
  banPubkeyViaModerate,
  allowPubkey,
  callRelayRpc,
  banEvent,
  allowEvent,
  banPubkey,
  unbanPubkey,
  listBannedPubkeys,
  listBannedEvents,
  fetchReports,
  fetchReportsByTarget,
  fetchResolutionLabels,
  publishLabel,
  publishLabelAndBan,
  markAsReviewed,
  moderateMedia,
  verifyAgeRestricted,
  logDecision,
  getDecisions,
  extractMediaHashes,
  isBlockedMediaAction,
  updateAgeReviewCase,
  bulkModerate,
  getBulkJobStatus,
  ApiError,
  type UnsignedEvent,
  type ApiResponse,
  type LabelParams,
  type ModerationAction,
  type MediaStatusAction,
} from './adminApi';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Test API URL
const API_URL = 'https://test-api.example.com';

describe('adminApi', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('getAccountStatus', () => {
    it('GETs /api/account-status/:pubkey and returns the parsed status', async () => {
      const pubkey = 'a'.repeat(64);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          verified_minor: true,
          verified_minor_at: '2026-06-30T12:00:00Z',
        }),
      });

      const result = await getAccountStatus(API_URL, pubkey);

      expect(mockFetch).toHaveBeenCalledWith(
        `${API_URL}/api/account-status/${pubkey}`,
        expect.objectContaining({ method: 'GET' }),
      );
      expect(result).toMatchObject({ success: true, verified_minor: true });
    });
  });

  describe('apiRequest (via getWorkerInfo)', () => {
    it('should make GET request with correct headers', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, pubkey: 'abc123' }),
      });

      await getWorkerInfo(API_URL);

      expect(mockFetch).toHaveBeenCalledWith(
        `${API_URL}/api/info`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        })
      );
    });

    it('should make POST request with correct headers and body', async () => {
      const event: UnsignedEvent = { kind: 1, content: 'test' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await publishEvent(API_URL, event);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/publish'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
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

      await expect(getWorkerInfo(API_URL)).rejects.toThrow('HTTP 404: Not Found');
    });

    it('should parse JSON response', async () => {
      const mockData = { success: true, pubkey: 'test123', npub: 'npub123' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockData,
      });

      const result = await getWorkerInfo(API_URL);

      expect(result).toEqual(mockData);
    });

    it('a read (GET) timeout says could-not-reach, not may-have-applied', async () => {
      // A timed-out read mutated nothing, so "may have applied" would be wrong;
      // the moderator should just retry.
      mockFetch.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));

      await expect(getWorkerInfo(API_URL)).rejects.toThrow(
        /Request to \/api\/info timed out after 30s\. Could not reach the relay\. Try again\./,
      );
    });

    it('a write (POST) timeout says the action may still have applied', async () => {
      // A timed-out write can still land on the relay even though we stopped
      // waiting, so the moderator must re-check rather than blindly retry.
      mockFetch.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));

      await expect(
        moderateAction(API_URL, { action: 'ban_pubkey', pubkey: 'p'.repeat(64) }),
      ).rejects.toThrow(
        /Request to \/api\/moderate timed out after 30s\. The action may still have applied\. Re-check before retrying\./,
      );
    });

    it('a stalled response BODY (headers sent, body never finishes) still maps to the friendly timeout copy', async () => {
      // A relay that sends headers then stalls the body aborts during
      // response.json(), AFTER fetch() resolved. Without bounding the read this
      // surfaced as a raw TimeoutError that skipped the "may have applied" copy.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => { throw new DOMException('timed out', 'TimeoutError'); },
      });

      await expect(
        moderateAction(API_URL, { action: 'ban_pubkey', pubkey: 'p'.repeat(64) }),
      ).rejects.toThrow(
        /Request to \/api\/moderate timed out after 30s\. The action may still have applied\. Re-check before retrying\./,
      );
    });

    it('bulkModerate (async enqueue) uses the default 30s bound, like other calls', async () => {
      // The async job model replaced the old 180s bulk bound: bulkModerate now just
      // enqueues a job and returns a jobId immediately, so it carries no special
      // timeout — the long-running work moved to the queue consumer.
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, jobId: 'job-1' }),
      });
      await bulkModerate(API_URL, 'a'.repeat(64), 'age-restrict-all');
      expect(timeoutSpy).toHaveBeenLastCalledWith(30_000);

      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
      await getWorkerInfo(API_URL);
      expect(timeoutSpy).toHaveBeenLastCalledWith(30_000);
      timeoutSpy.mockRestore();
    });

    it('surfaces a JSON error body (409 version_conflict) as structured ApiError fields', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        json: async () => ({
          error: 'Case was modified by another request',
          code: 'version_conflict',
          current_version: 3,
        }),
      });

      expect.assertions(5);
      try {
        await updateAgeReviewCase(API_URL, 'case-1', { state: 'cleared' });
      } catch (e) {
        const err = e as ApiError;
        expect(err).toBeInstanceOf(ApiError);
        expect(err.message).toBe('Case was modified by another request'); // not opaque "HTTP 409:"
        expect(err.statusCode).toBe(409);
        expect(err.code).toBe('version_conflict');
        expect(err.currentVersion).toBe(3);
      }
    });

    it('returns the enforcement object (not throws) on a 207 partial-enforcement response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, // fetch sets ok=true across the whole 2xx range, including 207
        status: 207,
        json: async () => ({
          success: false,
          case: { id: 'case-1' },
          enforcementComplete: false,
          enforcement: { relay: 'failed', bulk: 'ok', keycast: 'ok' },
        }),
      });

      const res = await updateAgeReviewCase(API_URL, 'case-1', { state: 'restricted_pending_user_response' });
      expect(res.enforcementComplete).toBe(false);
      expect(res.enforcement?.relay).toBe('failed');
    });
  });

  describe('getWorkerInfo', () => {
    it('should call /api/info endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, pubkey: 'abc' }),
      });

      await getWorkerInfo(API_URL);

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

      const result = await getWorkerInfo(API_URL);

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

      await publishEvent(API_URL, event);

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

      await expect(publishEvent(API_URL, { kind: 1, content: 'test' })).rejects.toThrow('Invalid event');
    });

    it('should return successful response', async () => {
      const mockResponse: ApiResponse = { success: true, event: { id: 'abc123' } };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await publishEvent(API_URL, { kind: 1, content: 'test' });

      expect(result).toEqual(mockResponse);
    });
  });

  describe('moderateAction', () => {
    it('should POST to /api/moderate', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await moderateAction(API_URL, { action: 'delete_event', eventId: 'event123' });

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

      await moderateAction(API_URL, params);

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

      await expect(moderateAction(API_URL, { action: 'delete_event', eventId: 'event123' })).rejects.toThrow(
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

      await deleteEvent(API_URL, 'event123', 'Inappropriate content');

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

      await banPubkeyViaModerate(API_URL, 'pubkey123', 'Spam bot');

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

      await allowPubkey(API_URL, 'pubkey123');

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

      await callRelayRpc(API_URL, 'testmethod', ['param1', 123]);

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

      await expect(callRelayRpc(API_URL, 'invalidmethod')).rejects.toThrow('Method not found');
    });

    it('should return result from successful RPC call', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, result: ['pubkey1', 'pubkey2'] }),
      });

      const result = await callRelayRpc<string[]>(API_URL, 'listbannedpubkeys');

      expect(result).toEqual(['pubkey1', 'pubkey2']);
    });

    it('throws an actionable ApiError naming the method when the RPC times out', async () => {
      // Regression: callRelayRpc had no timeout, so a hung banpubkey purge left
      // the "Banning…" modal spinning forever.
      mockFetch.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));

      await expect(callRelayRpc(API_URL, 'banpubkey', ['npub'])).rejects.toThrow(
        /Relay RPC 'banpubkey' timed out after 30s\. The action may still have applied\. Re-check before retrying\./,
      );
    });

    it('re-throws non-timeout fetch errors unchanged', async () => {
      const networkError = new TypeError('Failed to fetch');
      mockFetch.mockRejectedValueOnce(networkError);

      await expect(callRelayRpc(API_URL, 'banpubkey')).rejects.toBe(networkError);
    });

    it('an RPC list read timeout says could-not-reach (no may-have-applied)', async () => {
      // list* RPC methods are reads; a timeout there mutated nothing.
      mockFetch.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));

      await expect(listBannedPubkeys(API_URL)).rejects.toThrow(
        /Relay RPC 'listbannedpubkeys' timed out after 30s\. Could not reach the relay\. Try again\./,
      );
    });

    it('a non-list read RPC (getbannedevent) timeout says could-not-reach, not may-have-applied', async () => {
      // getbannedevent / supportedmethods are reads that do NOT start with 'list';
      // they must still get the read copy, not the write "may have applied".
      mockFetch.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));

      await expect(callRelayRpc(API_URL, 'getbannedevent', ['eventid'])).rejects.toThrow(
        /Relay RPC 'getbannedevent' timed out after 30s\. Could not reach the relay\. Try again\./,
      );
    });
  });

  describe('banPubkey', () => {
    it('should call banpubkey RPC method with pubkey and reason', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, result: null }),
      });

      await banPubkey(API_URL, 'pubkey123', 'Spam');

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

      await banPubkey(API_URL, 'pubkey123');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: JSON.stringify({ method: 'banpubkey', params: ['pubkey123', 'Banned via admin'] }),
        })
      );
    });
  });

  describe('unbanPubkey', () => {
    it('should call unbanpubkey RPC method', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, result: null }),
      });

      await unbanPubkey(API_URL, 'pubkey123');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/relay-rpc'),
        expect.objectContaining({
          body: JSON.stringify({ method: 'unbanpubkey', params: ['pubkey123'] }),
        })
      );
    });
  });

  describe('banEvent', () => {
    it('should call banevent RPC method with event id and reason', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, result: null }),
      });

      await banEvent(API_URL, 'event123', 'Spam');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/relay-rpc'),
        expect.objectContaining({
          body: JSON.stringify({ method: 'banevent', params: ['event123', 'Spam'] }),
        })
      );
    });
  });

  describe('allowEvent', () => {
    it('should call allowevent RPC method with only the event id', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, result: null }),
      });

      await allowEvent(API_URL, 'event123');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/relay-rpc'),
        expect.objectContaining({
          body: JSON.stringify({ method: 'allowevent', params: ['event123'] }),
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

      const result = await listBannedPubkeys(API_URL);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/relay-rpc'),
        expect.objectContaining({
          body: JSON.stringify({ method: 'listbannedpubkeys', params: [] }),
        })
      );
      // listBannedPubkeys normalizes string arrays to objects
      expect(result).toEqual([{ pubkey: 'pubkey1' }, { pubkey: 'pubkey2' }]);
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

      const result = await listBannedEvents(API_URL);

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

      await publishLabel(API_URL, params);

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

      await publishLabel(API_URL, {
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

      await publishLabel(API_URL, {
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

      await publishLabel(API_URL, {
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

      await publishLabel(API_URL, {
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

      await publishLabel(API_URL, {
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

      const result = await publishLabelAndBan(API_URL, {
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

      const result = await publishLabelAndBan(API_URL, {
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

      const result = await publishLabelAndBan(API_URL, {
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

      await markAsReviewed(API_URL, 'event', 'event123', 'reviewed');

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.tags).toContainEqual(['L', 'moderation/resolution']);
    });

    it('should include status as label value', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await markAsReviewed(API_URL, 'pubkey', 'pubkey123', 'dismissed', 'False alarm');

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.tags).toContainEqual(['l', 'dismissed', 'moderation/resolution']);
      expect(callBody.content).toBe('False alarm');
    });

    it('should use default comment when not provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await markAsReviewed(API_URL, 'event', 'event123', 'no-action');

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.content).toBe('Marked as no-action by moderator');
    });

    it('should default to reviewed status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await markAsReviewed(API_URL, 'event', 'event123');

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

      await moderateMedia(API_URL, sha256, action, reason);

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

      await expect(moderateMedia(API_URL, 'badhash', 'SAFE')).rejects.toThrow('Invalid hash');
    });

    it('should handle all moderation actions', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });

      const actions: ModerationAction[] = ['SAFE', 'REVIEW', 'QUARANTINE', 'AGE_RESTRICTED', 'PERMANENT_BAN', 'DELETE'];

      for (const action of actions) {
        await moderateMedia(API_URL, 'hash123', action);
        const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
        const callBody = JSON.parse(lastCall[1].body);
        expect(callBody.action).toBe(action);
      }
    });
  });

  describe('verifyAgeRestricted', () => {
    it('returns true when status is AGE_RESTRICTED after delay', async () => {
      vi.useFakeTimers();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sha256: 'testhash', action: 'AGE_RESTRICTED' }),
      });

      const promise = verifyAgeRestricted(API_URL, 'testhash');
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/check-result/testhash'),
        expect.anything()
      );
      vi.useRealTimers();
    });

    it('returns false when status is not AGE_RESTRICTED', async () => {
      vi.useFakeTimers();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sha256: 'testhash', action: 'SAFE' }),
      });

      const promise = verifyAgeRestricted(API_URL, 'testhash');
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(result).toBe(false);
      vi.useRealTimers();
    });

    it('returns false on fetch error', async () => {
      vi.useFakeTimers();
      mockFetch.mockRejectedValueOnce(new Error('network'));

      const promise = verifyAgeRestricted(API_URL, 'testhash');
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(result).toBe(false);
      vi.useRealTimers();
    });
  });

  describe('isBlockedMediaAction', () => {
    it('treats permanently banned media as blocked', () => {
      expect(isBlockedMediaAction('PERMANENT_BAN')).toBe(true);
    });

    it('treats quarantined media as blocked', () => {
      expect(isBlockedMediaAction('QUARANTINE')).toBe(true);
    });

    it('does not treat non-blocking statuses as blocked', () => {
      const actions: MediaStatusAction[] = ['SAFE', 'REVIEW', 'AGE_RESTRICTED'];

      for (const action of actions) {
        expect(isBlockedMediaAction(action)).toBe(false);
      }
    });
  });

  describe('logDecision', () => {
    it('should POST decision to /api/decisions', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await logDecision(API_URL, {
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

      await logDecision(API_URL, {
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

      const result = await getDecisions(API_URL, 'event123');

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

      const result = await getDecisions(API_URL, 'event123');

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

    it('should ignore imeta image thumbnail hashes for video moderation actions', () => {
      const videoHash = '81661ca024bec2be842557ff7e07c833660038f134203f10293568f5ea11863f';
      const thumbnailHash = 'b06e68dbec25463be257e44b06b0bcbb376d3cd1d5fa47e41747ead9e290e068';
      const tags = [
        [
          'imeta',
          `url https://media.divine.video/${videoHash}`,
          'm video/mp4',
          `image https://media.divine.video/${thumbnailHash}`,
          'dim 608x608',
          'size 1397120',
          `x ${videoHash}`,
          'blurhash UD0WGxgXghf[h2gagff_e6f~feg5g7f9e@e-',
        ],
      ];

      const hashes = extractMediaHashes('', tags);

      expect(hashes).toEqual([videoHash]);
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

  describe('fetchReportsByTarget', () => {
    it('requests /api/reports?event= and returns sanitized events', async () => {
      const events = [{ id: 'r1', kind: 1984, pubkey: 'pk', created_at: 1, tags: [], content: '', sig: '' }];
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, events }) });

      const result = await fetchReportsByTarget(API_URL, { event: 'abc' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/reports?event=abc'),
        expect.objectContaining({ method: 'GET' })
      );
      expect(result.map((e) => e.id)).toEqual(['r1']);
    });

    it('requests /api/reports?pubkey= when given a pubkey target', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, events: [] }) });

      await fetchReportsByTarget(API_URL, { pubkey: 'def' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/reports?pubkey=def'),
        expect.objectContaining({ method: 'GET' })
      );
    });
  });

  describe('fetchReports', () => {
    it('should call /api/reports and return sorted events', async () => {
      const events = [
        { id: 'report1', kind: 1984, pubkey: 'pk1', created_at: 100, tags: [], content: '', sig: '' },
        { id: 'report2', kind: 1984, pubkey: 'pk2', created_at: 200, tags: [], content: '', sig: '' },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, events }),
      });

      const result = await fetchReports(API_URL);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/reports'),
        expect.objectContaining({ method: 'GET' })
      );
      // Should be sorted newest first
      expect(result[0].id).toBe('report2');
      expect(result[1].id).toBe('report1');
    });

    it('should return empty array when no events', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, events: [] }),
      });

      const result = await fetchReports(API_URL);
      expect(result).toEqual([]);
    });

    it('should throw on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        json: async () => ({}),
      });

      await expect(fetchReports(API_URL)).rejects.toThrow('HTTP 502');
    });

    it('normalizes malformed tags and drops non-object events (raw payload is untrusted)', async () => {
      const events = [
        { id: 'r1', kind: 1984, pubkey: 'pk1', created_at: 100, content: '', sig: '' }, // tags missing
        { id: 'r2', kind: 1984, pubkey: 'pk2', created_at: 200, tags: null, content: '', sig: '' },
        { id: 'r3', kind: 1984, pubkey: 'pk3', created_at: 300, tags: 'junk', content: '', sig: '' },
        { id: 'r4', kind: 1984, pubkey: 'pk4', created_at: 400, tags: [['e', 'ok'], 'rogue', [42, 'x'], ['p', 'ok2']], content: '', sig: '' },
        null,
        'not an event',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, events }),
      });

      const result = await fetchReports(API_URL);

      // Sorted newest-first; every survivor has fully validated string[][] tags
      expect(result.map(e => e.id)).toEqual(['r4', 'r3', 'r2', 'r1']);
      expect(result.map(e => e.tags)).toEqual([
        [['e', 'ok'], ['p', 'ok2']],
        [],
        [],
        [],
      ]);
    });
  });

  describe('fetchResolutionLabels', () => {
    it('normalizes malformed tags in label events too', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          events: [{ id: 'l1', kind: 1985, pubkey: 'pk', created_at: 1, tags: null, content: '', sig: '' }],
        }),
      });

      const result = await fetchResolutionLabels(API_URL);
      expect(result[0].tags).toEqual([]);
    });

    it('should call /api/resolution-labels and return events', async () => {
      const events = [
        { id: 'label1', kind: 1985, pubkey: 'pk1', created_at: 100, tags: [['L', 'moderation/resolution']], content: '', sig: '' },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, events }),
      });

      const result = await fetchResolutionLabels(API_URL);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/resolution-labels'),
        expect.objectContaining({ method: 'GET' })
      );
      expect(result).toEqual(events);
    });

    it('should return empty array when no events', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, events: [] }),
      });

      const result = await fetchResolutionLabels(API_URL);
      expect(result).toEqual([]);
    });
  });

  describe('bulkModerate (async enqueue)', () => {
    it('enqueues and returns the jobId', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, jobId: 'job-9' }) });

      const res = await bulkModerate(API_URL, 'a'.repeat(64), 'age-restrict-all');

      expect(res.jobId).toBe('job-9');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/bulk-moderate'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('throws when the enqueue request fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false, status: 500, statusText: 'err', json: async () => ({ error: 'queue down' }),
      });

      await expect(bulkModerate(API_URL, 'a'.repeat(64), 'delete-all')).rejects.toThrow('queue down');
    });
  });

  describe('getBulkJobStatus', () => {
    it('GETs the job status by id', async () => {
      const job = {
        jobId: 'job-9', pubkey: 'a'.repeat(64), action: 'age-restrict-all', status: 'done',
        eventsProcessed: 3, mediaProcessed: 3, failures: [], createdAt: 't', updatedAt: 't',
      };
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => job });

      const res = await getBulkJobStatus(API_URL, 'job-9');

      expect(res.status).toBe('done');
      expect(res.mediaProcessed).toBe(3);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/bulk-moderate/status/job-9'),
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });
});
