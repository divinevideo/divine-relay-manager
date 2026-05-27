import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAdminApi } from "@/hooks/useAdminApi";
import { useToast } from "@/hooks/useToast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { UserPlus, Copy, Check, Loader2 } from "lucide-react";
import { CopyableId } from "@/components/CopyableId";

export function CreateMinorAccountDialog() {
  const api = useAdminApi();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [zendeskTicketId, setZendeskTicketId] = useState("");
  const [claimUrlCopied, setClaimUrlCopied] = useState(false);

  const createAccount = useMutation({
    mutationFn: () => {
      const ticketId = zendeskTicketId ? parseInt(zendeskTicketId, 10) : undefined;
      return api.createMinorAccount(username.trim(), displayName.trim() || undefined, ticketId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['age-review-cases'] });
    },
    onError: (err: Error) => {
      toast({ title: 'Failed to create account', description: err.message, variant: 'destructive' });
    },
  });

  const result = createAccount.data;

  function handleCopyClaimUrl() {
    if (!result?.claim_url) return;
    navigator.clipboard.writeText(result.claim_url);
    setClaimUrlCopied(true);
    setTimeout(() => setClaimUrlCopied(false), 2000);
    toast({ title: 'Claim link copied' });
  }

  function handleClose() {
    setOpen(false);
    setUsername("");
    setDisplayName("");
    setZendeskTicketId("");
    createAccount.reset();
    setClaimUrlCopied(false);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => v ? setOpen(true) : handleClose()}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 text-xs gap-1">
          <UserPlus className="h-3 w-3" />
          New Minor Account
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Create Approved Minor Account</DialogTitle>
        </DialogHeader>

        {!result?.success ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Username *</label>
              <Input
                placeholder="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="h-8 text-sm"
                disabled={createAccount.isPending}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Display Name</label>
              <Input
                placeholder="Display name (optional)"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="h-8 text-sm"
                disabled={createAccount.isPending}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Zendesk Ticket ID</label>
              <Input
                placeholder="e.g. 12345 (optional)"
                value={zendeskTicketId}
                onChange={(e) => setZendeskTicketId(e.target.value.replace(/\D/g, ''))}
                className="h-8 text-sm"
                disabled={createAccount.isPending}
              />
            </div>
            <Button
              className="w-full h-8 text-xs"
              disabled={!username.trim() || createAccount.isPending}
              onClick={() => createAccount.mutate()}
            >
              {createAccount.isPending ? (
                <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Creating...</>
              ) : (
                'Create Account & Generate Claim Link'
              )}
            </Button>
            {createAccount.isError && (
              <p className="text-xs text-red-600">{(createAccount.error as Error).message}</p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-md bg-green-50 dark:bg-green-900/20 p-3 space-y-2">
              <p className="text-xs font-medium text-green-800 dark:text-green-300">Account created</p>
              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground">Pubkey:</div>
                <CopyableId value={result.pubkey ?? ''} type="hex" size="xs" truncateStart={16} truncateEnd={8} />
              </div>
              <div className="text-xs text-muted-foreground">
                Expires: {result.expires_at ? new Date(result.expires_at).toLocaleDateString() : 'N/A'}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium">Claim Link</label>
              <div className="flex gap-1.5">
                <Input
                  readOnly
                  value={result.claim_url ?? ''}
                  className="h-8 text-xs font-mono"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0"
                  onClick={handleCopyClaimUrl}
                >
                  {claimUrlCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Send this link to the parent via Zendesk reply. The minor uses it to set their email and password.
              </p>
            </div>

            <Button variant="outline" className="w-full h-8 text-xs" onClick={handleClose}>
              Done
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
