$ErrorActionPreference = 'Continue'
$shell = New-Object -ComObject Shell.Application
$bin = $shell.NameSpace(10)
$items = @($bin.Items() | Where-Object { $bin.GetDetailsOf($_, 1) -match '\\Desktop$' })
Write-Output ("candidates: " + $items.Count)

$first = $items[0]
$verbs = $first.Verbs()
Write-Output ("verb count: " + $verbs.Count)
for ($i = 0; $i -lt $verbs.Count; $i++) {
  Write-Output ("  [$i] " + $verbs.Item($i).Name)
}

$before = (Get-ChildItem "$env:USERPROFILE\Desktop" -Force | Measure-Object).Count
Write-Output ("desktop count before: " + $before)

try {
  $verbs.Item(0).DoIt()
  Write-Output "DoIt(0) called"
} catch {
  Write-Output ("DoIt error: " + $_.Exception.Message)
}

Start-Sleep -Seconds 2
$after = (Get-ChildItem "$env:USERPROFILE\Desktop" -Force | Measure-Object).Count
Write-Output ("desktop count after: " + $after)
