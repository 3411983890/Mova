/**
 * 负责：输入栏的粘贴、听写帮助和当前模式菜单。
 * 不负责：申请麦克风权限、上传录音或伪装语音识别。
 * 被谁调用：chat-composer。
 */
import { Alert } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { showActionMenu } from '../../components/show-action-menu';
import { MAX_MESSAGE_LENGTH } from './chat-state';

/** 用户主动选择粘贴时读取文字；超长内容要求拆分而不静默截断。 */
export function openInsertMenu(onPaste: (text: string) => void, onClear: () => void) {
  showActionMenu('添加内容', [
    { title: '粘贴文字', run: () => void pasteText(onPaste) },
    { title: '清空输入', run: onClear },
  ]);
}
async function pasteText(onPaste: (text: string) => void) {
  try {
    const text = await Clipboard.getStringAsync();
    if (!text.trim()) { Alert.alert('没有可粘贴的文字'); return; }
    if (text.length > MAX_MESSAGE_LENGTH) { Alert.alert('文字过长', `请拆分为每次不超过 ${MAX_MESSAGE_LENGTH} 字符的内容。`); return; }
    onPaste(text);
  } catch { Alert.alert('无法粘贴', '请长按输入框使用系统粘贴菜单。'); }
}

/** 继续使用系统键盘的听写入口，不假装存在独立语音识别服务。 */
export function showDictationHelp(focus: () => void) {
  focus();
  Alert.alert('使用键盘听写', '点击系统键盘上的麦克风，即可将语音输入为文字。', [{ text: '知道了', onPress: focus }]);
}

/** 明确区分演示模式与尚未连接的真实模型。 */
export function openModelMenu(openSettings: () => void) {
  showActionMenu('当前使用本地演示回复', [{ title: '打开设置', run: openSettings }]);
}
