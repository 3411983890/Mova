$ErrorActionPreference = 'Continue'
$shell = New-Object -ComObject Shell.Application
$bin = $shell.NameSpace(10)

$done = 0
for ($n = 0; $n -lt 200; $n++) {
  $items = @($bin.Items() | Where-Object { $bin.GetDetailsOf($_, 1) -match '\\Desktop$' })
  if ($items.Count -eq 0) { break }
  $item = $items[0]
  $name = $item.Name
  try {
    $item.Verbs().Item(0).DoIt()
    $done++
  } catch {
    Write-Output ("fail: " + $name + " -> " + $_.Exception.Message)
    Start-Sleep -Milliseconds 200
  }
  Start-Sleep -Milliseconds 80
}
Write-Output ("restored: " + $done)
Write-Output ("desktop now: " + (Get-ChildItem "$env:USERPROFILE\Desktop" -Force | Measure-Object).Count)
