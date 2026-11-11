// ABOUTME: The warning shown over a post whose author is not the account under review, so it
// ABOUTME: is never read as that account's content. Shared by age review and the suspended viewer.

import { CopyableId } from "@/components/CopyableId";

/**
 * Stated as a fact about the author rather than an accusation: a client quirk
 * (a report naming a repost's original, say) is likelier than bad faith.
 * `subject` names the account under review, as the screen calls it.
 */
export function ForeignAuthorWarning({ author, subject = "this case's subject" }: { author: string; subject?: string }) {
  return (
    <div className="rounded-md border border-amber-500/40 p-2.5 text-xs text-amber-700 dark:text-amber-400">
      This post was authored by{" "}
      <CopyableId value={author} type="hex" className="text-amber-700 dark:text-amber-400" />, not by {subject}. Do not
      judge this account by it without confirming the connection.
    </div>
  );
}
