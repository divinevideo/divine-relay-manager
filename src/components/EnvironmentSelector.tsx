// ABOUTME: Environment selector component for switching between staging and production
// ABOUTME: Atomically updates both relayUrl and apiUrl to ensure they stay in sync

import { Check, ChevronsUpDown, Server } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppContext } from "@/hooks/useAppContext";
import { environments, getCurrentEnvironment, type Environment } from "@/lib/environments";
import { Badge } from "@/components/ui/badge";

interface EnvironmentSelectorProps {
  className?: string;
}

export function EnvironmentSelector({ className }: EnvironmentSelectorProps) {
  const { config, updateConfig } = useAppContext();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const currentEnvironment = getCurrentEnvironment(config.relayUrl, config.apiUrl);

  const switchEnvironment = (env: Environment) => {
    updateConfig(c => ({
      ...c,
      relayUrl: env.relayUrl,
      apiUrl: env.apiUrl,
    }));
    // Clear and refetch all queries to force fresh data for new environment
    queryClient.clear();
    queryClient.refetchQueries();
    setOpen(false);
  };

  // Determine badge variant based on environment
  const getBadgeVariant = (envId: string): "default" | "secondary" | "destructive" | "outline" => {
    if (envId === 'production') return 'destructive';
    if (envId === 'legacy') return 'outline';
    return 'secondary';
  };

  // Get badge label for environment
  const getBadgeLabel = (envId: string): string => {
    if (envId === 'production') return 'PROD';
    if (envId === 'staging') return 'STG';
    if (envId === 'legacy') return 'LEGACY';
    return envId.toUpperCase();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("justify-between", className)}
        >
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4" />
            <span className="truncate">
              {currentEnvironment?.name || 'Custom'}
            </span>
            {currentEnvironment && (
              <Badge variant={getBadgeVariant(currentEnvironment.id)} className="ml-1 text-xs">
                {getBadgeLabel(currentEnvironment.id)}
              </Badge>
            )}
          </div>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0">
        <Command>
          <CommandList>
            <CommandGroup heading="Environments">
              {environments.map((env) => (
                <CommandItem
                  key={env.id}
                  value={env.id}
                  onSelect={() => switchEnvironment(env)}
                  className="cursor-pointer"
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      currentEnvironment?.id === env.id ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <div className="flex flex-col flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{env.name}</span>
                      <Badge variant={getBadgeVariant(env.id)} className="text-xs">
                        {getBadgeLabel(env.id)}
                      </Badge>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {env.relayUrl.replace(/^wss?:\/\//, '')}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        {!currentEnvironment && (
          <div className="p-2 border-t">
            <p className="text-xs text-muted-foreground">
              Custom configuration detected. Select an environment to sync relay and API.
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
