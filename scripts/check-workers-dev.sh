#!/bin/bash
# ABOUTME: Check which Workers have workers.dev subdomain enabled
# ABOUTME: Lists all workers with their subdomain status

ACCOUNT_ID="c84e7a9bf7ed99cb41b8e73566568c75"
API_TOKEN="GYtPyfJsoUh0BL2AM4LTpCe_CYKuNNrJNYY7UdRE"

echo "Fetching workers..."
workers=$(curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts" \
  -H "Authorization: Bearer $API_TOKEN" | jq -r '.result[] | .id')

echo ""
echo "Workers with workers.dev ENABLED:"
echo "================================="

for worker in $workers; do
  result=$(curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/$worker/subdomain" \
    -H "Authorization: Bearer $API_TOKEN")
  enabled=$(echo "$result" | jq -r '.result.enabled // false')
  if [ "$enabled" = "true" ]; then
    echo "  $worker.protestnet.workers.dev"
  fi
done

echo ""
echo "Done."
