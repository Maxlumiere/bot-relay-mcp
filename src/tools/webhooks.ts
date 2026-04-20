// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { registerWebhook, listWebhooks, deleteWebhook } from "../db.js";
import { validateWebhookUrl } from "../url-safety.js";
import type { RegisterWebhookInput, DeleteWebhookInput } from "../types.js";
import { ERROR_CODES } from "../error-codes.js";

export async function handleRegisterWebhook(input: RegisterWebhookInput) {
  // SSRF protection — block private IPs, cloud metadata, and non-HTTP schemes
  const validation = await validateWebhookUrl(input.url);
  if (!validation.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: false,
              error: `Webhook URL rejected: ${validation.reason}`,
              error_code: ERROR_CODES.SSRF_REFUSED,
              url: input.url,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  const webhook = registerWebhook(input.url, input.event, input.filter, input.secret);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: true,
            webhook_id: webhook.id,
            url: webhook.url,
            event: webhook.event,
            filter: webhook.filter,
            has_secret: !!webhook.secret,
            resolved_ips: validation.resolvedIps,
            note: `Webhook registered for event "${webhook.event}"`,
          },
          null,
          2
        ),
      },
    ],
  };
}

export function handleListWebhooks() {
  const webhooks = listWebhooks().map((w) => ({
    id: w.id,
    url: w.url,
    event: w.event,
    filter: w.filter,
    has_secret: !!w.secret,
    created_at: w.created_at,
  }));

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            webhooks,
            count: webhooks.length,
          },
          null,
          2
        ),
      },
    ],
  };
}

export function handleDeleteWebhook(input: DeleteWebhookInput) {
  const deleted = deleteWebhook(input.webhook_id);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: deleted,
            webhook_id: input.webhook_id,
            note: deleted ? "Webhook deleted" : "Webhook not found",
          },
          null,
          2
        ),
      },
    ],
    isError: !deleted,
  };
}
