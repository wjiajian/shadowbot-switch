---
name: shadowbot-run-diagnostics
description: Run a ShadowBot flow and diagnose the result using the run ID and logs.
---

Identify the requested app, flow and inputs using `studio-mcp`. Check the tool schema for the current installation before submitting a run. Keep the run ID returned by `app_run` and use it with `app_wait_run_finish`, `app_run_result`, and `app_logs` when those tools are available. Use `diagnostics_snapshot` for additional context when the logs are insufficient.

Describe the result recorded by the host. If the chat is cancelled while waiting, the flow may still be running. Check its status by run ID before starting it again.
