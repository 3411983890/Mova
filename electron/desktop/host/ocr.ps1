param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Language = ''
)

# Windows.Media.Ocr（WinRT）在 PowerShell 5.1 里的调用：需要 AsTask 桥接 IAsyncOperation
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Out-Json($obj) {
  [Console]::Out.Write(($obj | ConvertTo-Json -Depth 6 -Compress))
}

try {
  if (-not (Test-Path -LiteralPath $Path)) {
    Out-Json ([ordered]@{ ok = $false; code = 'no-file'; message = 'image not found' })
    exit 0
  }

  [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
  Add-Type -AssemblyName System.Runtime.WindowsRuntime

  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1)

  function Await($operation, [Type]$resultType) {
    $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
    [void]$task.Wait(-1)
    return $task.Result
  }

  $engine = $null
  if (-not [string]::IsNullOrWhiteSpace($Language)) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($Language))
  }
  if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if ($null -eq $engine) {
    foreach ($tag in @('zh-Hans-CN', 'zh-CN', 'en-US')) {
      try {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($tag))
        if ($null -ne $engine) { break }
      } catch { }
    }
  }
  if ($null -eq $engine) {
    Out-Json ([ordered]@{ ok = $false; code = 'ocr-unavailable'; message = 'no OCR engine for installed languages' })
    exit 0
  }

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

  $lines = @()
  foreach ($line in $result.Lines) {
    $minX = [double]::MaxValue; $minY = [double]::MaxValue; $maxX = 0.0; $maxY = 0.0
    foreach ($word in $line.Words) {
      $r = $word.BoundingRect
      if ($r.X -lt $minX) { $minX = $r.X }
      if ($r.Y -lt $minY) { $minY = $r.Y }
      if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
      if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
    }
    if ($minX -eq [double]::MaxValue) { $minX = 0; $minY = 0 }
    $lines += [ordered]@{
      text = $line.Text
      x = [int]$minX; y = [int]$minY
      w = [int]($maxX - $minX); h = [int]($maxY - $minY)
    }
  }

  Out-Json ([ordered]@{
      ok = $true
      language = $engine.RecognizerLanguage.LanguageTag
      count = $lines.Count
      lines = $lines
    })
} catch {
  Out-Json ([ordered]@{ ok = $false; code = 'ocr-failed'; message = $_.Exception.Message })
}
