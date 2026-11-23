# Bambu Lab P2S · AMS 2 Pro / AMS HT Filament Manager

A zero-install Windows web dashboard for tracking filament usage across multiple **AMS 2 Pro** and **AMS HT** units on your **Bambu Lab P2S** — measuring how much filament your **last print** used, estimating whether your remaining spools can finish a **future print**, and submitting jobs directly to your printer.

## Features

- **Zero-Install Windows Runtime:** Runs locally using built-in Windows PowerShell, .NET, and `curl.exe` — no Python, Node.js, or external packages required.
- **Multi-AMS 2 Pro & AMS HT Support:** Tracks multiple 4-slot **AMS 2 Pro** units (`A1–A4`, `B1–B4`, etc.), single-slot **AMS HT** units (`HT-1+`, `ams_id` 128+), and an **External Spool**.
- **Full Non-RFID & RFID AMS Reading:** Reads live AMS temperature, humidity, active drying countdowns, loaded vs. empty slots, material, exact hex color, decoded Bambu filament profiles (`GFA00`, `GFL99`, etc.), nozzle temp ranges, and active-in-nozzle status (`tray_now`) over local MQTT — even for non-RFID third-party spools.
- **Last Print Usage Measurement:**
  - Pull `.gcode.3mf` files straight from your P2S External USB drive via FTPS (`port 990`, dynamic directory discovery).
  - Read sliced plates directly from your local **Bambu Studio** / **OrcaSlicer** cache (`From Bambu Studio`).
  - Drag & drop any `.gcode.3mf` or `.gcode` file to extract exact per-color grams, meters, flush/purge weight, and plate preview thumbnail from `Metadata/slice_info.config`.
  - Supports partial/failed print percentage scaling, kitchen-scale tare calibration (**⚖ Scale**), and 1-click **Undo Deduction** in Print History.
- **Future Print Estimator ("Will It Fit?"):**
  - Checks any upcoming `.gcode.3mf`, current active P2S job (with a **Remaining % only** toggle), or manual gram estimate against your loaded AMS spools.
  - Configurable safety buffers (`+g` and `+%`), projected leftover grams per slot, and automatic **AMS Auto-Refill** backup spool detection.
- **Direct Print Submission & Live Controls:**
  - Upload `.gcode.3mf` files to the P2S USB drive via FTPS and start prints directly via MQTT `project_file` (with multi-AMS `ams_mapping` + `ams_mapping2`, bed leveling, vibration/flow calibration, and timelapse options).
  - Live **Pause / Resume / Stop** controls while printing *(requires **LAN Only Mode + Developer Mode** enabled on P2S firmware)*.
- **Private Local Data:** All settings, spools, and print history are stored locally in `data/filament_db.json` (excluded from Git via `.gitignore`).

## Quick Start

1. Clone or download this repository.
2. Double-click **`Start-FilamentManager.bat`**.
3. Your browser opens `http://127.0.0.1:8765/` automatically.

## Connecting Your Bambu Lab P2S

1. Open **Settings** (top-right pill) and choose **Local LAN Mode** (recommended — works for telemetry and FTPS even while your P2S stays connected to Bambu Cloud).
2. Enter your P2S **IP Address**, **8-character Access Code** (**Settings → WLAN / Network**), and **Serial Number (SN)** (**Settings → Device**).
3. Click **Save & Connect**, then click **Sync from P2S** to import your live AMS 2 Pro / AMS HT slots.
4. *(Optional)* To start/pause/stop prints directly from the app, enable **LAN Only Mode** and **Developer Mode** on your P2S touchscreen.

## Project Structure

- `Start-FilamentManager.bat` — Double-click Windows launcher
- `server.ps1` — Local HTTP server, REST API, and local JSON datastore (`data/filament_db.json`)
- `BambuEngine.cs` — Embedded C#/.NET engine (TLS MQTT client, FTPS client, `.gcode.3mf`/`.gcode` parser, Bambu Studio cache scanner, and non-admin `TcpListener` HTTP server)
- `web/` — Frontend dashboard (`index.html`, `styles.css`, `app.js`)
