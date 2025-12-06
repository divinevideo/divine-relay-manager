#!/bin/bash
# ABOUTME: Script to disable pages.dev access for all Cloudflare Pages projects
# ABOUTME: Forces all traffic through custom domains (which should be behind Zero Trust)

set -e

# Configuration - UPDATE THESE
ACCOUNT_ID="${CF_ACCOUNT_ID:-}"
API_TOKEN="${CF_API_TOKEN:-}"

if [ -z "$ACCOUNT_ID" ] || [ -z "$API_TOKEN" ]; then
  echo "Error: Set CF_ACCOUNT_ID and CF_API_TOKEN environment variables"
  echo ""
  echo "Usage:"
  echo "  export CF_ACCOUNT_ID='your_account_id'"
  echo "  export CF_API_TOKEN='your_api_token'"
  echo "  ./disable-pages-dev.sh"
  echo ""
  echo "Get your Account ID from: Cloudflare Dashboard URL (the long hex string)"
  echo "Create API Token at: https://dash.cloudflare.com/profile/api-tokens"
  echo "  - Use 'Edit Cloudflare Workers' template or create custom with Pages:Edit permission"
  exit 1
fi

API_BASE="https://api.cloudflare.com/client/v4"

echo "Fetching all Pages projects..."
echo ""

# Get all Pages projects
response=$(curl -s -X GET "$API_BASE/accounts/$ACCOUNT_ID/pages/projects" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json")

# Check for errors
success=$(echo "$response" | jq -r '.success')
if [ "$success" != "true" ]; then
  echo "Error fetching projects:"
  echo "$response" | jq '.errors'
  exit 1
fi

# Get project names
projects=$(echo "$response" | jq -r '.result[].name')
project_count=$(echo "$projects" | wc -l | tr -d ' ')

echo "Found $project_count Pages projects"
echo "=================================="
echo ""

# Process each project
echo "$projects" | while read -r project_name; do
  if [ -z "$project_name" ]; then
    continue
  fi

  echo "→ Processing: $project_name"

  # Update project to disable pages.dev access for both preview and production
  update_response=$(curl -s -X PATCH "$API_BASE/accounts/$ACCOUNT_ID/pages/projects/$project_name" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    --data '{
      "deployment_configs": {
        "preview": {
          "pages_dev_access": {
            "type": "none"
          }
        },
        "production": {
          "pages_dev_access": {
            "type": "none"
          }
        }
      }
    }')

  update_success=$(echo "$update_response" | jq -r '.success')

  if [ "$update_success" == "true" ]; then
    echo "  ✓ Disabled pages.dev access"
  else
    echo "  ✗ Failed to update:"
    echo "$update_response" | jq '.errors'
  fi

  echo ""
done

echo "=================================="
echo "Done! All pages.dev URLs should now be disabled."
echo "Traffic will only be served via custom domains."
