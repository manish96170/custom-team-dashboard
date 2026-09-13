-- 0015_mcp_pool_lstart.sql — persist process start time for pooled MCP processes.
--
-- review-sol-2026-09-13.md finding 1 (critical): boot reconciliation verified only pid+pgid before
-- killing a pool's process group. After PID/PGID reuse (a real, if rare, OS event — the same risk
-- `runs.proc_lstart`, migration 0002, already exists to close for regular runs) that kill can hit a
-- completely unrelated process. `procinfo.js`'s `verifyProcIdentity()` already requires pid+pgid+lstart
-- for exactly this reason; `mcp_pool` never had anywhere to put the third field.
ALTER TABLE mcp_pool ADD COLUMN lstart TEXT;
