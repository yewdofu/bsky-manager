import { AppBskyFeedDefs, AtpAgent } from "@atproto/api";

export type EmbedType = "images" | "video" | "external" | "record" | "gallery" | "recordWithMedia" | "unknown";

export type EmbedImage = {
  thumb: string;
  alt: string;
};

export type PostEmbed = {
  type: EmbedType;
  images: EmbedImage[];
};

export type ManagedPost = {
  uri: string;
  cid: string;
  rkey: string;
  text: string;
  indexedAt: string;
  likeCount: number;
  repostCount: number;
  replyCount: number;
  embed: PostEmbed | null;
  isReply: boolean;
};

export type FeedPage = {
  posts: ManagedPost[];
  cursor?: string;
};

export type DeleteOutcome = {
  uri: string;
  ok: boolean;
  error?: string;
};

export const DELETE_INTERVAL_MS = 450;

const POST_COLLECTION = "app.bsky.feed.post";
const ATP_URI_PATTERN = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/;

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export function createAgent() {
  return new AtpAgent({ service: "https://bsky.social" });
}

export async function login(agent: AtpAgent, identifier: string, password: string) {
  try {
    const response = await agent.login({ identifier, password });

    if (!response.success || !agent.session?.did) {
      throw new Error("ログインに失敗しました。ハンドルとApp Passwordを確認してください。");
    }

    return {
      handle: agent.session.handle,
      did: agent.session.did,
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`ログイン失敗: ${error.message}`);
    }
    throw new Error("ログインに失敗しました。ハンドルとApp Passwordを確認してください。");
  }
}

export async function fetchAuthorFeed(
  agent: AtpAgent,
  actor: string,
  cursor?: string,
): Promise<FeedPage> {
  const response = await agent.getAuthorFeed({
    actor,
    cursor,
    filter: "posts_with_replies",
    limit: 25,
  });

  return {
    posts: response.data.feed.flatMap((item) => toManagedPost(item.post, Boolean(item.reply))),
    cursor: response.data.cursor,
  };
}

export async function deletePostsSequentially(
  agent: AtpAgent,
  repo: string,
  posts: ManagedPost[],
  onProgress: (completed: number, total: number) => void,
): Promise<DeleteOutcome[]> {
  const results: DeleteOutcome[] = [];

  for (const post of posts) {
    try {
      await agent.com.atproto.repo.deleteRecord({
        repo,
        collection: POST_COLLECTION,
        rkey: post.rkey,
      });
      results.push({ uri: post.uri, ok: true });
    } catch (error) {
      results.push({
        uri: post.uri,
        ok: false,
        error: error instanceof Error ? error.message : "不明なエラーが発生しました。",
      });
    }

    onProgress(results.length, posts.length);

    if (results.length < posts.length) {
      await delay(DELETE_INTERVAL_MS);
    }
  }

  return results;
}

function parseEmbed(embed: AppBskyFeedDefs.PostView["embed"]): PostEmbed | null {
  if (!embed || typeof embed !== "object" || !("$type" in embed)) {
    return null;
  }

  const $type = embed.$type as string;

  if ($type.includes("embed.images")) {
    const images = (embed as { images?: { thumb: string; alt: string }[] }).images ?? [];
    return { type: "images", images: images.map((img) => ({ thumb: img.thumb, alt: img.alt })) };
  }

  if ($type.includes("embed.video")) {
    return { type: "video", images: [] };
  }

  if ($type.includes("embed.gallery")) {
    const items = (embed as { items?: { thumb?: string; alt?: string }[] }).items ?? [];
    return {
      type: "gallery",
      images: items
        .filter((item): item is { thumb: string; alt?: string } => typeof item.thumb === "string")
        .map((item) => ({ thumb: item.thumb, alt: item.alt ?? "" })),
    };
  }

  if ($type.includes("embed.external")) {
    const ext = (embed as { external?: { thumb?: string } }).external;
    const images = ext?.thumb ? [{ thumb: ext.thumb, alt: "" }] : [];
    return { type: "external", images };
  }

  if ($type.includes("embed.recordWithMedia")) {
    const media = (embed as { media?: { $type?: string; images?: { thumb: string; alt: string }[] } }).media;
    if (media?.$type?.includes("embed.images") && media.images) {
      return { type: "recordWithMedia", images: media.images.map((img) => ({ thumb: img.thumb, alt: img.alt })) };
    }
    return { type: "recordWithMedia", images: [] };
  }

  if ($type.includes("embed.record")) {
    return { type: "record", images: [] };
  }

  return { type: "unknown", images: [] };
}

function toManagedPost(post: AppBskyFeedDefs.PostView, isReply: boolean): ManagedPost[] {
  const record = post.record as Record<string, unknown>;
  const text = typeof record?.text === "string" ? record.text : "";

  const match = post.uri.match(ATP_URI_PATTERN);
  if (!match) {
    return [];
  }

  return [
    {
      uri: post.uri,
      cid: post.cid,
      rkey: match[3],
      text,
      indexedAt: post.indexedAt,
      likeCount: post.likeCount ?? 0,
      repostCount: post.repostCount ?? 0,
      replyCount: post.replyCount ?? 0,
      embed: parseEmbed(post.embed),
      isReply,
    },
  ];
}
