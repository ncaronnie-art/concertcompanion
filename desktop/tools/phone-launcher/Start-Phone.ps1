param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$packageRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$dataDirectory = Join-Path $packageRoot 'data'
$hostScript = Join-Path $packageRoot 'host.cjs'
$readyFile = Join-Path $dataDirectory 'ready.json'
$connectionPage = Join-Path $dataDirectory 'Connect-your-iPhone.html'

function Test-PhoneProcess($hostPid, $runtimePath, $processStartedAt) {
    if (-not $hostPid -or [int]$hostPid -le 0) { return $false }
    $details = Get-Process -Id ([int]$hostPid) -ErrorAction SilentlyContinue
    if (-not $details -or -not $details.Path -or -not $processStartedAt) { return $false }
    $expectedStart = ([DateTimeOffset]$processStartedAt).UtcDateTime
    return ([IO.Path]::GetFullPath($details.Path) -ieq $runtimePath) -and
        ([Math]::Abs(($details.StartTime.ToUniversalTime() - $expectedStart).TotalSeconds) -lt 2)
}

try {
    $runtime = Get-Content -LiteralPath (Join-Path $packageRoot 'runtime.json') -Raw | ConvertFrom-Json
    $runtimePath = [IO.Path]::GetFullPath($runtime.nodePath)
    if (-not (Test-Path -LiteralPath $runtimePath) -or -not (Test-Path -LiteralPath $hostScript)) {
        throw 'The phone preview files or its installed runtime moved. Ask Codex to refresh this phone preview.'
    }
    New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
    $existing = $null
    if (Test-Path -LiteralPath $readyFile) { try { $existing = Get-Content -LiteralPath $readyFile -Raw | ConvertFrom-Json } catch { $existing = $null } }
    if ($existing -and (Test-PhoneProcess $existing.pid $runtimePath $existing.processStartedAt)) {
        try {
            $accessKey = (Get-Content -LiteralPath (Join-Path $dataDirectory 'access-key') -Raw).Trim()
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($existing.port)/api/health" -Headers @{ Authorization = "Bearer $accessKey" } -TimeoutSec 3
        } catch { throw 'Phone Preview is already running but is not responding. Use Stop Phone Preview, then open it again.' }
        if (-not $health.ready) { throw 'Phone Preview is still starting. Try opening it again in a moment.' }
    } else {
        $started = Start-Process -FilePath $runtimePath -ArgumentList ('"' + $hostScript + '"') -WorkingDirectory $packageRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataDirectory 'host-output.log') -RedirectStandardError (Join-Path $dataDirectory 'host-error.log')
        $ready = $false
        for ($attempt = 0; $attempt -lt 80; $attempt++) {
            Start-Sleep -Milliseconds 250
            $started.Refresh()
            if ($started.HasExited) {
                $detail = (Get-Content -LiteralPath (Join-Path $dataDirectory 'host-error.log') -Tail 5 -ErrorAction SilentlyContinue) -join ' '
                throw "Phone Preview could not start. $detail"
            }
            if (Test-Path -LiteralPath $readyFile) {
                try { $state = Get-Content -LiteralPath $readyFile -Raw | ConvertFrom-Json } catch { continue }
                if ([int]$state.pid -eq $started.Id -and (Test-Path -LiteralPath $connectionPage)) { $ready = $true; break }
            }
        }
        if (-not $ready) { throw 'Phone Preview is taking longer than expected to start. Open it again in a moment.' }
    }
    if (-not $NoBrowser) { Start-Process -FilePath $connectionPage }
} catch {
    if ($NoBrowser) { throw }
    $popup = New-Object -ComObject WScript.Shell
    $popup.Popup($_.Exception.Message, 0, 'Vibe Capsule Phone Preview', 16) | Out-Null
    exit 1
}
