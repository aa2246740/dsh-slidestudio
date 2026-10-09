# Local data handling

Applies to native editor/Hub, standalone plugin, archived web and legacy API.

| Data                                       | Storage/flow                                                                        | Handling                                                                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt, discussion and slide text          | Local PPTD and durable conversation; selected provider during a user-initiated run  | Treat as private content. Use synthetic/public fixtures for QA. Ask for explicit consent before provider QA.                                  |
| Attachments, images and generated exports  | Local project/media/output directories; selected tools/providers when the user asks | May contain names, addresses, phone numbers, faces or confidential work. Do not put them into logs, telemetry or Git.                         |
| API keys, OAuth grants and cookies         | Isolated local Harness home; existing supplier-scoped auth                          | Never copy credentials between profiles or include them in evidence.                                                                          |
| Local project paths and session identities | User-owned filesystem/state                                                         | Keep them out of metrics labels, logs and shared screenshots.                                                                                 |
| Operational diagnostics                    | Bounded memory in the local process/browser only                                    | Retain categorical event/status/timing and opaque request IDs. No prompt, body, query, attachment, persistent user ID or analytics transport. |

Node diagnostics mask private keys, email addresses, Chinese mobile numbers,
home-directory paths and common tokens. Provider error messages can contain
arbitrary user content, so diagnostics retain only categorical error metadata
and a fingerprint, never the raw provider message or stack. Browser loggers use
an allowlist and discard everything outside categorical operational fields.
These masks reduce accidental exposure; they are not general-purpose DLP and
do not make user documents anonymous.

Never export a raw environment, credential file or full conversation to diagnose
a fault. Prefer a request ID and synthetic reproduction. Review CPU profiles,
screenshots, advisory reports and local diagnostic snapshots before sharing.
There is no configured external APM, product analytics, user tracking or
error-to-ticket upload. Connecting one requires a data-flow/privacy review.

User work persists until the user deletes it or explicitly configures existing
retention. The new diagnostics do not delete projects or alter retention. To
remove personal data, delete the appropriate project with the product's existing
project-delete flow and review its exports/attachments. A restart clears process
diagnostics; closing the page clears browser diagnostics. Neither action erases
the user's presentation.
