import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAppContext } from "@/hooks/useAppContext";
import { useToast } from "@/hooks/useToast";
import { Shield, X, Plus, Save, AlertTriangle } from "lucide-react";

interface AutoHideTier {
  name: string;
  categories: string[];
  threshold: number;
  requireTrustedClient: boolean;
}

interface AutoHideConfig {
  enabled: boolean;
  trustedClients: string[];
  tiers: AutoHideTier[];
}

function ChipList({
  items,
  onRemove,
  onAdd,
  placeholder,
}: {
  items: string[];
  onRemove: (item: string) => void;
  onAdd: (item: string) => void;
  placeholder: string;
}) {
  const [input, setInput] = useState("");

  const handleAdd = () => {
    const trimmed = input.trim();
    if (trimmed && !items.includes(trimmed)) {
      onAdd(trimmed);
      setInput("");
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <Badge key={item} variant="secondary" className="gap-1 pr-1">
            {item}
            <button
              type="button"
              onClick={() => onRemove(item)}
              className="ml-1 rounded-full hover:bg-muted-foreground/20 p-0.5"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), handleAdd())}
          placeholder={placeholder}
          className="h-8 text-sm"
        />
        <Button type="button" size="sm" variant="outline" onClick={handleAdd} className="h-8">
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

function TierConfig({
  tier,
  onChange,
  isImmediate,
}: {
  tier: AutoHideTier;
  onChange: (tier: AutoHideTier) => void;
  isImmediate: boolean;
}) {
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold">{tier.name}</h4>
        <div className="flex items-center gap-2">
          <Label htmlFor={`trusted-${tier.name}`} className="text-xs text-muted-foreground">
            Require trusted client
          </Label>
          <Switch
            id={`trusted-${tier.name}`}
            checked={tier.requireTrustedClient}
            onCheckedChange={(checked) =>
              onChange({ ...tier, requireTrustedClient: checked })
            }
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Categories</Label>
        <ChipList
          items={tier.categories}
          onRemove={(cat) =>
            onChange({ ...tier, categories: tier.categories.filter((c) => c !== cat) })
          }
          onAdd={(cat) => onChange({ ...tier, categories: [...tier.categories, cat] })}
          placeholder="Add category..."
        />
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Threshold (unique reporters)</Label>
        {isImmediate ? (
          <p className="text-sm text-muted-foreground">1 (fixed for immediate tier)</p>
        ) : (
          <Input
            type="number"
            min={2}
            value={tier.threshold}
            onChange={(e) =>
              onChange({ ...tier, threshold: Math.max(2, parseInt(e.target.value) || 2) })
            }
            className="h-8 w-24 text-sm"
          />
        )}
      </div>
    </div>
  );
}

export function AutoHideSettings() {
  const { config: appConfig } = useAppContext();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["autoHideConfig", appConfig.apiUrl],
    queryFn: async () => {
      const res = await fetch(`${appConfig.apiUrl}/api/report-watcher/config`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Failed to fetch config: ${res.status}`);
      const body = await res.json() as { success: boolean; config: AutoHideConfig };
      return body.config;
    },
  });

  const [draft, setDraft] = useState<AutoHideConfig | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (data && !draft) {
      setDraft(structuredClone(data));
    }
  }, [data, draft]);

  const mutation = useMutation({
    mutationFn: async (config: AutoHideConfig) => {
      const res = await fetch(`${appConfig.apiUrl}/api/report-watcher/config`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const body = await res.json() as { success: boolean; config?: AutoHideConfig; error?: string };
      if (!res.ok || !body.success) {
        throw new Error(body.error || `Save failed: ${res.status}`);
      }
      return body.config!;
    },
    onSuccess: (saved) => {
      setDraft(structuredClone(saved));
      setValidationError(null);
      queryClient.invalidateQueries({ queryKey: ["autoHideConfig"] });
      toast({ title: "Auto-hide configuration saved" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    },
  });

  const handleSave = () => {
    if (!draft) return;

    const allCats = draft.tiers.flatMap((t) => t.categories);
    const dupes = allCats.filter((c, i) => allCats.indexOf(c) !== i);
    if (dupes.length > 0) {
      setValidationError(`Category "${dupes[0]}" appears in multiple tiers`);
      return;
    }
    if (draft.trustedClients.length === 0 && draft.tiers.some((t) => t.requireTrustedClient)) {
      setValidationError("Add at least one trusted client when a tier requires them");
      return;
    }
    const thresholdTier = draft.tiers.find((t) => t.name !== "Immediate");
    if (thresholdTier && thresholdTier.threshold < 2) {
      setValidationError("Threshold tier minimum is 2");
      return;
    }

    setValidationError(null);
    mutation.mutate(draft);
  };

  const isDirty = JSON.stringify(draft) !== JSON.stringify(data);

  if (isLoading) return null;
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Failed to load auto-hide config: {(error as Error).message}</AlertDescription>
      </Alert>
    );
  }
  if (!draft) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-4 w-4" />
            Auto-Hide Configuration
          </CardTitle>
          <div className="flex items-center gap-2">
            <Label htmlFor="autohide-enabled" className="text-sm text-muted-foreground">
              Enabled
            </Label>
            <Switch
              id="autohide-enabled"
              checked={draft.enabled}
              onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked })}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Label className="text-xs font-medium text-muted-foreground">Trusted Clients</Label>
          <ChipList
            items={draft.trustedClients}
            onRemove={(c) =>
              setDraft({ ...draft, trustedClients: draft.trustedClients.filter((tc) => tc !== c) })
            }
            onAdd={(c) => setDraft({ ...draft, trustedClients: [...draft.trustedClients, c] })}
            placeholder="Add client name..."
          />
        </div>

        {draft.tiers.map((tier, i) => (
          <TierConfig
            key={tier.name}
            tier={tier}
            isImmediate={tier.name === "Immediate"}
            onChange={(updated) => {
              const newTiers = [...draft.tiers];
              newTiers[i] = updated;
              setDraft({ ...draft, tiers: newTiers });
            }}
          />
        ))}

        {validationError && (
          <Alert variant="destructive" className="py-2">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-sm">{validationError}</AlertDescription>
          </Alert>
        )}

        <Button
          onClick={handleSave}
          disabled={!isDirty || mutation.isPending}
          className="w-full"
        >
          <Save className="h-4 w-4 mr-2" />
          {mutation.isPending ? "Saving..." : "Save Configuration"}
        </Button>
      </CardContent>
    </Card>
  );
}
