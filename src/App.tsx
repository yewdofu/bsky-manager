import { FormEvent, useMemo, useRef, useState } from "react";
import { AtpAgent } from "@atproto/api";
import {
  DeleteOutcome,
  ManagedPost,
  createAgent,
  deletePostsSequentially,
  fetchAuthorFeed,
  login,
} from "./lib/bsky";

type SessionState = {
  handle: string;
  did: string;
};

type DeleteProgress = {
  completed: number;
  total: number;
};

type ResultSummary = {
  success: number;
  failed: number;
  failures: DeleteOutcome[];
};

export default function App() {
  const agentRef = useRef<AtpAgent | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [identifier, setIdentifier] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [posts, setPosts] = useState<ManagedPost[]>([]);
  const [selectedUris, setSelectedUris] = useState<Set<string>>(() => new Set());
  const [currentCursor, setCurrentCursor] = useState<string | undefined>();
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [previousCursors, setPreviousCursors] = useState<(string | undefined)[]>([]);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isLoadingFeed, setIsLoadingFeed] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<DeleteProgress | null>(null);
  const [result, setResult] = useState<ResultSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"posts" | "replies">("posts");

  const visiblePosts = useMemo(
    () => posts.filter((post) => (tab === "replies" ? post.isReply : !post.isReply)),
    [posts, tab],
  );

  const postCount = useMemo(() => posts.filter((p) => !p.isReply).length, [posts]);
  const replyCount = useMemo(() => posts.filter((p) => p.isReply).length, [posts]);

  const selectedPosts = useMemo(
    () => posts.filter((post) => selectedUris.has(post.uri)),
    [posts, selectedUris],
  );

  const allVisibleSelected = visiblePosts.length > 0 && visiblePosts.every((post) => selectedUris.has(post.uri));
  const isBusy = isLoggingIn || isLoadingFeed || Boolean(deleteProgress);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsLoggingIn(true);
    setError(null);
    setResult(null);

    const agent = createAgent();

    try {
      const nextSession = await login(agent, identifier.trim(), appPassword);
      agentRef.current = agent;
      setSession(nextSession);
      setAppPassword("");
      await loadFeed(agent, nextSession.did, undefined, { resetHistory: true });
    } catch (loginError) {
      agentRef.current = null;
      setSession(null);
      setError(loginError instanceof Error ? loginError.message : "ログインに失敗しました。");
    } finally {
      setIsLoggingIn(false);
    }
  }

  async function loadFeed(
    agent: AtpAgent,
    actor: string,
    cursor: string | undefined,
    options?: { resetHistory?: boolean },
  ) {
    setIsLoadingFeed(true);
    setError(null);

    try {
      const page = await fetchAuthorFeed(agent, actor, cursor);
      setPosts(page.posts);
      setCurrentCursor(cursor);
      setNextCursor(page.cursor);
      setSelectedUris(new Set());
      if (options?.resetHistory) {
        setPreviousCursors([]);
      }
    } catch (feedError) {
      setError(feedError instanceof Error ? feedError.message : "ポスト一覧の取得に失敗しました。");
    } finally {
      setIsLoadingFeed(false);
    }
  }

  async function handleNextPage() {
    if (!agentRef.current || !session || !nextCursor) {
      return;
    }

    setPreviousCursors((cursors) => [...cursors, currentCursor]);
    await loadFeed(agentRef.current, session.did, nextCursor);
  }

  async function handlePreviousPage() {
    if (!agentRef.current || !session || previousCursors.length === 0) {
      return;
    }

    const previousCursor = previousCursors[previousCursors.length - 1];
    setPreviousCursors((cursors) => cursors.slice(0, -1));
    await loadFeed(agentRef.current, session.did, previousCursor);
  }

  function togglePost(uri: string) {
    setSelectedUris((current) => {
      const next = new Set(current);
      if (next.has(uri)) {
        next.delete(uri);
      } else {
        next.add(uri);
      }
      return next;
    });
  }

  function toggleVisibleSelection() {
    setSelectedUris((current) => {
      if (allVisibleSelected) {
        const next = new Set(current);
        for (const post of visiblePosts) {
          next.delete(post.uri);
        }
        return next;
      }

      const next = new Set(current);
      for (const post of visiblePosts) {
        next.add(post.uri);
      }
      return next;
    });
  }

  async function handleDelete() {
    if (!agentRef.current || !session || selectedPosts.length === 0) {
      return;
    }

    setIsConfirmingDelete(false);
    setDeleteProgress({ completed: 0, total: selectedPosts.length });
    setError(null);
    setResult(null);

    const outcomes = await deletePostsSequentially(
      agentRef.current,
      session.did,
      selectedPosts,
      (completed, total) => setDeleteProgress({ completed, total }),
    );

    const failures = outcomes.filter((outcome) => !outcome.ok);
    setResult({
      success: outcomes.length - failures.length,
      failed: failures.length,
      failures,
    });
    setDeleteProgress(null);
    setSelectedUris(new Set());

    if (agentRef.current) {
      await loadFeed(agentRef.current, session.did, currentCursor);
    }
  }

  function handleLogout() {
    agentRef.current = null;
    setSession(null);
    setPosts([]);
    setSelectedUris(new Set());
    setCurrentCursor(undefined);
    setNextCursor(undefined);
    setPreviousCursors([]);
    setResult(null);
    setError(null);
  }

  if (!session) {
    return (
      <main className="app app--centered">
        <section className="login-panel" aria-labelledby="login-title">
          <p className="eyebrow">Bluesky Post Manager</p>
          <h1 id="login-title">ポスト管理</h1>
          <form className="login-form" onSubmit={handleLogin}>
            <label>
              ハンドル
              <input
                autoComplete="username"
                disabled={isLoggingIn}
                onChange={(event) => setIdentifier(event.target.value)}
                placeholder="example.bsky.social"
                required
                type="text"
                value={identifier}
              />
            </label>
            <label>
              App Password
              <input
                autoComplete="current-password"
                disabled={isLoggingIn}
                onChange={(event) => setAppPassword(event.target.value)}
                placeholder="xxxx-xxxx-xxxx-xxxx"
                required
                type="password"
                value={appPassword}
              />
            </label>
            {error ? <p className="alert alert--error">{error}</p> : null}
            <button className="primary-button" disabled={isLoggingIn} type="submit">
              {isLoggingIn ? "ログイン中..." : "ログイン"}
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <p className="eyebrow">ログイン中</p>
          <h1>@{session.handle}</h1>
        </div>
        <button className="secondary-button" disabled={isBusy} onClick={handleLogout} type="button">
          ログアウト
        </button>
      </header>

      <nav className="tab-bar" aria-label="表示切り替え">
        <button
          className={`tab-button ${tab === "posts" ? "tab-button--active" : ""}`}
          disabled={isBusy}
          onClick={() => setTab("posts")}
          type="button"
        >
          投稿 ({postCount})
        </button>
        <button
          className={`tab-button ${tab === "replies" ? "tab-button--active" : ""}`}
          disabled={isBusy}
          onClick={() => setTab("replies")}
          type="button"
        >
          返信 ({replyCount})
        </button>
      </nav>

      <section className="toolbar" aria-label="ポスト操作">
        <label className="check-all">
          <input
            checked={allVisibleSelected}
            disabled={visiblePosts.length === 0 || isBusy}
            onChange={toggleVisibleSelection}
            type="checkbox"
          />
          表示中を全て選択
        </label>
        <div className="toolbar-actions">
          <span className="selection-count">{selectedPosts.length}件選択中</span>
          <button
            className="danger-button"
            disabled={selectedPosts.length === 0 || isBusy}
            onClick={() => setIsConfirmingDelete(true)}
            type="button"
          >
            選択したポストを削除
          </button>
        </div>
      </section>

      {error ? <p className="alert alert--error">{error}</p> : null}

      {result ? (
        <section className={result.failed > 0 ? "alert alert--warning" : "alert alert--success"}>
          <strong>削除結果:</strong> 成功 {result.success}件 / 失敗 {result.failed}件
          {result.failures.length > 0 ? (
            <ul className="failure-list">
              {result.failures.map((failure) => (
                <li key={failure.uri}>{failure.error}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {deleteProgress ? (
        <section className="progress" aria-live="polite">
          <div className="progress-header">
            <span>削除処理中</span>
            <span>
              {deleteProgress.completed}/{deleteProgress.total}
            </span>
          </div>
          <progress max={deleteProgress.total} value={deleteProgress.completed} />
        </section>
      ) : null}

      <section className="post-list" aria-busy={isLoadingFeed}>
        {isLoadingFeed ? <p className="empty-state">ポストを取得しています...</p> : null}
        {!isLoadingFeed && visiblePosts.length === 0 ? (
          <p className="empty-state">表示できるポストがありません。</p>
        ) : null}
        {visiblePosts.map((post) => (
          <article className="post-row" key={post.uri}>
            <input
              aria-label="ポストを選択"
              checked={selectedUris.has(post.uri)}
              disabled={isBusy}
              onChange={() => togglePost(post.uri)}
              type="checkbox"
            />
            <div className="post-content">
              <p>{post.text}</p>
              {post.embed ? (
                <div className="post-embed">
                  <span className="embed-badge" data-type={post.embed.type}>
                    {embedLabel(post.embed.type)}
                  </span>
                  {post.embed.images.length > 0 ? (
                    <div className="embed-thumbs">
                      {post.embed.images.map((img, i) => (
                        <img key={i} src={img.thumb} alt={img.alt || "添付画像"} className="embed-thumb" />
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <footer>
                <time dateTime={post.indexedAt}>{formatDate(post.indexedAt)}</time>
                <span>返信 {post.replyCount}</span>
                <span>リポスト {post.repostCount}</span>
                <span>いいね {post.likeCount}</span>
              </footer>
            </div>
          </article>
        ))}
      </section>

      <nav className="pagination" aria-label="ページネーション">
        <button
          className="secondary-button"
          disabled={previousCursors.length === 0 || isBusy}
          onClick={handlePreviousPage}
          type="button"
        >
          前へ
        </button>
        <button
          className="secondary-button"
          disabled={!nextCursor || isBusy}
          onClick={handleNextPage}
          type="button"
        >
          次へ
        </button>
      </nav>

      {isConfirmingDelete ? (
        <div className="dialog-backdrop" role="presentation">
          <section
            aria-labelledby="delete-dialog-title"
            aria-modal="true"
            className="dialog"
            role="dialog"
          >
            <h2 id="delete-dialog-title">削除確認</h2>
            <p>{selectedPosts.length}件のポストを削除します。この操作は取り消せません。</p>
            <div className="dialog-actions">
              <button className="secondary-button" onClick={() => setIsConfirmingDelete(false)} type="button">
                キャンセル
              </button>
              <button className="danger-button" onClick={handleDelete} type="button">
                削除する
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function embedLabel(type: string) {
  switch (type) {
    case "images": return "画像";
    case "video": return "動画";
    case "gallery": return "ギャラリー";
    case "external": return "リンク";
    case "record": return "引用";
    case "recordWithMedia": return "引用+メディア";
    default: return "メディア";
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
