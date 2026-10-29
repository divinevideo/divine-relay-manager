# Synthetic reviewer UI captures

Before source: `ddf6da544feab172bcb57a0f8d697cb1ba6e38f7` in an isolated detached worktree.
After source: `93623731a92abf2234d403eb5b12120c8aeb5b8a`.
The artifact commit adds only these captures and their provenance. Later worker-only policy fixes leave the captured UI source unchanged.

Captured with Playwright and headless Google Chrome in a new browser context,
light theme, 1440×1280 desktop and 390×1000 mobile viewports. Capture command:
`node /tmp/sexual-quarantine-ui-capture.mjs` (preinstalled browser runtime, no
repository dependency changes). Each revision ran in its own local Vite process
and working directory so Tailwind compiled the correct source revision.

The old entry point is `/reports`; the new screen is `/sexual-quarantine`.
Open the synthetic full-ID case to reach its detail view. The browser intercepts
all API calls with synthetic fixtures and blocks other external requests and
WebSockets. No production account, credential, case, media, or end-user data was
loaded. IDs use repeated hexadecimal fixture characters; there is no sexual media.

The exercise verified Restore is disabled without a reason, submits the viewed
revision with the reason, and shows the verified remaining-restrictions outcome.
Empty and service-error responses were captured separately. Every image was
visually inspected. The base screenshots show the previous entry point because
this case workflow did not exist in the base revision.

| Before | After |
| --- | --- |
| ![Before desktop entry point](before-desktop.png) | ![After desktop queue](after-queue-desktop.png) |
| ![Before mobile entry point](before-mobile.png) | ![After mobile queue](after-queue-mobile.png) |

![Pending verification detail](after-pending-desktop.png)
![Restore with remaining restrictions](after-restricted-desktop.png)
![Empty queue](after-empty-desktop.png)
![Service error](after-error-desktop.png)
