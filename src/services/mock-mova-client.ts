import type { MovaClient } from './mova-client';

function waitForChunk(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, 260);
    signal.addEventListener('abort', stop, { once: true });
  });
}

export const mockMovaClient: MovaClient = {
  source: 'mock',
  async *streamReply({ mode }, signal) {
    const chunks = [
      '已收到你的消息。', '这是一条在本地生成的示例回复，', '没有调用 AI 模型。\n\n',
      mode === 'CodeMova' ? '这次演示不会读取或修改项目文件。' : '你可以继续发送消息，体验多轮聊天。',
      '生成期间，', '点击输入框里的停止按钮', '可以中断回复。', '已显示的内容', '会随会话保存在本地。',
    ];
    for (const chunk of chunks) {
      await waitForChunk(signal);
      signal.throwIfAborted();
      yield chunk;
    }
  },
};
