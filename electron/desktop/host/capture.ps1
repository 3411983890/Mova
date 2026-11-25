param(
  [int]$X = -2147483648,
  [int]$Y = -2147483648,
  [int]$W = 0,
  [int]$H = 0,
  [string]$Out = ''
)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

[void][System.Reflection.Assembly]::LoadWithPartialName('System.Drawing')

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($W -le 0 -or $H -le 0) {
  $X = $bounds.X; $Y = $bounds.Y; $W = $bounds.Width; $H = $bounds.Height
} elseif ($X -eq -2147483648 -or $Y -eq -2147483648) {
  $X = $bounds.X; $Y = $bounds.Y
}

if ([string]::IsNullOrWhiteSpace($Out)) {
  $Out = Join-Path $env:TEMP ('mova-capture-' + [guid]::NewGuid().ToString('N') + '.png')
}

try {
  $bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($X, $Y, 0, 0, $bmp.Size)
  $g.Dispose()
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $result = [ordered]@{ ok = $true; path = $Out; x = $X; y = $Y; width = $W; height = $H }
} catch {
  $result = [ordered]@{ ok = $false; code = 'capture-failed'; message = $_.Exception.Message }
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::Out.Write(($result | ConvertTo-Json -Compress))
