# Supabase external coordinator trigger — owner action

Production must remain `COLLECTION_MODE=paused` until the staged acceptance completes.

1. Create a fine-grained GitHub token with:
   - owner/repository: only `ilishenkoiv/NextOut-price-etl`;
   - repository permission: **Actions — Read and write**;
   - **Metadata — Read**;
   - shortest practical expiration;
   - no organization, account-administration or other repository permissions.
2. Store it directly in Supabase Dashboard **Vault** as
   `nextout_github_workflow_dispatch_token`. Do not paste the value into Codex, chat, SQL,
   source files, workflow inputs or logs.
3. In Supabase SQL Editor, run the complete reviewed file
   `scripts/install-supabase-external-trigger.sql` once. Its transaction fails closed unless
   `pg_cron`, `pg_net`, Vault, exactly one named Vault secret and the no-duplicate-trigger check pass.
4. Return only the non-secret final row: `jobid`, `jobname`, `schedule`, `active`, plus confirmation
   that the transaction committed. Do not return the token or Vault decrypted output.

Rollback is `scripts/rollback-supabase-external-trigger.sql`. It removes only the job named
`nextout-etl-coordinator-dispatch-5m` and `public.nextout_dispatch_etl_coordinator()`; it does not
touch collection data or checkpoints.
