// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Channel tools (v2.0 intelligence layer).
 *
 * 5 new tools: create_channel, join_channel, leave_channel, post_to_channel,
 * get_channel_messages. Plus list_channels via discover-style listing.
 */
import {
  createChannel,
  joinChannel,
  leaveChannel,
  postToChannel,
  getChannelMessages,
  listChannels,
} from "../db.js";
import { fireWebhooks } from "../webhooks.js";
import type {
  CreateChannelInput,
  JoinChannelInput,
  LeaveChannelInput,
  PostToChannelInput,
  GetChannelMessagesInput,
} from "../types.js";
import { ERROR_CODES, type ErrorCode } from "../error-codes.js";

function jsonResponse(data: any, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * v2.1 Phase 4g: classify channel errors into stable codes. Channel helpers
 * throw Error with specific messages; fingerprint on those.
 */
function classifyChannelError(err: unknown): ErrorCode {
  if (err instanceof Error) {
    const m = err.message;
    if (/already exists/i.test(m)) return ERROR_CODES.ALREADY_EXISTS;
    if (/does not exist|not found/i.test(m)) return ERROR_CODES.NOT_FOUND;
    if (/not a member/i.test(m)) return ERROR_CODES.NOT_MEMBER;
  }
  return ERROR_CODES.INTERNAL;
}

export function handleCreateChannel(input: CreateChannelInput) {
  try {
    const channel = createChannel(input.name, input.description ?? null, input.creator);
    return jsonResponse({ success: true, channel, message: `Channel "${input.name}" created.` });
  } catch (err: any) {
    return jsonResponse({ success: false, error: err.message, error_code: classifyChannelError(err) }, true);
  }
}

export function handleJoinChannel(input: JoinChannelInput) {
  try {
    const { joined, channel_id } = joinChannel(input.channel_name, input.agent_name);
    return jsonResponse({
      success: true,
      channel_name: input.channel_name,
      agent_name: input.agent_name,
      joined,
      note: joined
        ? `Agent "${input.agent_name}" joined channel "${input.channel_name}".`
        : `Agent "${input.agent_name}" was already a member of "${input.channel_name}".`,
    });
  } catch (err: any) {
    return jsonResponse({ success: false, error: err.message, error_code: classifyChannelError(err) }, true);
  }
}

export function handleLeaveChannel(input: LeaveChannelInput) {
  try {
    const { left } = leaveChannel(input.channel_name, input.agent_name);
    return jsonResponse({
      success: true,
      channel_name: input.channel_name,
      agent_name: input.agent_name,
      left,
      note: left
        ? `Agent "${input.agent_name}" left channel "${input.channel_name}".`
        : `Agent "${input.agent_name}" was not a member of "${input.channel_name}".`,
    });
  } catch (err: any) {
    return jsonResponse({ success: false, error: err.message, error_code: classifyChannelError(err) }, true);
  }
}

export function handlePostToChannel(input: PostToChannelInput) {
  try {
    const msg = postToChannel(input.channel_name, input.from, input.content, input.priority);
    fireWebhooks("channel.message_posted", input.from, input.channel_name, {
      channel_name: input.channel_name,
      message_id: msg.id,
    });
    return jsonResponse({
      success: true,
      message_id: msg.id,
      channel_name: input.channel_name,
      from: input.from,
    });
  } catch (err: any) {
    return jsonResponse({ success: false, error: err.message, error_code: classifyChannelError(err) }, true);
  }
}

export function handleGetChannelMessages(input: GetChannelMessagesInput) {
  try {
    const messages = getChannelMessages(
      input.channel_name,
      input.agent_name,
      input.limit,
      input.since
    );
    return jsonResponse({
      messages,
      count: messages.length,
      channel_name: input.channel_name,
      agent: input.agent_name,
    });
  } catch (err: any) {
    return jsonResponse({ success: false, error: err.message, error_code: classifyChannelError(err) }, true);
  }
}

export function handleListChannels() {
  const channels = listChannels();
  return jsonResponse({ channels, count: channels.length });
}
