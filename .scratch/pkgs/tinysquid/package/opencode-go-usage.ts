/**
 * OpenCode Go usage: footer status line + usage table for the OpenCode Go plan.
 *
 * Data comes from opencode.ai's console API:
 *
 *   GET https://opencode.ai/console/api/go/status
 *   Cookie: __Host-console_session=st_…
 *   x-org-id: <wrk_… org id>
 *
 * The response carries `access.meters` with per-window limits, usage, and
 * reset timestamps. The extension reports percentages and countdowns only.
 */

export { default } from "./src/extension.ts";
