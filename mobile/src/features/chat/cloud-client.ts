/**
 * 负责：在 iPhone 通过配对码访问 Mova 并在系统钥匙串保存设备凭证。
 * 不负责：模型选路、后台任务执行或远端服务部署。
 * 被谁调用：mobile-provider 和云服务设置。
 */

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type { ChatState, Message } from './chat-state';

export type CloudProvider = 'research' | 'api' | 'codex' | 'gemini';
export type CloudConnection = { origin: string; id: string; token: string; provider: CloudProvider; botId?: string; research?: boolean; push?: boolean };
export type CloudTask = {
  id: string; conversationId: string; prompt: string; result: string | null; error: string | null;
  status: string; createdAt: number; updatedAt: number;
};
export type CloudSnapshot = {
  bots: { id: string; name: string }[];
  conversations: { id: string; botId: string; title: string; createdAt: number }[];
  tasks: CloudTask[];
  cursor: number;
};
const KEY = 'mova-cloud-device-v1';
const cacheKey = (connection: CloudConnection) => `mova-cloud-recent-${connection.id}`;
let cacheWrites = Promise.resolve();
const STATUS: Record<string, string> = { queued: '正在排队', running: '任务正在云端运行', cancelled: '任务已取消', blocked: '任务等待处理', failed: '任务执行失败' };

export function cloudOrigin(value: string) {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('请输入 Mova 服务的 HTTPS 地址。');
  }
  return url.origin;
}

export async function cloudRequest<T>(connection: Pick<CloudConnection, 'origin'> & Partial<Pick<CloudConnection, 'token'>>, path: string, method = 'GET', body?: object): Promise<T> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 12000);
  try {
    const response = await fetch(`${connection.origin}${path}`, {
      method, redirect: 'error', credentials: 'omit', signal: abort.signal,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(connection.token ? { Authorization: `Bearer ${connection.token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(typeof result.message === 'string' ? result.message : 'Mova 服务请求失败'), { status: response.status });
    return result as T;
  } finally { clearTimeout(timer); }
}

export async function loadCloudConnection(): Promise<CloudConnection | null> {
  if (!await SecureStore.isAvailableAsync()) return null;
  const saved = await SecureStore.getItemAsync(KEY);
  if (!saved) return null;
  const parsed = JSON.parse(saved) as CloudConnection;
  if (!/^[A-Za-z0-9_-]{32}$/.test(parsed.token) || !/^[A-Za-z0-9_-]{1,100}$/.test(parsed.id)) return null;
  return { ...parsed, origin: cloudOrigin(parsed.origin) };
}

export async function storeCloudConnection(value: CloudConnection | null) {
  if (!await SecureStore.isAvailableAsync()) throw new Error('请在支持钥匙串的原生手机 App 中配对');
  if (value) await SecureStore.setItemAsync(KEY, JSON.stringify(value), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  else await SecureStore.deleteItemAsync(KEY);
}

export async function pairCloud(address: string, code: string) {
  if (!await SecureStore.isAvailableAsync()) throw new Error('请在 iPhone App 中配对');
  const origin = cloudOrigin(address);
  const key = code.trim();
  if (!/^[A-Za-z0-9_-]{32}$/.test(key)) throw new Error('请输入桌面生成的一次性配对码');
  const response = await cloudRequest<{ id: string; token: string }>({ origin }, '/v1/pair', 'POST', { code: key, name: 'iPhone' });
  if (!/^[A-Za-z0-9_-]{32}$/.test(response.token) || !/^[A-Za-z0-9_-]{1,100}$/.test(response.id)) throw new Error('云服务返回了无效设备凭证');
  const connection: CloudConnection = { origin, id: response.id, token: response.token, provider: 'research' };
  try { await storeCloudConnection(connection); }
  catch (error) { await cloudRequest(connection, `/v1/devices/${connection.id}`, 'DELETE').catch(() => {}); throw error; }
  return connection;
}

export async function loadRecentCloud(connection: CloudConnection): Promise<CloudSnapshot | null> {
  const value = await AsyncStorage.getItem(cacheKey(connection));
  return value ? JSON.parse(value) as CloudSnapshot : null;
}

export function cacheRecentCloud(connection: CloudConnection, snapshot: CloudSnapshot | null) {
  const write = cacheWrites.then(() => snapshot
    ? AsyncStorage.setItem(cacheKey(connection), JSON.stringify({ ...snapshot, tasks: snapshot.tasks.slice(0, 30) }))
    : AsyncStorage.removeItem(cacheKey(connection)));
  cacheWrites = write.catch(() => {});
  return write;
}

export async function setCloudNotifications(connection: CloudConnection, enabled: boolean) {
  let token: string | null = null;
  if (enabled) {
    const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId ?? process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
    if (Platform.OS !== 'ios' || !projectId) throw new Error('任务通知需要已配置 EAS 项目和 Apple 推送的 iPhone 构建。');
    const notifications = await import('expo-notifications');
    let permissions = await notifications.getPermissionsAsync();
    if (!permissions.granted && permissions.canAskAgain) permissions = await notifications.requestPermissionsAsync();
    if (!permissions.granted) throw new Error('请在 iPhone 系统设置中允许 Mova 通知。');
    token = (await notifications.getExpoPushTokenAsync({ projectId })).data;
  }
  await cloudRequest(connection, '/v1/device/push', 'PUT', { token });
}

export function chatStateFromCloud(snapshot: CloudSnapshot): ChatState {
  const byConversation = new Map<string, { messages: Message[]; updatedAt: number }>();
  for (const task of [...snapshot.tasks].reverse()) {
    const target = byConversation.get(task.conversationId) || { messages: [], updatedAt: 0 };
    target.messages.push({ id: `${task.id}-user`, role: 'user', text: task.prompt });
    const state = [STATUS[task.status], task.error].filter(Boolean).join(' · ');
    if (task.result || state) target.messages.push({ id: `${task.id}-assistant`, role: 'assistant', text: task.result || state });
    target.updatedAt = Math.max(target.updatedAt, task.updatedAt);
    byConversation.set(task.conversationId, target);
  }
  return { conversations: snapshot.conversations.map(row => ({ id: row.id, title: row.title, messages: byConversation.get(row.id)?.messages ?? [], updatedAt: byConversation.get(row.id)?.updatedAt || row.createdAt }))
    .sort((left, right) => right.updatedAt - left.updatedAt) };
}
