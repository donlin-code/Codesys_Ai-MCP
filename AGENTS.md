# Contributor and operator rules

Read docs/acceptance.md and workflows/ANALYZE.md and EDIT.md. Use fresh isolated test copies. Present actual engineering batch diffs and obtain confirmation for the exact plan hash before writes; reread immediately before each write. Stop on unknown/failed writes and reconcile first. Compilation, saving, reopening and behavior are separate. Never package live IPC, bootstrap, nonce, session files or user projects. No PLC download/start/force tools. Test with npm ci and npm test; Python contracts: python tests/sp20-bridge-contract.py.
