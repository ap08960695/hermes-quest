# Operator deployment gate

`tools/post_deploy_check.py` is an explicitly invoked operator helper, not plugin runtime code or an updater.
It checks the installed SHA/clean tree, unauthenticated API 401s, authenticated Quest page and Desktop bootstrap
(when shipped), then three chained replay/events rounds ten seconds apart. Cursor limits remain enforced.
On failure it detaches the supplied rollback SHA, restarts the user dashboard service and verifies rollback;
exit 1 still means the candidate failed. Exit 2 means preflight/configuration or rollback failed.
`--check-only` never checks out, restarts or edits credentials. JSONL logs contain fixed check codes and metrics,
not response contents, credentials or subprocess output.

## Authentication file

Supply `--auth-file /path/to/private-auth.env` (or `QUEST_AUTH_FILE`). The file must be a regular non-symlink
owned by the operator, with no group/other permissions (use mode 0600). Keep it outside the repository.
Choose exactly one method; never put credentials in command arguments or publish this file:

- `QUEST_AUTH_COOKIE='...'`: the complete Cookie header from an ordinary authenticated public-host session.
  Include the access cookie and its provider cookie as issued by the host. Obtain it through the dashboard's
  normal login flow, never by constructing claims/signatures yourself.
- `QUEST_AUTH_TOKEN='...'`: an ordinary host-issued bearer token, without the `Bearer ` prefix.
- `HERMES_DASHBOARD_BASIC_AUTH_USERNAME='...'` and `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD='...'`: the helper
  POSTs JSON with `provider: basic`, username and password to the public `/auth/password-login` endpoint
  and forwards the returned session cookies unchanged. This supports the dashboard Basic password form;
  use a host-issued session/token for other providers or a token-only host.

Signing secrets and password hashes are not authentication inputs: unrelated fields are ignored without
parsing their values. A file with only a username, password hash and signing configuration cannot authenticate.
An expired/revoked session fails the normal authenticated checks. No provider is created or imported.
The helper bypasses environment proxies and refuses redirects, including login redirects, so credentials
are never forwarded to redirect targets. Use only a trusted dashboard URL; prefer HTTPS outside loopback.

```bash
python3 tools/post_deploy_check.py --plugin-dir "$PLUGIN_DIR" --expected-sha "$CANDIDATE_SHA" \
  --rollback-sha "$BEFORE" --base-url "$BASE_URL" --auth-file "$AUTH_FILE"
```

For a non-mutating inspection of the currently installed revision:

```bash
python3 tools/post_deploy_check.py --plugin-dir "$PLUGIN_DIR" --expected-sha "$INSTALLED_SHA" \
  --base-url "$BASE_URL" --auth-file "$AUTH_FILE" --check-only
```

The installed revision must match `--expected-sha`; running a new helper against an older installation does
not verify the new candidate's runtime. A bootstrap 200 or synthetic SDK harness pass is not a real Desktop
playtest. Run synthetic helper regressions with `python3 tools/test_post_deploy_check.py -v`.
