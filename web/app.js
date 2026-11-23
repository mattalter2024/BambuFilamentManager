(() => {
  "use strict";

  const MATERIAL_DENSITY = {
    "PLA": 1.24,
    "PLA-CF": 1.22,
    "PETG": 1.27,
    "PETG-CF": 1.25,
    "ABS": 1.05,
    "ASA": 1.07,
    "TPU": 1.21,
    "PA-CF": 1.18,
    "PA6-CF": 1.18,
    "PAHT-CF": 1.18,
    "PC": 1.20,
    "PVA": 1.23,
    "Support": 1.24
  };

  let state = {
    db: null,
    telemetry: null,
    activeTab: "overview",
    lastPrintDraft: null,     // { fileName, plateName, source, completionPct, flushGrams, predictionSeconds, thumbnailBase64, finishedJobId, items: [...] }
    futurePrintDraft: null,   // { fileName, plateName, predictionSeconds, thumbnailBase64, items: [...] }
    manualLastRows: [],
    futureManualRows: [],
    cloudTasksCache: [],
    cloudDevicesCache: [],
    lastShownCmdAt: ""
  };

  // ==================== UTILITIES ====================
  const $ = (id) => document.getElementById(id);

  async function api(method, url, body = null) {
    const opts = { method, headers: {} };
    if (body !== null) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  async function uploadAndParseFile(file) {
    const res = await fetch("/api/parse-file", {
      method: "POST",
      headers: { "X-File-Name": encodeURIComponent(file.name) },
      body: file
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || "Failed to parse file");
    }
    return data;
  }

  function toast(msg, type = "ok") {
    const c = $("toastContainer");
    const el = document.createElement("div");
    el.className = "toast" + (type === "error" ? " error" : type === "warn" ? " warn" : "");
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => { el.remove(); }, 4200);
  }

  function esc(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtG(val) {
    const n = Number(val || 0);
    return n >= 100 ? n.toFixed(1) : n.toFixed(1);
  }

  function gramsToMeters(grams, material, customDensity) {
    const rho = Number(customDensity) || MATERIAL_DENSITY[material] || 1.24;
    // 1.75mm filament cross section = pi * (0.0875 cm)^2 = 0.0240528 cm^2 => 100cm (1m) = 2.40528 cm^3
    return Number(grams || 0) / (rho * 2.40528);
  }

  function fmtDuration(sec) {
    const s = Number(sec || 0);
    if (s <= 0) return "--";
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function fmtRelativeTime(iso) {
    if (!iso) return "";
    const diffSec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (diffSec < 60) return "just now";
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return `${Math.floor(diffSec / 86400)}d ago`;
  }

  function hexToRgb(hex) {
    const h = String(hex || "#888888").replace("#", "");
    if (h.length !== 6) return [128, 128, 128];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function colorDistance(hex1, hex2) {
    const [r1, g1, b1] = hexToRgb(hex1);
    const [r2, g2, b2] = hexToRgb(hex2);
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
  }

  function getUnitSlotKeys(unit) {
    if (unit.unitType === "AMS HT") {
      const idx = unit.amsId >= 128 ? (unit.amsId - 128) + 1 : unit.amsId + 1;
      return [`HT-${idx}`];
    }
    if (unit.unitType === "External") return ["EXT"];
    const letter = String.fromCharCode(65 + Math.min(Number(unit.amsId || 0), 25));
    return [`${letter}1`, `${letter}2`, `${letter}3`, `${letter}4`];
  }

  function getAllSlotKeys() {
    const keys = [];
    for (const u of (state.db?.amsUnits || [])) {
      keys.push(...getUnitSlotKeys(u));
    }
    return keys;
  }

  function getLoadedSpools() {
    const validSlots = new Set(getAllSlotKeys());
    return (state.db?.spools || []).filter(s => validSlots.has(s.slotKey));
  }

  function findSpoolBySlot(slotKey) {
    return (state.db?.spools || []).find(s => s.slotKey === slotKey) || null;
  }

  function findSpoolById(id) {
    return (state.db?.spools || []).find(s => s.id === id) || null;
  }

  // Auto-match a sliced filament (type + color + optional printer mapping) to best loaded AMS spool
  function autoMatchSpool(fil, mappingKey = null) {
    if (mappingKey) {
      const mapped = findSpoolBySlot(mappingKey);
      if (mapped) return mapped;
    }
    const loaded = getLoadedSpools();
    if (loaded.length === 0) return null;

    const targetMat = String(fil.Type || fil.material || "PLA").toUpperCase().split("-")[0];
    const targetColor = fil.Color || fil.color || "#888888";

    let best = null;
    let bestScore = Infinity;

    for (const sp of loaded) {
      const spMat = String(sp.material || "").toUpperCase();
      const matExact = spMat === String(fil.Type || fil.material || "").toUpperCase();
      const matBase = spMat.startsWith(targetMat) || targetMat.startsWith(spMat.split("-")[0]);
      const cDist = colorDistance(sp.color, targetColor);
      // Heavy penalty if material doesn't match
      const score = cDist + (matExact ? 0 : matBase ? 40 : 500);
      if (score < bestScore) {
        bestScore = score;
        best = sp;
      }
    }
    return best;
  }

  function findAutoRefillBackups(primarySpool) {
    if (!primarySpool || primarySpool.slotKey === "VAULT") return [];
    const loaded = getLoadedSpools();
    return loaded.filter(sp =>
      sp.id !== primarySpool.id &&
      String(sp.material || "").toUpperCase() === String(primarySpool.material || "").toUpperCase() &&
      colorDistance(sp.color, primarySpool.color) < 35 &&
      Number(sp.remainingGrams || 0) > 0
    );
  }

  function buildSpoolSvg(colorHex, pct) {
    const clamped = Math.max(0, Math.min(100, pct));
    // Visual filament ring radius scales between inner hub (r=11) and outer flange (r=23)
    const r = 11.5 + (clamped / 100) * 11.0;
    const strokeW = Math.max(2, r - 10.5);
    const midR = 10.5 + strokeW / 2;
    return `
      <svg class="spool-svg" width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
        <circle cx="28" cy="28" r="25" fill="#0f1722" stroke="#2c3a4f" stroke-width="2"/>
        ${clamped > 0.5 ? `<circle cx="28" cy="28" r="${midR.toFixed(1)}" fill="none" stroke="${esc(colorHex)}" stroke-width="${strokeW.toFixed(1)}" opacity="0.95"/>` : ""}
        <circle cx="28" cy="28" r="10" fill="#172130" stroke="#3b4d68" stroke-width="1.5"/>
        <circle cx="28" cy="28" r="4.5" fill="#0b0f14"/>
      </svg>`;
  }

  // ==================== DATA FETCH & POLLING ====================
  async function loadState(renderFull = true) {
    try {
      const data = await api("GET", "/api/state");
      state.db = data.db;
      state.telemetry = data.telemetry;
      renderTopbarAndBanners();
      if (renderFull) {
        renderAllViews();
      } else {
        // Lightweight live refresh: update AMS header telemetry without killing modals/inputs
        if (state.activeTab === "overview") {
          renderHero();
          renderAmsRack();
        }
      }
    } catch (err) {
      console.error("Failed to fetch state:", err);
    }
  }

  function renderAllViews() {
    renderHero();
    renderAmsRack();
    renderLastPrintPreview();
    renderFutureEstimatorResult();
    renderVaultAndHistory();
  }

  // ==================== TOPBAR & BANNERS ====================
  function renderTopbarAndBanners() {
    const cfg = state.db?.config || {};
    const tel = state.telemetry || {};
    const mode = cfg.connectionMode || "cloud";

    $("printerSubtitle").textContent = `${cfg.printerModel || "Bambu Lab P2S"} · ${mode === "cloud" ? "Bambu Cloud" : "Local LAN"} · ${state.db?.amsUnits?.length || 0} AMS Unit(s)`;

    // Update Pull labels depending on Cloud vs LAN mode
    const lpTitle = $("lastPullTitle");
    if (lpTitle) {
      lpTitle.textContent = mode === "cloud" ? "Pull Directly from Bambu Cloud" : "Pull Directly from Bambu P2S SD Card (FTPS)";
      $("lastPullSub").textContent = mode === "cloud"
        ? "Fetches your latest print job's exact grams, meters & AMS mapping from Bambu Cloud"
        : "Downloads the last sliced .gcode.3mf straight off your printer over LAN";
      $("estPullTitle").textContent = mode === "cloud" ? "Check Current / Recent Job from Bambu Cloud" : "Check Current / SD Card Job on P2S (FTPS)";
      $("estPullSub").textContent = mode === "cloud"
        ? "Fetches the active or latest print task from Bambu Cloud to estimate filament needed"
        : "Downloads the active or newest .gcode.3mf directly from your P2S to estimate filament needed";
    }

    const dot = $("connDot");
    const label = $("connLabel");
    dot.className = "status-dot";
    if (tel.Connected) {
      dot.classList.add("connected");
      label.textContent = `${mode === "cloud" ? "Cloud Live" : "LAN Live"} · ${tel.GcodeState || "IDLE"}`;
    } else if (tel.LastError && (cfg.cloudToken || cfg.printerIp)) {
      dot.classList.add("error");
      label.textContent = mode === "cloud" ? "Cloud Reconnecting" : "LAN Reconnecting";
    } else {
      label.textContent = mode === "cloud"
        ? (cfg.cloudToken ? "Cloud Disconnected" : "Sign In · Bambu Cloud")
        : (cfg.printerIp ? "LAN Disconnected" : "Connect P2S");
    }

    // Live printing bar
    const liveBar = $("livePrintBar");
    const gState = String(tel.GcodeState || "").toUpperCase();
    if (tel.Connected && (gState === "RUNNING" || gState === "PREPARE" || gState === "PAUSE")) {
      liveBar.classList.remove("hidden");
      $("liveJobName").textContent = tel.SubtaskName || tel.GcodeFile || "Active Print";
      $("liveLayerInfo").textContent = `Layer ${tel.LayerNum || 0} / ${tel.TotalLayerNum || 0}`;
      $("liveProgressFill").style.width = `${Math.min(100, Math.max(0, tel.McPercent || 0))}%`;
      $("livePercentText").textContent = `${tel.McPercent || 0}%`;
      $("liveEtaText").textContent = `${tel.RemainingMinutes || 0}m left`;
      $("liveNozzleTemp").textContent = `N: ${Math.round(tel.NozzleTemp || 0)}°C`;
      $("liveBedTemp").textContent = `B: ${Math.round(tel.BedTemp || 0)}°C`;
      $("liveChamberTemp").textContent = `C: ${Math.round(tel.ChamberTemp || 0)}°C`;
      const prBtn = $("btnLivePauseResume");
      if (prBtn) prBtn.textContent = gState === "PAUSE" ? "Resume" : "Pause";
    } else {
      liveBar.classList.add("hidden");
    }

    // Surface printer command ack/rejection (e.g. "mqtt message verify failed")
    if (tel.LastCommandAtUtc && tel.LastCommandAtUtc !== state.lastShownCmdAt && tel.LastCommandResult && tel.LastCommandResult !== "SENT") {
      state.lastShownCmdAt = tel.LastCommandAtUtc;
      const resLower = String(tel.LastCommandResult || "").toLowerCase();
      const reason = String(tel.LastCommandReason || "");
      const statusEl = $("printSubmitStatus");
      if (resLower === "failed" || resLower === "fail") {
        const devHint = reason.toLowerCase().includes("verify")
          ? " — Enable LAN Only Mode + Developer Mode on your P2S touchscreen to allow local print start/control commands."
          : "";
        const msg = `P2S rejected command: ${reason || "failed"}${devHint}`;
        toast(msg, "error");
        if (statusEl) { statusEl.style.color = "#fca5a5"; statusEl.textContent = msg; }
      } else if (resLower === "success") {
        toast("P2S accepted print command!", "ok");
        if (statusEl) { statusEl.style.color = "#4ade80"; statusEl.textContent = "P2S accepted print command!"; }
      }
    }

    // Finished job banner
    const finBanner = $("finishedJobBanner");
    if (tel.LastFinishedJobId) {
      finBanner.classList.remove("hidden");
      $("finishedJobText").textContent = `${tel.LastFinishedFileName || "Recent Print"} (${tel.LastFinishedState}, ${tel.LastFinishedPercent}%) — ready to measure & deduct.`;
    } else {
      finBanner.classList.add("hidden");
    }

    // Sample data banner
    const demoBanner = $("demoBanner");
    if (state.db?.isDemoData) {
      demoBanner.classList.remove("hidden");
    } else {
      demoBanner.classList.add("hidden");
    }

    // Sync settings modal status box if open
    if (!$("modalSettings").classList.contains("hidden")) {
      $("settingsConnTitle").textContent = tel.Connected
        ? (mode === "cloud" ? `Connected via Bambu Cloud (${cfg.printerSerial || ""})` : `Connected via LAN (${cfg.printerIp})`)
        : (tel.StatusMessage || "Disconnected");
      $("settingsConnDetail").textContent = tel.LastError
        ? `Error: ${tel.LastError}`
        : tel.Connected
          ? `MQTT messages received: ${tel.MessagesReceived || 0} · Detected AMS units: ${(tel.AmsUnits || []).length}`
          : (mode === "cloud"
              ? "Sign in with your Bambu Lab account email & password (or Bearer token)."
              : "Enter your P2S LAN IP, Serial Number, and Access Code.");
    }
  }

  // ==================== HERO & KPIs ====================
  function renderHero() {
    const history = (state.db?.history || []).filter(h => !h.undone);
    const last = history[0] || null;
    const cfg = state.db?.config || {};
    const warnThreshold = Number(cfg.lowSpoolWarnG || 150);

    if (!last) {
      $("heroLastTitle").textContent = "No prints measured yet";
      $("heroLastBody").innerHTML = `
        <div class="empty-state" style="width:100%;padding:12px 0;">
          <p style="margin:0 0 6px;">Measure your last print by pulling it from your P2S or dropping a sliced <code>.gcode.3mf</code> file.</p>
          <p class="muted small" style="margin:0;">Once logged, your exact remaining filament per AMS 2 Pro slot updates automatically.</p>
        </div>`;
    } else {
      $("heroLastTitle").textContent = last.plateName || last.fileName || "Last Print";
      const thumbHtml = last.thumbnailBase64
        ? `<img src="${last.thumbnailBase64}" alt="Plate preview" />`
        : `<span>🖨️</span>`;

      const chipsHtml = (last.items || []).map(it => {
        const sp = findSpoolById(it.spoolId) || findSpoolBySlot(it.slotKey);
        const nowRem = sp ? sp.remainingGrams : it.afterGrams;
        return `
          <div class="usage-chip">
            <span class="swatch" style="background:${esc(it.color || "#888")}"></span>
            <strong>${esc(it.slotKey || "?")}</strong>
            <span>${esc(it.material || "")}</span>
            <span class="mono" style="color:#fca5a5;">-${fmtG(it.usedGrams)}g</span>
            <span class="muted">(${fmtG(nowRem)}g left)</span>
          </div>`;
      }).join("");

      $("heroLastBody").innerHTML = `
        <div class="last-print-thumb">${thumbHtml}</div>
        <div style="flex:1;min-width:0;">
          <div class="last-print-metrics">
            <div>
              <div class="lp-metric-label">Filament Used</div>
              <div class="lp-metric-val accent mono">${fmtG(last.totalGrams)} g</div>
            </div>
            <div>
              <div class="lp-metric-label">Length Used</div>
              <div class="lp-metric-val mono">${Number(last.totalMeters || 0).toFixed(1)} m</div>
            </div>
            ${Number(last.flushGrams || 0) > 0 ? `
            <div>
              <div class="lp-metric-label">Purge / Flush</div>
              <div class="lp-metric-val mono">${fmtG(last.flushGrams)} g</div>
            </div>` : ""}
            <div>
              <div class="lp-metric-label">Logged</div>
              <div class="lp-metric-val" style="font-size:15px;padding-top:5px;">${fmtRelativeTime(last.timestampUtc)} <span class="muted small">(${last.completionPct || 100}%)</span></div>
            </div>
          </div>
          <div class="slot-usage-chips">${chipsHtml}</div>
        </div>`;
    }

    // Fleet KPIs
    const loaded = getLoadedSpools();
    const totalG = loaded.reduce((acc, s) => acc + Number(s.remainingGrams || 0), 0);
    const lowSpools = loaded.filter(s => Number(s.remainingGrams || 0) <= warnThreshold);
    const dryingUnits = (state.db?.amsUnits || []).filter(u => Number(u.dryTimeMinutes || 0) > 0);

    $("kpiTotalGrams").textContent = `${Math.round(totalG).toLocaleString()} g`;
    $("kpiTotalSub").textContent = `${(totalG / 1000).toFixed(2)} kg across ${loaded.length} loaded spool(s)`;

    const kLow = $("kpiLowCount");
    kLow.textContent = lowSpools.length > 0 ? `${lowSpools.length} spool${lowSpools.length > 1 ? "s" : ""}` : "All Good";
    kLow.className = "kpi-value mono " + (lowSpools.length > 0 ? "warn" : "accent");
    $("kpiLowSub").textContent = lowSpools.length > 0
      ? `Low: ${lowSpools.map(s => `${s.slotKey} (${fmtG(s.remainingGrams)}g)`).join(", ")}`
      : `All spools above ${warnThreshold} g`;

    const kDry = $("kpiDryingCount");
    if (dryingUnits.length > 0) {
      kDry.textContent = `${dryingUnits.length} Active`;
      kDry.className = "kpi-value mono warn";
      $("kpiDryingSub").textContent = dryingUnits.map(u => `${u.label}: ${fmtDuration(u.dryTimeMinutes * 60)} left`).join(" · ");
    } else {
      kDry.textContent = "Standby";
      kDry.className = "kpi-value mono";
      $("kpiDryingSub").textContent = `${(state.db?.amsUnits || []).length} unit(s) monitored`;
    }
  }

  // ==================== AMS RACK ====================
  function renderAmsRack() {
    const container = $("amsRackContainer");
    const units = state.db?.amsUnits || [];
    const warnThreshold = Number(state.db?.config?.lowSpoolWarnG || 150);

    if (units.length === 0) {
      container.innerHTML = `<div class="card empty-state">No AMS units configured yet. Click <strong>+ AMS 2 Pro</strong> or <strong>Sync from P2S</strong> above.</div>`;
      return;
    }

    container.innerHTML = units.map(unit => {
      const slotKeys = getUnitSlotKeys(unit);
      const isHt = unit.unitType === "AMS HT";
      const isExt = unit.unitType === "External";
      const badgeClass = isHt ? "ht" : isExt ? "ext" : "";

      const envHtml = !isExt ? `
        <div class="ams-env-badges">
          ${Number(unit.tempC || 0) > 0 ? `<span class="env-pill mono">🌡 ${Number(unit.tempC).toFixed(1)}°C</span>` : ""}
          ${Number(unit.humidityRaw || 0) > 0 ? `<span class="env-pill mono">💧 ${unit.humidityRaw}% RH</span>` : (Number(unit.humidityLevel || 0) > 0 ? `<span class="env-pill">💧 Level ${unit.humidityLevel}/5</span>` : "")}
          ${Number(unit.dryTimeMinutes || 0) > 0 ? `<span class="env-pill drying mono">🔥 Drying · ${fmtDuration(unit.dryTimeMinutes * 60)} left</span>` : ""}
          <button class="btn btn-ghost btn-xs" data-remove-unit="${esc(unit.id)}" title="Remove unit">Remove</button>
        </div>` : `
        <div class="ams-env-badges">
          <button class="btn btn-ghost btn-xs" data-remove-unit="${esc(unit.id)}">Remove</button>
        </div>`;

      const slotsHtml = slotKeys.map(sk => {
        const sp = findSpoolBySlot(sk);
        if (!sp) {
          return `
            <div class="slot-card empty-slot">
              <div class="slot-key">${esc(sk)}</div>
              <div class="muted small">Empty Slot</div>
              <button class="btn btn-secondary btn-xs" data-add-to-slot="${esc(sk)}">+ Load Spool</button>
            </div>`;
        }

        const initG = Math.max(1, Number(sp.initialGrams || 1000));
        const remG = Math.max(0, Number(sp.remainingGrams || 0));
        const pct = Math.min(100, Math.round((remG / initG) * 100));
        const meters = gramsToMeters(remG, sp.material, sp.density);
        const isCritical = remG <= warnThreshold * 0.45;
        const isLow = remG <= warnThreshold;
        const barClass = isCritical ? "danger" : isLow ? "warn" : "";
        const gramsClass = isCritical ? "critical" : isLow ? "low" : "";

        // Check if this slot is actively feeding the P2S nozzle right now
        const activeTrayRaw = String(state.telemetry?.ActiveTrayNow ?? "");
        let isActiveInNozzle = false;
        if (activeTrayRaw && activeTrayRaw !== "255" && activeTrayRaw !== "254") {
          const tIdx = Number(activeTrayRaw);
          if (!Number.isNaN(tIdx)) {
            const expectedKey = tIdx >= 128
              ? `HT-${(tIdx - 128) + 1}`
              : `${String.fromCharCode(65 + Math.floor(tIdx / 4))}${(tIdx % 4) + 1}`;
            if (expectedKey === sk) isActiveInNozzle = true;
          }
        }

        const profileSub = [sp.trayInfoIdx, sp.nozzleTempRange].filter(Boolean).join(" · ");

        return `
          <div class="slot-card ${isLow ? "low-spool" : ""}" style="${isActiveInNozzle ? "border-color:var(--accent);box-shadow:0 0 0 1px var(--accent-soft);" : ""}">
            <div class="slot-top">
              <div style="display:flex;align-items:center;gap:6px;">
                <span class="slot-key mono">${esc(sk)}</span>
                ${isActiveInNozzle ? `<span class="pulse-badge">ACTIVE</span>` : ""}
              </div>
              <span class="mat-pill">${esc(sp.material || "PLA")}</span>
            </div>

            <div class="slot-visual-row">
              ${buildSpoolSvg(sp.color || "#64748b", pct)}
              <div class="slot-grams-block">
                <div class="slot-grams-main mono ${gramsClass}">${fmtG(remG)} g</div>
                <div class="slot-meters mono">~${meters.toFixed(1)} m · ${pct}%</div>
                <div class="slot-name" title="${esc(sp.name)}">${esc(sp.name || sp.material)}</div>
                <div class="slot-brand mono">${esc(profileSub || sp.brand || "")}</div>
              </div>
            </div>

            <div class="progress-track">
              <div class="progress-fill ${barClass}" style="width:${pct}%"></div>
            </div>

            <div class="slot-meta-row">
              ${Number(sp.rfidRemainPct) >= 0 ? `<span class="rfid-tag mono" title="AMS optical RFID estimate">RFID ${sp.rfidRemainPct}%</span>` : (sp.needsWeightInit ? `<span class="env-pill drying" style="padding:1px 6px;font-size:10.5px;">Non-RFID · Set Weight</span>` : `<span class="muted small">Non-RFID · Tracked</span>`)}
              ${Number(sp.lastPrintUsedG || 0) > 0 ? `<span class="last-used-tag mono">-${fmtG(sp.lastPrintUsedG)}g last print</span>` : `<span class="muted small">Tare ${sp.tareGrams || 250}g</span>`}
            </div>

            <div class="slot-actions">
              <button class="btn btn-secondary btn-xs" data-weigh-spool="${esc(sp.id)}" title="Calibrate with kitchen scale">⚖ Scale</button>
              <button class="btn btn-ghost btn-xs" data-edit-spool="${esc(sp.id)}">Edit</button>
              <button class="btn btn-ghost btn-xs" data-unload-spool="${esc(sp.id)}" title="Move spool to Vault">Unload</button>
            </div>
          </div>`;
      }).join("");

      return `
        <div class="ams-unit-card">
          <div class="ams-unit-head">
            <div class="ams-unit-title">
              <span class="unit-type-badge ${badgeClass}">${esc(unit.unitType)}</span>
              <strong>${esc(unit.label)}</strong>
              <span class="muted small mono">ID ${unit.amsId}</span>
            </div>
            ${envHtml}
          </div>
          <div class="ams-slots-grid ${slotKeys.length === 1 ? "single-slot" : ""}">
            ${slotsHtml}
          </div>
        </div>`;
    }).join("");
  }

  // ==================== LAST PRINT MEASUREMENT ====================
  function prepareLastPrintDraftFromParsed(parsed, sourceLabel, finishedJobId = null, completionPct = 100, mappingKeys = []) {
    const items = (parsed.Filaments || []).map((f, idx) => {
      const mappedKey = mappingKeys && mappingKeys[idx] ? mappingKeys[idx] : null;
      const matched = autoMatchSpool(f, mappedKey);
      return {
        index: f.Index || (idx + 1),
        material: f.Type || "PLA",
        color: f.Color || "#94A3B8",
        usedGrams: Number(f.UsedGrams || 0),
        usedMeters: Number(f.UsedMeters || 0),
        spoolId: matched ? matched.id : ""
      };
    });

    state.lastPrintDraft = {
      fileName: parsed.FileName || "print.gcode.3mf",
      plateName: parsed.PlateName || parsed.FileName || "Print",
      source: sourceLabel,
      completionPct: completionPct,
      flushGrams: Number(parsed.FlushGrams || 0),
      predictionSeconds: Number(parsed.PredictionSeconds || 0),
      thumbnailBase64: parsed.ThumbnailBase64 || "",
      warning: parsed.Warning || "",
      finishedJobId,
      items
    };
    renderLastPrintPreview();
  }

  function buildSpoolSelectOptions(selectedId) {
    const loaded = getLoadedSpools();
    const vault = (state.db?.spools || []).filter(s => s.slotKey === "VAULT");
    let html = `<option value="">-- Unassigned (Do not deduct) --</option>`;
    if (loaded.length > 0) {
      html += `<optgroup label="Loaded in AMS Units">`;
      for (const s of loaded) {
        html += `<option value="${esc(s.id)}" ${s.id === selectedId ? "selected" : ""}>${esc(s.slotKey)} · ${esc(s.material)} · ${esc(s.name)} (${fmtG(s.remainingGrams)}g left)</option>`;
      }
      html += `</optgroup>`;
    }
    if (vault.length > 0) {
      html += `<optgroup label="Spool Vault">`;
      for (const s of vault) {
        html += `<option value="${esc(s.id)}" ${s.id === selectedId ? "selected" : ""}>VAULT · ${esc(s.material)} · ${esc(s.name)} (${fmtG(s.remainingGrams)}g left)</option>`;
      }
      html += `</optgroup>`;
    }
    return html;
  }

  function renderLastPrintPreview() {
    const box = $("lastPrintPreview");
    const draft = state.lastPrintDraft;
    if (!draft) {
      box.innerHTML = `
        <div class="empty-state">
          <p>Drop a <code>.gcode.3mf</code> file, pull the latest print from your P2S, or enter manual grams on the left.</p>
          <p class="muted small">We will auto-match each filament color to your AMS 2 Pro / AMS HT slots and show exact <strong>Before &rarr; After</strong> remaining weight before deducting.</p>
        </div>`;
      return;
    }

    const scale = Math.max(0.01, Math.min(1, Number(draft.completionPct || 100) / 100));
    const totalScaledG = draft.items.reduce((acc, it) => acc + Number(it.usedGrams || 0) * scale, 0);
    const totalScaledM = draft.items.reduce((acc, it) => acc + Number(it.usedMeters || 0) * scale, 0);

    const rowsHtml = draft.items.map((it, idx) => {
      const scaledG = Number(it.usedGrams || 0) * scale;
      const sp = findSpoolById(it.spoolId);
      const beforeG = sp ? Number(sp.remainingGrams || 0) : null;
      const afterG = sp ? Math.max(0, beforeG - scaledG) : null;

      return `
        <tr>
          <td>
            <div style="display:flex;align-items:center;gap:7px;">
              <span class="swatch" style="background:${esc(it.color)}"></span>
              <div>
                <strong>${esc(it.material)}</strong>
                <div class="muted small mono">Fil #${it.index}</div>
              </div>
            </div>
          </td>
          <td class="mono">
            <strong>${fmtG(scaledG)} g</strong>
            <div class="muted small">${(Number(it.usedMeters || 0) * scale).toFixed(1)} m</div>
          </td>
          <td>
            <select data-lp-map-idx="${idx}">
              ${buildSpoolSelectOptions(it.spoolId)}
            </select>
          </td>
          <td class="mono small">
            ${sp ? `${fmtG(beforeG)}g &rarr; <strong style="color:${afterG < 100 ? "#f59e0b" : "#4ade80"}">${fmtG(afterG)}g</strong>` : `<span class="muted">Not deducted</span>`}
          </td>
        </tr>`;
    }).join("");

    box.innerHTML = `
      ${draft.warning ? `<div class="alert-banner alert-info" style="border-radius:8px;margin-bottom:12px;">${esc(draft.warning)}</div>` : ""}
      <div class="parsed-header">
        <div class="last-print-thumb" style="width:68px;height:68px;">
          ${draft.thumbnailBase64 ? `<img src="${draft.thumbnailBase64}" alt="Preview"/>` : "<span>📦</span>"}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:15px;">${esc(draft.plateName || draft.fileName)}</div>
          <div class="muted small">${esc(draft.fileName)} · Source: ${esc(draft.source)}</div>
          <div class="btn-row" style="margin-top:6px;">
            <span class="env-pill mono">Total: <strong style="color:#4ade80;">${fmtG(totalScaledG)} g</strong></span>
            <span class="env-pill mono">${totalScaledM.toFixed(1)} m</span>
            ${draft.flushGrams > 0 ? `<span class="env-pill mono">Flush: ${fmtG(draft.flushGrams * scale)} g</span>` : ""}
            ${draft.predictionSeconds > 0 ? `<span class="env-pill mono">Est: ${fmtDuration(draft.predictionSeconds)}</span>` : ""}
          </div>
        </div>
      </div>

      <div class="completion-box">
        <div class="completion-box-head">
          <span>Print Completion % <span class="muted">(adjust if failed or cancelled early)</span></span>
          <strong class="mono" id="lpPctDisplay">${Math.round(draft.completionPct)}%</strong>
        </div>
        <input type="range" id="lpPctSlider" min="1" max="100" value="${Math.round(draft.completionPct)}" />
      </div>

      ${draft.items.length > 0 ? `
        <table class="mapping-table">
          <thead>
            <tr>
              <th>Filament</th>
              <th>Used</th>
              <th>Deduct From Spool</th>
              <th>Before &rarr; After</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <div class="btn-row" style="justify-content:space-between;">
          <button class="btn btn-ghost btn-sm" id="btnClearLastDraft">Clear</button>
          <button class="btn btn-primary" id="btnConfirmLogPrint">Log Last Print &amp; Deduct ${fmtG(totalScaledG)} g</button>
        </div>` : `<div class="empty-state">No filament usage entries found in this file.</div>`}
    `;

    // Bind dynamic handlers inside preview
    const slider = $("lpPctSlider");
    if (slider) {
      slider.addEventListener("input", (e) => {
        state.lastPrintDraft.completionPct = Number(e.target.value);
        renderLastPrintPreview();
      });
    }
    box.querySelectorAll("select[data-lp-map-idx]").forEach(sel => {
      sel.addEventListener("change", (e) => {
        const idx = Number(e.target.dataset.lpMapIdx);
        state.lastPrintDraft.items[idx].spoolId = e.target.value;
        renderLastPrintPreview();
      });
    });
    const btnClear = $("btnClearLastDraft");
    if (btnClear) btnClear.addEventListener("click", () => { state.lastPrintDraft = null; renderLastPrintPreview(); });
    const btnConfirm = $("btnConfirmLogPrint");
    if (btnConfirm) btnConfirm.addEventListener("click", submitLastPrintLog);
  }

  async function submitLastPrintLog() {
    const draft = state.lastPrintDraft;
    if (!draft) return;
    try {
      const payload = {
        fileName: draft.fileName,
        plateName: draft.plateName,
        source: draft.source,
        completionPct: draft.completionPct,
        flushGrams: draft.flushGrams,
        predictionSeconds: draft.predictionSeconds,
        thumbnailBase64: draft.thumbnailBase64,
        finishedJobId: draft.finishedJobId,
        items: draft.items.map(it => {
          const sp = findSpoolById(it.spoolId);
          return {
            spoolId: it.spoolId || "",
            slotKey: sp ? sp.slotKey : "",
            spoolName: sp ? sp.name : it.material,
            material: it.material,
            color: it.color,
            usedGrams: it.usedGrams,
            usedMeters: it.usedMeters || gramsToMeters(it.usedGrams, it.material)
          };
        })
      };
      const res = await api("POST", "/api/prints/log", payload);
      state.db = res.db;
      state.lastPrintDraft = null;
      toast(`Logged "${payload.plateName}" and deducted ${fmtG(res.entry.totalGrams)} g!`);
      renderTopbarAndBanners();
      renderAllViews();
      switchTab("overview");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  // ==================== FUTURE PRINT ESTIMATOR ====================
  function prepareFutureDraftFromParsed(parsed, mappingKeys = [], activeProgressPct = 0, fileMeta = {}) {
    const items = (parsed.Filaments || []).map((f, idx) => {
      const mappedKey = mappingKeys && mappingKeys[idx] ? mappingKeys[idx] : null;
      const matched = autoMatchSpool(f, mappedKey);
      return {
        index: f.Index || (idx + 1),
        material: f.Type || "PLA",
        color: f.Color || "#94A3B8",
        requiredGrams: Number(f.UsedGrams || 0),
        requiredMeters: Number(f.UsedMeters || 0),
        spoolId: matched ? matched.id : ""
      };
    });

    state.futurePrintDraft = {
      fileName: parsed.FileName || "upcoming.gcode.3mf",
      plateName: parsed.PlateName || parsed.FileName || "Upcoming Print",
      plateIndex: Number(parsed.PlateIndex || 1),
      predictionSeconds: Number(parsed.PredictionSeconds || 0),
      flushGrams: Number(parsed.FlushGrams || 0),
      thumbnailBase64: parsed.ThumbnailBase64 || "",
      warning: parsed.Warning || "",
      activeProgressPct: Number(activeProgressPct || 0),
      onlyRemainingPct: Number(activeProgressPct || 0) > 0 && Number(activeProgressPct || 0) < 100,
      remotePath: fileMeta.remotePath || "",
      stagedId: fileMeta.stagedId || "",
      localFilePath: fileMeta.localFilePath || "",
      printOpts: {
        useAms: true,
        bedLeveling: true,
        vibrationCali: true,
        flowCali: false,
        timelapse: false,
        urlScheme: "ftp"
      },
      items
    };
    renderFutureEstimatorResult();
  }

  function syncFutureDraftFromManualRows() {
    const items = state.futureManualRows
      .filter(r => Number(r.grams || 0) > 0)
      .map((r, idx) => {
        const sp = findSpoolById(r.spoolId);
        return {
          index: idx + 1,
          material: sp ? sp.material : "PLA",
          color: sp ? sp.color : "#60A5FA",
          requiredGrams: Number(r.grams || 0),
          requiredMeters: gramsToMeters(r.grams, sp ? sp.material : "PLA", sp ? sp.density : 1.24),
          spoolId: r.spoolId || ""
        };
      });

    if (items.length === 0) {
      state.futurePrintDraft = null;
    } else {
      state.futurePrintDraft = {
        fileName: "Manual Estimate",
        plateName: "Manual Future Print Check",
        predictionSeconds: 0,
        flushGrams: 0,
        thumbnailBase64: "",
        warning: "",
        items
      };
    }
    renderFutureEstimatorResult();
  }

  function renderFutureManualRows() {
    const c = $("futureManualRows");
    if (state.futureManualRows.length === 0) {
      c.innerHTML = `<div class="muted small">Click <strong>+ Add Filament</strong> to check estimated grams directly without a file.</div>`;
      return;
    }
    c.innerHTML = state.futureManualRows.map((row, idx) => `
      <div class="manual-row">
        <select data-fm-spool="${idx}">
          ${buildSpoolSelectOptions(row.spoolId)}
        </select>
        <input type="number" min="1" step="1" placeholder="Grams" value="${row.grams || ""}" data-fm-grams="${idx}" />
        <button class="btn btn-ghost btn-xs" data-fm-del="${idx}">&times;</button>
      </div>`).join("");

    c.querySelectorAll("[data-fm-spool]").forEach(el => {
      el.addEventListener("change", (e) => {
        state.futureManualRows[Number(e.target.dataset.fmSpool)].spoolId = e.target.value;
        syncFutureDraftFromManualRows();
      });
    });
    c.querySelectorAll("[data-fm-grams]").forEach(el => {
      el.addEventListener("input", (e) => {
        state.futureManualRows[Number(e.target.dataset.fmGrams)].grams = Number(e.target.value);
        syncFutureDraftFromManualRows();
      });
    });
    c.querySelectorAll("[data-fm-del]").forEach(el => {
      el.addEventListener("click", (e) => {
        state.futureManualRows.splice(Number(e.target.dataset.fmDel), 1);
        renderFutureManualRows();
        syncFutureDraftFromManualRows();
      });
    });
  }

  function renderFutureEstimatorResult() {
    const container = $("futureResultContainer");
    const draft = state.futurePrintDraft;
    if (!draft || draft.items.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <p>Drop a sliced <code>.gcode.3mf</code> or add manual gram requirements on the left.</p>
          <p class="muted small">You'll see a per-slot Go / Tight / Insufficient verdict, projected leftover grams after printing, and whether an AMS Auto-Refill backup spool can cover a shortfall.</p>
        </div>`;
      return;
    }

    const bufG = Math.max(0, Number($("estBufferG").value || 0));
    const bufPct = Math.max(0, Number($("estBufferPct").value || 0));
    const useAutoRefill = $("estIncludeAutoRefill").checked;
    const activePct = Number(draft.activeProgressPct || 0);
    const remainScale = (draft.onlyRemainingPct && activePct > 0 && activePct < 100) ? ((100 - activePct) / 100) : 1.0;

    // Aggregate requirements if two filament lines point to the same spool
    const spoolDemandMap = {};
    for (const it of draft.items) {
      if (it.spoolId) {
        spoolDemandMap[it.spoolId] = (spoolDemandMap[it.spoolId] || 0) + Number(it.requiredGrams || 0) * remainScale;
      }
    }

    let overallStatus = "ok"; // ok | tight | fail
    let failCount = 0;
    let tightCount = 0;
    const totalReqG = draft.items.reduce((a, b) => a + Number(b.requiredGrams || 0) * remainScale, 0);

    const cardsHtml = draft.items.map((it, idx) => {
      const reqG = Number(it.requiredGrams || 0) * remainScale;
      const bufferAdded = Math.max(bufG, reqG * (bufPct / 100));
      const reqWithBuffer = reqG + bufferAdded;
      const sp = findSpoolById(it.spoolId);

      const availG = sp ? Number(sp.remainingGrams || 0) : 0;
      const totalForThisSpool = sp ? (spoolDemandMap[sp.id] || reqG) : reqG;
      const leftoverRaw = availG - totalForThisSpool;
      const leftoverBuffered = availG - (totalForThisSpool + bufferAdded);

      const backups = (useAutoRefill && sp) ? findAutoRefillBackups(sp) : [];
      const backupSumG = backups.reduce((a, b) => a + Number(b.remainingGrams || 0), 0);
      const combinedAvail = availG + backupSumG;

      let status = "ok";
      let statusLabel = "Ready";
      if (!sp) {
        status = "fail";
        statusLabel = "No Spool Mapped";
        failCount++;
      } else if (availG >= totalForThisSpool + bufferAdded) {
        status = "ok";
        statusLabel = "Enough Filament";
      } else if (availG >= totalForThisSpool) {
        status = "tight";
        statusLabel = "Tight Margin";
        tightCount++;
      } else if (useAutoRefill && combinedAvail >= totalForThisSpool + bufferAdded) {
        status = "tight";
        statusLabel = "Needs Auto-Refill";
        tightCount++;
      } else {
        status = "fail";
        statusLabel = `Short ${fmtG(totalForThisSpool - availG)}g`;
        failCount++;
      }

      const barPct = sp && availG > 0 ? Math.min(100, Math.round((totalForThisSpool / availG) * 100)) : 100;
      const barClass = status === "fail" ? "danger" : status === "tight" ? "warn" : "";

      return `
        <div class="est-item-card status-${status}">
          <div class="est-item-top">
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="swatch" style="background:${esc(it.color)}"></span>
              <strong>${esc(it.material)}</strong>
              <span class="muted small mono">Needs ${fmtG(reqG)}g (+${fmtG(bufferAdded)}g buf)</span>
            </div>
            <span class="mat-pill" style="background:${status === "ok" ? "var(--accent-soft);color:#4ade80" : status === "tight" ? "var(--warn-soft);color:#fcd34d" : "var(--danger-soft);color:#fca5a5"}">${statusLabel}</span>
          </div>

          <div class="form-row" style="margin-bottom:8px;">
            <select data-est-map-idx="${idx}">
              ${buildSpoolSelectOptions(it.spoolId)}
            </select>
          </div>

          <div class="est-metrics-grid mono">
            <div class="est-metric"><span>Available</span><strong>${sp ? fmtG(availG) + " g" : "--"}</strong></div>
            <div class="est-metric"><span>Print Needs</span><strong>${fmtG(reqG)} g</strong></div>
            <div class="est-metric"><span>With Buffer</span><strong>${fmtG(reqWithBuffer)} g</strong></div>
            <div class="est-metric">
              <span>After Print</span>
              <strong style="color:${leftoverRaw < 0 ? "#fca5a5" : leftoverBuffered < 0 ? "#fcd34d" : "#4ade80"}">
                ${sp ? (leftoverRaw >= 0 ? fmtG(leftoverRaw) + " g" : "-" + fmtG(Math.abs(leftoverRaw)) + " g") : "--"}
              </strong>
            </div>
          </div>

          <div class="progress-track">
            <div class="progress-fill ${barClass}" style="width:${barPct}%"></div>
          </div>

          ${backups.length > 0 ? `
            <div class="backup-callout">
              <strong>AMS Auto-Refill Backup Detected:</strong>
              ${backups.map(b => `${esc(b.slotKey)} (${fmtG(b.remainingGrams)}g)`).join(", ")}
              &rarr; Combined available: <strong class="mono">${fmtG(combinedAvail)} g</strong>
              (Leftover with backup: <strong class="mono">${fmtG(combinedAvail - totalForThisSpool)} g</strong>)
            </div>` : ""}
        </div>`;
    }).join("");

    if (failCount > 0) overallStatus = "fail";
    else if (tightCount > 0) overallStatus = "tight";

    const verdictTitle = overallStatus === "ok"
      ? "READY TO PRINT"
      : overallStatus === "tight"
        ? "TIGHT MARGIN / AUTO-REFILL NEEDED"
        : "NOT ENOUGH FILAMENT";

    const verdictSub = overallStatus === "ok"
      ? `All ${draft.items.length} filament(s) clear the ${bufG}g / ${bufPct}% safety margin.`
      : overallStatus === "tight"
        ? `Fits, but at least one slot is within your safety margin or relies on an AMS Auto-Refill backup spool.`
        : `${failCount} filament slot(s) do not have enough remaining grams to finish this print.`;

    container.innerHTML = `
      ${draft.warning ? `<div class="alert-banner alert-info" style="border-radius:8px;margin-bottom:12px;">${esc(draft.warning)}</div>` : ""}
      ${activePct > 0 && activePct < 100 ? `
        <div class="completion-box" style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div>
            <strong>Active P2S Job (${activePct}% complete)</strong>
            <div class="muted small">${draft.onlyRemainingPct ? `Estimating remaining ${100 - activePct}% needed to finish.` : `Showing full 100% print requirement.`}</div>
          </div>
          <label class="checkbox-inline" style="flex-shrink:0;">
            <input type="checkbox" id="chkEstOnlyRemaining" ${draft.onlyRemainingPct ? "checked" : ""} />
            <span>Remaining ${100 - activePct}% only</span>
          </label>
        </div>` : ""}
      <div class="verdict-banner verdict-${overallStatus}">
        <div>
          <div class="verdict-title">${verdictTitle}</div>
          <div class="small" style="margin-top:2px;">${verdictSub}</div>
        </div>
        <div class="mono" style="text-align:right;">
          <div style="font-size:18px;font-weight:800;">${fmtG(totalReqG)} g</div>
          <div class="small muted">${draft.predictionSeconds > 0 ? fmtDuration(draft.predictionSeconds) : "total needed"}</div>
        </div>
      </div>

      ${cardsHtml}

      ${(draft.remotePath || draft.stagedId || draft.localFilePath) ? `
        <div class="subpanel" style="background:var(--bg);padding:14px;border-radius:10px;border:1px solid var(--border-light);margin-top:14px;">
          <div class="subpanel-head" style="margin-bottom:8px;">
            <div>
              <strong>Submit Print Job to Bambu P2S</strong>
              <div class="muted small mono">
                ${draft.remotePath ? `On P2S USB: ${esc(draft.remotePath)}` : `Ready to upload &amp; print: ${esc(draft.fileName)}`}
              </div>
            </div>
            <span class="mat-pill">Plate ${draft.plateIndex || 1}</span>
          </div>

          <div style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:8px;margin:10px 0;">
            <label class="checkbox-inline"><input type="checkbox" id="prtUseAms" ${(draft.printOpts?.useAms !== false) ? "checked" : ""}/><span>Use AMS</span></label>
            <label class="checkbox-inline"><input type="checkbox" id="prtBedLevel" ${(draft.printOpts?.bedLeveling !== false) ? "checked" : ""}/><span>Bed Leveling</span></label>
            <label class="checkbox-inline"><input type="checkbox" id="prtVibCali" ${(draft.printOpts?.vibrationCali !== false) ? "checked" : ""}/><span>Vibration Cali</span></label>
            <label class="checkbox-inline"><input type="checkbox" id="prtFlowCali" ${draft.printOpts?.flowCali ? "checked" : ""}/><span>Flow Cali</span></label>
            <label class="checkbox-inline"><input type="checkbox" id="prtTimelapse" ${draft.printOpts?.timelapse ? "checked" : ""}/><span>Timelapse</span></label>
            <label style="gap:3px;">Path Format
              <select id="prtUrlScheme" style="padding:4px 6px;font-size:12px;">
                <option value="ftp" ${(draft.printOpts?.urlScheme || "ftp") === "ftp" ? "selected" : ""}>ftp:/// (P2S Default)</option>
                <option value="sdcard" ${draft.printOpts?.urlScheme === "sdcard" ? "selected" : ""}>file:///sdcard/</option>
              </select>
            </label>
          </div>

          ${overallStatus === "fail" ? `<div class="muted small" style="color:#fca5a5;margin-bottom:8px;">⚠ Warning: Filament check shows at least one slot may run out before finishing.</div>` : ""}

          <div class="btn-row" style="justify-content:space-between;margin-top:8px;">
            ${!draft.remotePath ? `<button class="btn btn-secondary btn-sm" id="btnUploadOnlyP2S">Upload Only to USB</button>` : `<span class="muted small">Uses mapped AMS slots above</span>`}
            <button class="btn ${overallStatus === "fail" ? "btn-danger" : "btn-primary"}" id="btnStartPrintP2S">🖨 Start Print on P2S</button>
          </div>
          <div id="printSubmitStatus" class="muted small" style="margin-top:8px;"></div>
        </div>` : ""}

      <div class="btn-row" style="justify-content:space-between;margin-top:12px;">
        <button class="btn btn-ghost btn-sm" id="btnClearFuture">Clear</button>
        <button class="btn btn-secondary btn-sm" id="btnSendFutureToLast">Already Printed? Log &amp; Deduct &rarr;</button>
      </div>`;

    const chkRem = $("chkEstOnlyRemaining");
    if (chkRem) {
      chkRem.addEventListener("change", (e) => {
        state.futurePrintDraft.onlyRemainingPct = e.target.checked;
        renderFutureEstimatorResult();
      });
    }

    // Bind Print Submission options & buttons
    const syncPrintOpts = () => {
      if (!state.futurePrintDraft) return;
      state.futurePrintDraft.printOpts = {
        useAms: !!$("prtUseAms")?.checked,
        bedLeveling: !!$("prtBedLevel")?.checked,
        vibrationCali: !!$("prtVibCali")?.checked,
        flowCali: !!$("prtFlowCali")?.checked,
        timelapse: !!$("prtTimelapse")?.checked,
        urlScheme: $("prtUrlScheme")?.value || "ftp"
      };
    };
    ["prtUseAms","prtBedLevel","prtVibCali","prtFlowCali","prtTimelapse","prtUrlScheme"].forEach(id => {
      const el = $(id);
      if (el) el.addEventListener("change", syncPrintOpts);
    });

    const submitPrintJob = async (uploadOnly = false) => {
      syncPrintOpts();
      const d = state.futurePrintDraft;
      if (!d) return;

      if (!uploadOnly) {
        const warnMsg = overallStatus === "fail"
          ? `WARNING: Filament check indicates NOT ENOUGH FILAMENT for "${d.plateName}".\n\nStart printing on your P2S anyway?`
          : `Start printing "${d.plateName}" (${fmtG(totalReqG)}g) on your Bambu Lab P2S now?`;
        if (!confirm(warnMsg)) return;
      }

      // Build 1-based slotKeys array (index 0 = filament #1, etc.)
      const maxIdx = Math.max(1, ...d.items.map(it => Number(it.index || 1)));
      const slotKeys = new Array(maxIdx).fill("");
      for (const it of d.items) {
        const pos = Math.max(0, Number(it.index || 1) - 1);
        const sp = findSpoolById(it.spoolId);
        slotKeys[pos] = sp ? sp.slotKey : "";
      }

      const statusEl = $("printSubmitStatus");
      const btnStart = $("btnStartPrintP2S");
      const btnUp = $("btnUploadOnlyP2S");
      if (btnStart) btnStart.disabled = true;
      if (btnUp) btnUp.disabled = true;
      if (statusEl) statusEl.textContent = uploadOnly ? "Uploading .gcode.3mf to P2S USB..." : (d.remotePath ? "Sending print command to P2S..." : "Uploading .gcode.3mf to P2S USB and starting print...");

      try {
        const res = await api("POST", "/api/print/start", {
          remotePath: d.remotePath || "",
          stagedId: d.stagedId || "",
          localFilePath: d.localFilePath || "",
          subtaskName: d.plateName || d.fileName,
          plateIndex: d.plateIndex || 1,
          useAms: d.printOpts.useAms,
          bedLeveling: d.printOpts.bedLeveling,
          flowCali: d.printOpts.flowCali,
          vibrationCali: d.printOpts.vibrationCali,
          layerInspect: false,
          timelapse: d.printOpts.timelapse,
          urlScheme: d.printOpts.urlScheme,
          slotKeys,
          uploadOnly
        });

        if (res.remotePath) d.remotePath = res.remotePath;
        toast(res.message || "Print submitted to P2S!");
        if (statusEl) {
          statusEl.style.color = "#4ade80";
          statusEl.textContent = res.message + (uploadOnly ? "" : " (Note: if P2S ignores local print commands, verify LAN Only + Developer Mode is enabled on the printer.)");
        }
        setTimeout(() => loadState(false), 2000);
      } catch (err) {
        toast(err.message, "error");
        if (statusEl) {
          statusEl.style.color = "#fca5a5";
          statusEl.textContent = "Error: " + err.message;
        }
      } finally {
        if (btnStart) btnStart.disabled = false;
        if (btnUp) btnUp.disabled = false;
      }
    };

    const btnStartP2S = $("btnStartPrintP2S");
    if (btnStartP2S) btnStartP2S.addEventListener("click", () => submitPrintJob(false));
    const btnUploadOnly = $("btnUploadOnlyP2S");
    if (btnUploadOnly) btnUploadOnly.addEventListener("click", () => submitPrintJob(true));

    container.querySelectorAll("select[data-est-map-idx]").forEach(sel => {
      sel.addEventListener("change", (e) => {
        state.futurePrintDraft.items[Number(e.target.dataset.estMapIdx)].spoolId = e.target.value;
        renderFutureEstimatorResult();
      });
    });

    const btnClear = $("btnClearFuture");
    if (btnClear) btnClear.addEventListener("click", () => {
      state.futurePrintDraft = null;
      state.futureManualRows = [];
      renderFutureManualRows();
      renderFutureEstimatorResult();
    });

    const btnSend = $("btnSendFutureToLast");
    if (btnSend) btnSend.addEventListener("click", () => {
      state.lastPrintDraft = {
        fileName: draft.fileName,
        plateName: draft.plateName,
        source: "From Estimator",
        completionPct: 100,
        flushGrams: draft.flushGrams || 0,
        predictionSeconds: draft.predictionSeconds || 0,
        thumbnailBase64: draft.thumbnailBase64 || "",
        warning: "",
        finishedJobId: null,
        items: draft.items.map(it => ({
          index: it.index,
          material: it.material,
          color: it.color,
          usedGrams: it.requiredGrams,
          usedMeters: it.requiredMeters,
          spoolId: it.spoolId
        }))
      };
      renderLastPrintPreview();
      switchTab("last-print");
    });
  }

  // ==================== VAULT & HISTORY ====================
  function renderVaultAndHistory() {
    const vaultSpools = (state.db?.spools || []).filter(s => s.slotKey === "VAULT");
    const vc = $("vaultSpoolsContainer");
    if (vaultSpools.length === 0) {
      vc.innerHTML = `<div class="muted small" style="padding:10px 0;">No unloaded spools in your Vault. Unloaded spools from your AMS units will appear here with their remaining weight preserved.</div>`;
    } else {
      vc.innerHTML = vaultSpools.map(sp => {
        const pct = Math.min(100, Math.round((Number(sp.remainingGrams || 0) / Math.max(1, Number(sp.initialGrams || 1000))) * 100));
        return `
          <div class="slot-card">
            <div class="slot-top">
              <span class="slot-key">VAULT</span>
              <span class="mat-pill">${esc(sp.material)}</span>
            </div>
            <div class="slot-visual-row">
              ${buildSpoolSvg(sp.color, pct)}
              <div class="slot-grams-block">
                <div class="slot-grams-main mono">${fmtG(sp.remainingGrams)} g</div>
                <div class="slot-name">${esc(sp.name)}</div>
                <div class="slot-brand">${esc(sp.brand)}</div>
              </div>
            </div>
            <div class="slot-actions">
              <button class="btn btn-secondary btn-xs" data-weigh-spool="${esc(sp.id)}">⚖ Scale</button>
              <button class="btn btn-primary btn-xs" data-edit-spool="${esc(sp.id)}">Load / Edit</button>
            </div>
          </div>`;
      }).join("");
    }

    const hist = state.db?.history || [];
    const hc = $("historyContainer");
    if (hist.length === 0) {
      hc.innerHTML = `<div class="muted small" style="padding:10px 0;">No prints logged yet.</div>`;
    } else {
      hc.innerHTML = hist.map(h => `
        <div class="history-row ${h.undone ? "undone" : ""}">
          <div style="display:flex;gap:12px;align-items:center;flex:1;min-width:240px;">
            <div class="last-print-thumb" style="width:52px;height:52px;font-size:20px;">
              ${h.thumbnailBase64 ? `<img src="${h.thumbnailBase64}" alt=""/>` : "🖨️"}
            </div>
            <div>
              <div><strong>${esc(h.plateName || h.fileName)}</strong> ${h.undone ? `<span class="mat-pill">UNDONE</span>` : ""}</div>
              <div class="muted small">${esc(h.fileName)} · ${esc(h.source)} · ${fmtRelativeTime(h.timestampUtc)} · ${h.completionPct || 100}%</div>
              <div class="slot-usage-chips" style="margin-top:6px;">
                ${(h.items || []).map(it => `
                  <span class="usage-chip" style="padding:3px 7px;">
                    <span class="swatch" style="background:${esc(it.color)}"></span>
                    <strong>${esc(it.slotKey || "?")}</strong>
                    <span class="mono">-${fmtG(it.usedGrams)}g</span>
                    <span class="muted mono">(${fmtG(it.beforeGrams)}&rarr;${fmtG(it.afterGrams)}g)</span>
                  </span>`).join("")}
              </div>
            </div>
          </div>
          <div style="text-align:right;">
            <div class="mono" style="font-size:16px;font-weight:800;color:#4ade80;">-${fmtG(h.totalGrams)} g</div>
            <div class="muted small mono">${Number(h.totalMeters || 0).toFixed(1)} m</div>
            ${!h.undone ? `<button class="btn btn-ghost btn-xs" style="margin-top:6px;" data-undo-print="${esc(h.id)}">Undo Deduction</button>` : ""}
          </div>
        </div>`).join("");
    }
  }

  // ==================== MODALS ====================
  function openModal(id) { $(id).classList.remove("hidden"); }
  function closeModal(id) { $(id).classList.add("hidden"); }

  function toggleConnectionModeSections() {
    const mode = $("cfgConnectionMode").value || "cloud";
    $("cloudSettingsSection").classList.toggle("hidden", mode !== "cloud");
    $("lanSettingsSection").classList.toggle("hidden", mode !== "lan");
  }

  function populateCloudDeviceSelect(devices, currentSerial) {
    state.cloudDevicesCache = devices || [];
    const row = $("cloudDevicePickerRow");
    const sel = $("cfgCloudDeviceSelect");
    if (!devices || devices.length === 0) {
      row.classList.add("hidden");
      return;
    }
    row.classList.remove("hidden");
    sel.innerHTML = devices.map(d =>
      `<option value="${esc(d.DevId)}" ${d.DevId === currentSerial ? "selected" : ""}>${esc(d.Name)} (${esc(d.ModelName)} · ${esc(d.DevId)}) ${d.Online ? "● Online" : "○ Offline"}</option>`
    ).join("");
  }

  function openSettingsModal() {
    const cfg = state.db?.config || {};
    $("cfgConnectionMode").value = cfg.connectionMode || "cloud";
    $("cfgCloudRegion").value = cfg.cloudRegion || "global";
    $("cfgCloudEmail").value = cfg.cloudEmail || "";
    $("cfgCloudPassword").value = "";
    $("cfgCloudVerifyCode").value = "";
    $("cfgCloudToken").value = cfg.cloudToken || "";
    $("cfgCloudUid").value = cfg.cloudUid || "";
    $("cfgPrinterName").value = cfg.printerName || "My P2S";
    $("cfgPrinterModel").value = cfg.printerModel || "Bambu Lab P2S";
    $("cfgPrinterIp").value = cfg.printerIp || "";
    $("cfgAccessCode").value = cfg.accessCode || "";
    $("cfgPrinterSerial").value = cfg.printerSerial || "";
    $("cfgLowWarnG").value = cfg.lowSpoolWarnG ?? 150;
    $("cfgSafetyG").value = cfg.safetyBufferG ?? 15;
    $("cfgSafetyPct").value = cfg.safetyBufferPct ?? 5;
    $("cfgAutoConnect").checked = !!cfg.autoConnect;
    $("cfgAutoSyncRfid").checked = cfg.autoSyncRfid !== false;
    toggleConnectionModeSections();
    openModal("modalSettings");
    renderTopbarAndBanners();
  }

  function openSpoolModal(spoolId = null, preselectSlot = null) {
    const slotSelect = $("spSlotKey");
    const slots = getAllSlotKeys();
    slotSelect.innerHTML = slots.map(k => `<option value="${esc(k)}">${esc(k)}</option>`).join("")
      + `<option value="VAULT">VAULT (Unloaded / Shelf)</option>`;

    const sp = spoolId ? findSpoolById(spoolId) : null;
    if (sp) {
      $("modalSpoolTitle").textContent = `Edit Spool · ${sp.slotKey}`;
      $("spId").value = sp.id;
      slotSelect.value = sp.slotKey || "VAULT";
      $("spMaterial").value = sp.material || "PLA";
      $("spBrand").value = sp.brand || "";
      $("spName").value = sp.name || "";
      $("spColorPicker").value = sp.color || "#00AE42";
      $("spColorHex").value = sp.color || "#00AE42";
      $("spInitialG").value = sp.initialGrams ?? 1000;
      $("spRemainingG").value = sp.remainingGrams ?? 1000;
      $("spTareG").value = sp.tareGrams ?? 250;
      $("spCostKg").value = sp.costPerKg ?? 19.99;
      $("spNotes").value = sp.notes || "";
      $("spIsRfid").checked = !!sp.isRfid;
      $("btnDeleteSpool").classList.remove("hidden");
    } else {
      $("modalSpoolTitle").textContent = preselectSlot ? `Load Spool into ${preselectSlot}` : "Add New Spool";
      $("spId").value = "";
      slotSelect.value = preselectSlot || "VAULT";
      $("spMaterial").value = "PLA";
      $("spBrand").value = "Bambu Lab";
      $("spName").value = "";
      $("spColorPicker").value = "#00AE42";
      $("spColorHex").value = "#00AE42";
      $("spInitialG").value = 1000;
      $("spRemainingG").value = 1000;
      $("spTareG").value = 250;
      $("spCostKg").value = 19.99;
      $("spNotes").value = "";
      $("spIsRfid").checked = true;
      $("btnDeleteSpool").classList.add("hidden");
    }
    openModal("modalSpool");
  }

  function openWeighModal(spoolId) {
    const sp = findSpoolById(spoolId);
    if (!sp) return;
    $("weighSpoolId").value = sp.id;
    $("weighSpoolLabel").textContent = `${sp.slotKey} · ${sp.name || sp.material} (Currently tracked: ${fmtG(sp.remainingGrams)}g)`;
    const tare = Number(sp.tareGrams ?? 250);
    $("weighTareG").value = tare;
    $("weighGrossG").value = Math.round(Number(sp.remainingGrams || 0) + tare);
    updateWeighPreview();
    openModal("modalWeigh");
  }

  function updateWeighPreview() {
    const gross = Number($("weighGrossG").value || 0);
    const tare = Number($("weighTareG").value || 0);
    const net = Math.max(0, gross - tare);
    $("weighNetPreview").textContent = `${net.toFixed(1)} g`;
  }

  // ==================== TAB NAVIGATION ====================
  function switchTab(tabName) {
    state.activeTab = tabName;
    document.querySelectorAll(".nav-tab").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.tab === tabName);
    });
    document.querySelectorAll(".tab-panel").forEach(panel => {
      panel.classList.toggle("active", panel.id === `tab-${tabName}`);
    });
  }

  // ==================== DROPZONE SETUP ====================
  function bindDropzone(zoneId, inputId, onFile) {
    const zone = $(zoneId);
    const input = $(inputId);
    zone.addEventListener("click", (e) => {
      if (e.target.tagName !== "BUTTON") input.click();
    });
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("dragover"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
    zone.addEventListener("drop", async (e) => {
      e.preventDefault();
      zone.classList.remove("dragover");
      const file = e.dataTransfer?.files?.[0];
      if (file) await onFile(file);
    });
    input.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (file) await onFile(file);
      input.value = "";
    });
  }

  // ==================== EVENT BINDINGS ====================
  function bindEvents() {
    // Tabs
    document.querySelectorAll(".nav-tab").forEach(btn => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    // Close modals
    document.querySelectorAll("[data-close-modal]").forEach(btn => {
      btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
    });
    document.querySelectorAll(".modal-backdrop").forEach(bg => {
      bg.addEventListener("click", (e) => { if (e.target === bg) bg.classList.add("hidden"); });
    });

    // Topbar & Hero Quick Actions
    $("btnPrinterSettings").addEventListener("click", openSettingsModal);
    $("btnBannerConnect").addEventListener("click", openSettingsModal);
    $("btnQuickMeasure").addEventListener("click", () => switchTab("last-print"));
    $("btnQuickEstimate").addEventListener("click", () => switchTab("estimator"));

    $("btnClearDemo").addEventListener("click", async () => {
      const res = await api("POST", "/api/demo/clear");
      state.db = res.db;
      toast("Cleared sample data. Ready for your P2S!");
      renderTopbarAndBanners();
      renderAllViews();
    });

    $("btnLoadSampleData").addEventListener("click", async () => {
      const res = await api("POST", "/api/demo/load");
      state.db = res.db;
      toast("Loaded P2S + 2× AMS 2 Pro + AMS HT sample dataset.");
      renderTopbarAndBanners();
      renderAllViews();
    });

    // Finished job banner actions
    $("btnMeasureFinishedJob").addEventListener("click", async () => {
      const tel = state.telemetry || {};
      const mode = state.db?.config?.connectionMode || "cloud";
      switchTab("last-print");
      toast(mode === "cloud" ? "Pulling finished print from Bambu Cloud..." : "Pulling finished print from P2S via FTPS...");
      try {
        if (mode === "cloud") {
          const res = await api("POST", "/api/cloud/current-job");
          prepareLastPrintDraftFromParsed(
            res.parsed,
            "Bambu Cloud",
            tel.LastFinishedJobId,
            tel.LastFinishedPercent || 100,
            res.mappingKeys || tel.LastFinishedMappingKeys || []
          );
          toast("Loaded last print usage from Bambu Cloud!");
        } else {
          const res = await api("POST", "/api/ftps/parse", { remotePath: "" });
          prepareLastPrintDraftFromParsed(
            res.parsed,
            "P2S Auto-FTPS",
            tel.LastFinishedJobId,
            tel.LastFinishedPercent || 100,
            tel.LastFinishedMappingKeys || []
          );
          toast("Loaded last print usage from P2S!");
        }
      } catch (err) {
        toast(`Pull failed: ${err.message}. You can drop the .gcode.3mf manually.`, "warn");
      }
    });

    $("btnDismissFinishedJob").addEventListener("click", async () => {
      const id = state.telemetry?.LastFinishedJobId;
      if (id) await api("POST", "/api/printer/dismiss-finished", { jobId: id });
      await loadState(false);
    });

    // AMS Unit Management
    $("btnAddAmsPro").addEventListener("click", async () => {
      const res = await api("POST", "/api/ams/add", { unitType: "AMS 2 Pro" });
      state.db = res.db;
      toast("Added AMS 2 Pro (4 slots).");
      renderAllViews();
    });
    $("btnAddAmsHt").addEventListener("click", async () => {
      const res = await api("POST", "/api/ams/add", { unitType: "AMS HT" });
      state.db = res.db;
      toast("Added AMS HT (1 high-temp slot).");
      renderAllViews();
    });
    $("btnAddExternal").addEventListener("click", async () => {
      const res = await api("POST", "/api/ams/add", { unitType: "External" });
      state.db = res.db;
      toast("Added External Spool holder.");
      renderAllViews();
    });
    $("btnSyncAms").addEventListener("click", async () => {
      try {
        await api("POST", "/api/printer/pushall");
        const res = await api("POST", "/api/printer/sync-ams");
        state.db = res.db;
        toast("Synced live AMS units & RFID trays from P2S!");
        renderAllViews();
      } catch (err) {
        toast(err.message, "warn");
      }
    });

    // Delegated clicks inside AMS Rack, Vault, History
    document.body.addEventListener("click", async (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;

      if (btn.dataset.addToSlot) {
        openSpoolModal(null, btn.dataset.addToSlot);
      } else if (btn.dataset.editSpool) {
        openSpoolModal(btn.dataset.editSpool);
      } else if (btn.dataset.weighSpool) {
        openWeighModal(btn.dataset.weighSpool);
      } else if (btn.dataset.unloadSpool) {
        const res = await api("POST", "/api/spools/adjust", { id: btn.dataset.unloadSpool, slotKey: "VAULT" });
        state.db = res.db;
        toast("Moved spool to Spool Vault.");
        renderAllViews();
      } else if (btn.dataset.removeUnit) {
        if (!confirm("Remove this AMS unit? Loaded spools will be safely moved to the Spool Vault.")) return;
        const res = await api("POST", "/api/ams/remove", { id: btn.dataset.removeUnit });
        state.db = res.db;
        toast("Removed AMS unit.");
        renderAllViews();
      } else if (btn.dataset.undoPrint) {
        const res = await api("POST", "/api/prints/undo", { id: btn.dataset.undoPrint });
        state.db = res.db;
        toast("Undid print deduction and restored spool weights.");
        renderAllViews();
      } else if (btn.dataset.ftpsPath) {
        toast(`Downloading ${btn.dataset.ftpsPath} from P2S...`);
        try {
          const res = await api("POST", "/api/ftps/parse", { remotePath: btn.dataset.ftpsPath });
          prepareLastPrintDraftFromParsed(res.parsed, "P2S FTPS");
          toast("Parsed print usage from P2S SD card!");
        } catch (err) {
          toast(err.message, "error");
        }
      } else if (btn.dataset.estFtpsPath) {
        toast(`Downloading ${btn.dataset.estFtpsPath} from P2S for estimation...`);
        try {
          const res = await api("POST", "/api/ftps/parse", { remotePath: btn.dataset.estFtpsPath });
          prepareFutureDraftFromParsed(res.parsed, [], 0, { remotePath: res.remotePath || btn.dataset.estFtpsPath });
          toast(`Loaded ${res.parsed.FileName} into Future Print Estimator!`);
        } catch (err) {
          toast(err.message, "error");
        }
      } else if (btn.dataset.cloudTaskLast) {
        const task = state.cloudTasksCache.find(t => String(t.Id) === btn.dataset.cloudTaskLast);
        if (task) {
          prepareLastPrintDraftFromParsed(task.Parsed, "Bambu Cloud", null, 100, task.MappingKeys || []);
          toast(`Loaded "${task.DesignTitle || task.Title}" from Bambu Cloud!`);
        }
      } else if (btn.dataset.cloudTaskEst) {
        const task = state.cloudTasksCache.find(t => String(t.Id) === btn.dataset.cloudTaskEst);
        if (task) {
          prepareFutureDraftFromParsed(task.Parsed, task.MappingKeys || [], 0);
          toast(`Loaded "${task.DesignTitle || task.Title}" into Future Print Estimator!`);
        }
      } else if (btn.dataset.localPathLast) {
        try {
          const res = await api("POST", "/api/local-cache/parse", { path: btn.dataset.localPathLast });
          prepareLastPrintDraftFromParsed(res.parsed, "Bambu Studio Cache");
          toast(`Loaded "${res.parsed.PlateName || res.parsed.FileName}" from Bambu Studio!`);
        } catch (err) { toast(err.message, "error"); }
      } else if (btn.dataset.localPathEst) {
        try {
          const res = await api("POST", "/api/local-cache/parse", { path: btn.dataset.localPathEst });
          const pth = btn.dataset.localPathEst;
          const isFileArchive = /\.(3mf|gcode)$/i.test(pth);
          prepareFutureDraftFromParsed(res.parsed, [], 0, isFileArchive ? { localFilePath: pth } : {});
          toast(`Loaded "${res.parsed.PlateName || res.parsed.FileName}" into Estimator!`);
        } catch (err) { toast(err.message, "error"); }
      }
    });

    // Last Print Dropzone & FTPS
    $("btnBrowseLastFile").addEventListener("click", () => $("lastPrintFileInput").click());
    bindDropzone("lastPrintDropzone", "lastPrintFileInput", async (file) => {
      try {
        toast(`Parsing ${file.name}...`);
        const data = await uploadAndParseFile(file);
        prepareLastPrintDraftFromParsed(data.parsed, "3MF Drop");
        toast(`Measured ${fmtG(data.parsed.TotalGrams)} g across ${(data.parsed.Filaments || []).length} filament(s)!`);
      } catch (err) {
        toast(err.message, "error");
      }
    });

    $("btnFtpsPullLatest").addEventListener("click", async () => {
      const mode = state.db?.config?.connectionMode || "cloud";
      try {
        if (mode === "cloud") {
          toast("Fetching latest print from Bambu Cloud...");
          const res = await api("POST", "/api/cloud/current-job");
          prepareLastPrintDraftFromParsed(res.parsed, "Bambu Cloud", null, 100, res.mappingKeys || []);
          toast(`Measured latest Bambu Cloud print: ${res.parsed.PlateName || res.parsed.FileName}`);
        } else {
          toast("Connecting to P2S FTPS (port 990)...");
          const res = await api("POST", "/api/ftps/parse", { remotePath: "" });
          prepareLastPrintDraftFromParsed(res.parsed, "P2S FTPS");
          toast(`Measured latest P2S print: ${res.parsed.FileName}`);
        }
      } catch (err) {
        toast(err.message, "error");
      }
    });

    $("btnFtpsBrowse").addEventListener("click", async () => {
      const mode = state.db?.config?.connectionMode || "cloud";
      const listEl = $("ftpsFileList");
      listEl.classList.remove("hidden");
      listEl.innerHTML = `<div class="muted small">${mode === "cloud" ? "Loading Bambu Cloud print history..." : "Listing files on P2S SD card..."}</div>`;
      try {
        if (mode === "cloud") {
          const res = await api("GET", "/api/cloud/tasks");
          state.cloudTasksCache = res.tasks || [];
          if (state.cloudTasksCache.length === 0) {
            listEl.innerHTML = `<div class="muted small">${esc(res.error || "No Bambu Cloud print tasks found. Sign in under Connection Settings.")}</div>`;
            return;
          }
          listEl.innerHTML = state.cloudTasksCache.map(t => `
            <div class="ftps-item">
              <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;">
                <strong>${esc(t.DesignTitle || t.Title)}</strong>
                <div class="muted small mono">${fmtG(t.WeightGrams)}g · ${Number(t.LengthMeters || 0).toFixed(1)}m · ${esc(t.Status || "")} · ${esc(t.StartTime || "")}</div>
              </div>
              <button class="btn btn-secondary btn-xs" data-cloud-task-last="${esc(t.Id)}">Measure</button>
            </div>`).join("");
        } else {
          const res = await api("GET", "/api/ftps/files");
          if (!res.files || res.files.length === 0) {
            listEl.innerHTML = `<div class="muted small">${esc(res.error || "No .gcode.3mf files found in /cache or / on SD card.")}</div>`;
            return;
          }
          listEl.innerHTML = res.files.slice(0, 20).map(f => `
            <div class="ftps-item">
              <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;">
                <strong>${esc(f.Name)}</strong>
                <div class="muted small mono">${esc(f.Folder)} · ${(f.SizeBytes / 1024 / 1024).toFixed(2)} MB · ${esc(f.ModifiedRaw)}</div>
              </div>
              <button class="btn btn-secondary btn-xs" data-ftps-path="${esc(f.Path)}">Measure</button>
            </div>`).join("");
        }
      } catch (err) {
        listEl.innerHTML = `<div class="muted small" style="color:#fca5a5;">${esc(err.message)}</div>`;
      }
    });

    $("btnLocalSlicerLast").addEventListener("click", async () => {
      const listEl = $("ftpsFileList");
      listEl.classList.remove("hidden");
      listEl.innerHTML = `<div class="muted small">Scanning Bambu Studio / OrcaSlicer cache &amp; Downloads...</div>`;
      try {
        const res = await api("GET", "/api/local-cache/files");
        if (!res.files || res.files.length === 0) {
          listEl.innerHTML = `<div class="muted small">No sliced plates found in Bambu Studio cache or Downloads. Slice a plate in Bambu Studio (or export <code>.gcode.3mf</code>) and click again.</div>`;
          return;
        }
        listEl.innerHTML = res.files.map(f => `
          <div class="ftps-item">
            <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;">
              <strong>${esc(f.Name)}</strong>
              <div class="muted small mono">${esc(f.Source)} · ${fmtRelativeTime(f.ModifiedIso)}</div>
            </div>
            <button class="btn btn-secondary btn-xs" data-local-path-last="${esc(f.FullPath)}">Measure</button>
          </div>`).join("");
      } catch (err) {
        listEl.innerHTML = `<div class="muted small" style="color:#fca5a5;">${esc(err.message)}</div>`;
      }
    });

    $("btnLocalSlicerEst").addEventListener("click", async () => {
      const listEl = $("estFtpsFileList");
      listEl.classList.remove("hidden");
      listEl.innerHTML = `<div class="muted small">Scanning Bambu Studio / OrcaSlicer cache &amp; Downloads...</div>`;
      try {
        const res = await api("GET", "/api/local-cache/files");
        if (!res.files || res.files.length === 0) {
          listEl.innerHTML = `<div class="muted small">No sliced plates found in Bambu Studio cache or Downloads. Slice a plate in Bambu Studio (or export <code>.gcode.3mf</code>) and click again.</div>`;
          return;
        }
        listEl.innerHTML = res.files.map(f => `
          <div class="ftps-item">
            <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;">
              <strong>${esc(f.Name)}</strong>
              <div class="muted small mono">${esc(f.Source)} · ${fmtRelativeTime(f.ModifiedIso)}</div>
            </div>
            <button class="btn btn-secondary btn-xs" data-local-path-est="${esc(f.FullPath)}">Estimate</button>
          </div>`).join("");
      } catch (err) {
        listEl.innerHTML = `<div class="muted small" style="color:#fca5a5;">${esc(err.message)}</div>`;
      }
    });

    // Manual Last Print Entry
    $("btnStartManualLast").addEventListener("click", () => {
      $("manualLastForm").classList.toggle("hidden");
      if (state.manualLastRows.length === 0) {
        const firstSpool = getLoadedSpools()[0];
        state.manualLastRows.push({ spoolId: firstSpool ? firstSpool.id : "", grams: 35 });
        renderManualLastRows();
      }
    });
    $("btnAddManualLastRow").addEventListener("click", () => {
      state.manualLastRows.push({ spoolId: "", grams: 20 });
      renderManualLastRows();
    });
    $("btnApplyManualLast").addEventListener("click", () => {
      const name = $("manualLastName").value.trim() || "Manual Print Entry";
      const items = state.manualLastRows
        .filter(r => Number(r.grams || 0) > 0)
        .map((r, idx) => {
          const sp = findSpoolById(r.spoolId);
          return {
            index: idx + 1,
            material: sp ? sp.material : "PLA",
            color: sp ? sp.color : "#94A3B8",
            usedGrams: Number(r.grams),
            usedMeters: gramsToMeters(r.grams, sp ? sp.material : "PLA", sp ? sp.density : 1.24),
            spoolId: r.spoolId
          };
        });
      if (items.length === 0) { toast("Enter at least one positive gram value.", "warn"); return; }
      state.lastPrintDraft = {
        fileName: name,
        plateName: name,
        source: "Manual / Scale",
        completionPct: 100,
        flushGrams: 0,
        predictionSeconds: 0,
        thumbnailBase64: "",
        warning: "",
        finishedJobId: null,
        items
      };
      renderLastPrintPreview();
    });

    // Future Print Dropzone & Manual Check
    $("btnBrowseFutureFile").addEventListener("click", () => $("futurePrintFileInput").click());
    bindDropzone("futurePrintDropzone", "futurePrintFileInput", async (file) => {
      try {
        toast(`Checking ${file.name}...`);
        const data = await uploadAndParseFile(file);
        prepareFutureDraftFromParsed(data.parsed, [], 0, { stagedId: data.stagedId || "" });
        toast(`Estimated ${fmtG(data.parsed.TotalGrams)} g needed for ${data.parsed.PlateName || file.name}.`);
      } catch (err) {
        toast(err.message, "error");
      }
    });

    // Check Current Job on P2S (Cloud or LAN FTPS)
    const pullCurrentJobForEstimate = async () => {
      const mode = state.db?.config?.connectionMode || "cloud";
      switchTab("estimator");
      toast(mode === "cloud" ? "Pulling current print job from Bambu Cloud..." : "Pulling current print job from P2S via FTPS...");
      try {
        const endpoint = mode === "cloud" ? "/api/cloud/current-job" : "/api/ftps/current-job";
        const res = await api("POST", endpoint);
        const isRunning = ["RUNNING", "PREPARE", "PAUSE"].includes(String(res.gcodeState || "").toUpperCase());
        const rPath = (res.remotePath && res.remotePath.startsWith("/")) ? res.remotePath : "";
        prepareFutureDraftFromParsed(res.parsed, res.mappingKeys || [], isRunning ? (res.mcPercent || 0) : 0, { remotePath: rPath });
        toast(`Loaded "${res.parsed.PlateName || res.parsed.FileName}" from ${mode === "cloud" ? "Bambu Cloud" : "P2S"}!`);
      } catch (err) {
        toast(`Could not pull current job: ${err.message}`, "error");
      }
    };
    $("btnEstCheckCurrentJob").addEventListener("click", pullCurrentJobForEstimate);
    $("btnLiveCheckCurrentJob").addEventListener("click", pullCurrentJobForEstimate);

    $("btnLivePauseResume").addEventListener("click", async () => {
      const gState = String(state.telemetry?.GcodeState || "").toUpperCase();
      const action = gState === "PAUSE" ? "resume" : "pause";
      try {
        const res = await api("POST", "/api/print/control", { action });
        toast(res.message);
      } catch (err) { toast(err.message, "error"); }
    });

    $("btnLiveStopPrint").addEventListener("click", async () => {
      if (!confirm("STOP and cancel the active print on your Bambu Lab P2S?")) return;
      try {
        const res = await api("POST", "/api/print/control", { action: "stop" });
        toast(res.message, "warn");
      } catch (err) { toast(err.message, "error"); }
    });

    $("btnEstFtpsBrowse").addEventListener("click", async () => {
      const mode = state.db?.config?.connectionMode || "cloud";
      const listEl = $("estFtpsFileList");
      listEl.classList.remove("hidden");
      listEl.innerHTML = `<div class="muted small">${mode === "cloud" ? "Loading Bambu Cloud jobs..." : "Listing files on P2S SD card..."}</div>`;
      try {
        if (mode === "cloud") {
          const res = await api("GET", "/api/cloud/tasks");
          state.cloudTasksCache = res.tasks || [];
          if (state.cloudTasksCache.length === 0) {
            listEl.innerHTML = `<div class="muted small">${esc(res.error || "No Bambu Cloud print jobs found.")}</div>`;
            return;
          }
          listEl.innerHTML = state.cloudTasksCache.map(t => `
            <div class="ftps-item">
              <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;">
                <strong>${esc(t.DesignTitle || t.Title)}</strong>
                <div class="muted small mono">${fmtG(t.WeightGrams)}g · ${Number(t.LengthMeters || 0).toFixed(1)}m · ${esc(t.Status || "")}</div>
              </div>
              <button class="btn btn-secondary btn-xs" data-cloud-task-est="${esc(t.Id)}">Estimate</button>
            </div>`).join("");
        } else {
          const res = await api("GET", "/api/ftps/files");
          if (!res.files || res.files.length === 0) {
            listEl.innerHTML = `<div class="muted small">${esc(res.error || "No .gcode.3mf files found on P2S SD card.")}</div>`;
            return;
          }
          listEl.innerHTML = res.files.slice(0, 20).map(f => `
            <div class="ftps-item">
              <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;">
                <strong>${esc(f.Name)}</strong>
                <div class="muted small mono">${esc(f.Folder)} · ${(f.SizeBytes / 1024 / 1024).toFixed(2)} MB · ${esc(f.ModifiedRaw)}</div>
              </div>
              <button class="btn btn-secondary btn-xs" data-est-ftps-path="${esc(f.Path)}">Estimate</button>
            </div>`).join("");
        }
      } catch (err) {
        listEl.innerHTML = `<div class="muted small" style="color:#fca5a5;">${esc(err.message)}</div>`;
      }
    });

    $("btnAddFutureRow").addEventListener("click", () => {
      const loaded = getLoadedSpools();
      const pick = loaded[state.futureManualRows.length % Math.max(1, loaded.length)];
      state.futureManualRows.push({ spoolId: pick ? pick.id : "", grams: 150 });
      renderFutureManualRows();
      syncFutureDraftFromManualRows();
    });

    ["estBufferG", "estBufferPct", "estIncludeAutoRefill"].forEach(id => {
      $(id).addEventListener("input", renderFutureEstimatorResult);
      $(id).addEventListener("change", renderFutureEstimatorResult);
    });

    // Vault
    $("btnNewVaultSpool").addEventListener("click", () => openSpoolModal(null, "VAULT"));

    // Settings Modal Controls (Bambu Cloud & LAN)
    $("cfgConnectionMode").addEventListener("change", toggleConnectionModeSections);

    $("cfgCloudDeviceSelect").addEventListener("change", (e) => {
      const dev = state.cloudDevicesCache.find(d => d.DevId === e.target.value);
      if (dev) {
        $("cfgPrinterSerial").value = dev.DevId;
        $("cfgPrinterName").value = dev.Name || $("cfgPrinterName").value;
        if (dev.ModelName) $("cfgPrinterModel").value = dev.ModelName;
      }
    });

    $("btnCloudSignIn").addEventListener("click", async () => {
      try {
        const emailVal = $("cfgCloudEmail").value.trim();
        const passVal = $("cfgCloudPassword").value;
        const codeVal = $("cfgCloudVerifyCode").value.trim();
        const tokenVal = $("cfgCloudToken").value.trim();
        const body = {
          region: $("cfgCloudRegion").value,
          email: emailVal,
          password: passVal,
          verifyCode: codeVal,
          accessToken: (!passVal && !codeVal) ? tokenVal : ""
        };
        toast("Signing in to Bambu Cloud...");
        const res = await api("POST", "/api/cloud/login", body);
        if (res.needsVerificationCode) {
          toast(res.message || "Check your email for the 6-digit Bambu verification code.", "warn");
          $("cfgCloudVerifyCode").focus();
          return;
        }
        if (res.config) {
          state.db.config = res.config;
          $("cfgCloudToken").value = res.config.cloudToken || "";
          $("cfgPrinterSerial").value = res.config.printerSerial || "";
          $("cfgPrinterName").value = res.config.printerName || "My P2S";
          $("cfgPrinterModel").value = res.config.printerModel || "Bambu Lab P2S";
        }
        if (res.telemetry) state.telemetry = res.telemetry;
        populateCloudDeviceSelect(res.devices || [], $("cfgPrinterSerial").value);
        toast(res.message || "Signed in to Bambu Cloud!");
        renderTopbarAndBanners();
      } catch (err) {
        toast(err.message, "error");
      }
    });

    $("btnCloudRefreshDevices").addEventListener("click", async () => {
      try {
        const res = await api("GET", "/api/cloud/devices");
        if (res.devices && res.devices.length > 0) {
          populateCloudDeviceSelect(res.devices, $("cfgPrinterSerial").value);
          toast(`Found ${res.devices.length} bound printer(s) in your Bambu Cloud account.`);
        } else {
          toast(res.error || "No printers found. Sign in to Bambu Cloud first.", "warn");
        }
      } catch (err) {
        toast(err.message, "error");
      }
    });

    $("btnShutdownServer").addEventListener("click", async () => {
      if (!confirm("Exit the Bambu Filament Manager server?")) return;
      try {
        await api("POST", "/api/shutdown");
      } catch {}
      document.body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#eef2f7;font-family:sans-serif;text-align:center;"><div><h2>Bambu Filament Manager Exited</h2><p style="color:#94a3b8;">You can close this browser tab. Run <code>Start-FilamentManager.bat</code> anytime to relaunch.</p></div></div>`;
    });

    $("btnSaveSettings").addEventListener("click", async () => {
      try {
        const mode = $("cfgConnectionMode").value || "cloud";
        const body = {
          connectionMode: mode,
          cloudRegion: $("cfgCloudRegion").value || "global",
          cloudEmail: $("cfgCloudEmail").value.trim(),
          cloudToken: $("cfgCloudToken").value.trim(),
          cloudUid: $("cfgCloudUid").value.trim(),
          printerName: $("cfgPrinterName").value.trim(),
          printerModel: $("cfgPrinterModel").value.trim() || "Bambu Lab P2S",
          printerIp: $("cfgPrinterIp").value.trim(),
          accessCode: $("cfgAccessCode").value.trim(),
          printerSerial: $("cfgPrinterSerial").value.trim(),
          lowSpoolWarnG: Number($("cfgLowWarnG").value || 150),
          safetyBufferG: Number($("cfgSafetyG").value || 15),
          safetyBufferPct: Number($("cfgSafetyPct").value || 5),
          autoConnect: $("cfgAutoConnect").checked,
          autoSyncRfid: $("cfgAutoSyncRfid").checked,
          connectNow: mode === "cloud"
            ? !!($("cfgCloudToken").value.trim() && $("cfgPrinterSerial").value.trim())
            : !!($("cfgPrinterIp").value.trim() && $("cfgPrinterSerial").value.trim() && $("cfgAccessCode").value.trim())
        };
        const res = await api("POST", "/api/config", body);
        state.db.config = res.config;
        state.telemetry = res.telemetry;
        $("estBufferG").value = body.safetyBufferG;
        $("estBufferPct").value = body.safetyBufferPct;
        closeModal("modalSettings");
        toast(body.connectNow
          ? (mode === "cloud" ? "Saved — connecting to Bambu Cloud..." : "Saved — connecting to P2S LAN...")
          : "Settings saved.");
        renderTopbarAndBanners();
        renderAllViews();
      } catch (err) {
        toast(err.message, "error");
      }
    });

    $("btnModalConnect").addEventListener("click", async () => {
      const mode = $("cfgConnectionMode").value || "cloud";
      await api("POST", "/api/config", {
        connectionMode: mode,
        cloudRegion: $("cfgCloudRegion").value || "global",
        cloudToken: $("cfgCloudToken").value.trim(),
        cloudUid: $("cfgCloudUid").value.trim(),
        printerIp: $("cfgPrinterIp").value.trim(),
        accessCode: $("cfgAccessCode").value.trim(),
        printerSerial: $("cfgPrinterSerial").value.trim(),
        connectNow: true
      });
      toast(mode === "cloud" ? "Connecting to Bambu Cloud MQTT (port 8883)..." : "Connecting to P2S LAN MQTT (port 8883)...");
      setTimeout(() => loadState(false), 1500);
    });

    $("btnModalDisconnect").addEventListener("click", async () => {
      await api("POST", "/api/printer/disconnect");
      toast("Disconnected.");
      await loadState(false);
    });

    $("btnModalTestFtps").addEventListener("click", async () => {
      const mode = $("cfgConnectionMode").value || "cloud";
      if (mode === "cloud") {
        try {
          const res = await api("GET", "/api/cloud/tasks");
          if (res.tasks && res.tasks.length > 0) {
            toast(`Bambu Cloud OK! Found ${res.tasks.length} recent print task(s).`);
          } else {
            toast(res.error || "Bambu Cloud reachable, no tasks found yet.", "warn");
          }
        } catch (err) {
          toast(`Bambu Cloud test failed: ${err.message}`, "error");
        }
        return;
      }
      await api("POST", "/api/config", {
        printerIp: $("cfgPrinterIp").value.trim(),
        accessCode: $("cfgAccessCode").value.trim()
      });
      try {
        const res = await api("GET", "/api/ftps/files");
        if (res.files && res.files.length > 0) {
          toast(`FTPS OK! Found ${res.files.length} print file(s) on P2S SD card.`);
        } else {
          toast(res.error || "FTPS connected, no .3mf files found.", "warn");
        }
      } catch (err) {
        toast(`FTPS failed: ${err.message}`, "error");
      }
    });

    // Spool Modal Controls
    $("spColorPicker").addEventListener("input", (e) => { $("spColorHex").value = e.target.value.toUpperCase(); });
    $("spColorHex").addEventListener("input", (e) => {
      if (/^#[0-9A-Fa-f]{6}$/.test(e.target.value)) $("spColorPicker").value = e.target.value;
    });
    $("spTarePreset").addEventListener("change", (e) => {
      if (e.target.value !== "custom") $("spTareG").value = Number(e.target.value);
    });

    $("btnSaveSpool").addEventListener("click", async () => {
      const mat = $("spMaterial").value;
      const body = {
        id: $("spId").value || "",
        slotKey: $("spSlotKey").value,
        material: mat,
        brand: $("spBrand").value.trim() || "Bambu Lab",
        name: $("spName").value.trim() || `${mat} Spool`,
        color: $("spColorHex").value.trim() || "#00AE42",
        initialGrams: Number($("spInitialG").value || 1000),
        remainingGrams: Number($("spRemainingG").value || 0),
        tareGrams: Number($("spTareG").value || 250),
        density: MATERIAL_DENSITY[mat] || 1.24,
        costPerKg: Number($("spCostKg").value || 20),
        notes: $("spNotes").value.trim(),
        isRfid: $("spIsRfid").checked
      };
      const res = await api("POST", "/api/spools/save", body);
      state.db = res.db;
      closeModal("modalSpool");
      toast(`Saved spool in ${body.slotKey}.`);
      renderAllViews();
    });

    $("btnDeleteSpool").addEventListener("click", async () => {
      const id = $("spId").value;
      if (!id || !confirm("Delete this spool permanently?")) return;
      const res = await api("POST", "/api/spools/delete", { id });
      state.db = res.db;
      closeModal("modalSpool");
      toast("Spool deleted.");
      renderAllViews();
    });

    // Weigh Modal
    $("weighGrossG").addEventListener("input", updateWeighPreview);
    $("weighTareG").addEventListener("input", updateWeighPreview);
    $("btnApplyWeigh").addEventListener("click", async () => {
      const id = $("weighSpoolId").value;
      const grossGrams = Number($("weighGrossG").value || 0);
      const tareGrams = Number($("weighTareG").value || 0);
      const res = await api("POST", "/api/spools/weigh", { id, grossGrams, tareGrams });
      state.db = res.db;
      closeModal("modalWeigh");
      toast(`Calibrated remaining filament to ${fmtG(res.netGrams)} g!`);
      renderAllViews();
    });
  }

  function renderManualLastRows() {
    const c = $("manualLastRows");
    c.innerHTML = state.manualLastRows.map((row, idx) => `
      <div class="manual-row">
        <select data-ml-spool="${idx}">${buildSpoolSelectOptions(row.spoolId)}</select>
        <input type="number" min="0.1" step="0.5" placeholder="Used g" value="${row.grams || ""}" data-ml-grams="${idx}" />
        <button class="btn btn-ghost btn-xs" type="button" data-ml-del="${idx}">&times;</button>
      </div>`).join("");

    c.querySelectorAll("[data-ml-spool]").forEach(el => {
      el.addEventListener("change", (e) => { state.manualLastRows[Number(e.target.dataset.mlSpool)].spoolId = e.target.value; });
    });
    c.querySelectorAll("[data-ml-grams]").forEach(el => {
      el.addEventListener("input", (e) => { state.manualLastRows[Number(e.target.dataset.mlGrams)].grams = Number(e.target.value); });
    });
    c.querySelectorAll("[data-ml-del]").forEach(el => {
      el.addEventListener("click", (e) => {
        state.manualLastRows.splice(Number(e.target.dataset.mlDel), 1);
        renderManualLastRows();
      });
    });
  }

  // ==================== BOOT ====================
  async function init() {
    bindEvents();
    await loadState(true);
    if (state.db?.config) {
      $("estBufferG").value = state.db.config.safetyBufferG ?? 15;
      $("estBufferPct").value = state.db.config.safetyBufferPct ?? 5;
    }
    renderFutureManualRows();
    // Poll live MQTT telemetry every 3 seconds
    setInterval(() => loadState(false), 3000);
  }

  init();
})();
