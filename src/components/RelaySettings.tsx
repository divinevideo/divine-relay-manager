import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { callRelayRpc } from "@/lib/adminApi";
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
import { Globe, FileText, Image, Plus, Trash2, Shield, Network } from "lucide-react";

interface RelaySettingsProps {
  relayUrl: string;
}


export function RelaySettings({ relayUrl }: RelaySettingsProps) {
  const { user } = useCurrentUser();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  // Form states
  const [relayName, setRelayName] = useState("");
  const [relayDescription, setRelayDescription] = useState("");
  const [relayIcon, setRelayIcon] = useState("");
  const [newKind, setNewKind] = useState("");
  const [newIp, setNewIp] = useState("");
  const [newIpReason, setNewIpReason] = useState("");
  const [isKindDialogOpen, setIsKindDialogOpen] = useState(false);
  const [isIpDialogOpen, setIsIpDialogOpen] = useState(false);
  const [kindAction, setKindAction] = useState<'allow' | 'disallow'>('allow');

  // Query for allowed kinds
  const { data: allowedKinds, isLoading: loadingKinds, error: kindsError } = useQuery({
    queryKey: ['allowed-kinds', relayUrl],
    queryFn: () => callRelayRpc<number[]>('listallowedkinds'),
    enabled: !!relayUrl && !!user,
  });

  // Query for blocked IPs
  const { data: blockedIps, isLoading: loadingIps, error: ipsError } = useQuery({
    queryKey: ['blocked-ips', relayUrl],
    queryFn: () => callRelayRpc<Array<{ ip: string; reason?: string }>>('listblockedips'),
    enabled: !!relayUrl && !!user,
  });

  // Mutation for changing relay name
  const changeNameMutation = useMutation({
    mutationFn: (name: string) => callRelayRpc('changerelayname', [name]),
    onSuccess: () => {
      toast({ title: "Relay name updated successfully" });
      queryClient.invalidateQueries({ queryKey: ['relay-info', relayUrl] });
    },
    onError: (error: Error) => {
      toast({ 
        title: "Failed to update relay name", 
        description: error.message,
        variant: "destructive" 
      });
    },
  });

  // Mutation for changing relay description
  const changeDescriptionMutation = useMutation({
    mutationFn: (description: string) => callRelayRpc('changerelaydescription', [description]),
    onSuccess: () => {
      toast({ title: "Relay description updated successfully" });
      queryClient.invalidateQueries({ queryKey: ['relay-info', relayUrl] });
    },
    onError: (error: Error) => {
      toast({ 
        title: "Failed to update relay description", 
        description: error.message,
        variant: "destructive" 
      });
    },
  });

  // Mutation for changing relay icon
  const changeIconMutation = useMutation({
    mutationFn: (icon: string) => callRelayRpc('changerelayicon', [icon]),
    onSuccess: () => {
      toast({ title: "Relay icon updated successfully" });
      queryClient.invalidateQueries({ queryKey: ['relay-info', relayUrl] });
    },
    onError: (error: Error) => {
      toast({ 
        title: "Failed to update relay icon", 
        description: error.message,
        variant: "destructive" 
      });
    },
  });

  // Mutation for managing kinds
  const manageKindMutation = useMutation({
    mutationFn: ({ kind, action }: { kind: number; action: 'allow' | 'disallow' }) => {
      const method = action === 'allow' ? 'allowkind' : 'disallowkind';
      return callRelayRpc(method, [kind]);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['allowed-kinds', relayUrl] });
      toast({ title: "Kind settings updated successfully" });
      setIsKindDialogOpen(false);
      setNewKind("");
    },
    onError: (error: Error) => {
      toast({ 
        title: "Failed to update kind settings", 
        description: error.message,
        variant: "destructive" 
      });
    },
  });

  // Mutation for blocking IPs
  const blockIpMutation = useMutation({
    mutationFn: ({ ip, reason }: { ip: string; reason?: string }) =>
      callRelayRpc('blockip', [ip, reason]),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['blocked-ips', relayUrl] });
      toast({ title: "IP blocked successfully" });
      setIsIpDialogOpen(false);
      setNewIp("");
      setNewIpReason("");
    },
    onError: (error: Error) => {
      toast({ 
        title: "Failed to block IP", 
        description: error.message,
        variant: "destructive" 
      });
    },
  });

  // Mutation for unblocking IPs
  const unblockIpMutation = useMutation({
    mutationFn: (ip: string) => callRelayRpc('unblockip', [ip]),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['blocked-ips', relayUrl] });
      toast({ title: "IP unblocked successfully" });
    },
    onError: (error: Error) => {
      toast({ 
        title: "Failed to unblock IP", 
        description: error.message,
        variant: "destructive" 
      });
    },
  });

  const handleUpdateName = () => {
    if (!relayName.trim()) {
      toast({ 
        title: "Invalid input", 
        description: "Please enter a valid relay name",
        variant: "destructive" 
      });
      return;
    }
    changeNameMutation.mutate(relayName.trim());
  };

  const handleUpdateDescription = () => {
    if (!relayDescription.trim()) {
      toast({ 
        title: "Invalid input", 
        description: "Please enter a valid description",
        variant: "destructive" 
      });
      return;
    }
    changeDescriptionMutation.mutate(relayDescription.trim());
  };

  const handleUpdateIcon = () => {
    if (!relayIcon.trim()) {
      toast({ 
        title: "Invalid input", 
        description: "Please enter a valid icon URL",
        variant: "destructive" 
      });
      return;
    }
    changeIconMutation.mutate(relayIcon.trim());
  };

  const handleManageKind = () => {
    const kind = parseInt(newKind);
    if (isNaN(kind) || kind < 0) {
      toast({ 
        title: "Invalid input", 
        description: "Please enter a valid kind number",
        variant: "destructive" 
      });
      return;
    }
    manageKindMutation.mutate({ kind, action: kindAction });
  };

  const handleBlockIp = () => {
    if (!newIp.trim()) {
      toast({ 
        title: "Invalid input", 
        description: "Please enter a valid IP address",
        variant: "destructive" 
      });
      return;
    }
    blockIpMutation.mutate({ ip: newIp.trim(), reason: newIpReason.trim() || undefined });
  };

  if (!user) {
    return (
      <Alert>
        <AlertDescription>
          Please log in to manage relay settings.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Relay Settings</h2>
        <p className="text-muted-foreground">Configure your relay's metadata and policies</p>
      </div>

      <Tabs defaultValue="metadata" className="space-y-4">
        <TabsList>
          <TabsTrigger value="metadata" className="flex items-center space-x-2">
            <Globe className="h-4 w-4" />
            <span>Metadata</span>
          </TabsTrigger>
          <TabsTrigger value="kinds" className="flex items-center space-x-2">
            <FileText className="h-4 w-4" />
            <span>Event Kinds</span>
          </TabsTrigger>
          <TabsTrigger value="network" className="flex items-center space-x-2">
            <Network className="h-4 w-4" />
            <span>Network</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="metadata">
          <div className="space-y-6">
            {/* Relay Name */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Globe className="h-5 w-5" />
                  <span>Relay Name</span>
                </CardTitle>
                <CardDescription>
                  Set a friendly name for your relay
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="relay-name">Relay Name</Label>
                  <Input
                    id="relay-name"
                    value={relayName}
                    onChange={(e) => setRelayName(e.target.value)}
                    placeholder="My Awesome Relay"
                    className="mt-1"
                  />
                </div>
                <Button 
                  onClick={handleUpdateName}
                  disabled={changeNameMutation.isPending}
                >
                  Update Name
                </Button>
              </CardContent>
            </Card>

            {/* Relay Description */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <FileText className="h-5 w-5" />
                  <span>Relay Description</span>
                </CardTitle>
                <CardDescription>
                  Provide a detailed description of your relay
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="relay-description">Description</Label>
                  <Textarea
                    id="relay-description"
                    value={relayDescription}
                    onChange={(e) => setRelayDescription(e.target.value)}
                    placeholder="A description of what this relay is for..."
                    className="mt-1"
                    rows={4}
                  />
                </div>
                <Button 
                  onClick={handleUpdateDescription}
                  disabled={changeDescriptionMutation.isPending}
                >
                  Update Description
                </Button>
              </CardContent>
            </Card>

            {/* Relay Icon */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Image className="h-5 w-5" />
                  <span>Relay Icon</span>
                </CardTitle>
                <CardDescription>
                  Set an icon URL for your relay
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="relay-icon">Icon URL</Label>
                  <Input
                    id="relay-icon"
                    value={relayIcon}
                    onChange={(e) => setRelayIcon(e.target.value)}
                    placeholder="https://example.com/icon.png"
                    className="mt-1"
                  />
                </div>
                <Button 
                  onClick={handleUpdateIcon}
                  disabled={changeIconMutation.isPending}
                >
                  Update Icon
                </Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="kinds">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center space-x-2">
                    <FileText className="h-5 w-5" />
                    <span>Event Kinds</span>
                  </CardTitle>
                  <CardDescription>
                    Manage which event kinds are allowed on your relay
                  </CardDescription>
                </div>
                <Dialog open={isKindDialogOpen} onOpenChange={setIsKindDialogOpen}>
                  <DialogTrigger asChild>
                    <Button>
                      <Plus className="h-4 w-4 mr-2" />
                      Manage Kind
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Manage Event Kind</DialogTitle>
                      <DialogDescription>
                        Allow or disallow a specific event kind
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                      <div>
                        <Label>Action</Label>
                        <div className="flex space-x-2 mt-1">
                          <Button
                            variant={kindAction === 'allow' ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => setKindAction('allow')}
                          >
                            Allow
                          </Button>
                          <Button
                            variant={kindAction === 'disallow' ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => setKindAction('disallow')}
                          >
                            Disallow
                          </Button>
                        </div>
                      </div>
                      <div>
                        <Label htmlFor="kind-number">Kind Number</Label>
                        <Input
                          id="kind-number"
                          type="number"
                          value={newKind}
                          onChange={(e) => setNewKind(e.target.value)}
                          placeholder="1"
                          className="mt-1"
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setIsKindDialogOpen(false)}>
                        Cancel
                      </Button>
                      <Button 
                        onClick={handleManageKind}
                        disabled={manageKindMutation.isPending}
                      >
                        {kindAction === 'allow' ? 'Allow Kind' : 'Disallow Kind'}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent>
              {loadingKinds ? (
                <div className="space-y-2">
                  {[...Array(5)].map((_, i) => (
                    <Skeleton key={i} className="h-8 w-20" />
                  ))}
                </div>
              ) : kindsError ? (
                <Alert>
                  <AlertDescription>
                    Failed to load allowed kinds: {kindsError.message}
                  </AlertDescription>
                </Alert>
              ) : !allowedKinds || allowedKinds.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Shield className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>All event kinds are allowed</p>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {allowedKinds.map((kind: number) => (
                    <Badge key={kind} variant="secondary">
                      Kind {kind}
                    </Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="network">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center space-x-2">
                    <Network className="h-5 w-5" />
                    <span>Blocked IP Addresses</span>
                  </CardTitle>
                  <CardDescription>
                    Manage IP addresses that are blocked from accessing your relay
                  </CardDescription>
                </div>
                <Dialog open={isIpDialogOpen} onOpenChange={setIsIpDialogOpen}>
                  <DialogTrigger asChild>
                    <Button variant="destructive">
                      <Plus className="h-4 w-4 mr-2" />
                      Block IP
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Block IP Address</DialogTitle>
                      <DialogDescription>
                        Block an IP address from accessing your relay
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                      <div>
                        <Label htmlFor="ip-address">IP Address</Label>
                        <Input
                          id="ip-address"
                          value={newIp}
                          onChange={(e) => setNewIp(e.target.value)}
                          placeholder="192.168.1.1"
                          className="mt-1"
                        />
                      </div>
                      <div>
                        <Label htmlFor="ip-reason">Reason (optional)</Label>
                        <Textarea
                          id="ip-reason"
                          value={newIpReason}
                          onChange={(e) => setNewIpReason(e.target.value)}
                          placeholder="Reason for blocking this IP"
                          className="mt-1"
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setIsIpDialogOpen(false)}>
                        Cancel
                      </Button>
                      <Button 
                        variant="destructive"
                        onClick={handleBlockIp}
                        disabled={blockIpMutation.isPending}
                      >
                        Block IP
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent>
              {loadingIps ? (
                <div className="space-y-3">
                  {[...Array(3)].map((_, i) => (
                    <div key={i} className="flex items-center justify-between p-3 border rounded-lg">
                      <div className="space-y-2">
                        <Skeleton className="h-4 w-32" />
                        <Skeleton className="h-3 w-48" />
                      </div>
                      <Skeleton className="h-8 w-20" />
                    </div>
                  ))}
                </div>
              ) : ipsError ? (
                <Alert>
                  <AlertDescription>
                    Failed to load blocked IPs: {ipsError.message}
                  </AlertDescription>
                </Alert>
              ) : !blockedIps || blockedIps.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Network className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No blocked IP addresses</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {blockedIps.map((item: { ip: string; reason?: string }, index: number) => (
                    <div key={index} className="flex items-center justify-between p-3 border rounded-lg">
                      <div>
                        <p className="font-mono text-sm">{item.ip}</p>
                        {item.reason && (
                          <p className="text-sm text-muted-foreground mt-1">{item.reason}</p>
                        )}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => unblockIpMutation.mutate(item.ip)}
                        disabled={unblockIpMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
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