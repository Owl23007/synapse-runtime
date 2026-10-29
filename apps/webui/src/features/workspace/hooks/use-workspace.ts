import { useRunActivity } from "./use-run-activity.js";
import { useLegacySessionSummaries } from "./use-session-summaries.js";
import { navigate } from "../lib/navigation.js";
import { useCallback, useEffect, useMemo, useRef, useState, useId, type FormEvent } from "react";
import { type WorkspaceMessage } from "@synapse/runtime-client";
import { message, record } from "../../../shared/lib/runtime.js";
import { toast } from "../../../shared/lib/toast.js";
import { useLoad } from "../../../shared/hooks/use-load.js";
import { type ViewProps } from "../../../shared/types/runtime.js";
import { sessionDay } from "../lib/activity.js";
import {
  initialSessionTitle,
  presentSession,
  sessionMessageTime,
  workspaceSummary
} from "../lib/session-presentation.js";

/** 工作台统一管理布局与 API 编排，操作结果经全局提醒呈现，读取错误保留页面重试 */
export function useWorkspace({
  client,
  revision,
  initialSession,
  initialLine
}: ViewProps & { initialSession: string; initialLine: string }) {
  const [search, setSearch] = useState("");
  const [initialText, setInitialText] = useState("");
  const [sessionKind, setSessionKind] = useState("all");
  const [tab, setTab] = useState("chat");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [head, setHead] = useState("");
  const [forkTitle, setForkTitle] = useState("");
  const [merging, setMerging] = useState(false);
  const [older, setOlder] = useState<WorkspaceMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<number>();
  const [moreHistory, setMoreHistory] = useState<boolean>();
  const [sessionPages, setSessionPages] = useState<Record<string, unknown>[]>([]);
  const [sessionCursor, setSessionCursor] = useState<number>();
  const [inspectorOpen, setInspectorOpen] = useState(() => matchMedia("(min-width: 1280px)").matches);
  const [sessionsOpen, setSessionsOpen] = useState(() => matchMedia("(min-width: 761px)").matches);
  const [sessionListExpanded, setSessionListExpanded] = useState(true);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState("");
  const sessionLoadingRef = useRef(false);
  const sessionSearch = useRef<HTMLInputElement>(null);
  const initialMessage = useRef<HTMLTextAreaElement>(null);
  const menuId = useId();
  const [menuPosition, setMenuPosition] = useState({ top: 64, left: 24 });
  const scope = `${initialSession}:${initialLine}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  // 结果未知时保留原键；再次提交相同内容不会重复执行或创建会话
  const requestKey = useRef<{ payload: string; key: string } | undefined>(undefined);
  const actionKey = (payload: string) => {
    if (requestKey.current?.payload !== payload) requestKey.current = { payload, key: crypto.randomUUID() };
    return requestKey.current.key;
  };
  const sessionsLoad = useCallback(() => client.sessions(), [client]);
  const sessions = useLoad(sessionsLoad, revision + nonce);
  const rawSessionItems = [
    ...new Map([...(sessions.value?.items ?? []), ...sessionPages].map((item) => [String(item.id), item])).values()
  ];
  const needsLegacy = rawSessionItems.some((item) => !("lastMessageAt" in item));
  const recentLoad = useCallback(
    () => (needsLegacy ? client.runs({ limit: 200 }) : Promise.resolve(undefined)),
    [client, needsLegacy]
  );
  const recent = useLoad(recentLoad, revision + nonce);
  const legacySummaries = useLegacySessionSummaries(client, rawSessionItems, recent.value?.items ?? [], nonce);
  const load = useCallback(
    () => (initialSession ? client.workspace(initialSession, initialLine || undefined) : Promise.resolve(undefined)),
    [client, initialSession, initialLine]
  );
  const data = useLoad(load, revision + nonce);
  const session = data.value?.session;
  const sessionItems = rawSessionItems
    .map((item) => {
      const value = Object.assign(
        Object.create(null) as Record<string, unknown>,
        item,
        legacySummaries.get(String(item.id))
      );
      if (item.id !== initialSession || !data.value) return value;
      const current = workspaceSummary(data.value);
      const lastMessageAt =
        [value.lastMessageAt, current.lastMessageAt]
          .filter((entry): entry is string => typeof entry === "string" && Number.isFinite(Date.parse(entry)))
          .toSorted((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
      return Object.assign(value, current, { lastMessageAt });
    })
    .toSorted(
      (a, b) =>
        (Date.parse(sessionMessageTime(b) ?? "") || 0) - (Date.parse(sessionMessageTime(a) ?? "") || 0) ||
        String(a.id).localeCompare(String(b.id))
    );
  const currentPresentation = presentSession({
    ...sessionItems.find((item) => item.id === initialSession),
    ...session,
    id: initialSession
  });
  const native = session?.locator?.platform === "native";
  const lineId = data.value?.line.id ?? "";
  const branch = data.value?.branches.find((item) => item.id === lineId);
  const graphLoad = useCallback(
    () => (initialSession ? client.sessionGraph(initialSession, head || undefined) : Promise.resolve(undefined)),
    [client, initialSession, head]
  );
  const graph = useLoad(graphLoad, revision + nonce);
  const runsLoad = useCallback(
    () => (initialSession ? client.runs({ sessionId: initialSession, limit: 50 }) : Promise.resolve(undefined)),
    [client, initialSession]
  );
  const runs = useLoad(runsLoad, revision + nonce);
  const lineRuns = runs.value?.items.filter((run) => run.lineId === lineId) ?? [];
  const activeRun = lineRuns.find((run) => ["accepted", "running"].includes(run.status));
  const latestRun = activeRun ?? lineRuns[0];
  const activity = useRunActivity(
    client,
    inspectorOpen || tab === "chat" ? latestRun?.id : undefined,
    revision + nonce
  );
  // 主线仅展示关联运行，任务属于分支，不能将主线标识传入分支任务接口
  const taskBranchId = branch?.id;
  const tasksLoad = useCallback(
    () => (taskBranchId && tab === "runs" ? client.tasks(taskBranchId) : Promise.resolve(undefined)),
    [client, taskBranchId, tab]
  );
  const tasks = useLoad(tasksLoad, revision + nonce);
  const taskItems = Array.isArray(record(tasks.value).tasks)
    ? (record(tasks.value).tasks as unknown[])
        .map(record)
        .filter((task) => task.sessionId === initialSession && task.branchId === lineId)
    : [];
  const artifactsLoad = useCallback(
    () => (initialSession && inspectorOpen ? client.artifacts(initialSession) : Promise.resolve(undefined)),
    [client, initialSession, inspectorOpen]
  );
  const inspectorArtifacts = useLoad(artifactsLoad, revision + nonce);
  const messages = useMemo(
    () =>
      [...new Map([...older, ...(data.value?.messages ?? [])].map((item) => [item.id, item])).values()].toSorted(
        (a, b) => a.sequence - b.sequence
      ),
    [older, data.value]
  );
  const tail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const narrow = matchMedia("(max-width: 1279px)");
    const mobile = matchMedia("(max-width: 760px)");
    const collapseInspector = () => {
      if (narrow.matches) setInspectorOpen(false);
    };
    const collapseSessions = () => {
      if (mobile.matches) setSessionsOpen(false);
    };
    narrow.addEventListener("change", collapseInspector);
    mobile.addEventListener("change", collapseSessions);
    return () => {
      narrow.removeEventListener("change", collapseInspector);
      mobile.removeEventListener("change", collapseSessions);
    };
  }, []);
  useEffect(() => {
    setOlder([]);
    setOlderCursor(undefined);
    setMoreHistory(undefined);
    setSelected(undefined);
    setHead("");
    setText("");
    setForkTitle("");
    setMerging(false);
    setTab("chat");
    setError("");
    requestKey.current = undefined;
  }, [initialSession, initialLine]);
  useEffect(() => {
    const searchShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSessionsOpen(true);
        setSessionListExpanded(true);
        requestAnimationFrame(() => sessionSearch.current?.focus());
      }
      if (event.key === "Escape" && inspectorOpen) setInspectorOpen(false);
    };
    addEventListener("keydown", searchShortcut);
    return () => removeEventListener("keydown", searchShortcut);
  }, [inspectorOpen]);
  useEffect(() => {
    tail.current?.scrollIntoView({
      block: "nearest",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"
    });
  }, [messages.at(-1)?.id]);
  const act = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operation();
      setNonce((value) => value + 1);
    } catch (cause) {
      toast.error(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const create = (event: FormEvent) => {
    event.preventDefault();
    const content = initialText.trim();
    if (!content || busy) return;
    const name = initialSessionTitle(content);
    const key = actionKey(`create:${name}:${content}`);
    void act(async () => {
      const result = await client.createSession(name, key);
      await client.submitRun({
        sessionId: result.session.id,
        lineId: result.session.mainlineId,
        text: content,
        idempotencyKey: `${key}:initial`
      });
      setInitialText("");
      navigate(result.session.id);
    });
  };
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || !native || !lineId) return;
    void act(async () => {
      await client.submitRun({
        sessionId: initialSession,
        lineId,
        text: text.trim(),
        idempotencyKey: actionKey(`send:${initialSession}:${lineId}:${text.trim()}`)
      });
      requestKey.current = undefined;
      if (scopeRef.current === scope) setText("");
    });
  };
  const commit = graph.value?.nodes.find((node) => node.id === selected);
  const mainRef = graph.value?.refs.find((ref) => ref.name === `line:${session?.mainlineId}`);
  const branchRef = graph.value?.refs.find((ref) => ref.name === `line:${lineId}`);
  const branchResult = graph.value?.nodes.find((node) => node.id === branchRef?.commitId);
  const mainResult = graph.value?.nodes.find((node) => node.id === mainRef?.commitId);
  const moreSessions = useCallback(async () => {
    const cursor = sessionCursor ?? sessions.value?.nextCursor;
    if (typeof cursor !== "number" || cursor === 0 || sessionLoadingRef.current) return;
    sessionLoadingRef.current = true;
    setSessionLoading(true);
    setSessionError("");
    try {
      const page = await client.sessions(cursor);
      if (page.nextCursor === cursor) throw new Error("会话游标未推进，请重试");
      setSessionPages((current) => [...current, ...page.items]);
      setSessionCursor(typeof page.nextCursor === "number" ? page.nextCursor : 0);
    } catch (cause) {
      setSessionError(message(cause));
    } finally {
      sessionLoadingRef.current = false;
      setSessionLoading(false);
    }
  }, [client, sessionCursor, sessions.value?.nextCursor]);
  const sessionGroups = ["今天", "昨天", "更早"].map((label) => ({
    label,
    items: sessionItems.filter(
      (item) =>
        sessionDay(sessionMessageTime(item)) === label &&
        (sessionKind === "all" || presentSession(item).native === (sessionKind === "native")) &&
        `${item.id} ${presentSession(item).title} ${presentSession(item).subtitle}`
          .toLowerCase()
          .includes(search.toLowerCase())
    )
  }));

  return {
    client,
    revision,
    initialSession,
    search,
    setSearch,
    initialText,
    setInitialText,
    sessionKind,
    setSessionKind,
    tab,
    setTab,
    text,
    setText,
    busy,
    error,
    setError,
    nonce,
    setNonce,
    selected,
    setSelected,
    head,
    setHead,
    forkTitle,
    setForkTitle,
    merging,
    setMerging,
    setOlder,
    olderCursor,
    setOlderCursor,
    moreHistory,
    setMoreHistory,
    sessionCursor,
    setNotice: toast.success,
    inspectorOpen,
    setInspectorOpen,
    sessionsOpen,
    setSessionsOpen,
    sessionListExpanded,
    setSessionListExpanded,
    sessionLoading,
    sessionError,
    sessionSearch,
    initialMessage,
    menuId,
    menuPosition,
    setMenuPosition,
    scope,
    scopeRef,
    actionKey,
    sessions,
    data,
    session,
    sessionItems,
    currentPresentation,
    native,
    lineId,
    branch,
    graph,
    runs,
    lineRuns,
    activeRun,
    latestRun,
    activity,
    tasks,
    taskItems,
    inspectorArtifacts,
    messages,
    tail,
    act,
    create,
    send,
    commit,
    mainRef,
    branchRef,
    branchResult,
    mainResult,
    moreSessions,
    sessionGroups
  };
}
/** 工作台输入仅包含服务上下文与持久会话标识 */
export type WorkspaceProps = Parameters<typeof useWorkspace>[0];
/** 工作台视图使用的状态与动作投影，不扩展 Runtime 领域协议 */
export type WorkspaceController = ReturnType<typeof useWorkspace>;
