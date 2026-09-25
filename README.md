# belltower
A harness built on Claude Code for running projects with many sessions. Long-lived tower sessions each own one area. Towers ring each other's doorbell (a trigger that wakes the other session in seconds) and leave the details on a shared git ledger. They dispatch short-lived workers to do the work; finished workers are archived automatically.
