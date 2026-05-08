#Requires -Version 5.1
# Native Messaging Host for SuckLess Factors Auto-Submit
# Reads one request from stdin, writes one response to stdout using the
# Chrome native messaging protocol (4-byte LE length prefix + UTF-8 JSON).

$ErrorActionPreference = 'SilentlyContinue'

# ---------------------------------------------------------------------------
# Compute first-wake / last-sleep for each workday in the current ISO week
# ---------------------------------------------------------------------------
function Get-WeekTimes {
    param([string]$AnchorDate)

    # Determine the Monday of the target week
    if ($AnchorDate) {
        $anchor = [datetime]::ParseExact($AnchorDate, 'yyyy-MM-dd', $null)
    } else {
        $anchor = Get-Date
    }
    $dayOfWeek   = [int]$anchor.DayOfWeek          # 0=Sun, 1=Mon, …
    $daysToMon   = if ($dayOfWeek -eq 0) { 6 } else { $dayOfWeek - 1 }
    $monday      = $anchor.AddDays(-$daysToMon).Date
    $sunday      = $monday.AddDays(7)  # exclusive end

    $events = @()
    try {
        $events = Get-WinEvent -FilterHashtable @{
            LogName      = 'System'
            ProviderName = 'Microsoft-Windows-Power-Troubleshooter'
            Id           = 1
            StartTime    = $monday
            EndTime      = $sunday
        } -ErrorAction SilentlyContinue | Sort-Object TimeCreated
    } catch { }

    # Build per-date map: firstWake, lastSleep
    # Each wake event's Properties[0] is the timestamp when the machine
    # went to sleep *before* that wake event (i.e. end of the prior session).
    # So: session i started at events[i].TimeCreated
    #     session i ended  at events[i+1].Properties[0]
    $dayMap = @{}

    for ($i = 0; $i -lt $events.Count; $i++) {
        $wakeTime = $events[$i].TimeCreated
        $dateKey  = $wakeTime.ToString('yyyy-MM-dd')

        $sleepTime = $null
        if ($i + 1 -lt $events.Count) {
            try { $sleepTime = [datetime]$events[$i + 1].Properties[0].Value } catch { }
        }

        if (-not $dayMap.ContainsKey($dateKey)) {
            $dayMap[$dateKey] = @{ firstWake = $wakeTime; lastSleep = $sleepTime }
        } else {
            # Keep the earliest wake of the day
            if ($wakeTime -lt $dayMap[$dateKey].firstWake) {
                $dayMap[$dateKey].firstWake = $wakeTime
            }
            # Keep the latest sleep of the day
            if ($null -ne $sleepTime) {
                if ($null -eq $dayMap[$dateKey].lastSleep -or
                    $sleepTime -gt $dayMap[$dateKey].lastSleep) {
                    $dayMap[$dateKey].lastSleep = $sleepTime
                }
            }
        }
    }

    $daysArr = @()
    foreach ($dateKey in ($dayMap.Keys | Sort-Object)) {
        $d   = $dayMap[$dateKey]
        # If the machine is still on (no sleep time recorded yet), use now
        $end = if ($null -ne $d.lastSleep) {
                   $d.lastSleep.ToString('HH:mm')
               } else {
                   (Get-Date).ToString('HH:mm')
               }

        $daysArr += [PSCustomObject]@{
            date  = $dateKey
            start = $d.firstWake.ToString('HH:mm')
            end   = $end
        }
    }

    return @{ days = $daysArr }
}

# ---------------------------------------------------------------------------
# Native messaging I/O
# ---------------------------------------------------------------------------
try {
    $stdin  = [Console]::OpenStandardInput()
    $stdout = [Console]::OpenStandardOutput()

    # Read 4-byte message length (little-endian)
    $lenBuf = New-Object byte[] 4
    $read   = 0
    while ($read -lt 4) {
        $n = $stdin.Read($lenBuf, $read, 4 - $read)
        if ($n -le 0) { exit 0 }
        $read += $n
    }
    $msgLen = [BitConverter]::ToInt32($lenBuf, 0)

    # Read message bytes
    $msgBuf = New-Object byte[] $msgLen
    $read   = 0
    while ($read -lt $msgLen) {
        $n = $stdin.Read($msgBuf, $read, $msgLen - $read)
        if ($n -le 0) { exit 0 }
        $read += $n
    }

    $request = [Text.Encoding]::UTF8.GetString($msgBuf) | ConvertFrom-Json

    # Dispatch
    $response = switch ($request.action) {
        'getWeekTimes' { Get-WeekTimes -AnchorDate $request.anchorDate }
        default        { @{ error = "Unknown action: $($request.action)" } }
    }

    # Write response
    $responseJson  = $response | ConvertTo-Json -Compress -Depth 5
    $responseBytes = [Text.Encoding]::UTF8.GetBytes($responseJson)
    $lenBytes      = [BitConverter]::GetBytes([int]$responseBytes.Length)

    $stdout.Write($lenBytes,      0, 4)
    $stdout.Write($responseBytes, 0, $responseBytes.Length)
    $stdout.Flush()

} catch {
    # Attempt to return the error as a native message so the popup can show it
    try {
        $errMsg    = @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
        $errBytes  = [Text.Encoding]::UTF8.GetBytes($errMsg)
        $lenBytes  = [BitConverter]::GetBytes([int]$errBytes.Length)
        $out = [Console]::OpenStandardOutput()
        $out.Write($lenBytes,  0, 4)
        $out.Write($errBytes,  0, $errBytes.Length)
        $out.Flush()
    } catch { }
}
