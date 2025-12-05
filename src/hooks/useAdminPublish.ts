// ABOUTME: Hook for publishing events via the Worker API (server-side signing)
// ABOUTME: Use this instead of useNostrPublish when Worker signing is needed

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  publishEvent,
  deleteEvent,
  banPubkey,
  allowPubkey,
  getWorkerInfo,
} from '@/lib/adminApi';

interface UnsignedEvent {
  kind: number;
  content: string;
  tags?: string[][];
  created_at?: number;
}

export function useWorkerInfo() {
  return useQuery({
    queryKey: ['worker-info'],
    queryFn: getWorkerInfo,
    staleTime: 60000,
    retry: 1,
  });
}

export function useAdminPublish() {
  return useMutation({
    mutationFn: (event: UnsignedEvent) => publishEvent(event),
    onError: (error) => {
      console.error('Failed to publish event via Worker:', error);
    },
    onSuccess: (data) => {
      if (data.success) {
        console.log('Event published via Worker:', data.event);
      } else {
        console.error('Worker rejected event:', data.error);
      }
    },
  });
}

export function useDeleteEvent() {
  return useMutation({
    mutationFn: ({ eventId, reason }: { eventId: string; reason?: string }) =>
      deleteEvent(eventId, reason),
    onError: (error) => {
      console.error('Failed to delete event:', error);
    },
  });
}

export function useBanPubkey() {
  return useMutation({
    mutationFn: ({ pubkey, reason }: { pubkey: string; reason?: string }) =>
      banPubkey(pubkey, reason),
    onError: (error) => {
      console.error('Failed to ban pubkey:', error);
    },
  });
}

export function useAllowPubkey() {
  return useMutation({
    mutationFn: (pubkey: string) => allowPubkey(pubkey),
    onError: (error) => {
      console.error('Failed to allow pubkey:', error);
    },
  });
}
