// ABOUTME: App-wide notice for a write the worker refused because it carried no
// ABOUTME: verified Divine login (moderator_login_required). Offers sign-in.
//
// One prompt for every write path: the API client announces the refusal
// (lib/moderatorLoginRequired) and this, mounted once at the app root, shows.
// The screen that ran the action still shows its own error, which reads the
// same plain message.
//
// A Radix AlertDialog, not a fixed banner or a toast. Most refusals happen
// inside a confirm dialog, which stays open after a failed action, and a Radix
// modal makes everything outside it unclickable (body pointer-events: none),
// aria-hidden, and out of keyboard reach (its focus trap). A dialog opened over
// it becomes the top layer: it gets pointer events, hides the dialog beneath
// instead, and pauses that dialog's focus trap, which resume when this closes.
// Not a toast either: the toaster shows one at a time, so the screen's own
// error toast would replace it.
//
// Never retries the action. Sign-in redirects away, and the moderator runs the
// action again once back, against whatever they then see.
//
// Not hidden for a session that looks signed in: a revoked or no longer
// honoured login is refused too, and signing in again is the fix.
import { useEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useStartSignIn } from '@/hooks/useStartSignIn';
import {
  MODERATOR_LOGIN_REQUIRED_MESSAGE,
  subscribeModeratorLoginRequired,
} from '@/lib/moderatorLoginRequired';

export function LoginRequiredPrompt() {
  const [open, setOpen] = useState(false);
  const handleSignIn = useStartSignIn();
  // Where focus was when the prompt opened. Opened from code, the prompt has
  // no trigger, so Radix would return focus to <body> on close and a keyboard
  // or screen reader user would lose their place (the confirm button, or the
  // button that ran the action).
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => subscribeModeratorLoginRequired(() => setOpen(true)), []);

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent
        onOpenAutoFocus={() => {
          // Fires before Radix moves focus in, so this is still the element
          // that had it at the refusal.
          returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef.current;
          returnFocusRef.current = null;
          if (target) {
            // Radix's own handler, skipped once this prevents it, would focus
            // the dialog's trigger. There is none today, so that does nothing,
            // but taking over focus is what preventDefault is for here. An
            // element removed meanwhile ignores focus(), leaving <body>.
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{MODERATOR_LOGIN_REQUIRED_MESSAGE}</AlertDialogTitle>
          <AlertDialogDescription>Sign in, then try the action again.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Dismiss</AlertDialogCancel>
          <AlertDialogAction onClick={handleSignIn}>Sign in</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
