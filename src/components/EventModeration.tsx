import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/useToast";
import { Shield, ShieldCheck, ShieldX, Plus, AlertTriangle, CheckCircle, XCircle } from "lucide-react";

const WORKER_URL = import.meta.env.VITE_WORKER_URL || '';

interface EventModerationProps {
  relayUrl: string;
}

interface EventNeedingModeration {
  id: string;
  reason?: string;
}

interface BannedEvent {
  id: string;
  reason?: string;
}

// API functions for relay management via Worker
async function callRelayAPI(method: string, params: (string | number | undefined)[] = []) {
  const response = await fetch(`${WORKER_URL}/api/relay-rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ method, params }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  if (!data.success) {
    throw new Error(data.error || 'Unknown error');
  }

  return data.result;
}

export function EventModeration({ relayUrl }: EventModerationProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [newEventId, setNewEventId] = useState("");
  const [newReason, setNewReason] = useState("");
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);

  // Query for events needing moderation
  const { data: eventsNeedingModeration, isLoading: loadingPending, error: pendingError } = useQuery({
    queryKey: ['events-needing-moderation'],
    queryFn: () => callRelayAPI('listeventsneedingmoderation'),
  });

  // Query for banned events
  const { data: bannedEvents, isLoading: loadingBanned, error: bannedError } = useQuery({
    queryKey: ['banned-events'],
    queryFn: () => callRelayAPI('listbannedevents'),
  });

  // Mutation for allowing events
  const allowEventMutation = useMutation({
    mutationFn: ({ eventId, reason }: { eventId: string; reason?: string }) =>
      callRelayAPI('allowevent', [eventId, reason]),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['events-needing-moderation'] });
      toast({ title: "Event approved successfully" });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to approve event",
        description: error.message,
        variant: "destructive"
      });
    },
  });

  // Mutation for banning events
  const banEventMutation = useMutation({
    mutationFn: ({ eventId, reason }: { eventId: string; reason?: string }) =>
      callRelayAPI('banevent', [eventId, reason]),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['events-needing-moderation'] });
      queryClient.invalidateQueries({ queryKey: ['banned-events'] });
      toast({ title: "Event banned successfully" });
      setIsAddDialogOpen(false);
      setNewEventId("");
      setNewReason("");
    },
    onError: (error: Error) => {
      toast({ 
        title: "Failed to ban event", 
        description: error.message,
        variant: "destructive" 
      });
    },
  });

  const handleBanEvent = () => {
    if (!newEventId.trim()) {
      toast({ 
        title: "Invalid input", 
        description: "Please enter a valid event ID",
        variant: "destructive" 
      });
      return;
    }

    banEventMutation.mutate({ eventId: newEventId.trim(), reason: newReason.trim() || undefined });
  };

  const handleApproveEvent = (eventId: string) => {
    allowEventMutation.mutate({ eventId });
  };

  const handleRejectEvent = (eventId: string, reason?: string) => {
    banEventMutation.mutate({ eventId, reason });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Event Moderation</h2>
          <p className="text-muted-foreground">Review and moderate events on your relay</p>
        </div>
        <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="destructive">
              <Plus className="h-4 w-4 mr-2" />
              Ban Event
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Ban Event</DialogTitle>
              <DialogDescription>
                Manually ban an event by its ID
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label htmlFor="event-id">Event ID (hex)</Label>
                <Input
                  id="event-id"
                  value={newEventId}
                  onChange={(e) => setNewEventId(e.target.value)}
                  placeholder="Enter 64-character hex event ID"
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="reason">Reason (optional)</Label>
                <Textarea
                  id="reason"
                  value={newReason}
                  onChange={(e) => setNewReason(e.target.value)}
                  placeholder="Enter reason for banning this event"
                  className="mt-1"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>
                Cancel
              </Button>
              <Button 
                variant="destructive"
                onClick={handleBanEvent}
                disabled={banEventMutation.isPending}
              >
                Ban Event
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Tabs defaultValue="pending" className="space-y-4">
        <TabsList>
          <TabsTrigger value="pending" className="flex items-center space-x-2">
            <AlertTriangle className="h-4 w-4" />
            <span>Pending Review</span>
          </TabsTrigger>
          <TabsTrigger value="banned" className="flex items-center space-x-2">
            <ShieldX className="h-4 w-4" />
            <span>Banned Events</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="pending">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <AlertTriangle className="h-5 w-5" />
                <span>Events Needing Moderation</span>
              </CardTitle>
              <CardDescription>
                Events that have been flagged and require manual review
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingPending ? (
                <div className="space-y-3">
                  {[...Array(3)].map((_, i) => (
                    <div key={i} className="flex items-center justify-between p-4 border rounded-lg">
                      <div className="space-y-2 flex-1">
                        <Skeleton className="h-4 w-64" />
                        <Skeleton className="h-3 w-48" />
                      </div>
                      <div className="flex space-x-2">
                        <Skeleton className="h-8 w-20" />
                        <Skeleton className="h-8 w-20" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : pendingError ? (
                <Alert>
                  <AlertDescription>
                    Failed to load events needing moderation: {pendingError.message}
                  </AlertDescription>
                </Alert>
              ) : !eventsNeedingModeration || eventsNeedingModeration.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <ShieldCheck className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No events need moderation</p>
                  <p className="text-sm">All events are currently approved</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {eventsNeedingModeration.map((event: EventNeedingModeration, index: number) => (
                    <div key={index} className="flex items-center justify-between p-4 border rounded-lg">
                      <div className="flex-1">
                        <p className="font-mono text-sm">{event.id}</p>
                        {event.reason && (
                          <div className="mt-2">
                            <Badge variant="destructive" className="text-xs">
                              {event.reason}
                            </Badge>
                          </div>
                        )}
                      </div>
                      <div className="flex space-x-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleApproveEvent(event.id)}
                          disabled={allowEventMutation.isPending}
                          className="text-green-600 hover:text-green-700"
                        >
                          <CheckCircle className="h-4 w-4 mr-1" />
                          Approve
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => handleRejectEvent(event.id, event.reason)}
                          disabled={banEventMutation.isPending}
                        >
                          <XCircle className="h-4 w-4 mr-1" />
                          Reject
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="banned">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <ShieldX className="h-5 w-5" />
                <span>Banned Events</span>
              </CardTitle>
              <CardDescription>
                Events that have been banned from this relay
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingBanned ? (
                <div className="space-y-3">
                  {[...Array(3)].map((_, i) => (
                    <div key={i} className="flex items-center justify-between p-3 border rounded-lg">
                      <div className="space-y-2">
                        <Skeleton className="h-4 w-64" />
                        <Skeleton className="h-3 w-48" />
                      </div>
                      <Skeleton className="h-8 w-20" />
                    </div>
                  ))}
                </div>
              ) : bannedError ? (
                <Alert>
                  <AlertDescription>
                    Failed to load banned events: {bannedError.message}
                  </AlertDescription>
                </Alert>
              ) : !bannedEvents || bannedEvents.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Shield className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No banned events</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {bannedEvents.map((event: BannedEvent, index: number) => (
                    <div key={index} className="flex items-center justify-between p-3 border rounded-lg">
                      <div>
                        <p className="font-mono text-sm">{event.id}</p>
                        {event.reason && (
                          <p className="text-sm text-muted-foreground mt-1">{event.reason}</p>
                        )}
                      </div>
                      <Badge variant="destructive">Banned</Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}