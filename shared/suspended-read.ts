// ABOUTME: The refusal code the worker returns when relay-rpc would expose a suspended account's content.
// ABOUTME: Shared so the client can recognise the refusal by code rather than by message text.

// /api/relay-rpc answers 403 with this code when a caller asks for one of the
// relay's suspended-account reads, or for a banned event whose author is
// suspended. Retrying never changes the answer while the suspension stands.
export const SUSPENDED_READ_REFUSED = 'suspended_read_not_allowed';
