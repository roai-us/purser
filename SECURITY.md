# Security policy

ROAI Purser holds AI provider keys and controls whether agents may run. We treat
security reports as our top priority.

## Reporting a vulnerability

Email **admin@roai.us**, or use GitHub's private vulnerability reporting on this
repository (the "Report a vulnerability" button under the Security tab).

Please include:

- what you found and where (file, endpoint or version)
- steps to reproduce, or a proof of concept
- the impact as you understand it

Do not open a public issue, pull request or discussion about an unfixed vulnerability.

## What to expect

- We acknowledge your report within 3 business days.
- We send an assessment and a planned fix date within 10 business days.
- We credit you in the release notes, if you want credit.

## Supported versions

Purser is in early development. Until 1.0, only the latest release on the `main`
branch receives security fixes.

## Scope

These matter most to us:

- reading or extracting provider keys
- using an agent key to reach the admin API, change limits or avoid a kill switch
- bypassing spend caps, rate limits or allowlists
- reaching the server from the network when it is bound to localhost
- tampering with the audit log without detection
