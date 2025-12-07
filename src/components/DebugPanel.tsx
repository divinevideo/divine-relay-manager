// ABOUTME: Debug panel for testing moderation actions and NIP-86 RPC connectivity
// ABOUTME: Allows manual testing of ban/unban, viewing decision logs, and relay diagnostics

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/useToast";
import {
  getWorkerInfo,
  banPubkey,
  unbanPubkey,
  listBannedPubkeys,
  listBannedEvents,
  getAllDecisions,
  callRelayRpc,
  logDecision,
} from "@/lib/adminApi";
import {
  Bug,
  CheckCircle,
  XCircle,
  RefreshCw,
  Send,
  Trash2,
  UserX,
  UserCheck,
  Database,
  Radio,
  AlertTriangle,
  Terminal,
} from "lucide-react";

interface RpcTestResult {
  method: string;
  success: boolean;
  result?: unknown;
  error?: string;
  duration: number;
}

export function DebugPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [testPubkey, setTestPubkey] = useState("");
  const [rpcMethod, setRpcMethod] = useState("listbannedpubkeys");
  const [rpcParams, setRpcParams] = useState("");
  const [rpcResults, setRpcResults] = useState<RpcTestResult[]>([]);

  // Worker info
  const workerInfo = useQuery({
    queryKey: ['worker-info'],
    queryFn: getWorkerInfo,
  });

  // Banned pubkeys from relay
  const bannedPubkeys = useQuery({
    queryKey: ['debug-banned-pubkeys'],
    queryFn: async () => {
      const start = Date.now();
      try {
        const result = await listBannedPubkeys();
        return { success: true, data: result, duration: Date.now() - start };
      } catch (error) {
        return { success: false, error: String(error), duration: Date.now() - start };
      }
    },
  });

  // Banned events from relay
  const bannedEvents = useQuery({
    queryKey: ['debug-banned-events'],
    queryFn: async () => {
      const start = Date.now();
      try {
        const result = await listBannedEvents();
        return { success: true, data: result, duration: Date.now() - start };
      } catch (error) {
        return { success: false, error: String(error), duration: Date.now() - start };
      }
    },
  });

  // Decision log
  const decisions = useQuery({
    queryKey: ['debug-decisions'],
    queryFn: async () => {
      const start = Date.now();
      try {
        const result = await getAllDecisions();
        return { success: true, data: result, duration: Date.now() - start };
      } catch (error) {
        return { success: false, error: String(error), duration: Date.now() - start };
      }
    },
  });

  // Ban mutation
  const banMutation = useMutation({
    mutationFn: async (pubkey: string) => {
      await banPubkey(pubkey, "Debug test ban");
      await logDecision({
        targetType: 'pubkey',
        targetId: pubkey,
        action: 'ban_user',
        reason: 'Debug test ban',
      });
    },
    onSuccess: () => {
      toast({ title: "Ban request sent" });
      queryClient.invalidateQueries({ queryKey: ['debug-banned-pubkeys'] });
      queryClient.invalidateQueries({ queryKey: ['debug-decisions'] });
    },
    onError: (error: Error) => {
      toast({ title: "Ban failed", description: error.message, variant: "destructive" });
    },
  });

  // Unban mutation
  const unbanMutation = useMutation({
    mutationFn: async (pubkey: string) => {
      await unbanPubkey(pubkey);
      await logDecision({
        targetType: 'pubkey',
        targetId: pubkey,
        action: 'unban_user',
        reason: 'Debug test unban',
      });
    },
    onSuccess: () => {
      toast({ title: "Unban request sent" });
      queryClient.invalidateQueries({ queryKey: ['debug-banned-pubkeys'] });
      queryClient.invalidateQueries({ queryKey: ['debug-decisions'] });
    },
    onError: (error: Error) => {
      toast({ title: "Unban failed", description: error.message, variant: "destructive" });
    },
  });

  // Generic RPC call
  const executeRpc = async () => {
    const start = Date.now();
    let params: (string | number)[] = [];
    try {
      if (rpcParams.trim()) {
        params = JSON.parse(rpcParams);
      }
    } catch {
      toast({ title: "Invalid params", description: "Must be valid JSON array", variant: "destructive" });
      return;
    }

    try {
      const result = await callRelayRpc(rpcMethod, params);
      setRpcResults(prev => [{
        method: rpcMethod,
        success: true,
        result,
        duration: Date.now() - start,
      }, ...prev.slice(0, 9)]);
    } catch (error) {
      setRpcResults(prev => [{
        method: rpcMethod,
        success: false,
        error: String(error),
        duration: Date.now() - start,
      }, ...prev.slice(0, 9)]);
    }
  };

  const refreshAll = () => {
    workerInfo.refetch();
    bannedPubkeys.refetch();
    bannedEvents.refetch();
    decisions.refetch();
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bug className="h-5 w-5" />
          <h2 className="text-lg font-semibold">Debug & Diagnostics</h2>
        </div>
        <Button variant="outline" size="sm" onClick={refreshAll}>
          <RefreshCw className="h-4 w-4 mr-1" />
          Refresh All
        </Button>
      </div>

      <Tabs defaultValue="connectivity">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="connectivity">
            <Radio className="h-3 w-3 mr-1" />
            Connectivity
          </TabsTrigger>
          <TabsTrigger value="actions">
            <UserX className="h-3 w-3 mr-1" />
            Test Actions
          </TabsTrigger>
          <TabsTrigger value="rpc">
            <Terminal className="h-3 w-3 mr-1" />
            Raw RPC
          </TabsTrigger>
          <TabsTrigger value="decisions">
            <Database className="h-3 w-3 mr-1" />
            Decision Log
          </TabsTrigger>
        </TabsList>

        {/* Connectivity Tab */}
        <TabsContent value="connectivity" className="space-y-4">
          {/* Worker Status */}
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">Worker Status</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {workerInfo.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : workerInfo.error ? (
                <Alert variant="destructive">
                  <XCircle className="h-4 w-4" />
                  <AlertTitle>Worker Unreachable</AlertTitle>
                  <AlertDescription>{String(workerInfo.error)}</AlertDescription>
                </Alert>
              ) : (
                <div className="space-y-1 text-sm">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-green-500" />
                    <span>Worker connected</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <div>
                      <Label className="text-xs text-muted-foreground">Pubkey</Label>
                      <code className="text-xs block truncate">{workerInfo.data?.pubkey}</code>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Relay</Label>
                      <code className="text-xs block">{workerInfo.data?.relay}</code>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* NIP-86 RPC Status */}
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">NIP-86 RPC Status</CardTitle>
              <CardDescription className="text-xs">
                Tests if the relay supports NIP-86 Management API
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* listbannedpubkeys */}
              <div className="flex items-center justify-between p-2 bg-muted rounded">
                <div className="flex items-center gap-2">
                  <code className="text-xs">listbannedpubkeys</code>
                  {bannedPubkeys.isLoading ? (
                    <RefreshCw className="h-3 w-3 animate-spin" />
                  ) : bannedPubkeys.data?.success ? (
                    <Badge variant="outline" className="text-green-600 text-xs">
                      <CheckCircle className="h-3 w-3 mr-1" />
                      OK ({bannedPubkeys.data.duration}ms)
                    </Badge>
                  ) : (
                    <Badge variant="destructive" className="text-xs">
                      <XCircle className="h-3 w-3 mr-1" />
                      Failed
                    </Badge>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {bannedPubkeys.data?.success
                    ? `${(bannedPubkeys.data.data as string[])?.length || 0} banned`
                    : bannedPubkeys.data?.error?.slice(0, 50)}
                </span>
              </div>

              {/* listbannedevents */}
              <div className="flex items-center justify-between p-2 bg-muted rounded">
                <div className="flex items-center gap-2">
                  <code className="text-xs">listbannedevents</code>
                  {bannedEvents.isLoading ? (
                    <RefreshCw className="h-3 w-3 animate-spin" />
                  ) : bannedEvents.data?.success ? (
                    <Badge variant="outline" className="text-green-600 text-xs">
                      <CheckCircle className="h-3 w-3 mr-1" />
                      OK ({bannedEvents.data.duration}ms)
                    </Badge>
                  ) : (
                    <Badge variant="destructive" className="text-xs">
                      <XCircle className="h-3 w-3 mr-1" />
                      Failed
                    </Badge>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {bannedEvents.data?.success
                    ? `${(bannedEvents.data.data as unknown[])?.length || 0} deleted`
                    : bannedEvents.data?.error?.slice(0, 50)}
                </span>
              </div>

              {/* Decision log */}
              <div className="flex items-center justify-between p-2 bg-muted rounded">
                <div className="flex items-center gap-2">
                  <code className="text-xs">decisions (D1)</code>
                  {decisions.isLoading ? (
                    <RefreshCw className="h-3 w-3 animate-spin" />
                  ) : decisions.data?.success ? (
                    <Badge variant="outline" className="text-green-600 text-xs">
                      <CheckCircle className="h-3 w-3 mr-1" />
                      OK ({decisions.data.duration}ms)
                    </Badge>
                  ) : (
                    <Badge variant="destructive" className="text-xs">
                      <XCircle className="h-3 w-3 mr-1" />
                      Failed
                    </Badge>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {decisions.data?.success
                    ? `${(decisions.data.data as unknown[])?.length || 0} decisions`
                    : decisions.data?.error?.slice(0, 50)}
                </span>
              </div>

              {/* Warning if NIP-86 fails but D1 works */}
              {!bannedPubkeys.data?.success && decisions.data?.success && (
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>NIP-86 Not Supported</AlertTitle>
                  <AlertDescription className="text-xs">
                    The relay doesn't support NIP-86 Management API. Bans are logged to our database
                    but may not be enforced by the relay. Consider using a relay that supports NIP-86
                    (like strfry with management enabled).
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Test Actions Tab */}
        <TabsContent value="actions" className="space-y-4">
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">Test Ban/Unban</CardTitle>
              <CardDescription className="text-xs">
                Test banning and unbanning a pubkey
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="test-pubkey" className="text-xs">Pubkey (hex)</Label>
                <Input
                  id="test-pubkey"
                  placeholder="Enter 64-character hex pubkey..."
                  value={testPubkey}
                  onChange={(e) => setTestPubkey(e.target.value)}
                  className="font-mono text-xs"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => banMutation.mutate(testPubkey)}
                  disabled={!testPubkey || testPubkey.length !== 64 || banMutation.isPending}
                >
                  <UserX className="h-4 w-4 mr-1" />
                  {banMutation.isPending ? 'Banning...' : 'Ban'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => unbanMutation.mutate(testPubkey)}
                  disabled={!testPubkey || testPubkey.length !== 64 || unbanMutation.isPending}
                >
                  <UserCheck className="h-4 w-4 mr-1" />
                  {unbanMutation.isPending ? 'Unbanning...' : 'Unban'}
                </Button>
              </div>

              {/* Quick test: use a fake pubkey */}
              <Separator />
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Quick Test</Label>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const fakePubkey = 'deadbeef'.repeat(8);
                    setTestPubkey(fakePubkey);
                  }}
                >
                  Use Test Pubkey (deadbeef...)
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Currently banned */}
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">Currently Banned (from relay)</CardTitle>
            </CardHeader>
            <CardContent>
              {bannedPubkeys.data?.success ? (
                (bannedPubkeys.data.data as string[])?.length > 0 ? (
                  <ScrollArea className="h-32">
                    <div className="space-y-1">
                      {(bannedPubkeys.data.data as string[]).map((pk) => (
                        <div key={pk} className="flex items-center justify-between text-xs p-1 bg-muted rounded">
                          <code className="truncate flex-1">{pk}</code>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2"
                            onClick={() => {
                              setTestPubkey(pk);
                              unbanMutation.mutate(pk);
                            }}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                ) : (
                  <p className="text-xs text-muted-foreground">No banned pubkeys</p>
                )
              ) : (
                <p className="text-xs text-red-500">Failed to load: {bannedPubkeys.data?.error}</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Raw RPC Tab */}
        <TabsContent value="rpc" className="space-y-4">
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">Execute NIP-86 RPC</CardTitle>
              <CardDescription className="text-xs">
                Send raw RPC commands to the relay
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Method</Label>
                  <Input
                    value={rpcMethod}
                    onChange={(e) => setRpcMethod(e.target.value)}
                    placeholder="listbannedpubkeys"
                    className="font-mono text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Params (JSON array)</Label>
                  <Input
                    value={rpcParams}
                    onChange={(e) => setRpcParams(e.target.value)}
                    placeholder='["arg1", "arg2"]'
                    className="font-mono text-xs"
                  />
                </div>
              </div>
              <Button size="sm" onClick={executeRpc}>
                <Send className="h-4 w-4 mr-1" />
                Execute
              </Button>

              {/* Common methods */}
              <div className="flex flex-wrap gap-1">
                <Label className="text-xs text-muted-foreground w-full">Quick methods:</Label>
                {['listbannedpubkeys', 'listbannedevents', 'listallowedpubkeys', 'listeventsneedingmoderation'].map(m => (
                  <Button
                    key={m}
                    variant="outline"
                    size="sm"
                    className="text-xs h-6"
                    onClick={() => {
                      setRpcMethod(m);
                      setRpcParams('');
                    }}
                  >
                    {m}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* RPC Results */}
          {rpcResults.length > 0 && (
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm">RPC Results</CardTitle>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-64">
                  <div className="space-y-2">
                    {rpcResults.map((r, i) => (
                      <div key={i} className={`p-2 rounded text-xs ${r.success ? 'bg-green-50 dark:bg-green-950' : 'bg-red-50 dark:bg-red-950'}`}>
                        <div className="flex items-center gap-2 mb-1">
                          {r.success ? (
                            <CheckCircle className="h-3 w-3 text-green-500" />
                          ) : (
                            <XCircle className="h-3 w-3 text-red-500" />
                          )}
                          <code className="font-semibold">{r.method}</code>
                          <span className="text-muted-foreground">{r.duration}ms</span>
                        </div>
                        <pre className="overflow-auto max-h-24 text-xs bg-background/50 p-1 rounded">
                          {r.success
                            ? JSON.stringify(r.result, null, 2)
                            : r.error}
                        </pre>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Decision Log Tab */}
        <TabsContent value="decisions" className="space-y-4">
          <Card>
            <CardHeader className="py-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-sm">Decision Log (D1 Database)</CardTitle>
                  <CardDescription className="text-xs">
                    All moderation decisions stored in our database
                  </CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={() => decisions.refetch()}>
                  <RefreshCw className={`h-4 w-4 ${decisions.isFetching ? 'animate-spin' : ''}`} />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {decisions.data?.success ? (
                (decisions.data.data as Array<{
                  id: number;
                  target_type: string;
                  target_id: string;
                  action: string;
                  reason?: string;
                  created_at: string;
                }>)?.length > 0 ? (
                  <ScrollArea className="h-96">
                    <div className="space-y-2">
                      {(decisions.data.data as Array<{
                        id: number;
                        target_type: string;
                        target_id: string;
                        action: string;
                        reason?: string;
                        created_at: string;
                      }>).map((d) => (
                        <div key={d.id} className="p-2 bg-muted rounded text-xs">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge variant="outline">{d.action}</Badge>
                            <Badge variant="secondary">{d.target_type}</Badge>
                            <span className="text-muted-foreground">
                              {new Date(d.created_at).toLocaleString()}
                            </span>
                          </div>
                          <code className="text-xs block truncate">{d.target_id}</code>
                          {d.reason && (
                            <p className="text-muted-foreground mt-1">{d.reason}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                ) : (
                  <p className="text-xs text-muted-foreground">No decisions logged yet</p>
                )
              ) : (
                <Alert variant="destructive">
                  <XCircle className="h-4 w-4" />
                  <AlertTitle>Failed to load</AlertTitle>
                  <AlertDescription className="text-xs">{decisions.data?.error}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
