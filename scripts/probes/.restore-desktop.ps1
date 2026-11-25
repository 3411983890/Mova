Add-Type -AssemblyName System.Windows.Forms
$ErrorActionPreference = 'Continue'

$shell = New-Object -ComObject Shell.Application
$bin = $shell.NameSpace(10)
$items = @($bin.Items() | Where-Object { $bin.GetDetailsOf($_, 1) -match '\\Desktop$' })
Write-Output ("to restore: " + $items.Count)

$ok = 0
$fail = 0
foreach ($it in $items) {
  try {
    $verb = $it.Verbs() | Where-Object { $_.Name -match '还原|Restore' } | Select-Object -First 1
    if ($null -ne $verb) {
      $verb.DoIt()
      $ok++
    } else {
      $fail++
      Write-Output ("no-verb: " + $it.Name)
    }
  } catch {
    $fail++
    Write-Output ("err: " + $it.Name + " -> " + $_.Exception.Message)
  }
  Start-Sleep -Milliseconds 60
}
Write-Output ("restored=" + $ok + " failed=" + $fail)
