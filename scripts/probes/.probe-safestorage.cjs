// 精确探测 Electron 45 的 safeStorage 异步 API 返回形状。
const { app, safeStorage } = require('electron');

app.whenReady().then(async () => {
  const describe = value => {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (Buffer.isBuffer(value)) return `Buffer(${value.length}) => ${JSON.stringify(value.toString('utf8').slice(0, 40))}`;
    if (typeof value === 'string') return `string => ${JSON.stringify(value)}`;
    if (typeof value === 'object') return `object keys=[${Object.keys(value).join(',')}]`;
    return `${typeof value} => ${String(value)}`;
  };

  const out = {};

  const pending = safeStorage.isAsyncEncryptionAvailable();
  out.isAsync_awaited = await pending;
  out.isAsync_typeof = typeof pending;

  try {
    const encrypted = await safeStorage.encryptStringAsync('mova-probe');
    out.encrypted = describe(encrypted);

    const viaBuffer = await safeStorage.decryptStringAsync(encrypted);
    out.decrypt_raw = describe(viaBuffer);
    out.decrypt_toString = Buffer.isBuffer(viaBuffer)
      ? JSON.stringify(viaBuffer.toString('utf8'))
      : JSON.stringify(String(viaBuffer));

    // 也试一下同步接口解同一段密文，确认两者互通
    try {
      out.decrypt_sync = JSON.stringify(safeStorage.decryptString(encrypted));
    } catch (error) {
      out.decrypt_sync = `throw:${error.message}`;
    }
  } catch (error) {
    out.encryptError = `throw:${error.message}`;
  }

  console.log(JSON.stringify(out, null, 2));
  app.quit();
});
