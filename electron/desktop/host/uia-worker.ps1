# Mova desktop UIA worker: long-lived PowerShell process (UIA2 + a little user32).
# Protocol: one JSON request per stdin line {id,cmd,args}; one JSON response per stdout line,
#           either {id,ok:true,result} or {id,ok:false,code,message}.
# IMPORTANT: keep this file pure ASCII. Windows PowerShell 5.1 decodes .ps1 sources with the
# system code page (GBK on this machine) unless the file carries a UTF-8 BOM; a stray CJK byte
# can then eat a newline and break parsing. Chinese text lives in the JS layer instead.
# Runtime data (window titles, input values) is Unicode and round-trips as UTF-8.

$ErrorActionPreference = 'Stop'

# Encoding first: never depend on the system code page for stdin/stdout.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
try { [Console]::InputEncoding = [Text.Encoding]::UTF8 } catch { }

$script:version = '1.0.0'
$script:uiaReady = $false
$script:quit = $false
$script:refMap = @{}
$script:refSeq = 0
$script:windowIndex = @{}
$script:nextWindowIndex = 1
$script:exeCache = @{}

function Write-Line {
  param([string]$Text)
  [Console]::Out.WriteLine($Text)
  [Console]::Out.Flush()
}

function Write-Log {
  param([string]$Text)
  [Console]::Error.WriteLine('[uia-worker] ' + $Text)
}

function Fail {
  param([string]$Code, [string]$Message)
  $ex = New-Object System.Exception($Message)
  $ex.Data['movaCode'] = $Code
  throw $ex
}

# ---- user32 / shcore: DPI, foreground window, rectangles
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace MovaNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  public static class Win32 {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
    [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hmon, int dpiType, out uint dpiX, out uint dpiY);
  }
}
"@ | Out-Null

# ---- DPI: PerMonitorV2 first (context -4), fall back to SetProcessDPIAware, so rects are physical pixels
$script:dpiMode = 'none'
try {
  if ([MovaNative.Win32]::SetProcessDpiAwarenessContext([IntPtr](-4))) { $script:dpiMode = 'permonitorv2' }
} catch { }
if ($script:dpiMode -eq 'none') {
  try { if ([MovaNative.Win32]::SetProcessDPIAware()) { $script:dpiMode = 'system' } } catch { }
}

# ---- UIA2
try {
  Add-Type -AssemblyName UIAutomationClient | Out-Null
  Add-Type -AssemblyName UIAutomationTypes | Out-Null
  $script:uiaReady = $true
} catch {
  Write-Log ('UIA load failed: ' + $_.Exception.Message)
}

$script:TrueCondition = $null
$script:ChildrenScope = $null
$script:RootElement = $null
if ($script:uiaReady) {
  $script:TrueCondition = [System.Windows.Automation.Condition]::TrueCondition
  $script:ChildrenScope = [System.Windows.Automation.TreeScope]::Children
  $script:RootElement = [System.Windows.Automation.AutomationElement]::RootElement
}

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

function Assert-Uia {
  if (-not $script:uiaReady) { Fail 'uia-unavailable' 'UIA could not be loaded in this worker' }
}

function Get-ToInt {
  param($Value, [int]$Fallback = 0)
  try {
    if ($null -eq $Value) { return $Fallback }
    $d = [double]$Value
    if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return $Fallback }
    return [int][Math]::Round($d)
  } catch { return $Fallback }
}

# Rect -> [x,y,w,h]; minimized windows report Infinity, so non-finite values collapse to zero.
function Get-SanitizedRect {
  param($Rect)
  $x = 0; $y = 0; $w = 0; $h = 0
  try {
    if ($null -ne $Rect) {
      $x = Get-ToInt $Rect.X 0
      $y = Get-ToInt $Rect.Y 0
      $rw = Get-ToInt $Rect.Width 0
      $rh = Get-ToInt $Rect.Height 0
      if ($rw -gt 0 -and $rh -gt 0) { $w = $rw; $h = $rh }
    }
  } catch { }
  return @($x, $y, $w, $h)
}

function Get-ShortText {
  param([string]$Text, [int]$Max)
  if ($null -eq $Text) { return '' }
  $s = [string]$Text
  $s = $s -replace "[\u0000-\u0008\u000b\u000c\u000e-\u001f]", ' '
  if ($s.Length -gt $Max) { $s = $s.Substring(0, $Max) }
  return $s
}

# "ControlType.Button" -> "button"
function Convert-RoleName {
  param($ControlType)
  if ($null -eq $ControlType) { return 'custom' }
  try {
    $name = [string]$ControlType.ProgrammaticName
    if (-not $name) { return 'custom' }
    return ($name -replace '^ControlType\.', '').ToLowerInvariant()
  } catch { return 'custom' }
}

# "InvokePatternIdentifiers.Pattern" -> "invoke"
function Convert-PatternName {
  param($Name)
  if ($null -eq $Name) { return '' }
  $s = [string]$Name
  $s = $s -replace 'PatternIdentifiers\.Pattern$', ''
  $s = $s -replace 'Pattern$', ''
  $s = $s.ToLowerInvariant()
  if ($s -eq 'legacyiaccessible') { return 'legacy' }
  return $s
}

function Get-PatternNames {
  param($Element)
  $names = New-Object 'System.Collections.Generic.List[string]'
  try {
    $raw = $Element.GetSupportedPatterns()
    if ($null -ne $raw) {
      foreach ($p in $raw) {
        $n = Convert-PatternName $p.ProgrammaticName
        if ($n) { $names.Add($n) }
      }
    }
  } catch { }
  # Leading comma keeps a one-element array from being unrolled into a scalar.
  return ,($names.ToArray())
}

function Get-HwndLong {
  param($Value)
  try { return [long]$Value } catch { return 0 }
}

function Get-ForegroundHwnd {
  try { return [long][MovaNative.Win32]::GetForegroundWindow().ToInt64() } catch { return 0 }
}

# w<n>.<seq> prefix: the window index is sticky per hwnd for the worker lifetime.
function Get-WindowIndex {
  param([long]$Hwnd)
  $key = [string]$Hwnd
  if (-not $script:windowIndex.ContainsKey($key)) {
    $script:windowIndex[$key] = $script:nextWindowIndex
    $script:nextWindowIndex = $script:nextWindowIndex + 1
  }
  return [int]$script:windowIndex[$key]
}

function Get-ExeName {
  param([int]$ProcessId)
  if ($ProcessId -le 0) { return '' }
  $key = [string]$ProcessId
  if ($script:exeCache.ContainsKey($key)) { return [string]$script:exeCache[$key] }
  $name = ''
  try {
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -ne $p -and $p.ProcessName) { $name = ([string]$p.ProcessName) + '.exe' }
  } catch { }
  $script:exeCache[$key] = $name
  return $name
}

function Get-WindowRecord {
  param($Element)
  Assert-Uia
  $cur = $null
  try { $cur = $Element.Current } catch { return $null }

  $hwnd = Get-HwndLong $cur.NativeWindowHandle
  if ($hwnd -le 0) { return $null }
  $procId = 0
  try { $procId = [int]$cur.ProcessId } catch { $procId = 0 }
  $minimized = $false
  $visible = $true
  try { $minimized = [MovaNative.Win32]::IsIconic([IntPtr]$hwnd) } catch { }
  try { $visible = [MovaNative.Win32]::IsWindowVisible([IntPtr]$hwnd) } catch { }
  if (-not $visible) { return $null }
  $rect = Get-SanitizedRect $cur.BoundingRectangle
  if ((-not $minimized) -and ($rect[2] -le 0 -or $rect[3] -le 0)) { return $null }

  $hwndIndex = Get-WindowIndex $hwnd
  return [pscustomobject]@{
    hwnd = $hwnd
    pid = $procId
    exe = Get-ExeName $procId
    title = Get-ShortText ([string]$cur.Name) 200
    class = [string]$cur.ClassName
    rect = $rect
    foreground = [bool]($hwnd -eq (Get-ForegroundHwnd))
    minimized = [bool]$minimized
    index = $hwndIndex
  }
}

# ---------------------------------------------------------------------------
# ref -> AutomationElement
# ---------------------------------------------------------------------------

function Get-ElementByRef {
  param([string]$Ref)
  if (-not $Ref) { Fail 'stale-ref' 'ref is required' }
  $key = ([string]$Ref).Trim()
  if (-not $script:refMap.ContainsKey($key)) {
    Fail 'stale-ref' ('unknown ref ' + $key + ', take a new snapshot')
  }
  $el = $script:refMap[$key]
  if ($null -eq $el) { Fail 'stale-ref' ('ref ' + $key + ' is no longer valid') }
  return $el
}

function Assert-ElementEnabled {
  param($Element)
  $enabled = $true
  $alive = $true
  try { $enabled = [bool]$Element.Current.IsEnabled } catch { $alive = $false }
  if (-not $alive) { Fail 'stale-ref' 'element is gone' }
  if (-not $enabled) { Fail 'disabled' 'element is disabled' }
}

function Get-ErrorCode {
  param($Exception)
  if ($null -eq $Exception) { return 'failed' }
  try {
    if ($Exception.Data -and $Exception.Data.Contains('movaCode')) { return [string]$Exception.Data['movaCode'] }
  } catch { }
  $typeName = ''
  try { $typeName = $Exception.GetType().Name } catch { }
  switch ($typeName) {
    'ElementNotAvailableException' { return 'stale-ref' }
    'ElementNotEnabledException' { return 'disabled' }
    'InvalidOperationException' { return 'pattern-unsupported' }
  }
  return 'failed'
}

# ---------------------------------------------------------------------------
# tree
# ---------------------------------------------------------------------------

function Get-NodeRecord {
  param($Element, [int]$Depth, [string]$ParentRef, [string]$Prefix)

  $cur = $null
  try { $cur = $Element.Current } catch { return $null }

  $password = $false
  try { $password = [bool]$cur.IsPassword } catch { $password = $false }
  $role = Convert-RoleName $cur.ControlType
  $name = Get-ShortText ([string]$cur.Name) 120
  $rect = Get-SanitizedRect $cur.BoundingRectangle
  $patterns = Get-PatternNames $Element

  $selected = $null
  $expanded = $null
  $toggled = $null
  $value = $null

  if ($patterns -contains 'selectionitem') {
    $pat = $null
    try {
      if ($Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) {
        $selected = [bool]$pat.Current.IsSelected
      }
    } catch { }
  }
  if ($patterns -contains 'expandcollapse') {
    $pat = $null
    try {
      if ($Element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pat)) {
        $state = [string]$pat.Current.ExpandCollapseState
        if ($state -eq 'Expanded') { $expanded = $true }
        elseif ($state -eq 'Collapsed') { $expanded = $false }
        elseif ($state -eq 'PartiallyExpanded') { $expanded = 'partial' }
      }
    } catch { }
  }
  if ($patterns -contains 'toggle') {
    $pat = $null
    try {
      if ($Element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) {
        $state = [string]$pat.Current.ToggleState
        if ($state -eq 'On') { $toggled = $true }
        elseif ($state -eq 'Off') { $toggled = $false }
        elseif ($state -eq 'Indeterminate') { $toggled = 'indeterminate' }
      }
    } catch { }
  }
  # Password fields never return their value.
  if ($password) {
    $value = $null
  } elseif ($patterns -contains 'value') {
    $pat = $null
    try {
      if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pat)) {
        $value = Get-ShortText ([string]$pat.Current.Value) 200
      }
    } catch { $value = $null }
  }

  $script:refSeq = $script:refSeq + 1
  $ref = $Prefix + [string]$script:refSeq

  $enabled = $true
  $focusable = $false
  $offscreen = $false
  $focused = $false
  try { $enabled = [bool]$cur.IsEnabled } catch { $enabled = $true }
  try { $focusable = [bool]$cur.IsKeyboardFocusable } catch { $focusable = $false }
  try { $offscreen = [bool]$cur.IsOffscreen } catch { $offscreen = $false }
  try { $focused = [bool]$cur.HasKeyboardFocus } catch { $focused = $false }

  $automationId = ''
  try { $automationId = [string]$cur.AutomationId } catch { $automationId = '' }
  $className = ''
  try { $className = [string]$cur.ClassName } catch { $className = '' }
  if ($className.Length -gt 120) { $className = $className.Substring(0, 120) }

  return [pscustomobject]@{
    ref = $ref
    role = $role
    name = $name
    automationId = $automationId
    className = $className
    rect = $rect
    depth = $Depth
    parent = $ParentRef
    states = [pscustomobject]@{
      enabled = $enabled
      focusable = $focusable
      offscreen = $offscreen
      password = $password
      selected = $selected
      expanded = $expanded
      toggled = $toggled
      focused = $focused
    }
    value = $value
    patterns = $patterns
  }
}

function Invoke-TreeWalk {
  param($Element, [int]$Depth, [string]$ParentRef)
  if ($null -eq $Element) { return }
  if ($script:walkTimedOut -or $script:walkTruncated) { return }
  if ($script:walkSw.ElapsedMilliseconds -gt $script:walkDeadlineMs) { $script:walkTimedOut = $true; return }
  if ($Depth -gt $script:walkMaxDepth) { $script:walkTruncated = $true; return }

  $myRef = $ParentRef
  $rec = Get-NodeRecord -Element $Element -Depth $Depth -ParentRef $ParentRef -Prefix $script:walkPrefix
  if ($null -ne $rec) {
    # Offscreen subtree is dropped entirely (a scrolled-away container rarely holds visible children).
    if (($rec.states.offscreen) -and (-not $script:walkIncludeOffscreen)) { return }
    $script:walkNodes.Add($rec) | Out-Null
    $script:refMap[$rec.ref] = $Element
    $myRef = $rec.ref
  }

  if ($Depth -ge $script:walkMaxDepth) { return }
  $kids = $null
  try { $kids = $Element.FindAll($script:ChildrenScope, $script:TrueCondition) } catch { return }
  if ($null -eq $kids) { return }
  foreach ($kid in $kids) {
    if ($script:walkTimedOut -or $script:walkTruncated) { return }
    if ($script:walkNodes.Count -ge $script:walkMaxNodes) { $script:walkTruncated = $true; return }
    if ($script:walkSw.ElapsedMilliseconds -gt $script:walkDeadlineMs) { $script:walkTimedOut = $true; return }
    Invoke-TreeWalk -Element $kid -Depth ($Depth + 1) -ParentRef $myRef
  }
}

# Rebuilds the tree and invalidates every previous ref (old refs -> stale-ref).
function Invoke-TreeBuild {
  param([long]$Hwnd, [int]$MaxDepth, [int]$MaxNodes, [int]$DeadlineMs, [bool]$IncludeOffscreen)

  Assert-Uia
  $el = $null
  try { $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Hwnd) } catch { $el = $null }
  if ($null -eq $el) { Fail 'no-window' ('no UIA element for hwnd ' + $Hwnd) }

  $script:refMap = @{}
  $script:refSeq = 0
  $script:walkNodes = New-Object 'System.Collections.Generic.List[object]'
  $script:walkMaxDepth = [Math]::Max(0, [Math]::Min(20, $MaxDepth))
  $script:walkMaxNodes = [Math]::Max(1, [Math]::Min(20000, $MaxNodes))
  $script:walkDeadlineMs = [Math]::Max(50, $DeadlineMs)
  $script:walkIncludeOffscreen = $IncludeOffscreen
  $script:walkTruncated = $false
  $script:walkTimedOut = $false
  $script:walkPrefix = 'w' + (Get-WindowIndex $Hwnd) + '.'
  $script:walkSw = [System.Diagnostics.Stopwatch]::StartNew()

  $window = Get-WindowRecord $el
  if ($null -eq $window) {
    $window = [pscustomobject]@{
      hwnd = $Hwnd; pid = 0; exe = ''; title = ''; class = ''
      rect = @(0, 0, 0, 0); foreground = $false; minimized = $false
      index = (Get-WindowIndex $Hwnd)
    }
  }

  Invoke-TreeWalk -Element $el -Depth 0 -ParentRef ''
  $script:walkSw.Stop()

  return [pscustomobject]@{
    hwnd = $Hwnd
    window = $window
    nodes = $script:walkNodes.ToArray()
    truncated = [bool]$script:walkTruncated
    timedOut = [bool]$script:walkTimedOut
    elapsedMs = [int]$script:walkSw.ElapsedMilliseconds
  }
}

# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------

function Invoke-Ping {
  return [pscustomobject]@{
    pid = $PID
    uia = [bool]$script:uiaReady
    version = $script:version
    dpiMode = $script:dpiMode
  }
}

function Invoke-Windows {
  param($CommandArgs)
  Assert-Uia
  $includeMinimized = $true
  if ($null -ne $CommandArgs -and $null -ne $CommandArgs.includeMinimized) {
    $includeMinimized = [bool]$CommandArgs.includeMinimized
  }
  $list = New-Object 'System.Collections.Generic.List[object]'
  $tops = $null
  try { $tops = $script:RootElement.FindAll($script:ChildrenScope, $script:TrueCondition) } catch {
    Fail 'uia-failed' ('enumerate top-level windows failed: ' + $_.Exception.Message)
  }
  foreach ($el in $tops) {
    $rec = Get-WindowRecord $el
    if ($null -eq $rec) { continue }
    if ($rec.minimized -and (-not $includeMinimized)) { continue }
    $list.Add($rec) | Out-Null
  }
  return [pscustomobject]@{ windows = $list.ToArray() }
}

function Invoke-Foreground {
  Assert-Uia
  $hwnd = Get-ForegroundHwnd
  if ($hwnd -le 0) { return [pscustomobject]@{ window = $null } }
  $el = $null
  try { $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd) } catch { $el = $null }
  if ($null -eq $el) { return [pscustomobject]@{ window = $null } }
  return [pscustomobject]@{ window = (Get-WindowRecord $el) }
}

function Invoke-Tree {
  param($CommandArgs)
  if ($null -eq $CommandArgs -or $null -eq $CommandArgs.hwnd) { Fail 'invalid-args' 'hwnd is required' }
  $hwnd = Get-HwndLong $CommandArgs.hwnd
  if ($hwnd -le 0) { Fail 'invalid-args' 'hwnd must be a positive number' }
  $maxDepth = 6
  $maxNodes = 2000
  $deadlineMs = 1500
  $includeOffscreen = $false
  if ($null -ne $CommandArgs.maxDepth) { $maxDepth = [int]$CommandArgs.maxDepth }
  if ($null -ne $CommandArgs.maxNodes) { $maxNodes = [int]$CommandArgs.maxNodes }
  if ($null -ne $CommandArgs.deadlineMs) { $deadlineMs = [int]$CommandArgs.deadlineMs }
  if ($null -ne $CommandArgs.includeOffscreen) { $includeOffscreen = [bool]$CommandArgs.includeOffscreen }
  return (Invoke-TreeBuild -Hwnd $hwnd -MaxDepth $maxDepth -MaxNodes $maxNodes -DeadlineMs $deadlineMs -IncludeOffscreen $includeOffscreen)
}

function Test-SegmentMatch {
  param($Node, $Segment)
  $segRole = ''
  $segName = ''
  if ($Segment -is [string]) {
    $text = [string]$Segment
    if ($text -match '^[A-Za-z]+$') { $segRole = $text.ToLowerInvariant() } else { $segName = $text }
  } else {
    if ($null -ne $Segment.role) { $segRole = ([string]$Segment.role).ToLowerInvariant() }
    if ($null -ne $Segment.name) { $segName = [string]$Segment.name }
  }
  if ($segRole -and $Node.role -ne $segRole) { return $false }
  if ($segName -and $Node.name -ne $segName) { return $false }
  return $true
}

# by: {automationId?|name?|role?|path?[]}; path runs outermost -> innermost.
function Invoke-Find {
  param($CommandArgs)
  if ($null -eq $CommandArgs -or $null -eq $CommandArgs.hwnd) { Fail 'invalid-args' 'hwnd is required' }
  if ($null -eq $CommandArgs.by) { Fail 'invalid-args' 'by is required' }
  $by = $CommandArgs.by
  $hwnd = Get-HwndLong $CommandArgs.hwnd
  $limit = 2500
  if ($null -ne $CommandArgs.maxNodes) { $limit = [int]$CommandArgs.maxNodes }
  $tree = Invoke-TreeBuild -Hwnd $hwnd -MaxDepth 10 -MaxNodes $limit -DeadlineMs 2500 -IncludeOffscreen $false

  $wantId = ''
  $wantName = ''
  $wantRole = ''
  $wantPath = $null
  if ($null -ne $by.automationId) { $wantId = [string]$by.automationId }
  if ($null -ne $by.name) { $wantName = [string]$by.name }
  if ($null -ne $by.role) { $wantRole = ([string]$by.role).ToLowerInvariant() }
  if ($null -ne $by.path) { $wantPath = @($by.path) }
  if ((-not $wantId) -and (-not $wantName) -and (-not $wantRole) -and ($null -eq $wantPath)) {
    Fail 'invalid-args' 'by needs at least one of automationId/name/role/path'
  }

  $byRef = @{}
  foreach ($node in $tree.nodes) { $byRef[$node.ref] = $node }

  $loose = $null
  foreach ($node in $tree.nodes) {
    if ($wantId -and ($node.automationId -ne $wantId)) { continue }
    if ($wantRole -and ($node.role -ne $wantRole)) { continue }
    if ($wantName) {
      if ($node.name -eq $wantName) { }
      elseif ($node.name.ToLowerInvariant().Contains($wantName.ToLowerInvariant())) {
        if ($null -eq $loose) { $loose = $node }
        continue
      } else { continue }
    }
    if ($null -ne $wantPath) {
      $chain = New-Object 'System.Collections.Generic.List[object]'
      $cursor = $node
      while ($null -ne $cursor) {
        $chain.Insert(0, $cursor) | Out-Null
        if ($cursor.parent -and $byRef.ContainsKey($cursor.parent)) { $cursor = $byRef[$cursor.parent] } else { $cursor = $null }
      }
      if ($chain.Count -lt $wantPath.Count) { continue }
      $start = $chain.Count - $wantPath.Count
      $ok = $true
      for ($i = 0; $i -lt $wantPath.Count; $i++) {
        if (-not (Test-SegmentMatch -Node $chain[$start + $i] -Segment $wantPath[$i])) { $ok = $false; break }
      }
      if (-not $ok) { continue }
    }
    return [pscustomobject]@{ node = $node; truncated = $tree.truncated; timedOut = $tree.timedOut }
  }

  if ($null -ne $loose) {
    return [pscustomobject]@{ node = $loose; truncated = $tree.truncated; timedOut = $tree.timedOut; loose = $true }
  }
  Fail 'not-found' 'no element matched the given by filter'
}

function Invoke-Invoke {
  param($CommandArgs)
  $el = Get-ElementByRef ([string]$CommandArgs.ref)
  Assert-ElementEnabled $el

  $pat = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) {
      $pat.Invoke()
      return [pscustomobject]@{ ok = $true; via = 'invoke' }
    }
  } catch {
    Fail (Get-ErrorCode $_.Exception) $_.Exception.Message
  }

  $legacy = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref]$legacy)) {
      $legacy.DoDefaultAction()
      return [pscustomobject]@{ ok = $true; via = 'legacy' }
    }
  } catch {
    Fail (Get-ErrorCode $_.Exception) $_.Exception.Message
  }

  Fail 'pattern-unsupported' 'element has no InvokePattern and no default action'
}

function Invoke-SetValue {
  param($CommandArgs)
  $el = Get-ElementByRef ([string]$CommandArgs.ref)
  Assert-ElementEnabled $el
  $text = ''
  if ($null -ne $CommandArgs.text) { $text = [string]$CommandArgs.text }

  $pat = $null
  $hasPattern = $false
  try { $hasPattern = $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pat) } catch { $hasPattern = $false }
  if (-not $hasPattern) { Fail 'pattern-unsupported' 'element has no ValuePattern' }

  $readOnly = $false
  try { $readOnly = [bool]$pat.Current.IsReadOnly } catch { $readOnly = $false }
  if ($readOnly) { Fail 'failed' 'value is read-only' }

  try {
    $pat.SetValue($text)
    return [pscustomobject]@{ ok = $true; via = 'value' }
  } catch {
    Fail (Get-ErrorCode $_.Exception) $_.Exception.Message
  }
}

function Convert-ScrollAmount {
  param($Value)
  if ($null -eq $Value) { return 'NoAmount' }
  if ($Value -is [string]) {
    $text = ([string]$Value).ToLowerInvariant()
    if ($text -eq 'largeincrement' -or $text -eq 'largeincrease' -or $text -eq 'large' -or $text -eq 'down' -or $text -eq 'right') { return 'LargeIncrement' }
    if ($text -eq 'smallincrement' -or $text -eq 'smallincrease' -or $text -eq 'small') { return 'SmallIncrement' }
    if ($text -eq 'largedecrement' -or $text -eq 'largedecrease' -or $text -eq 'up' -or $text -eq 'left') { return 'LargeDecrement' }
    if ($text -eq 'smalldecrement' -or $text -eq 'smalldecrease') { return 'SmallDecrement' }
    return 'NoAmount'
  }
  try {
    $n = [double]$Value
    if ($n -gt 0) { return 'LargeIncrement' }
    if ($n -lt 0) { return 'LargeDecrement' }
  } catch { }
  return 'NoAmount'
}

function Invoke-Pattern {
  param($CommandArgs)
  $el = Get-ElementByRef ([string]$CommandArgs.ref)
  $name = ''
  if ($null -ne $CommandArgs.name) { $name = ([string]$CommandArgs.name).ToLowerInvariant() }
  if (-not $name) { Fail 'invalid-args' 'pattern name is required' }
  $extra = $CommandArgs.args
  Assert-ElementEnabled $el

  try {
    if ($name -eq 'invoke') {
      $pat = $null
      if (-not $el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) {
        Fail 'pattern-unsupported' 'no InvokePattern'
      }
      $pat.Invoke()
      return [pscustomobject]@{ ok = $true; value = $null }
    }
    if ($name -eq 'value') {
      $pat = $null
      if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pat)) {
        Fail 'pattern-unsupported' 'no ValuePattern'
      }
      if ($null -ne $extra -and $null -ne $extra.text) {
        if ($pat.Current.IsReadOnly) { Fail 'failed' 'value is read-only' }
        $pat.SetValue([string]$extra.text)
        return [pscustomobject]@{ ok = $true; value = $null }
      }
      return [pscustomobject]@{ ok = $true; value = [string]$pat.Current.Value }
    }
    if ($name -eq 'toggle') {
      $pat = $null
      if (-not $el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) {
        Fail 'pattern-unsupported' 'no TogglePattern'
      }
      $before = [string]$pat.Current.ToggleState
      if ($null -ne $extra -and $null -ne $extra.toggle) {
        $want = ([string]$extra.toggle).ToLowerInvariant()
        if ($want -eq 'on' -and $before -eq 'On') { return [pscustomobject]@{ ok = $true; value = 'On'; unchanged = $true } }
        if ($want -eq 'off' -and $before -eq 'Off') { return [pscustomobject]@{ ok = $true; value = 'Off'; unchanged = $true } }
      }
      $pat.Toggle()
      return [pscustomobject]@{ ok = $true; value = [string]$pat.Current.ToggleState }
    }
    if ($name -eq 'selectionitem') {
      $pat = $null
      if (-not $el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) {
        Fail 'pattern-unsupported' 'no SelectionItemPattern'
      }
      $op = 'select'
      if ($null -ne $extra -and $null -ne $extra.op) { $op = ([string]$extra.op).ToLowerInvariant() }
      if ($op -eq 'add') { $pat.AddToSelection() }
      elseif ($op -eq 'remove') { $pat.RemoveFromSelection() }
      else { $pat.Select() }
      return [pscustomobject]@{ ok = $true; value = [bool]$pat.Current.IsSelected }
    }
    if ($name -eq 'expandcollapse') {
      $pat = $null
      if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pat)) {
        Fail 'pattern-unsupported' 'no ExpandCollapsePattern'
      }
      $state = 'expand'
      if ($null -ne $extra -and $null -ne $extra.state) { $state = ([string]$extra.state).ToLowerInvariant() }
      elseif ($null -ne $extra -and $null -ne $extra.expand) { if (-not [bool]$extra.expand) { $state = 'collapse' } }
      if ($state -eq 'collapse') { $pat.Collapse() } else { $pat.Expand() }
      return [pscustomobject]@{ ok = $true; value = [string]$pat.Current.ExpandCollapseState }
    }
    if ($name -eq 'scroll') {
      $pat = $null
      if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$pat)) {
        Fail 'pattern-unsupported' 'no ScrollPattern'
      }
      $h = 'NoAmount'
      $v = 'NoAmount'
      if ($null -ne $extra) {
        if ($null -ne $extra.horizontal) { $h = Convert-ScrollAmount $extra.horizontal }
        if ($null -ne $extra.vertical) { $v = Convert-ScrollAmount $extra.vertical }
      }
      $pat.Scroll([System.Windows.Automation.ScrollAmount]$h, [System.Windows.Automation.ScrollAmount]$v)
      return [pscustomobject]@{ ok = $true; value = $null }
    }
    if ($name -eq 'scrollitem') {
      $pat = $null
      if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$pat)) {
        Fail 'pattern-unsupported' 'no ScrollItemPattern'
      }
      $pat.ScrollIntoView()
      return [pscustomobject]@{ ok = $true; value = 'intoView' }
    }
    if ($name -eq 'rangevalue') {
      $pat = $null
      if (-not $el.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref]$pat)) {
        Fail 'pattern-unsupported' 'no RangeValuePattern'
      }
      if ($null -ne $extra -and $null -ne $extra.value) {
        $pat.SetValue([double]$extra.value)
      }
      return [pscustomobject]@{ ok = $true; value = [double]$pat.Current.Value }
    }
    if ($name -eq 'window') {
      $pat = $null
      if (-not $el.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$pat)) {
        Fail 'pattern-unsupported' 'no WindowPattern'
      }
      $op = 'restore'
      if ($null -ne $extra -and $null -ne $extra.op) { $op = ([string]$extra.op).ToLowerInvariant() }
      if ($op -eq 'minimize') { $pat.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Minimized) }
      elseif ($op -eq 'maximize') { $pat.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Maximized) }
      elseif ($op -eq 'restore') { $pat.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Normal) }
      elseif ($op -eq 'close') { $pat.Close() }
      else { Fail 'invalid-args' ('unknown window op ' + $op) }
      return [pscustomobject]@{ ok = $true; value = $op }
    }
    if ($name -eq 'text') {
      $pat = $null
      if (-not $el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pat)) {
        Fail 'pattern-unsupported' 'no TextPattern'
      }
      $max = 4000
      if ($null -ne $extra -and $null -ne $extra.maxChars) { $max = [Math]::Max(1, [int]$extra.maxChars) }
      $text = [string]$pat.DocumentRange.GetText($max)
      return [pscustomobject]@{ ok = $true; value = $text }
    }
  } catch {
    Fail (Get-ErrorCode $_.Exception) $_.Exception.Message
  }
  Fail 'pattern-unsupported' ('unknown pattern ' + $name)
}

function Invoke-Rect {
  param($CommandArgs)
  $el = Get-ElementByRef ([string]$CommandArgs.ref)
  $raw = $null
  try { $raw = $el.Current.BoundingRectangle } catch { Fail 'stale-ref' 'element is gone' }
  $rect = Get-SanitizedRect $raw
  if ($rect[2] -le 0 -or $rect[3] -le 0) { Fail 'not-visible' 'element has an empty rectangle' }
  $cx = [int]($rect[0] + [Math]::Floor($rect[2] / 2))
  $cy = [int]($rect[1] + [Math]::Floor($rect[3] / 2))
  return [pscustomobject]@{ rect = $rect; clickable = @($cx, $cy) }
}

function Invoke-Focus {
  param($CommandArgs)
  $el = Get-ElementByRef ([string]$CommandArgs.ref)
  Assert-ElementEnabled $el
  try {
    $el.SetFocus()
    return [pscustomobject]@{ ok = $true }
  } catch {
    Fail (Get-ErrorCode $_.Exception) $_.Exception.Message
  }
}

function Invoke-ReadText {
  param($CommandArgs)
  $el = Get-ElementByRef ([string]$CommandArgs.ref)
  $max = 4000
  if ($null -ne $CommandArgs.maxChars) { $max = [Math]::Max(1, [int]$CommandArgs.maxChars) }

  $text = ''
  $pat = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pat)) {
      $text = [string]$pat.DocumentRange.GetText($max + 1)
    }
  } catch { }

  if (-not $text) {
    $vp = $null
    try {
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
        $text = [string]$vp.Current.Value
      }
    } catch { }
  }
  if (-not $text) {
    try { $text = [string]$el.Current.Name } catch { $text = '' }
  }

  $truncated = $false
  if ($text.Length -gt $max) { $text = $text.Substring(0, $max); $truncated = $true }
  return [pscustomobject]@{ text = $text; truncated = $truncated }
}

function Invoke-Activate {
  param($CommandArgs)
  if ($null -eq $CommandArgs -or $null -eq $CommandArgs.hwnd) { Fail 'invalid-args' 'hwnd is required' }
  $hwnd = Get-HwndLong $CommandArgs.hwnd
  if ($hwnd -le 0) { Fail 'invalid-args' 'hwnd must be a positive number' }
  $h = [IntPtr]$hwnd

  $restored = $false
  try {
    if ([MovaNative.Win32]::IsIconic($h)) {
      [MovaNative.Win32]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
      $restored = $true
    }
  } catch { }

  $ok = $false
  try { $ok = [MovaNative.Win32]::SetForegroundWindow($h) } catch { $ok = $false }

  if (-not $ok) {
    # Foreground lock: Windows refuses SetForegroundWindow from a non-foreground process.
    # Tapping ALT resets the lock (documented workaround), then retry. Also raise z-order so the
    # window is actually visible above occluders, not just "active".
    try {
      [MovaNative.Win32]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
      [MovaNative.Win32]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 60
    } catch { }
    try { [MovaNative.Win32]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x0043) | Out-Null } catch { }
    try { [MovaNative.Win32]::BringWindowToTop($h) | Out-Null } catch { }
    try { $ok = [MovaNative.Win32]::SetForegroundWindow($h) } catch { $ok = $false }
  }

  if (-not $ok) {
    # Usual workaround: AttachThreadInput to the foreground thread, then retry.
    try {
      $fgHwnd = [MovaNative.Win32]::GetForegroundWindow()
      $fgPid = [uint32]0
      $fgThread = [MovaNative.Win32]::GetWindowThreadProcessId($fgHwnd, [ref]$fgPid)
      $myThread = [MovaNative.Win32]::GetCurrentThreadId()
      if ($fgThread -gt 0) {
        [MovaNative.Win32]::AttachThreadInput($myThread, $fgThread, $true) | Out-Null
        try { $ok = [MovaNative.Win32]::SetForegroundWindow($h) } finally {
          [MovaNative.Win32]::AttachThreadInput($myThread, $fgThread, $false) | Out-Null
        }
      }
    } catch { }
  }

  return [pscustomobject]@{
    ok = $true
    foreground = [bool]((Get-ForegroundHwnd) -eq $hwnd)
    restored = $restored
    hwnd = $hwnd
  }
}

function Invoke-ScreenInfo {
  $displays = New-Object 'System.Collections.Generic.List[object]'
  try {
    Add-Type -AssemblyName System.Windows.Forms | Out-Null
    $i = 0
    foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
      $b = $s.Bounds
      $scale = 1.0
      try {
        $pt = [MovaNative.POINT]::new()
        $pt.X = [int]($b.X + [Math]::Floor($b.Width / 2))
        $pt.Y = [int]($b.Y + [Math]::Floor($b.Height / 2))
        $mon = [MovaNative.Win32]::MonitorFromPoint($pt, 2)   # MONITOR_DEFAULTTONEAREST
        $dpiX = [uint32]0
        $dpiY = [uint32]0
        $hr = [MovaNative.Win32]::GetDpiForMonitor($mon, 0, [ref]$dpiX, [ref]$dpiY)
        if ($hr -eq 0 -and $dpiX -gt 0) { $scale = [Math]::Round(([double]$dpiX / 96.0), 3) }
      } catch { }
      $i = $i + 1
      $displays.Add([pscustomobject]@{
        id = [string]$s.DeviceName
        index = $i
        x = [int]$b.X
        y = [int]$b.Y
        w = [int]$b.Width
        h = [int]$b.Height
        scaleFactor = $scale
        primary = [bool]$s.Primary
      }) | Out-Null
    }
  } catch {
    Fail 'display-unavailable' $_.Exception.Message
  }
  return [pscustomobject]@{ displays = $displays.ToArray() }
}

# ---------------------------------------------------------------------------
# dispatch
# ---------------------------------------------------------------------------

function Invoke-WorkerCommand {
  param([string]$Command, $CommandArgs)
  if ($Command -eq 'ping') { return (Invoke-Ping) }
  if ($Command -eq 'windows') { return (Invoke-Windows $CommandArgs) }
  if ($Command -eq 'foreground') { return (Invoke-Foreground) }
  if ($Command -eq 'tree') { return (Invoke-Tree $CommandArgs) }
  if ($Command -eq 'find') { return (Invoke-Find $CommandArgs) }
  if ($Command -eq 'invoke') { return (Invoke-Invoke $CommandArgs) }
  if ($Command -eq 'setValue') { return (Invoke-SetValue $CommandArgs) }
  if ($Command -eq 'pattern') { return (Invoke-Pattern $CommandArgs) }
  if ($Command -eq 'rect') { return (Invoke-Rect $CommandArgs) }
  if ($Command -eq 'focus') { return (Invoke-Focus $CommandArgs) }
  if ($Command -eq 'readText') { return (Invoke-ReadText $CommandArgs) }
  if ($Command -eq 'activate') { return (Invoke-Activate $CommandArgs) }
  if ($Command -eq 'screenInfo') { return (Invoke-ScreenInfo) }
  if ($Command -eq 'quit') {
    $script:quit = $true
    return [pscustomobject]@{ ok = $true }
  }
  Fail 'unknown-command' ('unknown command: ' + $Command)
}

function Write-Result {
  param($Id, $Result)
  $payload = [pscustomobject]@{ id = $Id; ok = $true; result = $Result }
  Write-Line (ConvertTo-Json -InputObject $payload -Depth 12 -Compress)
}

function Write-Failure {
  param($Id, [string]$Code, [string]$Message)
  $payload = [pscustomobject]@{ id = $Id; ok = $false; code = $Code; message = $Message }
  Write-Line (ConvertTo-Json -InputObject $payload -Depth 6 -Compress)
}

# ---------------------------------------------------------------------------
# main loop: one request per stdin line
# ---------------------------------------------------------------------------

$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)), $false)
Write-Log ('worker ready pid=' + $PID + ' uia=' + $script:uiaReady + ' dpi=' + $script:dpiMode)

while (-not $script:quit) {
  $line = $null
  try { $line = $stdin.ReadLine() } catch { $line = $null }
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if (-not $line) { continue }

  $request = $null
  try {
    $request = ConvertFrom-Json -InputObject $line
  } catch {
    Write-Failure $null 'bad-json' ('request is not valid JSON: ' + $_.Exception.Message)
    continue
  }

  $id = $null
  $command = ''
  $commandArgs = $null
  try {
    if ($null -ne $request) {
      if ($null -ne $request.id) { $id = $request.id }
      if ($null -ne $request.cmd) { $command = [string]$request.cmd }
      if ($null -ne $request.args) { $commandArgs = $request.args }
    }
  } catch { }

  if (-not $command) {
    Write-Failure $id 'bad-request' 'cmd is required'
    continue
  }

  try {
    $result = Invoke-WorkerCommand -Command $command -CommandArgs $commandArgs
    Write-Result $id $result
  } catch {
    $ex = $_.Exception
    $code = Get-ErrorCode $ex
    $message = ''
    try { $message = [string]$ex.Message } catch { $message = '' }
    if (-not $message) { $message = $code }
    Write-Failure $id $code $message
    if ($code -eq 'failed') { Write-Log ('[' + $command + '] ' + $message) }
  }
}
