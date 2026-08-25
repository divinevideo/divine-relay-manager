# Protected-minor edge authentication

## Decision and ownership

Funnelcake authenticates to Relay Manager's protected-minor service with two independent credentials:

1. A dedicated Cloudflare Access service token at the edge, sent as `CF-Access-Client-Id` and `CF-Access-Client-Secret`.
2. The environment-specific `PROTECTED_MINOR_SERVICE_TOKEN` bearer credential, verified by the Worker.

Divine's Cloudflare Zero Trust administrators own the Access applications, policies, service-token lifecycle, and audit logs. The Funnelcake platform deployment owner owns delivery of all three credential values to the caller. Relay Manager owns the Worker bearer check and this contract.

Caller support is tracked in divinevideo/divine-funnelcake#1134. Secret delivery and activation-contract updates are tracked in divinevideo/divine-iac-coreconfig#1908; environment activation remains in divinevideo/divine-iac-coreconfig#1897.

The Access application must be path-scoped. A more-specific path application takes precedence over the hostname-wide moderator application without inheriting its policies. Never add this Service Auth policy to the hostname-wide application, and never use a Bypass policy for this integration. Those configurations would violate least privilege and remove an authentication layer.

Cloudflare Access is managed in the Zero Trust dashboard rather than this repository. This runbook is the durable source of truth for the manual configuration.

## Environment configuration

Configure staging before production. Use a separate Access application and service token in each environment so either can be rotated or revoked independently.

| Environment | Access application name | Application domain | Application path | Service token name |
| --- | --- | --- | --- | --- |
| Staging | `Relay Manager protected deletion - staging` | `api-relay-staging.divine.video` | `/api/internal/protected-minors/*` | `Funnelcake protected deletion - staging` |
| Production | `Relay Manager protected deletion - production` | `api-relay-prod.divine.video` | `/api/internal/protected-minors/*` | `Funnelcake protected deletion - production` |

For each environment:

1. Inspect the hostname-wide moderator application's policies before creating the new token. It must not use the **Any Access Service Token** selector, and none of its policies may include the protected-deletion token. Before replacing a broad selector, inventory its current machine callers in the approved operational record and preserve the previous policy for rollback. After narrowing to the explicit approved moderator service tokens, verify every known machine caller still succeeds; restore the previous policy and stop if any caller fails.
2. Create the named Access service token under **Access controls → Service credentials → Service Tokens**. Set an explicit expiry approved by the platform owner.
3. Store the client ID and client secret through the approved secret-management process. Do not paste either value into issues, pull requests, commands recorded in shell history, logs, screenshots, or verification notes.
4. Create a self-hosted Access application with the exact domain and path above.
5. Attach one policy with action **Service Auth**, including only the named service token.
6. Confirm the path-specific application is the application selected for a protected-minor URL. Cloudflare evaluates the more-specific application instead of the hostname-wide moderator application; policy ordering within the hostname-wide application does not provide this boundary.
7. Configure Funnelcake with both Access headers and the Worker bearer. The Access pair is all-or-nothing: either both values are present or startup must fail. Do not activate an environment until all three values are available.

## Verification

Use a full-length synthetic lowercase-hex pubkey that is known not to be protected. Supply credentials as environment variables from an approved secret-injection mechanism; do not type literal values into the command or enable shell tracing.

```bash
RESPONSE_HEADERS_FILE="$(mktemp)"
RESPONSE_BODY_FILE="$(mktemp)"

curl --silent --show-error \
  --output "$RESPONSE_BODY_FILE" \
  --dump-header "$RESPONSE_HEADERS_FILE" \
  --request POST "$RELAY_MANAGER_URL/api/internal/protected-minors/resolve" \
  --header "CF-Access-Client-Id: $RELAY_MANAGER_ACCESS_CLIENT_ID" \
  --header "CF-Access-Client-Secret: $RELAY_MANAGER_ACCESS_CLIENT_SECRET" \
  --header "Authorization: Bearer $RELAY_MANAGER_SERVICE_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{"pubkey":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'

head -n 1 "$RESPONSE_HEADERS_FILE"
rg -i '^content-type: application/json(?:;|\r?$)' "$RESPONSE_HEADERS_FILE"
jq -e 'keys == ["classification"] and .classification == "none"' "$RESPONSE_BODY_FILE"
rm -f "$RESPONSE_HEADERS_FILE" "$RESPONSE_BODY_FILE"
```

Record only the environment, timestamp, HTTP status, JSON content type, and `classification: none`. An HTTP 200 containing HTML is an Access interstitial and is not success.

Also verify these negative cases without recording response bodies that may contain provider details:

| Credentials supplied | Required result |
| --- | --- |
| Access token and Worker bearer | Worker returns HTTP 200 JSON with `classification: none` |
| Access token only | Worker returns HTTP 401 JSON with `error: unauthorized` |
| Worker bearer only | Request does not reach the Worker's determinate JSON contract |
| Neither credential | Request does not reach the Worker's determinate JSON contract |
| Access token sent to an unrelated moderator route | Access denies the request |

The exact unauthenticated status can vary with Access request handling. The invariant is that unauthenticated traffic cannot produce a valid Worker response.

## Rotation

Rotate one environment at a time. Create a replacement Access service token and temporarily include both the old and replacement tokens in the application's Service Auth policy. Update both caller values together, restart Funnelcake, and repeat the positive and negative verification matrix before removing and deleting the old token.

Rotate `PROTECTED_MINOR_SERVICE_TOKEN` separately. The Worker accepts only one bearer value, so there is no dual-token overlap window: disable the affected Funnelcake component, update the Cloudflare Secrets Store and Funnelcake values, restart Funnelcake, then re-enable it only after the positive verification passes. Requests made while the values differ fail closed with HTTP 401.

Never log or retrieve secret values for comparison. Confirm secret versions, synchronization status, workload readiness, and the functional request instead.

## Rollback

Disable the protected-minor resolution component in the affected Funnelcake environment so no deletion enters the protected-deletion path. Do not weaken Access, switch to Bypass, or remove only one credential.

After the caller is disabled, revoke the environment's dedicated Access service token if the edge identity must be invalidated. Keep the path-scoped Access application in deny-by-default state and retain the Worker bearer binding. Re-enable only after the caller configuration and verification matrix pass again.
