# Formal Mind for iPhone: App Store listing

Everything App Store Connect asks for, ready to paste. Character limits are Apple's; each field here fits its limit.
Screenshots are in `screenshots/` beside this file (6.9" iPhone, 1320 × 2868): upload `01`–`10` in order (setup first, then the app): `iphone-6.3/` (1206 × 2622 JPEG) for the 6.1"/6.3" slot, `iphone-6.9/` (1320 × 2868 JPEG, no alpha) for the 6.9" slot. The PNGs are the sources; `more/` holds spares.

## App Information (App Store Connect → App Information)

| Field | Value |
|---|---|
| Name (30) | Formal Mind |
| Subtitle (30) | Proofs and bugs for Solidity |
| Primary category | Developer Tools |
| Secondary category | Productivity |
| Content rights | Does not contain, show or access third-party content |
| Age rating | 4+ (answer "No" to every question) |

## Pricing and Availability

Free, all territories.

## Version 0.1.0 (App Store Connect → iOS App → 0.1.0 Prepare for Submission)

**Promotional text (170)**

> Follow the agents proving your Solidity contracts, read their Lean proofs and the bugs they file, and steer the swarm on your Mac from your phone.

**Description (4000)**

> Formal Mind proves Solidity correct. It writes what your contracts do as Lean theorems, proves them, and files the bugs it finds, each with a proof of concept. Formal Mind for iPhone puts all of that in your pocket.
>
> PROOFS
> See every contract's proof coverage at a glance: which functions are proved, which are modeled but not proved yet, and which the model leaves out. Open any function to read its Solidity beside the theorems that prove it, and every theorem in its Lean source.
>
> BUGS
> Read the findings from your audits and from the swarm: their severity, where they stand in the code today, and the Foundry test that demonstrates each one.
>
> CODE
> Browse your repositories with syntax highlighting for Solidity and Lean. Markdown renders with its images, and Solidity files show the compiler's errors and warnings in place. Pull down to get the latest commit from GitHub.
>
> YOUR MAC'S SWARM
> The swarm runs in Formal Mind on your Mac, where Lean and Foundry live. From your phone you can follow what each agent is doing, send it a message, and start, stop or resume a session. Sign in with the same account on both and your Mac shows up here by name.
>
> CHAT
> Ask Formal Mind about a project: what it does, where an audit should start, how a Lean proof checks a Solidity function.
>
> NOTIFICATIONS
> Hear when a proof lands, a bug is filed, or a session reaches its budget.
>
> Formal Mind for iPhone is free. Agents run on your formal.team credits or your own Anthropic key on the Mac.

**Keywords (100)**

> solidity,lean,formal verification,smart contract,audit,ethereum,proof,security,foundry,evm

**Support URL**: https://formal.team/support

**Marketing URL**: https://formal.team

**Copyright**: 2026 Asyncswap Labs, Inc.

## App Privacy (App Store Connect → App Privacy)

Privacy Policy URL: https://formal.team/privacy/

Data collected, all **linked to the user**, none used for tracking:

| Data type | Why |
|---|---|
| Contact Info → Email Address | App Functionality (the account, from GitHub sign-in) |
| Contact Info → Name | App Functionality (shown in Settings) |
| Identifiers → User ID | App Functionality (the account) |
| User Content → Other User Content | App Functionality (chat messages sent to Formal Mind and to your Mac's swarm) |

Not collected: location, contacts, health, financial info, browsing history, purchases, diagnostics, usage data,
advertising data. No third-party SDKs and no tracking.

## App Review Information

**Sign-in required**: yes, by a review code instead of GitHub. Set it once on the Worker with
`bunx wrangler secret put APP_REVIEW_CODE` (16 to 64 letters, digits, `-` or `_`), then put the same code in App Store
Connect: User name `App Review`, Password the code. It signs in as a demo account (no GitHub, no Mac). Change the
secret to revoke it.

**Notes**

> Formal Mind for iPhone reads a project's code, Lean proofs and audit findings from its GitHub repository, and lets you follow and steer the agent swarm that runs in Formal Mind for Mac.
>
> To review: on the first screen tap "Have a code?", enter the password above and tap Continue. Tap Skip on setup, then on Home tap "Add a project" and enter asyncswap/contracts (a public repository). Code, Proofs and Bugs show its contracts, its Lean proofs and its audit findings. Chat answers questions about it. The "Your Mac" screens need Formal Mind running on a Mac with the same account; without one they explain how to connect it.

## Export compliance

Answered by the build: `ITSAppUsesNonExemptEncryption = false` (mobile/src-tauri/Info.ios.plist). The app uses no
encryption beyond HTTPS through Apple's frameworks and the Keychain.

## Before submitting for review

- Sign in with Apple must be offered beside GitHub (guideline 4.8).
- An in-app way to delete the account (guideline 5.1.1(v)).
