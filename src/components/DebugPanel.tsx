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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useToast } from "@/hooks/useToast";
import { useAdminApi } from "@/hooks/useAdminApi";
import type { BannedPubkeyEntry } from "@/lib/adminApi";
import {
  Bug,
  CheckCircle,
  XCircle,
  RefreshCw,
  Send,
  UserX,
  UserCheck,
  Database,
  Radio,
  AlertTriangle,
  Terminal,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  Loader2,
} from "lucide-react";

interface ActionLog {
  id: number;
  timestamp: Date;
  action: string;
  target: string;
  success: boolean;
  result?: unknown;
  error?: string;
  duration: number;
}

interface RpcTestResult {
  method: string;
  success: boolean;
  result?: unknown;
  error?: string;
  duration: number;
}

let actionId = 0;

export function DebugPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const {
    getWorkerInfo,
    banPubkey,
    unbanPubkey,
    listBannedPubkeys,
    listBannedEvents,
    getAllDecisions,
    callRelayRpc,
    logDecision,
    verifyPubkeyBanned,
    verifyPubkeyUnbanned,
  } = useAdminApi();
  const [testPubkey, setTestPubkey] = useState("");
  const [rpcMethod, setRpcMethod] = useState("listbannedpubkeys");
  const [rpcParams, setRpcParams] = useState("");
  const [rpcResults, setRpcResults] = useState<RpcTestResult[]>([]);
  const [actionLogs, setActionLogs] = useState<ActionLog[]>([]);
  const [expandedLogs, setExpandedLogs] = useState<Set<number>>(new Set());
  const [isVerifying, setIsVerifying] = useState(false);
  const [verificationResult, setVerificationResult] = useState<{
    type: 'ban' | 'unban';
    success: boolean;
    message: string;
  } | null>(null);

  const addActionLog = (log: Omit<ActionLog, 'id' | 'timestamp'>) => {
    const newLog = { ...log, id: ++actionId, timestamp: new Date() };
    setActionLogs(prev => [newLog, ...prev.slice(0, 49)]);
    // Auto-expand new logs
    setExpandedLogs(prev => new Set([...prev, newLog.id]));
  };

  const toggleExpand = (id: number) => {
    setExpandedLogs(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: "Copied to clipboard" });
  };

  // Worker info
  const workerInfo = useQuery({
    queryKey: ['worker-info'],
    queryFn: async () => {
      const start = Date.now();
      try {
        const result = await getWorkerInfo();
        addActionLog({
          action: 'getWorkerInfo',
          target: 'worker',
          success: true,
          result,
          duration: Date.now() - start,
        });
        return result;
      } catch (error) {
        addActionLog({
          action: 'getWorkerInfo',
          target: 'worker',
          success: false,
          error: String(error),
          duration: Date.now() - start,
        });
        throw error;
      }
    },
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

  // Ban mutation with detailed logging
  const banMutation = useMutation({
    mutationFn: async (pubkey: string) => {
      const start = Date.now();
      const results: { banResult?: unknown; banError?: string; logResult?: unknown; logError?: string } = {};

      // Try to ban via NIP-86 RPC
      try {
        const banResult = await banPubkey(pubkey, "Debug test ban");
        results.banResult = banResult;
      } catch (error) {
        results.banError = String(error);
      }

      // Log to our database regardless
      try {
        const logResult = await logDecision({
          targetType: 'pubkey',
          targetId: pubkey,
          action: 'ban_user',
          reason: 'Debug test ban',
        });
        results.logResult = logResult;
      } catch (error) {
        results.logError = String(error);
      }

      const duration = Date.now() - start;
      const success = !results.banError || !results.logError;

      addActionLog({
        action: 'banPubkey',
        target: pubkey,
        success,
        result: results,
        error: results.banError || results.logError,
        duration,
      });

      if (results.banError && results.logError) {
        throw new Error(`Ban: ${results.banError}, Log: ${results.logError}`);
      }

      return results;
    },
    onSuccess: async (results, pubkey) => {
      if (results.banError) {
        toast({
          title: "Partial success",
          description: `NIP-86 failed but logged to DB. Error: ${results.banError}`,
          variant: "destructive"
        });
      } else {
        toast({ title: "Ban successful", description: "Verifying..." });
      }
      queryClient.invalidateQueries({ queryKey: ['debug-banned-pubkeys'] });
      queryClient.invalidateQueries({ queryKey: ['debug-decisions'] });

      // Verify the ban worked
      if (!results.banError) {
        setIsVerifying(true);
        setVerificationResult(null);
        try {
          const verified = await verifyPubkeyBanned(pubkey);
          setVerificationResult({
            type: 'ban',
            success: verified,
            message: verified
              ? 'Ban verified - user is in banned list'
              : 'Warning: User may not be banned',
          });
          addActionLog({
            action: 'verifyBan',
            target: pubkey,
            success: verified,
            result: { verified },
            duration: 0,
          });
          toast({
            title: verified ? "Ban Verified" : "Verification Warning",
            description: verified
              ? "User confirmed banned on relay"
              : "Could not confirm ban - check manually",
            variant: verified ? "default" : "destructive",
          });
        } catch {
          setVerificationResult({
            type: 'ban',
            success: false,
            message: 'Could not verify ban status',
          });
        } finally {
          setIsVerifying(false);
        }
      }
    },
    onError: (error: Error) => {
      toast({ title: "Ban failed", description: error.message, variant: "destructive" });
    },
  });

  // Unban mutation with detailed logging
  const unbanMutation = useMutation({
    mutationFn: async (pubkey: string) => {
      const start = Date.now();
      const results: { unbanResult?: unknown; unbanError?: string; logResult?: unknown; logError?: string } = {};

      try {
        const unbanResult = await unbanPubkey(pubkey);
        results.unbanResult = unbanResult;
      } catch (error) {
        results.unbanError = String(error);
      }

      try {
        const logResult = await logDecision({
          targetType: 'pubkey',
          targetId: pubkey,
          action: 'unban_user',
          reason: 'Debug test unban',
        });
        results.logResult = logResult;
      } catch (error) {
        results.logError = String(error);
      }

      const duration = Date.now() - start;
      const success = !results.unbanError || !results.logError;

      addActionLog({
        action: 'unbanPubkey',
        target: pubkey,
        success,
        result: results,
        error: results.unbanError || results.logError,
        duration,
      });

      if (results.unbanError && results.logError) {
        throw new Error(`Unban: ${results.unbanError}, Log: ${results.logError}`);
      }

      return results;
    },
    onSuccess: async (results, pubkey) => {
      if (results.unbanError) {
        toast({
          title: "Partial success",
          description: `NIP-86 failed but logged to DB`,
          variant: "destructive"
        });
      } else {
        toast({ title: "Unban successful", description: "Verifying..." });
      }
      queryClient.invalidateQueries({ queryKey: ['debug-banned-pubkeys'] });
      queryClient.invalidateQueries({ queryKey: ['debug-decisions'] });

      // Verify the unban worked
      if (!results.unbanError) {
        setIsVerifying(true);
        setVerificationResult(null);
        try {
          const verified = await verifyPubkeyUnbanned(pubkey);
          setVerificationResult({
            type: 'unban',
            success: verified,
            message: verified
              ? 'Unban verified - user removed from banned list'
              : 'Warning: User may still be banned',
          });
          addActionLog({
            action: 'verifyUnban',
            target: pubkey,
            success: verified,
            result: { verified },
            duration: 0,
          });
          toast({
            title: verified ? "Unban Verified" : "Verification Warning",
            description: verified
              ? "User confirmed removed from banned list"
              : "Could not confirm unban - check manually",
            variant: verified ? "default" : "destructive",
          });
        } catch {
          setVerificationResult({
            type: 'unban',
            success: false,
            message: 'Could not verify unban status',
          });
        } finally {
          setIsVerifying(false);
        }
      }
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
      const duration = Date.now() - start;
      setRpcResults(prev => [{
        method: rpcMethod,
        success: true,
        result,
        duration,
      }, ...prev.slice(0, 9)]);
      addActionLog({
        action: `RPC:${rpcMethod}`,
        target: JSON.stringify(params),
        success: true,
        result,
        duration,
      });
    } catch (error) {
      const duration = Date.now() - start;
      setRpcResults(prev => [{
        method: rpcMethod,
        success: false,
        error: String(error),
        duration,
      }, ...prev.slice(0, 9)]);
      addActionLog({
        action: `RPC:${rpcMethod}`,
        target: JSON.stringify(params),
        success: false,
        error: String(error),
        duration,
      });
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
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setActionLogs([])}>
            Clear Logs
          </Button>
          <Button variant="outline" size="sm" onClick={refreshAll}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh All
          </Button>
        </div>
      </div>

      {/* Action Log - Always visible at top */}
      <Card className="border-2 border-dashed">
        <CardHeader className="py-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Terminal className="h-4 w-4" />
            Action Log ({actionLogs.length})
          </CardTitle>
          <CardDescription className="text-xs">
            All API calls and their results - click to expand
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-48">
            <div className="space-y-1 p-3">
              {actionLogs.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">
                  No actions yet. Try banning a test pubkey or running an RPC command.
                </p>
              ) : (
                actionLogs.map((log) => (
                  <Collapsible
                    key={log.id}
                    open={expandedLogs.has(log.id)}
                    onOpenChange={() => toggleExpand(log.id)}
                  >
                    <CollapsibleTrigger asChild>
                      <div className={`flex items-center gap-2 p-2 rounded cursor-pointer hover:bg-muted/80 ${
                        log.success ? 'bg-green-50 dark:bg-green-950/30' : 'bg-red-50 dark:bg-red-950/30'
                      }`}>
                        {expandedLogs.has(log.id) ? (
                          <ChevronDown className="h-3 w-3 shrink-0" />
                        ) : (
                          <ChevronRight className="h-3 w-3 shrink-0" />
                        )}
                        {log.success ? (
                          <CheckCircle className="h-3 w-3 text-green-500 shrink-0" />
                        ) : (
                          <XCircle className="h-3 w-3 text-red-500 shrink-0" />
                        )}
                        <code className="text-xs font-semibold">{log.action}</code>
                        <span className="text-xs text-muted-foreground truncate flex-1">
                          {log.target.slice(0, 20)}{log.target.length > 20 && '...'}
                        </span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {log.duration}ms
                        </span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {log.timestamp.toLocaleTimeString()}
                        </span>
                      </div>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="ml-5 p-2 bg-muted/50 rounded-b text-xs space-y-2">
                        <div className="flex items-center gap-2">
                          <Label className="text-muted-foreground">Target:</Label>
                          <code className="flex-1 truncate">{log.target}</code>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2"
                            onClick={(e) => {
                              e.stopPropagation();
                              copyToClipboard(log.target);
                            }}
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                        </div>
                        {log.error && (
                          <div className="p-2 bg-red-100 dark:bg-red-900/30 rounded">
                            <Label className="text-red-600 dark:text-red-400">Error:</Label>
                            <pre className="whitespace-pre-wrap text-red-700 dark:text-red-300 mt-1">
                              {String(log.error)}
                            </pre>
                          </div>
                        )}
                        {!!log.result && (
                          <div className="p-2 bg-background rounded">
                            <div className="flex items-center justify-between">
                              <Label className="text-muted-foreground">Result:</Label>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  copyToClipboard(JSON.stringify(log.result, null, 2));
                                }}
                              >
                                <Copy className="h-3 w-3" />
                              </Button>
                            </div>
                            <pre className="whitespace-pre-wrap overflow-auto max-h-32 mt-1">
                              {JSON.stringify(log.result as object, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                ))
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <Tabs defaultValue="actions">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="actions">
            <UserX className="h-3 w-3 mr-1" />
            Test Actions
          </TabsTrigger>
          <TabsTrigger value="connectivity">
            <Radio className="h-3 w-3 mr-1" />
            Connectivity
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

        {/* Test Actions Tab */}
        <TabsContent value="actions" className="space-y-4">
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">Test Ban/Unban</CardTitle>
              <CardDescription className="text-xs">
                Test banning and unbanning a pubkey. Results appear in the Action Log above.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="test-pubkey" className="text-xs">Pubkey (hex, 64 characters)</Label>
                <div className="flex gap-2">
                  <Input
                    id="test-pubkey"
                    placeholder="Enter 64-character hex pubkey..."
                    value={testPubkey}
                    onChange={(e) => setTestPubkey(e.target.value)}
                    className="font-mono text-xs flex-1"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copyToClipboard(testPubkey)}
                    disabled={!testPubkey}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Length: {testPubkey.length}/64 {testPubkey.length === 64 && <CheckCircle className="h-3 w-3 inline text-green-500" />}
                </p>
              </div>

              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  onClick={() => banMutation.mutate(testPubkey)}
                  disabled={testPubkey.length !== 64 || banMutation.isPending}
                >
                  <UserX className="h-4 w-4 mr-1" />
                  {banMutation.isPending ? 'Banning...' : 'Ban Pubkey'}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => unbanMutation.mutate(testPubkey)}
                  disabled={testPubkey.length !== 64 || unbanMutation.isPending}
                >
                  <UserCheck className="h-4 w-4 mr-1" />
                  {unbanMutation.isPending ? 'Unbanning...' : 'Unban Pubkey'}
                </Button>
              </div>

              {/* Verification Status */}
              {(isVerifying || verificationResult) && (
                <div
                  className={`p-2 rounded flex items-center gap-2 text-xs ${
                    verificationResult?.success
                      ? "bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800"
                      : "bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800"
                  }`}
                >
                  {isVerifying ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : verificationResult?.success ? (
                    <CheckCircle className="h-4 w-4 text-green-600" />
                  ) : (
                    <XCircle className="h-4 w-4 text-red-600" />
                  )}
                  <span className={verificationResult?.success ? "text-green-800 dark:text-green-300" : "text-red-800 dark:text-red-300"}>
                    {isVerifying
                      ? "Verifying..."
                      : verificationResult?.message}
                  </span>
                  {verificationResult && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setVerificationResult(null)}
                      className="h-5 px-1 ml-auto"
                    >
                      Dismiss
                    </Button>
                  )}
                </div>
              )}

              <Separator />

              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Quick Test Pubkeys</Label>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setTestPubkey('deadbeef'.repeat(8))}
                  >
                    deadbeef... (test)
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setTestPubkey('0'.repeat(64))}
                  >
                    000...000 (null)
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setTestPubkey('f'.repeat(64))}
                  >
                    fff...fff (max)
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Currently banned */}
          <Card>
            <CardHeader className="py-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">Currently Banned (from relay NIP-86)</CardTitle>
                <Button variant="ghost" size="sm" onClick={() => bannedPubkeys.refetch()}>
                  <RefreshCw className={`h-4 w-4 ${bannedPubkeys.isFetching ? 'animate-spin' : ''}`} />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {bannedPubkeys.data?.success ? (
                (bannedPubkeys.data.data as BannedPubkeyEntry[])?.length > 0 ? (
                  <ScrollArea className="h-32">
                    <div className="space-y-1">
                      {(bannedPubkeys.data.data as BannedPubkeyEntry[]).map((entry) => (
                        <div key={entry.pubkey} className="flex items-center justify-between text-xs p-2 bg-muted rounded">
                          <div className="flex-1 min-w-0">
                            <code className="truncate block">{entry.pubkey}</code>
                            {entry.reason && (
                              <span className="text-muted-foreground text-xs">{entry.reason}</span>
                            )}
                          </div>
                          <div className="flex gap-1 shrink-0">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2"
                              onClick={() => copyToClipboard(entry.pubkey)}
                            >
                              <Copy className="h-3 w-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2"
                              onClick={() => {
                                setTestPubkey(entry.pubkey);
                              }}
                            >
                              <Eye className="h-3 w-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-green-600"
                              onClick={() => unbanMutation.mutate(entry.pubkey)}
                            >
                              <UserCheck className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                ) : (
                  <p className="text-xs text-muted-foreground">No banned pubkeys from relay</p>
                )
              ) : (
                <Alert variant="destructive">
                  <XCircle className="h-4 w-4" />
                  <AlertTitle>NIP-86 Failed</AlertTitle>
                  <AlertDescription className="text-xs">{bannedPubkeys.data?.error}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </TabsContent>

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
                    ? `${(bannedPubkeys.data.data as BannedPubkeyEntry[])?.length || 0} banned`
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
                    but may not be enforced by the relay. Consider using a relay that supports NIP-86.
                  </AlertDescription>
                </Alert>
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
                      <Collapsible key={i} defaultOpen={i === 0}>
                        <CollapsibleTrigger asChild>
                          <div className={`p-2 rounded text-xs cursor-pointer ${r.success ? 'bg-green-50 dark:bg-green-950' : 'bg-red-50 dark:bg-red-950'}`}>
                            <div className="flex items-center gap-2">
                              {r.success ? (
                                <CheckCircle className="h-3 w-3 text-green-500" />
                              ) : (
                                <XCircle className="h-3 w-3 text-red-500" />
                              )}
                              <code className="font-semibold">{r.method}</code>
                              <span className="text-muted-foreground">{r.duration}ms</span>
                              <ChevronDown className="h-3 w-3 ml-auto" />
                            </div>
                          </div>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <pre className="overflow-auto max-h-32 text-xs bg-muted p-2 rounded-b">
                            {r.success
                              ? JSON.stringify(r.result, null, 2)
                              : r.error}
                          </pre>
                        </CollapsibleContent>
                      </Collapsible>
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
                        <Collapsible key={d.id}>
                          <CollapsibleTrigger asChild>
                            <div className="p-2 bg-muted rounded text-xs cursor-pointer hover:bg-muted/80">
                              <div className="flex items-center gap-2">
                                <Badge variant="outline">{d.action}</Badge>
                                <Badge variant="secondary">{d.target_type}</Badge>
                                <span className="text-muted-foreground flex-1 truncate">
                                  {d.target_id.slice(0, 16)}...
                                </span>
                                <span className="text-muted-foreground shrink-0">
                                  {new Date(d.created_at).toLocaleString()}
                                </span>
                                <ChevronDown className="h-3 w-3" />
                              </div>
                            </div>
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <div className="ml-2 p-2 bg-background rounded-b text-xs space-y-1">
                              <div className="flex items-center gap-2">
                                <Label className="text-muted-foreground">Target:</Label>
                                <code className="flex-1">{d.target_id}</code>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 px-2"
                                  onClick={() => copyToClipboard(d.target_id)}
                                >
                                  <Copy className="h-3 w-3" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 px-2"
                                  onClick={() => setTestPubkey(d.target_id)}
                                >
                                  <Eye className="h-3 w-3" />
                                </Button>
                              </div>
                              {d.reason && (
                                <div>
                                  <Label className="text-muted-foreground">Reason:</Label>
                                  <p className="mt-1">{d.reason}</p>
                                </div>
                              )}
                            </div>
                          </CollapsibleContent>
                        </Collapsible>
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
