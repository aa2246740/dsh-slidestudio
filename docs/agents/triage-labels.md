# Triage Labels

The skills speak in terms of five canonical triage roles. In this repo's
tracker they live as predefined options on the `标签` multi-select field of
the `tickets` Feishu Base table.

| Label in mattpocock/skills | Option in `标签` field | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

Apply them via `node scripts/feishu-ticket.mjs create|update … --labels a,b`.
Add a new option on the Base field first if a new label is ever needed, then
update this table.
