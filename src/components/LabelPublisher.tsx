// ABOUTME: Form for creating kind 1985 labels (NIP-32)
// ABOUTME: Allows admins to label events/pubkeys with trust & safety categories

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/useToast";
import { Tag, Plus, X, UserX } from "lucide-react";
import { publishLabel, publishLabelAndBan, type LabelParams } from "@/lib/adminApi";

interface LabelPublisherProps {
  onSuccess?: () => void;
  defaultTarget?: { type: 'event' | 'pubkey'; value: string };
  defaultLabels?: string[];
  banOnPublish?: boolean;
}

/**
 * DTSP categories with severity levels:
 * - p0: Highest severity (CSAM, terrorism)
 * - p1: High severity (threats, doxxing, malware)
 * - p2: Medium severity (hate, illegal goods, violence)
 * - p3: Lower severity (NSFW, spam, copyright)
 */
const DTSP_CATEGORIES = [
  { value: 'csam', label: 'CSAM', severity: 'p0', namespace: 'dtsp' },
  { value: 'terrorism', label: 'Terrorism/Extremism', severity: 'p0', namespace: 'dtsp' },
  { value: 'credible_threats', label: 'Credible Threats', severity: 'p1', namespace: 'dtsp' },
  { value: 'doxxing', label: 'Doxxing/PII', severity: 'p1', namespace: 'dtsp' },
  { value: 'malware', label: 'Malware/Scam', severity: 'p1', namespace: 'dtsp' },
  { value: 'nonconsensual', label: 'Non-consensual Content', severity: 'p1', namespace: 'dtsp' },
  { value: 'hate', label: 'Hate/Harassment', severity: 'p2', namespace: 'dtsp' },
  { value: 'illegal_goods', label: 'Illegal Goods', severity: 'p2', namespace: 'dtsp' },
  { value: 'violence', label: 'Graphic Violence', severity: 'p2', namespace: 'dtsp' },
  { value: 'self_harm', label: 'Self-harm/Suicide', severity: 'p2', namespace: 'dtsp' },
  { value: 'nsfw', label: 'NSFW/Adult', severity: 'p3', namespace: 'content-warning' },
  { value: 'spam', label: 'Spam', severity: 'p3', namespace: 'ugc' },
  { value: 'impersonation', label: 'Impersonation', severity: 'p2', namespace: 'ugc' },
  { value: 'copyright', label: 'Copyright', severity: 'p3', namespace: 'legal' },
];

/**
 * Label namespaces per NIP-32:
 * - dtsp: Digital Trust & Safety Protocol (severe violations)
 * - content-warning: User preference labels (NSFW, spoilers)
 * - ugc: User-generated content flags (spam, impersonation)
 * - legal: Legal compliance labels (copyright, DMCA)
 * - custom: User-defined namespaces
 */
const NAMESPACES = [
  { value: 'dtsp', label: 'DTSP (Trust & Safety)' },
  { value: 'content-warning', label: 'Content Warning' },
  { value: 'ugc', label: 'UGC (User Generated Content)' },
  { value: 'legal', label: 'Legal' },
  { value: 'custom', label: 'Custom' },
];

export function LabelPublisher({ onSuccess, defaultTarget, defaultLabels, banOnPublish }: LabelPublisherProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);

  const [targetType, setTargetType] = useState<'event' | 'pubkey'>(defaultTarget?.type || 'pubkey');
  const [targetValue, setTargetValue] = useState(defaultTarget?.value || '');
  const [namespace, setNamespace] = useState('dtsp');
  const [customNamespace, setCustomNamespace] = useState('');
  const [selectedLabels, setSelectedLabels] = useState<string[]>(defaultLabels || []);
  const [customLabel, setCustomLabel] = useState('');
  const [comment, setComment] = useState('');
  const [shouldBan, setShouldBan] = useState(banOnPublish ?? false);

  const publishMutation = useMutation({
    mutationFn: async () => {
      const ns = namespace === 'custom' ? customNamespace : namespace;
      const params: LabelParams & { shouldBan?: boolean } = {
        targetType,
        targetValue,
        namespace: ns,
        labels: selectedLabels,
        comment,
        shouldBan: shouldBan && targetType === 'pubkey',
      };

      if (params.shouldBan) {
        return publishLabelAndBan(params);
      } else {
        await publishLabel(params);
        return { labelPublished: true, banned: false };
      }
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['labels'] });
      if (result.banned) {
        queryClient.invalidateQueries({ queryKey: ['banned-users'] });
        queryClient.invalidateQueries({ queryKey: ['banned-pubkeys'] });
        toast({ title: "Label published and user banned" });
      } else {
        toast({ title: "Label published successfully" });
      }
      setIsOpen(false);
      resetForm();
      onSuccess?.();
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to publish label",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const resetForm = () => {
    if (!defaultTarget) {
      setTargetValue('');
      setTargetType('pubkey');
    }
    if (!defaultLabels) {
      setSelectedLabels([]);
    }
    setComment('');
    setCustomLabel('');
    setShouldBan(false);
  };

  const addLabel = (label: string) => {
    if (label && !selectedLabels.includes(label)) {
      setSelectedLabels([...selectedLabels, label]);
    }
  };

  const removeLabel = (label: string) => {
    setSelectedLabels(selectedLabels.filter(l => l !== label));
  };

  const handleAddCustomLabel = () => {
    if (customLabel.trim()) {
      addLabel(customLabel.trim().toLowerCase());
      setCustomLabel('');
    }
  };

  const handleSubmit = () => {
    if (!targetValue.trim()) {
      toast({ title: "Please enter a target", variant: "destructive" });
      return;
    }
    if (selectedLabels.length === 0) {
      toast({ title: "Please select at least one label", variant: "destructive" });
      return;
    }
    if (namespace === 'custom' && !customNamespace.trim()) {
      toast({ title: "Please enter a custom namespace", variant: "destructive" });
      return;
    }
    publishMutation.mutate();
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4 mr-2" />
          Create Label
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tag className="h-5 w-5" />
            Create Label
          </DialogTitle>
          <DialogDescription>
            Publish a NIP-32 label for moderation purposes
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Target */}
          <div className="space-y-2">
            <Label>Target</Label>
            <div className="flex gap-2">
              <Select value={targetType} onValueChange={(v: 'event' | 'pubkey') => setTargetType(v)}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pubkey">Pubkey</SelectItem>
                  <SelectItem value="event">Event</SelectItem>
                </SelectContent>
              </Select>
              <Input
                value={targetValue}
                onChange={(e) => setTargetValue(e.target.value)}
                placeholder={targetType === 'pubkey' ? "Enter hex pubkey" : "Enter event ID"}
                className="flex-1 font-mono text-sm"
              />
            </div>
          </div>

          {/* Namespace */}
          <div className="space-y-2">
            <Label>Namespace</Label>
            <Select value={namespace} onValueChange={setNamespace}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NAMESPACES.map(ns => (
                  <SelectItem key={ns.value} value={ns.value}>{ns.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {namespace === 'custom' && (
              <Input
                value={customNamespace}
                onChange={(e) => setCustomNamespace(e.target.value)}
                placeholder="Enter custom namespace"
                className="mt-2"
              />
            )}
          </div>

          {/* Labels */}
          <div className="space-y-2">
            <Label>Labels</Label>
            <div className="flex flex-wrap gap-2 mb-2">
              {selectedLabels.map(label => (
                <Badge key={label} variant="secondary" className="cursor-pointer" onClick={() => removeLabel(label)}>
                  {label}
                  <X className="h-3 w-3 ml-1" />
                </Badge>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-1 max-h-32 overflow-y-auto border rounded-md p-2">
              {DTSP_CATEGORIES.map(cat => (
                <Button
                  key={cat.value}
                  variant={selectedLabels.includes(cat.value) ? "default" : "outline"}
                  size="sm"
                  className="text-xs justify-start"
                  onClick={() => selectedLabels.includes(cat.value) ? removeLabel(cat.value) : addLabel(cat.value)}
                >
                  {cat.label}
                </Button>
              ))}
            </div>
            <div className="flex gap-2 mt-2">
              <Input
                value={customLabel}
                onChange={(e) => setCustomLabel(e.target.value)}
                placeholder="Custom label"
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddCustomLabel())}
              />
              <Button variant="outline" size="sm" onClick={handleAddCustomLabel}>
                Add
              </Button>
            </div>
          </div>

          {/* Comment */}
          <div className="space-y-2">
            <Label>Comment (optional)</Label>
            <Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Add context for this label..."
              rows={2}
            />
          </div>

          {/* Ban option */}
          {targetType === 'pubkey' && (
            <div className="flex items-center space-x-2">
              <Checkbox
                id="shouldBan"
                checked={shouldBan}
                onCheckedChange={(checked) => setShouldBan(checked === true)}
              />
              <Label htmlFor="shouldBan" className="flex items-center gap-1 text-sm cursor-pointer">
                <UserX className="h-4 w-4" />
                Also ban this pubkey from relay
              </Label>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setIsOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={publishMutation.isPending}>
            {publishMutation.isPending ? 'Publishing...' : 'Publish Label'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Inline form version for embedding in other components
export function LabelPublisherInline({
  targetType,
  targetValue,
  onSuccess,
  onCancel,
}: {
  targetType: 'event' | 'pubkey';
  targetValue: string;
  onSuccess?: () => void;
  onCancel?: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [shouldBan, setShouldBan] = useState(false);

  const publishMutation = useMutation({
    mutationFn: async () => {
      const params: LabelParams & { shouldBan?: boolean } = {
        targetType,
        targetValue,
        namespace: 'dtsp',
        labels: selectedLabels,
        shouldBan: shouldBan && targetType === 'pubkey',
      };

      if (params.shouldBan) {
        return publishLabelAndBan(params);
      } else {
        await publishLabel(params);
        return { labelPublished: true, banned: false };
      }
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['labels'] });
      if (result.banned) {
        queryClient.invalidateQueries({ queryKey: ['banned-users'] });
        queryClient.invalidateQueries({ queryKey: ['banned-pubkeys'] });
        toast({ title: "Label published and user banned" });
      } else {
        toast({ title: "Label published" });
      }
      onSuccess?.();
    },
    onError: (error: Error) => {
      toast({ title: "Failed", description: error.message, variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Quick Label</CardTitle>
        <CardDescription className="text-xs font-mono">
          {targetType}: {targetValue.slice(0, 16)}...
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-1">
          {DTSP_CATEGORIES.slice(0, 8).map(cat => (
            <Badge
              key={cat.value}
              variant={selectedLabels.includes(cat.value) ? "default" : "outline"}
              className="cursor-pointer text-xs"
              onClick={() =>
                selectedLabels.includes(cat.value)
                  ? setSelectedLabels(selectedLabels.filter(l => l !== cat.value))
                  : setSelectedLabels([...selectedLabels, cat.value])
              }
            >
              {cat.label}
            </Badge>
          ))}
        </div>

        {targetType === 'pubkey' && (
          <div className="flex items-center space-x-2">
            <Checkbox
              id="quickBan"
              checked={shouldBan}
              onCheckedChange={(checked) => setShouldBan(checked === true)}
            />
            <Label htmlFor="quickBan" className="text-xs cursor-pointer">Also ban user</Label>
          </div>
        )}

        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => publishMutation.mutate()}
            disabled={selectedLabels.length === 0 || publishMutation.isPending}
          >
            {publishMutation.isPending ? '...' : 'Label'}
          </Button>
          {onCancel && (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
