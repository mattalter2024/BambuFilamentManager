param(
    [int]$Port = 8765,
    [switch]$NoBrowser,
    [string]$CustomDataDir = ""
)

$ErrorActionPreference = "Stop"

$RootDir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$WebDir     = Join-Path $RootDir "web"
$DataDir    = if (-not [string]::IsNullOrWhiteSpace($CustomDataDir)) { $CustomDataDir } else { Join-Path $RootDir "data" }
$UploadsDir = Join-Path $DataDir "uploads"
$DbPath     = Join-Path $DataDir "filament_db.json"
$CsPath     = Join-Path $RootDir "BambuEngine.cs"

if (-not (Test-Path $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
}
if (-not (Test-Path $UploadsDir)) {
    New-Item -ItemType Directory -Path $UploadsDir -Force | Out-Null
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Bambu Lab P2S + AMS 2 Pro / AMS HT Filament Manager" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Compiling built-in .NET MQTT / FTPS / 3MF engine..." -ForegroundColor Gray

Add-Type -Path $CsPath -ReferencedAssemblies @(
    "System.IO.Compression",
    "System.IO.Compression.FileSystem",
    "System.Xml",
    "System.Xml.Linq",
    "System.Web.Extensions"
)

$MqttClient = New-Object BambuFilamentManager.BambuMqttClient

# --- Helper: Build Default Realistic Sample Database (P2S + 2x AMS 2 Pro + 1x AMS HT) ---
function New-SampleDatabase {
    $now = [DateTime]::UtcNow
    $lastPrintTime = $now.AddHours(-2).ToString("o")
    $olderPrintTime = $now.AddDays(-1).AddHours(-4).ToString("o")

    return [ordered]@{
        isDemoData = $true
        config = [ordered]@{
            connectionMode  = "cloud"
            cloudRegion     = "global"
            cloudEmail      = ""
            cloudUid        = ""
            cloudToken      = ""
            printerModel    = "Bambu Lab P2S"
            printerName     = "My P2S"
            printerIp       = ""
            printerSerial   = ""
            accessCode      = ""
            safetyBufferG   = 15
            safetyBufferPct = 5
            lowSpoolWarnG      = 150
            autoConnect        = $false
            autoSyncRfid       = $true
            autoDeductOnFinish = $true
        }
        amsUnits = @(
            [ordered]@{ id = "ams-0"; amsId = 0; unitType = "AMS 2 Pro"; label = "AMS 2 Pro A"; slotCount = 4; tempC = 28.4; humidityRaw = 16; humidityLevel = 1; dryTimeMinutes = 0 },
            [ordered]@{ id = "ams-1"; amsId = 1; unitType = "AMS 2 Pro"; label = "AMS 2 Pro B"; slotCount = 4; tempC = 54.8; humidityRaw = 12; humidityLevel = 1; dryTimeMinutes = 185 },
            [ordered]@{ id = "ams-128"; amsId = 128; unitType = "AMS HT"; label = "AMS HT #1"; slotCount = 1; tempC = 64.2; humidityRaw = 10; humidityLevel = 1; dryTimeMinutes = 240 }
        )
        spools = @(
            [ordered]@{ id = "sp-a1"; slotKey = "A1"; brand = "Bambu Lab"; name = "PLA Basic Matte Charcoal"; material = "PLA"; color = "#27272A"; initialGrams = 1000; remainingGrams = 642.5; tareGrams = 250; density = 1.24; costPerKg = 19.99; isRfid = $true; rfidUuid = "SAMPLE-A1"; rfidRemainPct = 65; lastPrintUsedG = 48.6; notes = "Primary structural matte black" },
            [ordered]@{ id = "sp-a2"; slotKey = "A2"; brand = "Bambu Lab"; name = "PLA Basic Jade White"; material = "PLA"; color = "#F1F5F9"; initialGrams = 1000; remainingGrams = 418.2; tareGrams = 250; density = 1.24; costPerKg = 19.99; isRfid = $true; rfidUuid = "SAMPLE-A2"; rfidRemainPct = 42; lastPrintUsedG = 24.1; notes = "" },
            [ordered]@{ id = "sp-a3"; slotKey = "A3"; brand = "Bambu Lab"; name = "PLA Basic Bambu Green"; material = "PLA"; color = "#00AE42"; initialGrams = 1000; remainingGrams = 128.4; tareGrams = 250; density = 1.24; costPerKg = 19.99; isRfid = $true; rfidUuid = "SAMPLE-A3"; rfidRemainPct = 13; lastPrintUsedG = 14.3; notes = "Running low - backup in B1" },
            [ordered]@{ id = "sp-a4"; slotKey = "A4"; brand = "Polymaker"; name = "PolyLite PLA Pro Orange"; material = "PLA"; color = "#F97316"; initialGrams = 1000; remainingGrams = 815.0; tareGrams = 140; density = 1.24; costPerKg = 24.99; isRfid = $false; rfidUuid = ""; rfidRemainPct = -1; lastPrintUsedG = 0; notes = "Cardboard spool with rim adapter" },

            [ordered]@{ id = "sp-b1"; slotKey = "B1"; brand = "Bambu Lab"; name = "PLA Basic Bambu Green (Backup)"; material = "PLA"; color = "#00AE42"; initialGrams = 1000; remainingGrams = 960.0; tareGrams = 250; density = 1.24; costPerKg = 19.99; isRfid = $true; rfidUuid = "SAMPLE-B1"; rfidRemainPct = 96; lastPrintUsedG = 0; notes = "Auto-refill backup for A3" },
            [ordered]@{ id = "sp-b2"; slotKey = "B2"; brand = "Bambu Lab"; name = "PETG HF Dark Gray"; material = "PETG"; color = "#475569"; initialGrams = 1000; remainingGrams = 534.0; tareGrams = 250; density = 1.27; costPerKg = 22.99; isRfid = $true; rfidUuid = "SAMPLE-B2"; rfidRemainPct = 53; lastPrintUsedG = 0; notes = "Drying for functional brackets" },
            [ordered]@{ id = "sp-b3"; slotKey = "B3"; brand = "Bambu Lab"; name = "PETG HF Signal Blue"; material = "PETG"; color = "#2563EB"; initialGrams = 1000; remainingGrams = 780.5; tareGrams = 250; density = 1.27; costPerKg = 22.99; isRfid = $true; rfidUuid = "SAMPLE-B3"; rfidRemainPct = 78; lastPrintUsedG = 0; notes = "" },
            [ordered]@{ id = "sp-b4"; slotKey = "B4"; brand = "Sunlu"; name = "PETG Transparent Clear"; material = "PETG"; color = "#CBD5E1"; initialGrams = 1000; remainingGrams = 290.0; tareGrams = 130; density = 1.27; costPerKg = 16.99; isRfid = $false; rfidUuid = ""; rfidRemainPct = -1; lastPrintUsedG = 0; notes = "" },

            [ordered]@{ id = "sp-ht1"; slotKey = "HT-1"; brand = "Bambu Lab"; name = "PA6-CF Black"; material = "PA-CF"; color = "#18181B"; initialGrams = 500; remainingGrams = 342.0; tareGrams = 255; density = 1.18; costPerKg = 69.99; isRfid = $true; rfidUuid = "SAMPLE-HT1"; rfidRemainPct = 68; lastPrintUsedG = 0; notes = "High-temp drying active in AMS HT" },

            [ordered]@{ id = "sp-vault1"; slotKey = "VAULT"; brand = "Bambu Lab"; name = "ABS Red"; material = "ABS"; color = "#DC2626"; initialGrams = 1000; remainingGrams = 890.0; tareGrams = 255; density = 1.05; costPerKg = 22.99; isRfid = $true; rfidUuid = "SAMPLE-V1"; rfidRemainPct = 89; lastPrintUsedG = 0; notes = "Stored in dry box #2" }
        )
        history = @(
            [ordered]@{
                id = "pr-sample-1"
                timestampUtc = $lastPrintTime
                fileName = "P2S_PoopChute_MultiColor.gcode.3mf"
                plateName = "P2S Poop Chute + Logo Plate"
                source = "3MF Slicer"
                status = "FINISH"
                completionPct = 100
                totalGrams = 87.0
                totalMeters = 29.2
                flushGrams = 14.2
                predictionSeconds = 11400
                thumbnailBase64 = ""
                undone = $false
                items = @(
                    [ordered]@{ slotKey = "A1"; spoolId = "sp-a1"; spoolName = "PLA Basic Matte Charcoal"; material = "PLA"; color = "#27272A"; usedGrams = 48.6; usedMeters = 16.3; beforeGrams = 691.1; afterGrams = 642.5 },
                    [ordered]@{ slotKey = "A2"; spoolId = "sp-a2"; spoolName = "PLA Basic Jade White"; material = "PLA"; color = "#F1F5F9"; usedGrams = 24.1; usedMeters = 8.1; beforeGrams = 442.3; afterGrams = 418.2 },
                    [ordered]@{ slotKey = "A3"; spoolId = "sp-a3"; spoolName = "PLA Basic Bambu Green"; material = "PLA"; color = "#00AE42"; usedGrams = 14.3; usedMeters = 4.8; beforeGrams = 142.7; afterGrams = 128.4 }
                )
            },
            [ordered]@{
                id = "pr-sample-2"
                timestampUtc = $olderPrintTime
                fileName = "AMS2_Desiccant_Pod_Set.gcode.3mf"
                plateName = "AMS 2 Pro Silica Desiccant Pods (4x)"
                source = "3MF Slicer"
                status = "FINISH"
                completionPct = 100
                totalGrams = 66.0
                totalMeters = 21.8
                flushGrams = 0.0
                predictionSeconds = 7800
                thumbnailBase64 = ""
                undone = $false
                items = @(
                    [ordered]@{ slotKey = "B2"; spoolId = "sp-b2"; spoolName = "PETG HF Dark Gray"; material = "PETG"; color = "#475569"; usedGrams = 66.0; usedMeters = 21.8; beforeGrams = 600.0; afterGrams = 534.0 }
                )
            }
        )
    }
}

function New-CleanDatabase {
    return [ordered]@{
        isDemoData = $false
        config = [ordered]@{
            connectionMode  = "cloud"
            cloudRegion     = "global"
            cloudEmail      = ""
            cloudUid        = ""
            cloudToken      = ""
            printerModel    = "Bambu Lab P2S"
            printerName     = "My P2S"
            printerIp       = ""
            printerSerial   = ""
            accessCode      = ""
            safetyBufferG   = 15
            safetyBufferPct = 5
            lowSpoolWarnG      = 150
            autoConnect        = $false
            autoSyncRfid       = $true
            autoDeductOnFinish = $true
        }
        amsUnits = @(
            [ordered]@{ id = "ams-0"; amsId = 0; unitType = "AMS 2 Pro"; label = "AMS 2 Pro A"; slotCount = 4; tempC = 0; humidityRaw = 0; humidityLevel = 0; dryTimeMinutes = 0 },
            [ordered]@{ id = "ams-1"; amsId = 1; unitType = "AMS 2 Pro"; label = "AMS 2 Pro B"; slotCount = 4; tempC = 0; humidityRaw = 0; humidityLevel = 0; dryTimeMinutes = 0 }
        )
        spools = @()
        history = @()
    }
}

function Load-Database {
    if (Test-Path $DbPath) {
        try {
            $raw = [System.IO.File]::ReadAllText($DbPath, [System.Text.Encoding]::UTF8)
            $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
            $ser.MaxJsonLength = 50MB
            $obj = $ser.DeserializeObject($raw)
            if ($null -ne $obj) { return $obj }
        } catch {
            Write-Warning "Could not parse existing DB, creating fresh one: $_"
        }
    }
    $db = New-SampleDatabase
    Save-Database $db
    return $db
}

function Save-Database($db) {
    $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $ser.MaxJsonLength = 50MB
    $json = $ser.Serialize($db)
    [System.IO.File]::WriteAllText($DbPath, $json, [System.Text.Encoding]::UTF8)
}

function To-Json($obj) {
    $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $ser.MaxJsonLength = 50MB
    return $ser.Serialize($obj)
}

function Parse-JsonBody($request) {
    $body = $request.GetBodyText()
    if ([string]::IsNullOrWhiteSpace($body)) { return @{} }
    $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $ser.MaxJsonLength = 50MB
    return $ser.DeserializeObject($body)
}

function Read-RawBytes($request) {
    return $request.BodyBytes
}

function Send-Json($request, $data, [int]$statusCode = 200) {
    $json = To-Json $data
    $buf = [System.Text.Encoding]::UTF8.GetBytes($json)
    $request.SendResponse($statusCode, "application/json; charset=utf-8", $buf, "no-store")
}

function Send-StaticFile($request, $filePath) {
    if (-not (Test-Path $filePath -PathType Leaf)) {
        $buf = [System.Text.Encoding]::UTF8.GetBytes("Not Found")
        $request.SendResponse(404, "text/plain; charset=utf-8", $buf, "no-store")
        return
    }
    $ext = [System.IO.Path]::GetExtension($filePath).ToLowerInvariant()
    $mime = switch ($ext) {
        ".html" { "text/html; charset=utf-8" }
        ".css"  { "text/css; charset=utf-8" }
        ".js"   { "application/javascript; charset=utf-8" }
        ".svg"  { "image/svg+xml" }
        ".png"  { "image/png" }
        ".ico"  { "image/x-icon" }
        ".json" { "application/json; charset=utf-8" }
        default { "application/octet-stream" }
    }
    $bytes = [System.IO.File]::ReadAllBytes($filePath)
    $request.SendResponse(200, $mime, $bytes, "no-cache")
}

function To-List($val) {
    $list = New-Object System.Collections.ArrayList
    if ($null -ne $val) {
        foreach ($item in $val) { [void]$list.Add($item) }
    }
    # Unary comma prevents PowerShell from unrolling the ArrayList into a fixed-size object[]
    return ,$list
}

function Test-IsSampleSpool($sp) {
    $id = [string]$sp["id"]
    $uuid = [string]$sp["rfidUuid"]
    return ($id -in @("sp-a1","sp-a2","sp-a3","sp-a4","sp-b1","sp-b2","sp-b3","sp-b4","sp-ht1","sp-vault1")) -or ($uuid -like "SAMPLE-*")
}

function Sync-LiveTelemetryIntoDb($db, $snap) {
    if (-not $snap.Connected -or $snap.AmsUnits.Count -eq 0) { return $false }
    $changed = $false
    $units = To-List $db["amsUnits"]
    $spools = To-List $db["spools"]

    # If leftover sample spools/history exist, purge fake demo data so real P2S trays take over cleanly
    $hasSampleSpools = $false
    foreach ($sp in $spools) {
        if (Test-IsSampleSpool $sp) { $hasSampleSpools = $true; break }
    }
    if ($hasSampleSpools) {
        $cleanSpools = New-Object System.Collections.ArrayList
        foreach ($sp in $spools) {
            if (-not (Test-IsSampleSpool $sp)) { [void]$cleanSpools.Add($sp) }
        }
        $spools = $cleanSpools

        $cleanHist = New-Object System.Collections.ArrayList
        foreach ($h in $db["history"]) {
            if ([string]$h["id"] -notlike "pr-sample-*") { [void]$cleanHist.Add($h) }
        }
        $db["history"] = @($cleanHist)

        # Remove phantom sample AMS units that are not actually reported by the live P2S
        $liveIds = @($snap.AmsUnits | ForEach-Object { [int]$_.AmsId })
        $cleanUnits = New-Object System.Collections.ArrayList
        foreach ($u in $units) {
            if ($liveIds -contains [int]$u["amsId"] -or $u["unitType"] -eq "External") {
                [void]$cleanUnits.Add($u)
            }
        }
        $units = $cleanUnits
        $changed = $true
    }

    foreach ($liveUnit in $snap.AmsUnits) {
        $existingUnit = $null
        foreach ($u in $units) {
            if ([int]$u["amsId"] -eq [int]$liveUnit.AmsId) { $existingUnit = $u; break }
        }
        if ($null -eq $existingUnit) {
            $slotCount = if ($liveUnit.UnitType -eq "AMS HT") { 1 } else { 4 }
            $existingUnit = [ordered]@{
                id = "ams-" + $liveUnit.AmsId
                amsId = [int]$liveUnit.AmsId
                unitType = $liveUnit.UnitType
                label = $liveUnit.Label
                slotCount = $slotCount
                tempC = [math]::Round($liveUnit.TempC, 1)
                humidityRaw = [int]$liveUnit.HumidityRaw
                humidityLevel = [int]$liveUnit.HumidityLevel
                dryTimeMinutes = [int]$liveUnit.DryTimeMinutes
            }
            [void]$units.Add($existingUnit)
            $changed = $true
        } else {
            $existingUnit["tempC"] = [math]::Round($liveUnit.TempC, 1)
            $existingUnit["humidityRaw"] = [int]$liveUnit.HumidityRaw
            $existingUnit["humidityLevel"] = [int]$liveUnit.HumidityLevel
            $existingUnit["dryTimeMinutes"] = [int]$liveUnit.DryTimeMinutes
        }

        foreach ($tray in $liveUnit.Trays) {
            $matchedSpool = $null
            foreach ($sp in $spools) {
                if ($sp["slotKey"] -eq $tray.SlotKey) { $matchedSpool = $sp; break }
            }

            if ($tray.IsEmpty) {
                # Slot is physically empty on P2S: move any real occupant to Vault so slot accurately shows Empty
                if ($null -ne $matchedSpool) {
                    $matchedSpool["slotKey"] = "VAULT"
                    $changed = $true
                }
                continue
            }

            $profileName = if (-not [string]::IsNullOrWhiteSpace($tray.ProfileName)) { $tray.ProfileName } else { $tray.TrayType }
            $colorLabel  = if (-not [string]::IsNullOrWhiteSpace($tray.ColorName)) { $tray.ColorName } else { "" }
            $autoName    = if (-not [string]::IsNullOrWhiteSpace($colorLabel)) { "$profileName · $colorLabel" } else { $profileName }
            $brandName   = if ($profileName -like "Bambu*") { "Bambu Lab" } elseif ($profileName -like "Generic*") { "Generic / 3rd-Party" } else { $profileName }
            $tempRange   = if ($tray.NozzleTempMin -gt 0 -and $tray.NozzleTempMax -gt 0) { "$($tray.NozzleTempMin)-$($tray.NozzleTempMax)°C" } else { "" }

            if ($null -eq $matchedSpool) {
                $initG = if ($tray.TrayWeight -gt 50) { [double]$tray.TrayWeight } else { 1000.0 }
                $remG  = if ($tray.HasRfid -and $tray.RemainPercent -ge 0 -and $tray.RemainPercent -le 100) {
                    [math]::Round($initG * ($tray.RemainPercent / 100.0), 1)
                } else { $initG }
                $newSpool = [ordered]@{
                    id              = "sp-" + [Guid]::NewGuid().ToString("N").Substring(0, 8)
                    slotKey         = $tray.SlotKey
                    brand           = $brandName
                    name            = $autoName
                    material        = $tray.TrayType
                    color           = $tray.Color
                    initialGrams    = $initG
                    remainingGrams  = $remG
                    tareGrams       = 250
                    density         = 1.24
                    costPerKg       = 20.0
                    isRfid          = [bool]$tray.HasRfid
                    rfidUuid        = $tray.TrayUuid
                    rfidRemainPct   = [int]$tray.RemainPercent
                    trayInfoIdx     = $tray.TrayInfoIdx
                    profileName     = $profileName
                    nozzleTempRange = $tempRange
                    needsWeightInit = (-not [bool]$tray.HasRfid)
                    lastPrintUsedG  = 0
                    notes           = $(if ($tray.HasRfid) { "Auto-detected via Bambu RFID" } else { "Auto-detected from P2S AMS (Non-RFID · weigh or set starting grams)" })
                }
                [void]$spools.Add($newSpool)
                $changed = $true
            } else {
                # Update live AMS details (works for BOTH RFID and non-RFID spools!) without losing tracked grams
                $prevUuid = [string]$matchedSpool["rfidUuid"]
                if ($tray.HasRfid -and -not [string]::IsNullOrWhiteSpace($tray.TrayUuid) -and -not [string]::IsNullOrWhiteSpace($prevUuid) -and $prevUuid -ne $tray.TrayUuid) {
                    $initG = if ($tray.TrayWeight -gt 50) { [double]$tray.TrayWeight } else { 1000.0 }
                    $matchedSpool["rfidUuid"] = $tray.TrayUuid
                    $matchedSpool["initialGrams"] = $initG
                    if ($tray.RemainPercent -ge 0 -and $tray.RemainPercent -le 100) {
                        $matchedSpool["remainingGrams"] = [math]::Round($initG * ($tray.RemainPercent / 100.0), 1)
                    }
                    $matchedSpool["needsWeightInit"] = $false
                    $changed = $true
                }

                # Keep live profile, material, color, nozzle temp, and RFID status in sync
                $matchedSpool["isRfid"] = [bool]$tray.HasRfid
                $matchedSpool["rfidUuid"] = $tray.TrayUuid
                $matchedSpool["rfidRemainPct"] = [int]$tray.RemainPercent
                $matchedSpool["trayInfoIdx"] = $tray.TrayInfoIdx
                $matchedSpool["profileName"] = $profileName
                $matchedSpool["nozzleTempRange"] = $tempRange
                if (-not [string]::IsNullOrWhiteSpace($tray.TrayType) -and $matchedSpool["material"] -ne $tray.TrayType) {
                    $matchedSpool["material"] = $tray.TrayType
                    $changed = $true
                }
                if (-not [string]::IsNullOrWhiteSpace($tray.Color) -and $matchedSpool["color"] -ne $tray.Color) {
                    $matchedSpool["color"] = $tray.Color
                    $changed = $true
                }
            }
        }
    }

    if ($changed) {
        $db["amsUnits"] = @($units)
        $db["spools"] = @($spools)
        $db["isDemoData"] = $false
        Save-Database $db
    }
    return $changed
}

function Test-HasKey($dict, [string]$key) {
    if ($null -eq $dict) { return $false }
    return ($dict.Keys -contains $key)
}

function Get-HexColorDistance([string]$hex1, [string]$hex2) {
    $c1 = ([string]$hex1).TrimStart('#')
    $c2 = ([string]$hex2).TrimStart('#')
    if ($c1.Length -lt 6 -or $c2.Length -lt 6) { return 999.0 }
    try {
        $r1 = [Convert]::ToInt32($c1.Substring(0,2), 16); $g1 = [Convert]::ToInt32($c1.Substring(2,2), 16); $b1 = [Convert]::ToInt32($c1.Substring(4,2), 16)
        $r2 = [Convert]::ToInt32($c2.Substring(0,2), 16); $g2 = [Convert]::ToInt32($c2.Substring(2,2), 16); $b2 = [Convert]::ToInt32($c2.Substring(4,2), 16)
        return [math]::Sqrt([math]::Pow($r1 - $r2, 2) + [math]::Pow($g1 - $g2, 2) + [math]::Pow($b1 - $b2, 2))
    } catch { return 999.0 }
}

function Resolve-SpoolForFilament($db, $fil, [string]$mappedSlotKey, $usedSlotKeys, [bool]$isSingleFilament) {
    $loaded = @($db["spools"] | Where-Object { $_["slotKey"] -ne "VAULT" })
    if ($loaded.Count -eq 0) { return $null }

    # 1. Exact AMS mapping reported by P2S MQTT
    if (-not [string]::IsNullOrWhiteSpace($mappedSlotKey)) {
        foreach ($sp in $loaded) {
            if ($sp["slotKey"] -eq $mappedSlotKey) { return $sp }
        }
    }

    # 2. Single-filament job where P2S tray_now recorded exactly 1 active physical slot
    if ($isSingleFilament -and $null -ne $usedSlotKeys -and $usedSlotKeys.Count -eq 1) {
        $onlySlot = [string]$usedSlotKeys[0]
        foreach ($sp in $loaded) {
            if ($sp["slotKey"] -eq $onlySlot) { return $sp }
        }
    }

    # 3. Best material + closest color match (with bonus for slots actually seen active during print)
    $targetType = ([string]$fil.Type).ToUpperInvariant()
    $targetBase = ($targetType -split '-')[0]
    $targetCol  = [string]$fil.Color

    $best = $null
    $bestScore = [double]::MaxValue
    foreach ($sp in $loaded) {
        $spMat = ([string]$sp["material"]).ToUpperInvariant()
        $matExact = ($spMat -eq $targetType)
        $matBase  = ($spMat.StartsWith($targetBase) -or $targetBase.StartsWith(($spMat -split '-')[0]))
        $dist = Get-HexColorDistance ([string]$sp["color"]) $targetCol
        $activeBonus = if ($null -ne $usedSlotKeys -and ($usedSlotKeys -contains [string]$sp["slotKey"])) { -25.0 } else { 0.0 }
        $score = $dist + $(if ($matExact) { 0.0 } elseif ($matBase) { 40.0 } else { 500.0 }) + $activeBonus
        if ($score -lt $bestScore) {
            $bestScore = $score
            $best = $sp
        }
    }
    return $best
}

function Apply-PrintDeduction($db, $payload) {
    $itemsInput = $payload["items"]
    $completionPct = if (Test-HasKey $payload "completionPct") { [double]$payload["completionPct"] } else { 100.0 }
    $scaleFactor = [math]::Max(0.01, [math]::Min(1.0, $completionPct / 100.0))

    foreach ($sp in $db["spools"]) {
        $sp["lastPrintUsedG"] = 0
    }

    $loggedItems = New-Object System.Collections.ArrayList
    $totalG = 0.0
    $totalM = 0.0

    foreach ($it in $itemsInput) {
        $usedG = [math]::Round(([double]$it["usedGrams"]) * $scaleFactor, 2)
        $usedM = [math]::Round(([double]$it["usedMeters"]) * $scaleFactor, 2)
        if ($usedG -le 0) { continue }

        $spoolId = [string]$it["spoolId"]
        $slotKey = [string]$it["slotKey"]
        $spoolObj = $null
        foreach ($sp in $db["spools"]) {
            if ((-not [string]::IsNullOrWhiteSpace($spoolId) -and $sp["id"] -eq $spoolId) -or
                ([string]::IsNullOrWhiteSpace($spoolId) -and -not [string]::IsNullOrWhiteSpace($slotKey) -and $sp["slotKey"] -eq $slotKey)) {
                $spoolObj = $sp
                break
            }
        }

        $beforeG = 0.0
        $afterG = 0.0
        $spName = [string]$it["spoolName"]
        $spMat  = [string]$it["material"]
        $spCol  = [string]$it["color"]

        if ($null -ne $spoolObj) {
            $beforeG = [double]$spoolObj["remainingGrams"]
            $afterG = [math]::Max(0, [math]::Round($beforeG - $usedG, 2))
            $spoolObj["remainingGrams"] = $afterG
            $spoolObj["lastPrintUsedG"] = [math]::Round(([double]$spoolObj["lastPrintUsedG"]) + $usedG, 2)
            $spoolId = [string]$spoolObj["id"]
            $slotKey = [string]$spoolObj["slotKey"]
            $spName  = [string]$spoolObj["name"]
            $spMat   = [string]$spoolObj["material"]
            $spCol   = [string]$spoolObj["color"]
        }

        $totalG += $usedG
        $totalM += $usedM

        [void]$loggedItems.Add([ordered]@{
            slotKey     = $slotKey
            spoolId     = $spoolId
            spoolName   = $spName
            material    = $spMat
            color       = $spCol
            usedGrams   = $usedG
            usedMeters  = $usedM
            beforeGrams = $beforeG
            afterGrams  = $afterG
        })
    }

    $entry = [ordered]@{
        id                = "pr-" + [Guid]::NewGuid().ToString("N").Substring(0, 8)
        timestampUtc      = [DateTime]::UtcNow.ToString("o")
        fileName          = [string]$payload["fileName"]
        plateName         = [string]$payload["plateName"]
        source            = $(if (-not [string]::IsNullOrWhiteSpace($payload["source"])) { [string]$payload["source"] } else { "3MF Slicer" })
        status            = $(if ($completionPct -lt 99.5) { "PARTIAL" } else { "FINISH" })
        completionPct     = [math]::Round($completionPct, 0)
        totalGrams        = [math]::Round($totalG, 2)
        totalMeters       = [math]::Round($totalM, 2)
        flushGrams        = $(if (Test-HasKey $payload "flushGrams") { [math]::Round(([double]$payload["flushGrams"]) * $scaleFactor, 2) } else { 0 })
        predictionSeconds = $(if (Test-HasKey $payload "predictionSeconds") { [int]$payload["predictionSeconds"] } else { 0 })
        thumbnailBase64   = [string]$payload["thumbnailBase64"]
        undone            = $false
        items             = @($loggedItems)
    }

    $hist = To-List $db["history"]
    $hist.Insert(0, $entry)
    if ($hist.Count -gt 100) { $hist.RemoveAt($hist.Count - 1) }
    $db["history"] = @($hist)
    $db["isDemoData"] = $false
    Save-Database $db
    return $entry
}

$script:ProcessedAutoJobs = New-Object "System.Collections.Generic.HashSet[string]"
$script:LastAutoDeductNotice = $null

function Invoke-AutoDeductIfFinished($db, $snap) {
    if ($null -eq $snap -or [string]::IsNullOrWhiteSpace($snap.LastFinishedJobId)) { return $false }
    $cfg = $db["config"]
    if ((Test-HasKey $cfg "autoDeductOnFinish") -and (-not [bool]$cfg["autoDeductOnFinish"])) { return $false }

    $jobId = [string]$snap.LastFinishedJobId
    if ($script:ProcessedAutoJobs.Contains($jobId)) { return $false }
    [void]$script:ProcessedAutoJobs.Add($jobId)

    Write-Host ""
    Write-Host "[AUTO-DEDUCT] Detected finished print ($($snap.LastFinishedState), $($snap.LastFinishedPercent)%): $($snap.LastFinishedSubtaskName) / $($snap.LastFinishedFileName)" -ForegroundColor Cyan

    # Sync live AMS units/spools first so slot matching uses up-to-date slots
    if ($snap.Connected -and $snap.AmsUnits.Count -gt 0) {
        [void](Sync-LiveTelemetryIntoDb $db $snap)
    }

    $parsed = $null
    $sourceLabel = "Auto (P2S FTPS)"
    $mappingKeys = @($snap.LastFinishedMappingKeys)
    $usedSlots   = @($snap.LastFinishedUsedSlots)

    # Source 1: P2S External USB FTPS
    if (-not [string]::IsNullOrWhiteSpace($cfg["printerIp"]) -and -not [string]::IsNullOrWhiteSpace($cfg["accessCode"])) {
        $fErr = $null
        $files = [BambuFilamentManager.BambuFtpsClient]::ListPrintFiles([string]$cfg["printerIp"], [string]$cfg["accessCode"], [ref]$fErr)
        if ($files.Count -gt 0) {
            $matched = [BambuFilamentManager.BambuFtpsClient]::FindMatchingFile($files, $snap.LastFinishedFileName, $snap.LastFinishedSubtaskName)
            if ($null -ne $matched) {
                $dErr = $null
                $parsed = [BambuFilamentManager.BambuFtpsClient]::DownloadAndParse([string]$cfg["printerIp"], [string]$cfg["accessCode"], $matched.Path, [ref]$dErr)
                if ($null -ne $parsed) { $sourceLabel = "Auto (P2S USB)" }
            }
        }
    }

    # Source 2: Bambu Cloud tasks (if configured)
    if ($null -eq $parsed -and [string]$cfg["connectionMode"] -eq "cloud" -and -not [string]::IsNullOrWhiteSpace($cfg["cloudToken"])) {
        $cErr = $null
        $tasks = [BambuFilamentManager.BambuCloudClient]::GetTasks([string]$cfg["cloudRegion"], [string]$cfg["cloudToken"], [string]$cfg["printerSerial"], 5, [ref]$cErr)
        if ($tasks.Count -gt 0) {
            $parsed = $tasks[0].Parsed
            if ($mappingKeys.Count -eq 0 -and $tasks[0].MappingKeys.Count -gt 0) { $mappingKeys = @($tasks[0].MappingKeys) }
            $sourceLabel = "Auto (Bambu Cloud)"
        }
    }

    # Source 3: Local Bambu Studio / OrcaSlicer cache fallback
    if ($null -eq $parsed) {
        $localFiles = [BambuFilamentManager.LocalSlicerScanner]::FindRecentSlicedPrints(5)
        if ($localFiles.Count -gt 0) {
            $pick = $localFiles[0]
            if (-not [string]::IsNullOrWhiteSpace($snap.LastFinishedSubtaskName)) {
                foreach ($lf in $localFiles) {
                    if ($lf.Name -like ("*" + $snap.LastFinishedSubtaskName + "*")) { $pick = $lf; break }
                }
            }
            $parsed = [BambuFilamentManager.LocalSlicerScanner]::ParseLocalItem($pick.FullPath)
            if ($null -ne $parsed) { $sourceLabel = "Auto ($($pick.Source))" }
        }
    }

    if ($null -eq $parsed -or $parsed.Filaments.Count -eq 0) {
        Write-Warning "[AUTO-DEDUCT] Could not locate .gcode.3mf automatically for '$($snap.LastFinishedSubtaskName)'. Leaving manual banner active."
        return $false
    }

    $itemsPayload = New-Object System.Collections.ArrayList
    $isSingle = ($parsed.Filaments.Count -eq 1)
    for ($i = 0; $i -lt $parsed.Filaments.Count; $i++) {
        $fil = $parsed.Filaments[$i]
        $mKey = if ($i -lt $mappingKeys.Count) { [string]$mappingKeys[$i] } else { "" }
        $sp = Resolve-SpoolForFilament $db $fil $mKey $usedSlots $isSingle
        [void]$itemsPayload.Add([ordered]@{
            spoolId    = $(if ($null -ne $sp) { [string]$sp["id"] } else { "" })
            slotKey    = $(if ($null -ne $sp) { [string]$sp["slotKey"] } else { "" })
            spoolName  = $(if ($null -ne $sp) { [string]$sp["name"] } else { [string]$fil.Type })
            material   = [string]$fil.Type
            color      = [string]$fil.Color
            usedGrams  = [double]$fil.UsedGrams
            usedMeters = [double]$fil.UsedMeters
        })
    }

    $plateTitle = if (-not [string]::IsNullOrWhiteSpace($snap.LastFinishedSubtaskName)) { $snap.LastFinishedSubtaskName } elseif (-not [string]::IsNullOrWhiteSpace($parsed.PlateName)) { $parsed.PlateName } else { $parsed.FileName }
    $entry = Apply-PrintDeduction $db ([ordered]@{
        fileName          = $parsed.FileName
        plateName         = $plateTitle
        source            = $sourceLabel
        completionPct     = $(if ($snap.LastFinishedPercent -gt 0) { $snap.LastFinishedPercent } else { 100 })
        flushGrams        = $parsed.FlushGrams
        predictionSeconds = $parsed.PredictionSeconds
        thumbnailBase64   = $parsed.ThumbnailBase64
        items             = @($itemsPayload)
    })

    $MqttClient.ClearLastFinishedJob($jobId)

    $slotSummary = (@($entry["items"] | ForEach-Object { "$($_["slotKey"]) -$($_["usedGrams"])g" })) -join ", "
    $script:LastAutoDeductNotice = [ordered]@{
        id           = $entry["id"]
        plateName    = $entry["plateName"]
        totalGrams   = $entry["totalGrams"]
        slotSummary  = $slotSummary
        source       = $sourceLabel
        timestampUtc = $entry["timestampUtc"]
    }
    Write-Host "[AUTO-DEDUCT] Deducted $($entry["totalGrams"])g for '$($entry["plateName"])' ($slotSummary) via $sourceLabel!" -ForegroundColor Green
    return $true
}

function Connect-ConfiguredPrinter($cfg) {
    $mode = if ((Test-HasKey $cfg "connectionMode") -and -not [string]::IsNullOrWhiteSpace($cfg["connectionMode"])) { [string]$cfg["connectionMode"] } else { "lan" }
    if ($mode -eq "cloud") {
        $region = if ((Test-HasKey $cfg "cloudRegion") -and -not [string]::IsNullOrWhiteSpace($cfg["cloudRegion"])) { [string]$cfg["cloudRegion"] } else { "global" }
        $MqttClient.ConfigureAndConnectCloud($region, [string]$cfg["cloudUid"], [string]$cfg["cloudToken"], [string]$cfg["printerSerial"])
    } else {
        $MqttClient.ConfigureAndConnect([string]$cfg["printerIp"], [string]$cfg["printerSerial"], [string]$cfg["accessCode"])
    }
}

# Load Database & Ensure Cloud Config Fields Exist
$Db = Load-Database
if (-not (Test-HasKey $Db["config"] "connectionMode")) { $Db["config"]["connectionMode"] = "lan"; Save-Database $Db }
if (-not (Test-HasKey $Db["config"] "cloudRegion"))    { $Db["config"]["cloudRegion"] = "global" }
if (-not (Test-HasKey $Db["config"] "cloudEmail"))     { $Db["config"]["cloudEmail"] = "" }
if (-not (Test-HasKey $Db["config"] "cloudUid"))           { $Db["config"]["cloudUid"] = "" }
if (-not (Test-HasKey $Db["config"] "cloudToken"))         { $Db["config"]["cloudToken"] = "" }
if (-not (Test-HasKey $Db["config"] "autoDeductOnFinish")) { $Db["config"]["autoDeductOnFinish"] = $true; Save-Database $Db }

if ($Db["config"]["autoConnect"]) {
    $m = [string]$Db["config"]["connectionMode"]
    if ($m -eq "cloud" -and -not [string]::IsNullOrWhiteSpace($Db["config"]["cloudToken"]) -and -not [string]::IsNullOrWhiteSpace($Db["config"]["printerSerial"])) {
        Write-Host "Auto-connecting to Bambu Cloud ($($Db["config"]["cloudRegion"]))..." -ForegroundColor Yellow
        Connect-ConfiguredPrinter $Db["config"]
    } elseif ($m -eq "lan" -and -not [string]::IsNullOrWhiteSpace($Db["config"]["printerIp"]) -and -not [string]::IsNullOrWhiteSpace($Db["config"]["printerSerial"]) -and -not [string]::IsNullOrWhiteSpace($Db["config"]["accessCode"])) {
        Write-Host "Auto-connecting to P2S LAN at $($Db["config"]["printerIp"])..." -ForegroundColor Yellow
        Connect-ConfiguredPrinter $Db["config"]
    }
}

# Start HTTP Server (TcpListener-based, requires zero Admin/URLACL privileges!)
$Server = $null
$ActualPort = $Port
for ($p = $Port; $p -lt ($Port + 10); $p++) {
    try {
        $s = New-Object BambuFilamentManager.SimpleHttpServer
        $s.Start($p)
        $Server = $s
        $ActualPort = $p
        break
    } catch {
        if ($s) { try { $s.Stop() } catch {} }
    }
}

if ($null -eq $Server) {
    Write-Error "Could not start local web server on ports $Port-$($Port+9)."
    exit 1
}

$Url = "http://127.0.0.1:$ActualPort/"
Write-Host ""
Write-Host "  Dashboard URL : $Url" -ForegroundColor Green
Write-Host "  Data File     : $DbPath" -ForegroundColor Gray
Write-Host "  Press Ctrl+C in this window to stop the server." -ForegroundColor DarkGray
Write-Host ""

if (-not $NoBrowser) {
    Start-Process $Url
}

$script:LastBgCheckUtc = [DateTime]::MinValue

try {
    while ($Server.IsListening) {
        # Background check every ~2.5s so finished prints auto-deduct even when browser is closed!
        if (([DateTime]::UtcNow - $script:LastBgCheckUtc).TotalSeconds -ge 2.5) {
            $script:LastBgCheckUtc = [DateTime]::UtcNow
            try {
                $bgSnap = $MqttClient.GetSnapshot()
                if ($Db["config"]["autoSyncRfid"] -and $bgSnap.Connected -and $bgSnap.AmsUnits.Count -gt 0) {
                    [void](Sync-LiveTelemetryIntoDb $Db $bgSnap)
                }
                if (-not [string]::IsNullOrWhiteSpace($bgSnap.LastFinishedJobId)) {
                    [void](Invoke-AutoDeductIfFinished $Db $bgSnap)
                }
            } catch {
                Write-Warning "Background check error: $_"
            }
        }

        $req = $Server.AcceptRequestWithTimeout(1200)
        if ($null -eq $req) { continue }
        $res = $req
        $path = $req.Path
        $method = $req.Method

        try {
            if ($method -eq "GET" -and $path -eq "/api/state") {
                $snap = $MqttClient.GetSnapshot()
                if ($Db["config"]["autoSyncRfid"] -and $snap.Connected -and $snap.AmsUnits.Count -gt 0) {
                    [void](Sync-LiveTelemetryIntoDb $Db $snap)
                }
                if (-not [string]::IsNullOrWhiteSpace($snap.LastFinishedJobId)) {
                    if (Invoke-AutoDeductIfFinished $Db $snap) {
                        $snap = $MqttClient.GetSnapshot()
                    }
                }
                Send-Json $res ([ordered]@{
                    ok               = $true
                    db               = $Db
                    telemetry        = $snap
                    autoDeductNotice = $script:LastAutoDeductNotice
                })
            }
            elseif ($method -eq "POST" -and $path -eq "/api/auto-deduct/dismiss") {
                $script:LastAutoDeductNotice = $null
                Send-Json $res ([ordered]@{ ok = $true })
            }
            elseif ($method -eq "POST" -and $path -eq "/api/config") {
                $body = Parse-JsonBody $req
                $cfg = $Db["config"]
                foreach ($k in @("connectionMode","cloudRegion","cloudEmail","cloudUid","cloudToken","printerModel","printerName","printerIp","printerSerial","accessCode","safetyBufferG","safetyBufferPct","lowSpoolWarnG","autoConnect","autoSyncRfid","autoDeductOnFinish")) {
                    if ($body.ContainsKey($k)) { $cfg[$k] = $body[$k] }
                }
                if ($cfg["connectionMode"] -eq "cloud" -and -not [string]::IsNullOrWhiteSpace($cfg["cloudToken"]) -and [string]::IsNullOrWhiteSpace($cfg["cloudUid"])) {
                    $cfg["cloudUid"] = [BambuFilamentManager.BambuCloudClient]::ResolveUid([string]$cfg["cloudRegion"], [string]$cfg["cloudToken"])
                }
                $Db["config"] = $cfg
                Save-Database $Db

                if ($body.ContainsKey("connectNow") -and $body["connectNow"] -eq $true) {
                    Connect-ConfiguredPrinter $cfg
                }
                Send-Json $res ([ordered]@{ ok = $true; config = $cfg; telemetry = $MqttClient.GetSnapshot() })
            }
            elseif ($method -eq "POST" -and $path -eq "/api/cloud/login") {
                $body = Parse-JsonBody $req
                $cfg = $Db["config"]
                $region = if ($body.ContainsKey("region") -and -not [string]::IsNullOrWhiteSpace($body["region"])) { [string]$body["region"] } else { "global" }
                $email = [string]$body["email"]
                $password = [string]$body["password"]
                $verifyCode = [string]$body["verifyCode"]
                $directToken = [string]$body["accessToken"]

                if (-not [string]::IsNullOrWhiteSpace($directToken)) {
                    $uid = [BambuFilamentManager.BambuCloudClient]::ResolveUid($region, $directToken)
                    $devErr = $null
                    $devices = [BambuFilamentManager.BambuCloudClient]::GetBoundDevices($region, $directToken, [ref]$devErr)
                    if ([string]::IsNullOrWhiteSpace($uid) -and $devices.Count -eq 0 -and $devErr) {
                        Send-Json $res ([ordered]@{ ok = $false; error = $devErr }) 400
                        continue
                    }
                    $cfg["connectionMode"] = "cloud"
                    $cfg["cloudRegion"] = $region
                    $cfg["cloudToken"] = $directToken.Trim()
                    $cfg["cloudUid"] = $uid
                    if ($devices.Count -gt 0 -and [string]::IsNullOrWhiteSpace($cfg["printerSerial"])) {
                        $cfg["printerSerial"] = $devices[0].DevId
                        $cfg["printerName"] = $devices[0].Name
                        if (-not [string]::IsNullOrWhiteSpace($devices[0].ModelName)) { $cfg["printerModel"] = $devices[0].ModelName }
                    }
                    $Db["config"] = $cfg
                    Save-Database $Db
                    if (-not [string]::IsNullOrWhiteSpace($cfg["printerSerial"]) -and -not [string]::IsNullOrWhiteSpace($cfg["cloudUid"])) {
                        Connect-ConfiguredPrinter $cfg
                    }
                    Send-Json $res ([ordered]@{ ok = $true; needsVerificationCode = $false; message = "Signed in with Bambu Cloud token."; devices = $devices; config = $cfg; telemetry = $MqttClient.GetSnapshot() })
                    continue
                }

                $loginRes = [BambuFilamentManager.BambuCloudClient]::Login($region, $email, $password, $verifyCode)
                if ($loginRes.NeedsVerificationCode) {
                    $cfg["connectionMode"] = "cloud"
                    $cfg["cloudRegion"] = $region
                    $cfg["cloudEmail"] = $email
                    Save-Database $Db
                    Send-Json $res ([ordered]@{ ok = $true; needsVerificationCode = $true; message = $loginRes.Message })
                } elseif (-not $loginRes.Ok) {
                    Send-Json $res ([ordered]@{ ok = $false; error = $loginRes.Message }) 400
                } else {
                    $cfg["connectionMode"] = "cloud"
                    $cfg["cloudRegion"] = $region
                    $cfg["cloudEmail"] = $email
                    $cfg["cloudUid"] = $loginRes.Uid
                    $cfg["cloudToken"] = $loginRes.AccessToken
                    if ($loginRes.Devices.Count -gt 0 -and [string]::IsNullOrWhiteSpace($cfg["printerSerial"])) {
                        $cfg["printerSerial"] = $loginRes.Devices[0].DevId
                        $cfg["printerName"] = $loginRes.Devices[0].Name
                        if (-not [string]::IsNullOrWhiteSpace($loginRes.Devices[0].ModelName)) { $cfg["printerModel"] = $loginRes.Devices[0].ModelName }
                    }
                    $Db["config"] = $cfg
                    Save-Database $Db
                    if (-not [string]::IsNullOrWhiteSpace($cfg["printerSerial"]) -and -not [string]::IsNullOrWhiteSpace($cfg["cloudUid"])) {
                        Connect-ConfiguredPrinter $cfg
                    }
                    Send-Json $res ([ordered]@{ ok = $true; needsVerificationCode = $false; message = $loginRes.Message; devices = $loginRes.Devices; config = $cfg; telemetry = $MqttClient.GetSnapshot() })
                }
            }
            elseif ($method -eq "GET" -and $path -eq "/api/cloud/devices") {
                $cfg = $Db["config"]
                $err = $null
                $devs = [BambuFilamentManager.BambuCloudClient]::GetBoundDevices([string]$cfg["cloudRegion"], [string]$cfg["cloudToken"], [ref]$err)
                Send-Json $res ([ordered]@{ ok = ($null -eq $err -or $devs.Count -gt 0); devices = $devs; error = $err })
            }
            elseif ($method -eq "GET" -and $path -eq "/api/cloud/tasks") {
                $cfg = $Db["config"]
                $err = $null
                $tasks = [BambuFilamentManager.BambuCloudClient]::GetTasks([string]$cfg["cloudRegion"], [string]$cfg["cloudToken"], [string]$cfg["printerSerial"], 20, [ref]$err)
                Send-Json $res ([ordered]@{ ok = ($null -eq $err -or $tasks.Count -gt 0); tasks = $tasks; error = $err })
            }
            elseif ($method -eq "POST" -and $path -eq "/api/cloud/current-job") {
                $cfg = $Db["config"]
                $snap = $MqttClient.GetSnapshot()
                $err = $null
                $tasks = [BambuFilamentManager.BambuCloudClient]::GetTasks([string]$cfg["cloudRegion"], [string]$cfg["cloudToken"], [string]$cfg["printerSerial"], 10, [ref]$err)
                if ($tasks.Count -eq 0) {
                    Send-Json $res ([ordered]@{ ok = $false; error = $(if ($err) { $err } else { "No Bambu Cloud print tasks found for this printer." }) }) 400
                    continue
                }
                # Pick active running task if present, otherwise most recent task
                $chosen = $tasks[0]
                foreach ($t in $tasks) {
                    $st = ([string]$t.Status).ToLowerInvariant()
                    if ($st -eq "running" -or $st -eq "1" -or $st -eq "prepare" -or $st -eq "pause") { $chosen = $t; break }
                }
                $mKeys = if ($snap.AmsMappingKeys.Count -gt 0) { $snap.AmsMappingKeys } else { $chosen.MappingKeys }
                Send-Json $res ([ordered]@{
                    ok          = $true
                    task        = $chosen
                    parsed      = $chosen.Parsed
                    gcodeState  = $snap.GcodeState
                    mcPercent   = $snap.McPercent
                    mappingKeys = $mKeys
                })
            }
            elseif ($method -eq "POST" -and $path -eq "/api/printer/connect") {
                $cfg = $Db["config"]
                Connect-ConfiguredPrinter $cfg
                Send-Json $res ([ordered]@{ ok = $true; telemetry = $MqttClient.GetSnapshot() })
            }
            elseif ($method -eq "POST" -and $path -eq "/api/shutdown") {
                Send-Json $res ([ordered]@{ ok = $true; message = "Shutting down Filament Manager..." })
                break
            }
            elseif ($method -eq "POST" -and $path -eq "/api/printer/disconnect") {
                $MqttClient.Disconnect()
                Send-Json $res ([ordered]@{ ok = $true; telemetry = $MqttClient.GetSnapshot() })
            }
            elseif ($method -eq "POST" -and $path -eq "/api/printer/pushall") {
                $MqttClient.RequestPushAll()
                Send-Json $res ([ordered]@{ ok = $true })
            }
            elseif ($method -eq "POST" -and $path -eq "/api/printer/sync-ams") {
                $snap = $MqttClient.GetSnapshot()
                if (-not $snap.Connected) {
                    Send-Json $res ([ordered]@{ ok = $false; error = "Printer is not connected via LAN MQTT." }) 400
                } else {
                    $synced = Sync-LiveTelemetryIntoDb $Db $snap
                    Send-Json $res ([ordered]@{ ok = $true; changed = $synced; db = $Db })
                }
            }
            elseif ($method -eq "POST" -and $path -eq "/api/printer/dismiss-finished") {
                $body = Parse-JsonBody $req
                $MqttClient.ClearLastFinishedJob([string]$body["jobId"])
                Send-Json $res ([ordered]@{ ok = $true })
            }
            elseif ($method -eq "GET" -and $path -eq "/api/ftps/files") {
                $cfg = $Db["config"]
                $err = $null
                $files = [BambuFilamentManager.BambuFtpsClient]::ListPrintFiles([string]$cfg["printerIp"], [string]$cfg["accessCode"], [ref]$err)
                Send-Json $res ([ordered]@{ ok = ($null -eq $err -or $files.Count -gt 0); files = $files; error = $err })
            }
            elseif ($method -eq "GET" -and $path -eq "/api/local-cache/files") {
                $localFiles = [BambuFilamentManager.LocalSlicerScanner]::FindRecentSlicedPrints(20)
                Send-Json $res ([ordered]@{ ok = $true; files = $localFiles })
            }
            elseif ($method -eq "POST" -and $path -eq "/api/local-cache/parse") {
                $body = Parse-JsonBody $req
                $localPath = [string]$body["path"]
                if ([string]::IsNullOrWhiteSpace($localPath)) {
                    $localFiles = [BambuFilamentManager.LocalSlicerScanner]::FindRecentSlicedPrints(1)
                    if ($localFiles.Count -eq 0) {
                        Send-Json $res ([ordered]@{ ok = $false; error = "No sliced prints found in Bambu Studio / OrcaSlicer cache or Downloads. Slice a plate in Bambu Studio first (or export .gcode.3mf)." }) 400
                        continue
                    }
                    $localPath = $localFiles[0].FullPath
                }
                $parsed = [BambuFilamentManager.LocalSlicerScanner]::ParseLocalItem($localPath)
                Send-Json $res ([ordered]@{ ok = $true; parsed = $parsed; path = $localPath })
            }
            elseif ($method -eq "POST" -and $path -eq "/api/ftps/current-job") {
                $cfg = $Db["config"]
                $snap = $MqttClient.GetSnapshot()
                $err = $null
                $files = [BambuFilamentManager.BambuFtpsClient]::ListPrintFiles([string]$cfg["printerIp"], [string]$cfg["accessCode"], [ref]$err)
                if ($files.Count -eq 0) {
                    # Automatic fallback: if P2S external USB storage is empty, check local Bambu Studio / OrcaSlicer cache!
                    $localFiles = [BambuFilamentManager.LocalSlicerScanner]::FindRecentSlicedPrints(5)
                    if ($localFiles.Count -gt 0) {
                        $pick = $localFiles[0]
                        if (-not [string]::IsNullOrWhiteSpace($snap.SubtaskName)) {
                            foreach ($lf in $localFiles) {
                                if ($lf.Name -like ("*" + $snap.SubtaskName + "*")) { $pick = $lf; break }
                            }
                        }
                        $parsedLocal = [BambuFilamentManager.LocalSlicerScanner]::ParseLocalItem($pick.FullPath)
                        Send-Json $res ([ordered]@{
                            ok          = $true
                            parsed      = $parsedLocal
                            remotePath  = $pick.Source + ": " + $pick.Name
                            sourceNote  = "P2S FTPS USB was empty; pulled automatically from " + $pick.Source
                            gcodeState  = $snap.GcodeState
                            mcPercent   = $snap.McPercent
                            subtaskName = $snap.SubtaskName
                            mappingKeys = $snap.AmsMappingKeys
                        })
                        continue
                    }
                    Send-Json $res ([ordered]@{ ok = $false; error = $(if ($err) { $err } else { "No .gcode.3mf files found on P2S FTPS or local Bambu Studio cache." }) }) 400
                    continue
                }
                $matched = [BambuFilamentManager.BambuFtpsClient]::FindMatchingFile($files, $snap.GcodeFile, $snap.SubtaskName)
                $parsed = [BambuFilamentManager.BambuFtpsClient]::DownloadAndParse([string]$cfg["printerIp"], [string]$cfg["accessCode"], $matched.Path, [ref]$err)
                if ($null -eq $parsed) {
                    Send-Json $res ([ordered]@{ ok = $false; error = $err }) 400
                } else {
                    Send-Json $res ([ordered]@{
                        ok          = $true
                        parsed      = $parsed
                        remotePath  = $matched.Path
                        gcodeState  = $snap.GcodeState
                        mcPercent   = $snap.McPercent
                        subtaskName = $snap.SubtaskName
                        mappingKeys = $snap.AmsMappingKeys
                    })
                }
            }
            elseif ($method -eq "POST" -and $path -eq "/api/ftps/parse") {
                $body = Parse-JsonBody $req
                $cfg = $Db["config"]
                $remotePath = [string]$body["remotePath"]
                $err = $null

                if ([string]::IsNullOrWhiteSpace($remotePath)) {
                    $files = [BambuFilamentManager.BambuFtpsClient]::ListPrintFiles([string]$cfg["printerIp"], [string]$cfg["accessCode"], [ref]$err)
                    if ($files.Count -eq 0) {
                        Send-Json $res ([ordered]@{ ok = $false; error = $(if ($err) { $err } else { "No .gcode.3mf files found on P2S SD card." }) }) 400
                        continue
                    }
                    $remotePath = $files[0].Path
                }

                $parsed = [BambuFilamentManager.BambuFtpsClient]::DownloadAndParse([string]$cfg["printerIp"], [string]$cfg["accessCode"], $remotePath, [ref]$err)
                if ($null -eq $parsed) {
                    Send-Json $res ([ordered]@{ ok = $false; error = $err }) 400
                } else {
                    Send-Json $res ([ordered]@{ ok = $true; parsed = $parsed; remotePath = $remotePath })
                }
            }
            elseif ($method -eq "POST" -and $path -eq "/api/parse-file") {
                $fileName = $req.GetHeader("X-File-Name")
                if ([string]::IsNullOrWhiteSpace($fileName)) { $fileName = "upload.gcode.3mf" }
                $fileName = [System.Uri]::UnescapeDataString($fileName)
                $safeName = [System.IO.Path]::GetFileName($fileName) -replace '[^a-zA-Z0-9._-]', '_'
                $bytes = Read-RawBytes $req
                if ($bytes.Length -eq 0) {
                    Send-Json $res ([ordered]@{ ok = $false; error = "Empty file uploaded." }) 400
                } else {
                    # Stage file locally so user can submit it directly to P2S without re-uploading
                    if (-not (Test-Path $UploadsDir)) { New-Item -ItemType Directory -Path $UploadsDir -Force | Out-Null }
                    $stagedId = [Guid]::NewGuid().ToString("N").Substring(0, 10) + "_" + $safeName
                    $stagedPath = Join-Path $UploadsDir $stagedId
                    [System.IO.File]::WriteAllBytes($stagedPath, $bytes)

                    # Keep only the 10 most recent staged uploads
                    Get-ChildItem -Path $UploadsDir -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -Skip 10 | Remove-Item -Force -ErrorAction SilentlyContinue

                    $parsed = [BambuFilamentManager.ThreeMfParser]::ParseFile($stagedPath, $fileName)
                    Send-Json $res ([ordered]@{ ok = $true; parsed = $parsed; stagedId = $stagedId; fileName = $safeName })
                }
            }
            elseif ($method -eq "POST" -and $path -eq "/api/print/start") {
                $body = Parse-JsonBody $req
                $cfg = $Db["config"]
                $remotePath = [string]$body["remotePath"]
                $stagedId = [string]$body["stagedId"]
                $localFilePath = [string]$body["localFilePath"]
                $subtaskName = [string]$body["subtaskName"]
                $plateIndex = if ($body.ContainsKey("plateIndex") -and [int]$body["plateIndex"] -gt 0) { [int]$body["plateIndex"] } else { 1 }
                $useAms = if ($body.ContainsKey("useAms")) { [bool]$body["useAms"] } else { $true }
                $bedLeveling = if ($body.ContainsKey("bedLeveling")) { [bool]$body["bedLeveling"] } else { $true }
                $flowCali = if ($body.ContainsKey("flowCali")) { [bool]$body["flowCali"] } else { $false }
                $vibrationCali = if ($body.ContainsKey("vibrationCali")) { [bool]$body["vibrationCali"] } else { $true }
                $layerInspect = if ($body.ContainsKey("layerInspect")) { [bool]$body["layerInspect"] } else { $false }
                $timelapse = if ($body.ContainsKey("timelapse")) { [bool]$body["timelapse"] } else { $false }
                $urlScheme = if ($body.ContainsKey("urlScheme") -and -not [string]::IsNullOrWhiteSpace($body["urlScheme"])) { [string]$body["urlScheme"] } else { "ftp" }
                $uploadOnly = if ($body.ContainsKey("uploadOnly")) { [bool]$body["uploadOnly"] } else { $false }

                $md5Hex = ""
                $uploadedNow = $false

                # If no remotePath on P2S yet, upload staged or local .gcode.3mf to P2S via FTPS
                if ([string]::IsNullOrWhiteSpace($remotePath)) {
                    $srcFile = $null
                    $targetFileName = ""
                    if (-not [string]::IsNullOrWhiteSpace($stagedId)) {
                        $cleanId = [System.IO.Path]::GetFileName($stagedId)
                        $cand = Join-Path $UploadsDir $cleanId
                        if (Test-Path $cand -PathType Leaf) {
                            $srcFile = $cand
                            # Strip 10-char guid prefix
                            $targetFileName = if ($cleanId.Length -gt 11 -and $cleanId[10] -eq '_') { $cleanId.Substring(11) } else { $cleanId }
                        }
                    } elseif (-not [string]::IsNullOrWhiteSpace($localFilePath) -and (Test-Path $localFilePath -PathType Leaf)) {
                        $srcFile = $localFilePath
                        $targetFileName = [System.IO.Path]::GetFileName($localFilePath) -replace '[^a-zA-Z0-9._-]', '_'
                    }

                    if ($null -eq $srcFile) {
                        Send-Json $res ([ordered]@{ ok = $false; error = "No print file selected to submit. Drop a sliced .gcode.3mf file or pick a file from the P2S USB drive first." }) 400
                        continue
                    }

                    $remotePath = "/" + $targetFileName
                    $md5Hex = [BambuFilamentManager.BambuFtpsClient]::ComputeFileMd5($srcFile)
                    $upErr = $null
                    $upOk = [BambuFilamentManager.BambuFtpsClient]::UploadFile([string]$cfg["printerIp"], [string]$cfg["accessCode"], $srcFile, $remotePath, [ref]$upErr)
                    if (-not $upOk) {
                        Send-Json $res ([ordered]@{ ok = $false; error = "Failed to upload to P2S USB via FTPS: $upErr" }) 400
                        continue
                    }
                    $uploadedNow = $true
                }

                if ($uploadOnly) {
                    Send-Json $res ([ordered]@{ ok = $true; uploaded = $true; started = $false; remotePath = $remotePath; message = "Uploaded $remotePath to P2S USB storage." })
                    continue
                }

                # Build ordered slot-key mapping list matching 1-based filament indices in slice_info.config
                $slotKeysList = New-Object "System.Collections.Generic.List[string]"
                if ($body.ContainsKey("slotKeys") -and $null -ne $body["slotKeys"]) {
                    foreach ($sk in $body["slotKeys"]) {
                        $slotKeysList.Add([string]$sk)
                    }
                }

                $payloadOut = $null
                $startErr = $null
                $started = $MqttClient.StartPrintJob(
                    $remotePath,
                    $subtaskName,
                    $plateIndex,
                    $useAms,
                    $slotKeysList,
                    $bedLeveling,
                    $flowCali,
                    $vibrationCali,
                    $layerInspect,
                    $timelapse,
                    $urlScheme,
                    $md5Hex,
                    [ref]$payloadOut,
                    [ref]$startErr
                )

                if (-not $started) {
                    Send-Json $res ([ordered]@{ ok = $false; error = $startErr; uploaded = $uploadedNow; remotePath = $remotePath }) 400
                } else {
                    Send-Json $res ([ordered]@{
                        ok         = $true
                        uploaded   = $uploadedNow
                        started    = $true
                        remotePath = $remotePath
                        message    = $(if ($uploadedNow) { "Uploaded $remotePath and sent print command to P2S!" } else { "Sent print command for $remotePath to P2S!" })
                        telemetry  = $MqttClient.GetSnapshot()
                    })
                }
            }
            elseif ($method -eq "POST" -and $path -eq "/api/print/control") {
                $body = Parse-JsonBody $req
                $action = [string]$body["action"]
                $ctrlErr = $null
                $okCtrl = $MqttClient.SendPrintControl($action, [ref]$ctrlErr)
                if (-not $okCtrl) {
                    Send-Json $res ([ordered]@{ ok = $false; error = $ctrlErr }) 400
                } else {
                    Send-Json $res ([ordered]@{ ok = $true; action = $action; message = "Sent '$action' command to P2S." })
                }
            }
            elseif ($method -eq "POST" -and $path -eq "/api/ams/add") {
                $body = Parse-JsonBody $req
                $unitType = [string]$body["unitType"]
                if ([string]::IsNullOrWhiteSpace($unitType)) { $unitType = "AMS 2 Pro" }
                $units = To-List $Db["amsUnits"]

                if ($unitType -eq "AMS HT") {
                    $existingHt = @($units | Where-Object { $_["unitType"] -eq "AMS HT" })
                    $nextAmsId = 128 + $existingHt.Count
                    $label = if (-not [string]::IsNullOrWhiteSpace($body["label"])) { [string]$body["label"] } else { "AMS HT #" + ($existingHt.Count + 1) }
                    [void]$units.Add([ordered]@{
                        id = "ams-" + $nextAmsId; amsId = $nextAmsId; unitType = "AMS HT"; label = $label; slotCount = 1; tempC = 0; humidityRaw = 0; humidityLevel = 0; dryTimeMinutes = 0
                    })
                }
                elseif ($unitType -eq "External") {
                    $hasExt = @($units | Where-Object { $_["unitType"] -eq "External" }).Count -gt 0
                    if (-not $hasExt) {
                        [void]$units.Add([ordered]@{
                            id = "ams-254"; amsId = 254; unitType = "External"; label = "External Spool"; slotCount = 1; tempC = 0; humidityRaw = 0; humidityLevel = 0; dryTimeMinutes = 0
                        })
                    }
                }
                else {
                    $existingPro = @($units | Where-Object { $_["unitType"] -eq "AMS 2 Pro" -or $_["unitType"] -eq "AMS" })
                    $usedIds = @($existingPro | ForEach-Object { [int]$_["amsId"] })
                    $nextAmsId = 0
                    while ($usedIds -contains $nextAmsId) { $nextAmsId++ }
                    $letter = [char]([int][char]'A' + $nextAmsId)
                    $label = if (-not [string]::IsNullOrWhiteSpace($body["label"])) { [string]$body["label"] } else { "AMS 2 Pro $letter" }
                    [void]$units.Add([ordered]@{
                        id = "ams-" + $nextAmsId; amsId = $nextAmsId; unitType = "AMS 2 Pro"; label = $label; slotCount = 4; tempC = 0; humidityRaw = 0; humidityLevel = 0; dryTimeMinutes = 0
                    })
                }

                $Db["amsUnits"] = @($units)
                Save-Database $Db
                Send-Json $res ([ordered]@{ ok = $true; db = $Db })
            }
            elseif ($method -eq "POST" -and $path -eq "/api/ams/remove") {
                $body = Parse-JsonBody $req
                $targetId = [string]$body["id"]
                $units = To-List $Db["amsUnits"]
                $removed = $null
                for ($i = 0; $i -lt $units.Count; $i++) {
                    if ($units[$i]["id"] -eq $targetId) { $removed = $units[$i]; $units.RemoveAt($i); break }
                }
                if ($null -ne $removed) {
                    # Move any spools from removed unit safely to VAULT
                    $amsId = [int]$removed["amsId"]
                    $prefix = if ($removed["unitType"] -eq "AMS HT") { "HT-" + (($amsId - 128) + 1) } elseif ($removed["unitType"] -eq "External") { "EXT" } else { [string]([char]([int][char]'A' + $amsId)) }
                    foreach ($sp in $Db["spools"]) {
                        $sk = [string]$sp["slotKey"]
                        if ($removed["unitType"] -eq "AMS HT" -and $sk -eq $prefix) { $sp["slotKey"] = "VAULT" }
                        elseif ($removed["unitType"] -eq "External" -and $sk -eq "EXT") { $sp["slotKey"] = "VAULT" }
                        elseif ($removed["unitType"] -ne "AMS HT" -and $removed["unitType"] -ne "External" -and $sk -match ("^" + $prefix + "[1-4]$")) { $sp["slotKey"] = "VAULT" }
                    }
                    $Db["amsUnits"] = @($units)
                    Save-Database $Db
                }
                Send-Json $res ([ordered]@{ ok = $true; db = $Db })
            }
            elseif ($method -eq "POST" -and $path -eq "/api/spools/save") {
                $body = Parse-JsonBody $req
                $spools = To-List $Db["spools"]
                $spId = [string]$body["id"]
                $slotKey = if (-not [string]::IsNullOrWhiteSpace($body["slotKey"])) { [string]$body["slotKey"] } else { "VAULT" }

                # If assigning to a non-VAULT slot, move any existing occupant to VAULT
                if ($slotKey -ne "VAULT") {
                    foreach ($sp in $spools) {
                        if ($sp["slotKey"] -eq $slotKey -and $sp["id"] -ne $spId) {
                            $sp["slotKey"] = "VAULT"
                        }
                    }
                }

                $existing = $null
                if (-not [string]::IsNullOrWhiteSpace($spId)) {
                    foreach ($sp in $spools) {
                        if ($sp["id"] -eq $spId) { $existing = $sp; break }
                    }
                }

                if ($null -eq $existing) {
                    $newSp = [ordered]@{
                        id             = "sp-" + [Guid]::NewGuid().ToString("N").Substring(0, 8)
                        slotKey        = $slotKey
                        brand          = [string]$body["brand"]
                        name           = [string]$body["name"]
                        material       = [string]$body["material"]
                        color          = [BambuFilamentManager.ThreeMfParser]::NormalizeHexColor([string]$body["color"])
                        initialGrams   = [double]$body["initialGrams"]
                        remainingGrams = [math]::Max(0, [math]::Round([double]$body["remainingGrams"], 2))
                        tareGrams      = [double]$body["tareGrams"]
                        density        = $(if ($body.ContainsKey("density") -and [double]$body["density"] -gt 0) { [double]$body["density"] } else { 1.24 })
                        costPerKg      = $(if ($body.ContainsKey("costPerKg")) { [double]$body["costPerKg"] } else { 20.0 })
                        isRfid         = [bool]$body["isRfid"]
                        rfidUuid       = [string]$body["rfidUuid"]
                        rfidRemainPct  = $(if ($body.ContainsKey("rfidRemainPct")) { [int]$body["rfidRemainPct"] } else { -1 })
                        lastPrintUsedG = 0
                        notes          = [string]$body["notes"]
                    }
                    [void]$spools.Add($newSp)
                } else {
                    $existing["slotKey"]        = $slotKey
                    $existing["brand"]          = [string]$body["brand"]
                    $existing["name"]           = [string]$body["name"]
                    $existing["material"]       = [string]$body["material"]
                    $existing["color"]          = [BambuFilamentManager.ThreeMfParser]::NormalizeHexColor([string]$body["color"])
                    $existing["initialGrams"]   = [double]$body["initialGrams"]
                    $existing["remainingGrams"] = [math]::Max(0, [math]::Round([double]$body["remainingGrams"], 2))
                    $existing["tareGrams"]      = [double]$body["tareGrams"]
                    $existing["needsWeightInit"] = $false
                    if ($body.ContainsKey("density") -and [double]$body["density"] -gt 0) { $existing["density"] = [double]$body["density"] }
                    if ($body.ContainsKey("costPerKg")) { $existing["costPerKg"] = [double]$body["costPerKg"] }
                    if ($body.ContainsKey("isRfid")) { $existing["isRfid"] = [bool]$body["isRfid"] }
                    if ($body.ContainsKey("notes")) { $existing["notes"] = [string]$body["notes"] }
                }

                $Db["spools"] = @($spools)
                Save-Database $Db
                Send-Json $res ([ordered]@{ ok = $true; db = $Db })
            }
            elseif ($method -eq "POST" -and $path -eq "/api/spools/weigh") {
                $body = Parse-JsonBody $req
                $spId = [string]$body["id"]
                $grossG = [double]$body["grossGrams"]
                $tareG = [double]$body["tareGrams"]
                $netG = [math]::Max(0, [math]::Round($grossG - $tareG, 1))

                foreach ($sp in $Db["spools"]) {
                    if ($sp["id"] -eq $spId) {
                        $sp["tareGrams"] = $tareG
                        $sp["remainingGrams"] = $netG
                        $sp["needsWeightInit"] = $false
                        if ($netG -gt [double]$sp["initialGrams"]) {
                            $sp["initialGrams"] = [math]::Ceiling($netG / 100.0) * 100
                        }
                        break
                    }
                }
                Save-Database $Db
                Send-Json $res ([ordered]@{ ok = $true; netGrams = $netG; db = $Db })
            }
            elseif ($method -eq "POST" -and $path -eq "/api/spools/adjust") {
                $body = Parse-JsonBody $req
                $spId = [string]$body["id"]
                foreach ($sp in $Db["spools"]) {
                    if ($sp["id"] -eq $spId) {
                        if ($body.ContainsKey("deltaGrams")) {
                            $sp["remainingGrams"] = [math]::Max(0, [math]::Round([double]$sp["remainingGrams"] + [double]$body["deltaGrams"], 2))
                        }
                        if ($body.ContainsKey("slotKey")) {
                            $targetSlot = [string]$body["slotKey"]
                            if ($targetSlot -ne "VAULT") {
                                foreach ($other in $Db["spools"]) {
                                    if ($other["slotKey"] -eq $targetSlot -and $other["id"] -ne $spId) { $other["slotKey"] = "VAULT" }
                                }
                            }
                            $sp["slotKey"] = $targetSlot
                        }
                        break
                    }
                }
                Save-Database $Db
                Send-Json $res ([ordered]@{ ok = $true; db = $Db })
            }
            elseif ($method -eq "POST" -and $path -eq "/api/spools/delete") {
                $body = Parse-JsonBody $req
                $spId = [string]$body["id"]
                $spools = To-List $Db["spools"]
                for ($i = 0; $i -lt $spools.Count; $i++) {
                    if ($spools[$i]["id"] -eq $spId) { $spools.RemoveAt($i); break }
                }
                $Db["spools"] = @($spools)
                Save-Database $Db
                Send-Json $res ([ordered]@{ ok = $true; db = $Db })
            }
            elseif ($method -eq "POST" -and $path -eq "/api/prints/log") {
                $body = Parse-JsonBody $req
                $entry = Apply-PrintDeduction $Db $body
                if ((Test-HasKey $body "finishedJobId") -and -not [string]::IsNullOrWhiteSpace($body["finishedJobId"])) {
                    $MqttClient.ClearLastFinishedJob([string]$body["finishedJobId"])
                }
                Send-Json $res ([ordered]@{ ok = $true; entry = $entry; db = $Db })
            }
            elseif ($method -eq "POST" -and $path -eq "/api/prints/undo") {
                $body = Parse-JsonBody $req
                $prId = [string]$body["id"]
                foreach ($h in $Db["history"]) {
                    if ($h["id"] -eq $prId -and -not [bool]$h["undone"]) {
                        foreach ($it in $h["items"]) {
                            foreach ($sp in $Db["spools"]) {
                                if ($sp["id"] -eq $it["spoolId"]) {
                                    $sp["remainingGrams"] = [math]::Round([double]$sp["remainingGrams"] + [double]$it["usedGrams"], 2)
                                    $sp["lastPrintUsedG"] = 0
                                    break
                                }
                            }
                        }
                        $h["undone"] = $true
                        break
                    }
                }
                Save-Database $Db
                Send-Json $res ([ordered]@{ ok = $true; db = $Db })
            }
            elseif ($method -eq "POST" -and $path -eq "/api/demo/load") {
                $prevCfg = $Db["config"]
                $Db = New-SampleDatabase
                $Db["config"] = $prevCfg
                Save-Database $Db
                Send-Json $res ([ordered]@{ ok = $true; db = $Db })
            }
            elseif ($method -eq "POST" -and $path -eq "/api/demo/clear") {
                $prevCfg = $Db["config"]
                $Db = New-CleanDatabase
                $Db["config"] = $prevCfg
                Save-Database $Db
                Send-Json $res ([ordered]@{ ok = $true; db = $Db })
            }
            else {
                # Static web files
                $relPath = if ($path -eq "/" -or [string]::IsNullOrWhiteSpace($path)) { "index.html" } else { $path.TrimStart("/") }
                $relPath = $relPath -replace "\.\.", ""
                $targetFile = Join-Path $WebDir $relPath
                Send-StaticFile $res $targetFile
            }
        }
        catch {
            Write-Warning "Request error ($method $path): $_"
            try {
                Send-Json $res ([ordered]@{ ok = $false; error = $_.Exception.Message }) 500
            } catch {}
        }
    }
}
finally {
    Write-Host "Shutting down..." -ForegroundColor Yellow
    $MqttClient.Dispose()
    if ($Server) { $Server.Stop() }
}
