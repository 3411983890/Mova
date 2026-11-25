Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinList {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<string> Results = new List<string>();
  public static bool Callback(IntPtr h, IntPtr p) {
    var t = new StringBuilder(512);
    var c = new StringBuilder(256);
    GetWindowTextW(h, t, 512);
    GetClassNameW(h, c, 256);
    RECT r; GetWindowRect(h, out r);
    uint pid; GetWindowThreadProcessId(h, out pid);
    string title = t.ToString();
    string cls = c.ToString();
    if (title.Length == 0 && cls.Length == 0) return true;
    Results.Add("{" + "\"hwnd\":" + h.ToInt64() + ",\"pid\":" + pid + ",\"title\":\"" + Escape(title) + "\",\"cls\":\"" + Escape(cls) + "\",\"visible\":" + (IsWindowVisible(h) ? "true" : "false") + ",\"x\":" + r.Left + ",\"y\":" + r.Top + ",\"w\":" + (r.Right - r.Left) + ",\"h\":" + (r.Bottom - r.Top) + "}");
    return true;
  }
  static string Escape(string s) {
    var sb = new StringBuilder();
    foreach (char ch in s) {
      if (ch == '"' || ch == '\\') sb.Append('\\').Append(ch);
      else if (ch < 32) sb.Append(' ');
      else sb.Append(ch);
    }
    return sb.ToString();
  }
  public static string Dump() {
    Results.Clear();
    SetProcessDPIAware();
    EnumWindows(new EnumProc(Callback), IntPtr.Zero);
    return "[" + string.Join(",", Results) + "]";
  }
}
'@

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$json = [WinList]::Dump()
[Console]::Out.Write($json)
