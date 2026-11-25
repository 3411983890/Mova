# 负责：保持 Mova 的 WSL 本机验证环境运行，并检查 Windows 回环连接。
# 不负责：更改 WSL 默认发行版、Windows 防火墙或 Linux 公网监听。
# 被谁调用：本机验证操作者。
param(
    [ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$Distribution = 'Ubuntu-24.04',
    [ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$LinuxUser = 'mova',
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$wslArguments = @('-d', $Distribution, '-u', $LinuxUser, '--exec', '/usr/bin/sleep', 'infinity')
$marker = [regex]::Escape($wslArguments -join ' ') + '$'
$keepers = @(Get-CimInstance Win32_Process -Filter "Name = 'wsl.exe'" | Where-Object { $_.CommandLine -match $marker })
if ($Stop) {
    $keepers | ForEach-Object { Stop-Process -Id $_.ProcessId }
    return
}

$started = $null
if ($keepers.Count -eq 0) {
    $started = Start-Process -FilePath "$env:SystemRoot\System32\wsl.exe" -ArgumentList $wslArguments -WindowStyle Hidden -PassThru
}
$connection = [Net.Http.HttpClientHandler]::new()
$connection.UseProxy = $false
$client = [Net.Http.HttpClient]::new($connection)
$client.Timeout = [TimeSpan]::FromSeconds(2)
$url = 'http://127.0.0.1:17642/v1/health'
try {
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if ($null -ne $started -and $started.HasExited) { break }
        $health = $null
        try { $health = $client.GetStringAsync($url).GetAwaiter().GetResult() | ConvertFrom-Json } catch { }
        if ($health.service -eq 'mova' -and $health.status -eq 'ready') {
            Write-Output 'WSL Mova 已就绪。桌面服务地址 http://127.0.0.1:17642'
            return
        }
        Start-Sleep -Milliseconds 500
    }
} finally { $client.Dispose() }
throw 'Windows 暂时无法连接 Mova。请在对应的 WSL 发行版运行 mova doctor，检查用户服务是否已安装并运行。'
