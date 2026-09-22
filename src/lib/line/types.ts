export interface LineWebhookBody {
  destination: string;
  events: LineEvent[];
}

export type LineEvent =
  | LineMessageEvent
  | LineFollowEvent
  | LineUnfollowEvent
  | LineJoinEvent
  | LineLeaveEvent
  | LineMemberJoinedEvent
  | LineMemberLeftEvent
  | LinePostbackEvent
  | LineUnsendEvent;

interface LineEventBase {
  type: string;
  webhookEventId: string;
  deliveryContext: { isRedelivery: boolean };
  timestamp: number;
  source: LineSource;
  mode: "active" | "standby" | "chase";
}

export interface LineMessageEvent extends LineEventBase {
  type: "message";
  replyToken: string;
  message: LineMessage;
}

export interface LineFollowEvent extends LineEventBase {
  type: "follow";
  replyToken: string;
}

export interface LineUnfollowEvent extends LineEventBase {
  type: "unfollow";
}

export interface LineJoinEvent extends LineEventBase {
  type: "join";
  replyToken: string;
}

export interface LineLeaveEvent extends LineEventBase {
  type: "leave";
}

export interface LineMemberJoinedEvent extends LineEventBase {
  type: "memberJoined";
  replyToken: string;
  joined: { members: LineMember[] };
}

export interface LineMemberLeftEvent extends LineEventBase {
  type: "memberLeft";
  left: { members: LineMember[] };
}

export interface LinePostbackEvent extends LineEventBase {
  type: "postback";
  replyToken: string;
  postback: { data: string; params?: Record<string, string> };
}

export interface LineUnsendEvent extends LineEventBase {
  type: "unsend";
  unsend: { messageId: string };
}

// Sources
export type LineSource =
  | LineUserSource
  | LineGroupSource
  | LineRoomSource;

export interface LineUserSource {
  type: "user";
  userId: string;
}

export interface LineGroupSource {
  type: "group";
  groupId: string;
  userId?: string;
}

export interface LineRoomSource {
  type: "room";
  roomId: string;
  userId?: string;
}

// Messages
export type LineMessage =
  | LineTextMessage
  | LineImageMessage
  | LineVideoMessage
  | LineAudioMessage
  | LineFileMessage
  | LineLocationMessage
  | LineStickerMessage;

interface LineMessageBase {
  id: string;
  type: string;
  quoteToken: string;
  quotedMessageId?: string;
}

export interface LineTextMessage extends LineMessageBase {
  type: "text";
  text: string;
  emojis?: LineEmoji[];
  mention?: LineMention;
}

export interface LineImageMessage extends LineMessageBase {
  type: "image";
  contentProvider: LineContentProvider;
  imageSet?: { id: string; index: number; total: number };
}

export interface LineVideoMessage extends LineMessageBase {
  type: "video";
  duration: number;
  contentProvider: LineContentProvider;
}

export interface LineAudioMessage extends LineMessageBase {
  type: "audio";
  duration: number;
  contentProvider: LineContentProvider;
}

export interface LineFileMessage extends LineMessageBase {
  type: "file";
  fileName: string;
  fileSize: number;
}

export interface LineLocationMessage extends LineMessageBase {
  type: "location";
  title?: string;
  address?: string;
  latitude: number;
  longitude: number;
}

export interface LineStickerMessage extends LineMessageBase {
  type: "sticker";
  packageId: string;
  stickerId: string;
  stickerResourceType: string;
  keywords?: string[];
}

// Helpers
interface LineEmoji {
  index: number;
  length: number;
  productId: string;
  emojiId: string;
}

interface LineMention {
  mentionees: Array<{
    index: number;
    length: number;
    type: "user" | "all";
    userId?: string;
  }>;
}

interface LineContentProvider {
  type: "line" | "external";
  originalContentUrl?: string;
  previewImageUrl?: string;
}

interface LineMember {
  type: "user" | "group";
  userId?: string;
  groupId?: string;
}
