// ABOUTME: Displays kind 1985 labels (NIP-32 labeling)
// ABOUTME: Shows labels applied to events/pubkeys for moderation context with full content preview

import { useState } from "react";
import { nip19 } from "nostr-tools";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNostr } from "@nostrify/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tag, UserX, Clock, Filter, ChevronDown, ChevronRight, Eye, FileText, Flag } from "lucide-react";
import { useToast } from "@/hooks/useToast";
import { useUserStats } from "@/hooks/useUserStats";
import { banPubkey } from "@/lib/adminApi";
import { LabelPublisher } from "@/components/LabelPublisher";
import { EventContentPreview } from "@/components/EventContentPreview";
import { UserProfilePreview } from "@/components/UserProfilePreview";
import { ReportedBy } from "@/components/ReporterInfo";
import { UserIdentifier, UserDisplayName } from "@/components/UserIdentifier";
import type { NostrEvent } from "@nostrify/nostrify";

interface LabelsProps {
  relayUrl: string;
}

// Common label category colors
const LABEL_COLORS: Record<string, string> = {
  'spam': 'bg-yellow-500',
  'nsfw': 'bg-orange-500',
  'hate': 'bg-red-500',
  'harassment': 'bg-red-400',
  'impersonation': 'bg-purple-500',
  'illegal': 'bg-red-600',
  'malware': 'bg-red-700',
  'csam': 'bg-black',
  'violence': 'bg-red-500',
  'scam': 'bg-amber-600',
};

function getLabelNamespace(event: NostrEvent): string | null {
  const LTag = event.tags.find(t => t[0] === 'L');
  return LTag?.[1] || null;
}

function getLabels(event: NostrEvent): string[] {
  return event.tags
    .filter(t => t[0] === 'l')
    .map(t => t[1]);
}

function getLabelTarget(event: NostrEvent): { type: 'event' | 'pubkey'; value: string } | null {
  const eTag = event.tags.find(t => t[0] === 'e');
  if (eTag) return { type: 'event', value: eTag[1] };

  const pTag = event.tags.find(t => t[0] === 'p');
  if (pTag) return { type: 'pubkey', value: pTag[1] };

  return null;
}

function getLabelColor(label: string): string {
  const lowerLabel = label.toLowerCase();
  // Try exact match first
  if (LABEL_COLORS[lowerLabel]) {
    return LABEL_COLORS[lowerLabel];
  }
  // Fall back to substring matching
  for (const [key, color] of Object.entries(LABEL_COLORS)) {
    if (lowerLabel.includes(key)) return color;
  }
  return 'bg-gray-500';
}

export function Labels({ relayUrl }: LabelsProps) {
  const { nostr } = useNostr();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const [namespaceFilter, setNamespaceFilter] = useState<string | null>(null);
  const [confirmBan, setConfirmBan] = useState<{ pubkey: string; reason: string } | null>(null);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  const toggleExpanded = (id: string) => {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Query for kind 1985 labels
  const { data: labels, isLoading, error } = useQuery({
    queryKey: ['labels', relayUrl],
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ kinds: [1985], limit: 200 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }
      );
      return events.sort((a, b) => b.created_at - a.created_at);
    },
  });

  // Ban mutation with proper loading state and error handling
  const banMutation = useMutation({
    mutationFn: async ({ pubkey, reason }: { pubkey: string; reason: string }) => {
      await banPubkey(pubkey, reason);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['banned-users'] });
      queryClient.invalidateQueries({ queryKey: ['banned-pubkeys'] });
      toast({ title: "User banned successfully" });
      setConfirmBan(null);
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to ban user",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Get unique namespaces for filtering
  const namespaces = labels
    ? [...new Set(labels.map(getLabelNamespace).filter((ns): ns is string => ns !== null))]
    : [];

  // Filter labels by namespace
  const filteredLabels = labels?.filter(event => {
    if (!namespaceFilter) return true;
    return getLabelNamespace(event) === namespaceFilter;
  });

  // Group labels by target
  const labelsByTarget = filteredLabels?.reduce((acc, event) => {
    const target = getLabelTarget(event);
    if (!target) return acc;

    const key = `${target.type}:${target.value}`;
    if (!acc[key]) {
      acc[key] = { target, events: [] };
    }
    acc[key].events.push(event);
    return acc;
  }, {} as Record<string, { target: { type: 'event' | 'pubkey'; value: string }; events: NostrEvent[] }>);

  const handleBanClick = (pubkey: string, labels: string[]) => {
    setConfirmBan({
      pubkey,
      reason: `Labeled: ${labels.join(', ')}`,
    });
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Tag className="h-5 w-5" />
            Labels
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Failed to load labels: {error instanceof Error ? error.message : "Unknown error"}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      {/* Ban Confirmation Dialog */}
      <AlertDialog open={!!confirmBan} onOpenChange={() => setConfirmBan(null)}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Ban User?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>This will permanently ban this user from the relay.</p>

                {confirmBan?.pubkey && (
                  <>
                    {/* User Identifier */}
                    <div className="bg-muted px-3 py-2 rounded">
                      <UserIdentifier
                        pubkey={confirmBan.pubkey}
                        showAvatar
                        avatarSize="md"
                        variant="block"
                      />
                    </div>

                    {/* Labeled for */}
                    {confirmBan.reason && (
                      <div className="p-2 bg-amber-500/10 border border-amber-500/20 rounded text-xs">
                        <span className="font-medium text-amber-700 dark:text-amber-400">
                          <Tag className="h-3 w-3 inline mr-1" />
                          Labeled as: {confirmBan.reason}
                        </span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={banMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmBan && banMutation.mutate(confirmBan)}
              disabled={banMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {banMutation.isPending ? 'Banning...' : 'Ban User'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Tag className="h-5 w-5" />
                Labels (kind 1985)
              </CardTitle>
              <CardDescription>
                Content labels from trust & safety sources. {labels?.length || 0} labels found.
              </CardDescription>
            </div>
            <div className="flex items-center gap-3">
              {namespaces.length > 0 && (
                <div className="flex items-center gap-2">
                  <Filter className="h-4 w-4 text-muted-foreground" />
                  <select
                    className="text-sm border rounded px-2 py-1"
                    value={namespaceFilter || ''}
                    onChange={(e) => setNamespaceFilter(e.target.value || null)}
                  >
                    <option value="">All namespaces</option>
                    {namespaces.map(ns => (
                      <option key={ns} value={ns}>{ns}</option>
                    ))}
                  </select>
                </div>
              )}
              <LabelPublisher />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="timeline">
            <TabsList>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
              <TabsTrigger value="grouped">By Target</TabsTrigger>
            </TabsList>

            <TabsContent value="timeline" className="mt-4">
              {!filteredLabels || filteredLabels.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Tag className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No labels found</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredLabels.map((event) => {
                    const namespace = getLabelNamespace(event);
                    const eventLabels = getLabels(event);
                    const target = getLabelTarget(event);
                    const isExpanded = expandedItems.has(event.id);

                    return (
                      <div
                        key={event.id}
                        className={`p-4 border rounded-lg space-y-3 ${
                          selectedLabel === event.id ? 'ring-2 ring-primary' : ''
                        }`}
                        onClick={() => setSelectedLabel(event.id)}
                      >
                        <div className="flex items-start justify-between">
                          <div className="space-y-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              {eventLabels.map((label, idx) => (
                                <Badge
                                  key={idx}
                                  className={`${getLabelColor(label)} text-white`}
                                >
                                  {label}
                                </Badge>
                              ))}
                              {target && (
                                <Badge variant="secondary">
                                  {target.type === 'event' ? 'Event' : 'User'}
                                </Badge>
                              )}
                              {namespace && (
                                <Badge variant="outline" className="text-xs">
                                  {namespace}
                                </Badge>
                              )}
                            </div>
                            {target && (
                              target.type === 'pubkey' ? (
                                <div className="text-sm text-muted-foreground">
                                  <UserDisplayName pubkey={target.value} fallbackLength={16} />
                                </div>
                              ) : (
                                <p className="text-sm text-muted-foreground font-mono">
                                  {(() => {
                                    try {
                                      const noteId = nip19.noteEncode(target.value);
                                      return `${noteId.slice(0, 16)}...`;
                                    } catch {
                                      return `${target.value.slice(0, 16)}...`;
                                    }
                                  })()}
                                </p>
                              )
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Clock className="h-3 w-3" />
                            {new Date(event.created_at * 1000).toLocaleDateString()}
                          </div>
                        </div>

                        {/* Reporter info */}
                        <ReportedBy
                          pubkey={event.pubkey}
                          timestamp={event.created_at}
                        />

                        {/* Label reason/content */}
                        {event.content && (
                          <p className="text-sm bg-muted/50 p-2 rounded">{event.content}</p>
                        )}

                        {/* Expandable content preview */}
                        {target && (
                          <Collapsible open={isExpanded} onOpenChange={() => toggleExpanded(event.id)}>
                            <CollapsibleTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="w-full justify-start"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {isExpanded ? (
                                  <ChevronDown className="h-4 w-4 mr-2" />
                                ) : (
                                  <ChevronRight className="h-4 w-4 mr-2" />
                                )}
                                <Eye className="h-4 w-4 mr-2" />
                                {isExpanded ? 'Hide Content' : 'View Content'}
                              </Button>
                            </CollapsibleTrigger>
                            <CollapsibleContent className="space-y-3 mt-2">
                              {target.type === 'event' && (
                                <EventContentPreview eventId={target.value} />
                              )}
                              {target.type === 'pubkey' && (
                                <UserProfilePreview pubkey={target.value} />
                              )}
                            </CollapsibleContent>
                          </Collapsible>
                        )}

                        {/* Action buttons */}
                        <div className="flex gap-2">
                          {target?.type === 'pubkey' && (
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={banMutation.isPending}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleBanClick(target.value, eventLabels);
                              }}
                            >
                              <UserX className="h-4 w-4 mr-1" />
                              Ban User
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </TabsContent>

            <TabsContent value="grouped" className="mt-4">
              {!labelsByTarget || Object.keys(labelsByTarget).length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Tag className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No labeled targets found</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {Object.entries(labelsByTarget).map(([key, { target, events }]) => {
                    const allLabels = [...new Set(events.flatMap(getLabels))];

                    return (
                      <div key={key} className="p-4 border rounded-lg space-y-3">
                        <div className="flex items-start justify-between">
                          <div>
                            <Badge variant="secondary" className="mb-2">
                              {target.type === 'event' ? 'Event' : 'User'}
                            </Badge>
                            {target.type === 'pubkey' ? (
                              <div className="text-sm">
                                <UserDisplayName pubkey={target.value} fallbackLength={20} />
                              </div>
                            ) : (
                              <p className="font-mono text-sm">
                                {(() => {
                                  try {
                                    const noteId = nip19.noteEncode(target.value);
                                    return `${noteId.slice(0, 20)}...`;
                                  } catch {
                                    return `${target.value.slice(0, 20)}...`;
                                  }
                                })()}
                              </p>
                            )}
                          </div>
                          <Badge variant="outline">{events.length} label(s)</Badge>
                        </div>

                        <div className="flex flex-wrap gap-2">
                          {allLabels.map((label, idx) => (
                            <Badge
                              key={idx}
                              className={`${getLabelColor(label)} text-white`}
                            >
                              {label}
                            </Badge>
                          ))}
                        </div>

                        {target.type === 'pubkey' && (
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={banMutation.isPending}
                              onClick={() => handleBanClick(target.value, allLabels)}
                            >
                              <UserX className="h-4 w-4 mr-1" />
                              Ban User
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
