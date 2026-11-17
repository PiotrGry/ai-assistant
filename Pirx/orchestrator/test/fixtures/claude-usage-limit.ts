/**
 * A real Claude Code 2.1.319 record from a `claude -p` run (entrypoint sdk-cli)
 * that hit the 5-hour limit on 2026-11-10 at 11:36:57Z. Identifiers that point
 * at the session (uuids, request id, session id, cwd, branch) are removed;
 * every other field is unchanged. resetsAt 1794323400 is 2026-11-10T15:10:00Z,
 * which is 4:10pm in Europe/Warsaw, as the text says.
 */
export const REAL_FIVE_HOUR_LIMIT_RECORD =
{
  "isSidechain": false,
  "type": "assistant",
  "timestamp": "2026-11-10T11:36:57.494Z",
  "message": {
    "diagnostics": null,
    "container": null,
    "model": "<synthetic>",
    "role": "assistant",
    "stop_details": null,
    "stop_reason": "stop_sequence",
    "stop_sequence": "",
    "type": "message",
    "usage": {
      "output_tokens_details": null,
      "input_tokens": 0,
      "output_tokens": 0,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 0,
      "server_tool_use": {
        "web_search_requests": 0,
        "web_fetch_requests": 0
      },
      "service_tier": null,
      "cache_creation": {
        "ephemeral_1h_input_tokens": 0,
        "ephemeral_5m_input_tokens": 0
      },
      "inference_geo": null,
      "iterations": null,
      "speed": null,
      "fallback_credit": null
    },
    "content": [
      {
        "type": "text",
        "text": "You've hit your 5-hour limit · resets 4:10pm (Europe/Warsaw)"
      }
    ],
    "context_management": null
  },
  "apiError": "usage_limit_reached",
  "apiErrorParams": {
    "rate_limit_info": {
      "status": "rejected",
      "resetsAt": 1794323400,
      "rateLimitType": "five_hour",
      "overageStatus": "rejected",
      "overageDisabledReason": "org_level_disabled",
      "isUsingOverage": false
    }
  },
  "quotaLimits": {
    "status": "rejected",
    "resetsAt": 1794323400,
    "unifiedRateLimitFallbackAvailable": false,
    "rateLimitType": "five_hour",
    "overageStatus": "rejected",
    "overageDisabledReason": "org_level_disabled",
    "upgradePaths": [
      "upgrade_plan",
      "overage"
    ],
    "isUsingOverage": false
  },
  "error": "rate_limit",
  "isApiErrorMessage": true,
  "apiErrorStatus": 429,
  "failedResponseHadNoToolCall": true,
  "entrypoint": "sdk-cli",
  "version": "2.1.319"
} as const;

/** Observation time of the record above. */
export const REAL_FIVE_HOUR_LIMIT_OBSERVED_AT = "2026-11-10T11:36:57.494Z";

/** A real stream-json rate_limit_event from a Pirx worker transcript (2026-11-10), below the limit. */
export const REAL_ALLOWED_RATE_LIMIT_EVENT = {"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1794330600,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.25,"resetsAt":1794330600,"status":"allowed"},"seven_day":{"utilization":0.66,"resetsAt":1794513600,"status":"allowed"}}}} as const;
