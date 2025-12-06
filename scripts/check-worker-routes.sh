#!/bin/bash
# ABOUTME: Check custom domain routes for all workers
# ABOUTME: Shows which workers have custom domains vs only workers.dev

ACCOUNT_ID="c84e7a9bf7ed99cb41b8e73566568c75"
API_TOKEN="GYtPyfJsoUh0BL2AM4LTpCe_CYKuNNrJNYY7UdRE"

echo "Fetching all zones (domains)..."
zones=$(curl -s "https://api.cloudflare.com/client/v4/zones?account.id=$ACCOUNT_ID&per_page=50" \
  -H "Authorization: Bearer $API_TOKEN" | jq -r '.result[] | "\(.id):\(.name)"')

echo "Fetching worker routes for each zone..."
echo ""

declare -A worker_routes

# Get routes from each zone
for zone_info in $zones; do
  zone_id=$(echo "$zone_info" | cut -d: -f1)
  zone_name=$(echo "$zone_info" | cut -d: -f2)

  routes=$(curl -s "https://api.cloudflare.com/client/v4/zones/$zone_id/workers/routes" \
    -H "Authorization: Bearer $API_TOKEN" | jq -r '.result[] | "\(.script)|\(.pattern)"' 2>/dev/null)

  if [ -n "$routes" ]; then
    while IFS= read -r route; do
      script=$(echo "$route" | cut -d'|' -f1)
      pattern=$(echo "$route" | cut -d'|' -f2)
      if [ -n "$script" ] && [ "$script" != "null" ]; then
        echo "$script|$pattern"
      fi
    done <<< "$routes"
  fi
done | sort | uniq > /tmp/worker_routes.txt

echo "=========================================="
echo "WORKERS WITH CUSTOM DOMAINS:"
echo "=========================================="
echo ""

# Get all workers with workers.dev enabled
workers=$(curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts" \
  -H "Authorization: Bearer $API_TOKEN" | jq -r '.result[] | .id')

for worker in $workers; do
  # Check workers.dev status
  wd_enabled=$(curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/$worker/subdomain" \
    -H "Authorization: Bearer $API_TOKEN" | jq -r '.result.enabled // false')

  # Find custom routes for this worker
  custom_routes=$(grep "^$worker|" /tmp/worker_routes.txt | cut -d'|' -f2 | tr '\n' ', ' | sed 's/,$//')

  if [ -n "$custom_routes" ] || [ "$wd_enabled" = "true" ]; then
    echo "Worker: $worker"
    if [ "$wd_enabled" = "true" ]; then
      echo "  workers.dev: ✓ $worker.protestnet.workers.dev"
    else
      echo "  workers.dev: ✗ disabled"
    fi
    if [ -n "$custom_routes" ]; then
      echo "  custom routes: $custom_routes"
    else
      echo "  custom routes: (none)"
    fi
    echo ""
  fi
done

rm -f /tmp/worker_routes.txt
echo "Done."
