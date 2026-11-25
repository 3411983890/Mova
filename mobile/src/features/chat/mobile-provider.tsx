/**
 * 负责：维护云端工作区连接和跨端聊天，也保留本地演示入口。
 * 不负责：执行模型、保存服务端任务或运行桌面工具。
 * 被谁调用：根布局、聊天列表、对话和设置页。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { AppState } from 'react-native';
import {
  createConversation, createInitialState, deleteConversation, sendDemoMessage,
  type ChatState,
} from './chat-state';
import { cacheRecentCloud, chatStateFromCloud, cloudRequest, loadCloudConnection, loadRecentCloud, pairCloud, setCloudNotifications, storeCloudConnection,
  type CloudConnection, type CloudProvider, type CloudSnapshot, type CloudTask } from './cloud-client';

type MobileContextValue = {
  state: ChatState;
  activeId: string | null;
  selectConversation: (id: string) => void;
  demoEnabled: boolean;
  setDemoEnabled: (enabled: boolean) => void;
  newConversation: () => string;
  send: (id: string, text: string) => Promise<void>;
  remove: (id: string) => void;
  clear: () => void;
  cloudOrigin: string | null;
  cloudError: string;
  cloudProvider: CloudProvider;
  cloudBots: CloudSnapshot['bots'];
  cloudBot: string;
  cloudResearch: boolean;
  cloudPush: boolean;
  connectCloud: (address: string, code: string) => Promise<void>;
  disconnectCloud: () => Promise<void>;
  setCloudProvider: (provider: CloudProvider) => Promise<void>;
  setCloudBot: (botId: string) => Promise<void>;
  setCloudResearch: (value: boolean) => Promise<void>;
  setCloudPush: (value: boolean) => Promise<void>;
  cancelCloudTask: (id: string) => Promise<void>;
  retryCloudTask: (id: string) => Promise<void>;
  activeCloudTask: string | null;
  retryableCloudTask: string | null;
};
const MobileContext = createContext<MobileContextValue | null>(null);
let nextId = 0;
const makeId = () => `${Date.now().toString(36)}-${++nextId}`;

/** 在应用根部维护共享会话；所有变更交给纯状态函数处理。 */
export function MobileProvider({ children }: PropsWithChildren) {
  const [demo, setDemo] = useState(createInitialState);
  const [snapshot, setSnapshot] = useState<CloudSnapshot | null>(null);
  const [cloudDraft, setCloudDraft] = useState<ChatState['conversations'][number] | null>(null);
  const [connection, setConnection] = useState<CloudConnection | null>(null);
  const currentConnection = useRef<CloudConnection | null>(null);
  const cursor = useRef<number | undefined>(undefined);
  const [cloudError, setCloudError] = useState('');
  const [activeId, setActiveId] = useState<string | null>('welcome');
  const [demoEnabled, setDemoEnabled] = useState(true);
  const pending = useRef(new Map<string, string>());

  const changeConnection = (value: CloudConnection | null) => {
    currentConnection.current = value;
    setConnection(value);
  };
  const update = useCallback(async (current: CloudConnection) => {
    const after = cursor.current;
    const next = await cloudRequest<CloudSnapshot & { unchanged?: boolean }>(current, after === undefined ? '/v1/snapshot' : `/v1/snapshot?after=${after}`);
    if (currentConnection.current?.token !== current.token) return;
    if (!next.unchanged && (cursor.current === undefined || next.cursor >= cursor.current)) {
      cursor.current = next.cursor;
      setSnapshot(next);
      void cacheRecentCloud(current, next).catch(() => {});
    }
    setCloudError('');
  }, []);
  useEffect(() => {
    let mounted = true;
    void loadCloudConnection().then(async value => {
      if (!value) return;
      const recent = await loadRecentCloud(value).catch(() => null);
      if (mounted && !currentConnection.current) { setSnapshot(recent); setActiveId(null); changeConnection(value); }
    })
      .catch(() => { if (mounted) setCloudError('无法读取之前的配对，请重新配对。'); });
    return () => { mounted = false; };
  }, []);
  useEffect(() => {
    if (!connection) return;
    let stopped = false;
    let busy = false;
    const tick = async () => {
      if (stopped || busy || AppState.currentState === 'background') return;
      busy = true;
      try { await update(connection); } catch (error) {
        if (!stopped && currentConnection.current?.token === connection.token) {
          if ((error as { status?: number }).status === 401) {
            cursor.current = undefined;
            setSnapshot(null);
            void cacheRecentCloud(connection, null).catch(() => {});
          }
          const status = (error as { status?: number }).status;
          setCloudError(status && error instanceof Error ? error.message : '暂时无法连接 Mova 服务，显示上次同步记录。');
        }
      } finally { busy = false; }
    };
    void tick();
    const timer = setInterval(tick, 3000);
    const foreground = AppState.addEventListener('change', next => { if (next === 'active') void tick(); });
    return () => { stopped = true; clearInterval(timer); foreground.remove(); };
  }, [connection, update]);
  const state = connection ? chatStateFromCloud(snapshot || { bots: [], conversations: [], tasks: [], cursor: 0 }) : demo;
  if (connection && cloudDraft) state.conversations.unshift(cloudDraft);
  const selection = activeId || (connection ? state.conversations[0]?.id ?? null : null);
  const value: MobileContextValue = {
    state, activeId: selection, demoEnabled, setDemoEnabled, cloudOrigin: connection?.origin ?? null, cloudError,
    cloudProvider: connection?.provider || 'research',
    cloudBots: snapshot?.bots || [],
    cloudBot: connection?.botId || 'mova',
    cloudResearch: Boolean(connection?.research),
    cloudPush: Boolean(connection?.push),
    activeCloudTask: snapshot?.tasks.find(task => task.conversationId === selection && ['queued', 'running'].includes(task.status))?.id || null,
    retryableCloudTask: snapshot?.tasks.find(task => task.conversationId === selection && ['blocked', 'failed', 'cancelled'].includes(task.status))?.id || null,
    async connectCloud(address, code) {
      if (connection) throw new Error('请先断开现有设备');
      const paired = await pairCloud(address, code);
      cursor.current = undefined;
      setSnapshot(null); setActiveId(null); setCloudError(''); changeConnection(paired);
    },
    async disconnectCloud() {
      if (!connection) return;
      try { await cloudRequest(connection, `/v1/devices/${connection.id}`, 'DELETE'); }
      catch (error) { if ((error as { status?: number }).status !== 401) throw error; }
      await storeCloudConnection(null);
      cursor.current = undefined;
      pending.current.clear(); changeConnection(null); setSnapshot(null); setCloudDraft(null); setActiveId('welcome'); setCloudError('');
      await cacheRecentCloud(connection, null).catch(() => {});
    },
    async setCloudProvider(provider) {
      if (!connection) return;
      const next = { ...connection, provider };
      await storeCloudConnection(next); changeConnection(next);
    },
    async setCloudBot(botId) {
      if (!connection || !snapshot?.bots.some(bot => bot.id === botId)) return;
      const next = { ...connection, botId };
      await storeCloudConnection(next); changeConnection(next);
    },
    async setCloudResearch(research) {
      if (!connection) return;
      const next = { ...connection, research };
      await storeCloudConnection(next); changeConnection(next);
    },
    async setCloudPush(push) {
      if (!connection) return;
      await setCloudNotifications(connection, push);
      const next = { ...connection, push };
      await storeCloudConnection(next); changeConnection(next);
    },
    async cancelCloudTask(id) {
      if (!connection || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) return;
      await cloudRequest(connection, `/v1/tasks/${id}/cancel`, 'POST', {});
      await update(connection).catch(() => {});
    },
    async retryCloudTask(id) {
      if (!connection || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) return;
      await cloudRequest(connection, `/v1/tasks/${id}/retry`, 'POST', {});
      await update(connection).catch(() => {});
    },
    selectConversation(id) {
      if (state.conversations.some(item => item.id === id)) setActiveId(id);
    },
    newConversation() {
      const id = makeId();
      if (connection) setCloudDraft({ id, title: '新对话', messages: [], updatedAt: Date.now() });
      else setDemo(current => createConversation(current, id, Date.now()));
      setActiveId(id);
      return id;
    },
    async send(id, text) {
      if (connection) {
        const key = JSON.stringify([id, text, connection.provider, connection.botId, connection.research]);
        const job = pending.current.get(key) || `${connection.id}-${makeId()}`;
        pending.current.set(key, job);
        const task = await cloudRequest<CloudTask>(connection, '/v1/tasks', 'POST', {
          id: job, prompt: text, provider: connection.provider, botId: connection.botId, research: connection.research,
          ...(snapshot?.conversations.some(row => row.id === id) ? { conversationId: id } : {}),
        });
        if (currentConnection.current?.token !== connection.token) return;
        pending.current.delete(key);
        setActiveId(previous => previous === id || previous === null ? task.conversationId : previous);
        setCloudDraft(previous => previous?.id === id ? null : previous);
        await update(connection).catch(() => {});
        return;
      }
      const messageId = makeId();
      setDemo(current => sendDemoMessage(current, id, text, messageId, Date.now(), demoEnabled));
    },
    remove(id) {
      if (connection) { if (cloudDraft?.id === id) setCloudDraft(null); return; }
      setDemo(current => deleteConversation(current, id));
      if (activeId === id) setActiveId(state.conversations.find(item => item.id !== id)?.id ?? null);
    },
    clear() { setDemo({ conversations: [] }); if (!connection) setActiveId(null); },
  };
  return <MobileContext.Provider value={value}>{children}</MobileContext.Provider>;
}

/** 返回已由 MobileProvider 提供的共享状态。 */
export function useMobile() {
  const value = useContext(MobileContext);
  if (!value) throw new Error('useMobile 必须在 MobileProvider 中使用');
  return value;
}
