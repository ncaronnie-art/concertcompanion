param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
$packageRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$dataDirectory = Join-Path $packageRoot 'data'
$readyFile = Join-Path $dataDirectory 'ready.json'
$hostScript = Join-Path $packageRoot 'host.cjs'
try {
    if (Test-Path -LiteralPath $readyFile) {
        $runtime = Get-Content -LiteralPath (Join-Path $packageRoot 'runtime.json') -Raw | ConvertFrom-Json
        $savedReadyContent = Get-Content -LiteralPath $readyFile -Raw
        $state = $savedReadyContent | ConvertFrom-Json
        $hostPid = [int]$state.pid
        $details = Get-Process -Id $hostPid -ErrorAction SilentlyContinue
        if ($details) {
            if (-not $state.processStartedAt) { throw 'The phone preview start time could not be verified. The process has been left alone.' }
            $expectedStart = ([DateTimeOffset]$state.processStartedAt).UtcDateTime
            $isOurProcess = $details.Path -and
                ([IO.Path]::GetFullPath($details.Path) -ieq [IO.Path]::GetFullPath($runtime.nodePath)) -and
                ([Math]::Abs(($details.StartTime.ToUniversalTime() - $expectedStart).TotalSeconds) -lt 2)
            if (-not $isOurProcess) { throw 'The saved process is not this phone preview. It has been left alone.' }
            $hostPort = [int]$state.port
            if ($hostPort -lt 1 -or $hostPort -gt 65535) { throw 'The saved Phone Preview address is invalid. The process has been left alone.' }
            $accessKey = (Get-Content -LiteralPath (Join-Path $dataDirectory 'access-key') -Raw).Trim()
            $result = Invoke-RestMethod -Uri "http://127.0.0.1:$hostPort/api/stop" -Method Post -Headers @{ Authorization = "Bearer $accessKey" } -ContentType 'application/json' -Body '{}' -TimeoutSec 10
            if (-not $result.stopping) { throw 'Phone Preview did not accept the stop request. Try again in a moment.' }
            if (-not $details.WaitForExit(10000)) { throw 'Phone Preview is still finishing its stop request. Try again in a moment.' }
        }
        if ((Test-Path -LiteralPath $readyFile) -and ((Get-Content -LiteralPath $readyFile -Raw) -ceq $savedReadyContent)) {
            Remove-Item -LiteralPath $readyFile -Force
        }
    }
    if (-not $Quiet) { (New-Object -ComObject WScript.Shell).Popup('Phone Preview has stopped. Your uploaded copies and saved projects remain on this PC.', 0, 'Vibe Capsule Phone Preview', 64) | Out-Null }
} catch {
    if ($Quiet) { throw }
    (New-Object -ComObject WScript.Shell).Popup($_.Exception.Message, 0, 'Vibe Capsule Phone Preview', 16) | Out-Null
    exit 1
}
