# SuckLessFactors Auto-Submit

Browser extension that automatically fills your weekly working hours in SAP SuccessFactors by reading PC wake/sleep events from the Windows Event Log so your doings suck less.
<img width="501" height="497" alt="image" src="https://github.com/user-attachments/assets/cee6b8ac-5ef3-4eb3-9813-29b585a2c042" />


## How it works

1. **Extension** (Manifest V3) runs on any SAP SuccessFactors instance (`*.successfactors.eu` / `*.successfactors.com`)
2. Intercepts SAP's own XHR requests to capture your session (CSRF token, assignment ID, company)
3. On "Load from PC": talks to a **native messaging host** (PowerShell script) via Chrome's native messaging protocol
4. The PowerShell script queries the **Windows Event Log** (`System` → `Microsoft-Windows-Power-Troubleshooter` → Event ID 1) for wake/sleep events
5. Computes first-wake (start) and last-sleep (end) per day for the current week
6. Times are displayed in the popup for review/editing, then submitted to SAP's OData v4 batch API

### Time detection

- Source: Windows Event Log wake events (Event ID 1)
- Per day: **earliest wake** = work start, **latest sleep** = work end
- If the PC is still awake, current time is used as end
- Nothing is stored — times are computed fresh on every "Load from PC" click

## Compatibility

Brave, Chrome, Edge (any Chromium browser supporting Manifest V3)

## File structure

```
sf-timesheet-extension/
├── extension/
│   ├── manifest.json      # Extension manifest (MV3)
│   ├── background.js      # Service worker: message routing, SF API calls
│   ├── content.js         # Content script (ISOLATED): stores session data
│   ├── interceptor.js     # Content script (MAIN): XHR hooks for token capture
│   ├── popup.html         # Extension popup UI
│   └── popup.js           # Popup logic
└── native-host/
    ├── host.ps1           # PowerShell script reading Event Log
    ├── host.bat           # Launcher for host.ps1
    ├── install.ps1        # Registers native host for all browsers
    └── uninstall.ps1      # Removes registration + optional file cleanup
```

## Install

### 1. Load the extension

1. Open `brave://extensions` (or `chrome://extensions` / `edge://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder
4. Note the **Extension ID** shown (32-character string like `abcdefghijklmnopqrstuvwxyzabcdef`)

### 2. Register the native messaging host

```powershell
cd native-host
.\install.ps1 -ExtensionId <your-extension-id>
```

This:
- Optionally copies files to `%APPDATA%\SuckLessFactors`
- Writes the native messaging manifest JSON
- Creates registry keys for Brave, Chrome, and Edge

### 3. Use

1. Log into SAP SuccessFactors and open the **Timesheet** page
2. Click the extension icon → should show **Connected**
3. Click **Load from PC** to fetch times from the Event Log
4. Review/adjust, then click **Submit Week**
5. The SF page auto-reloads to show your entries

## Uninstall

```powershell
cd native-host
.\uninstall.ps1
```

This removes the registry keys. It will prompt whether to also delete the files from `%APPDATA%\SuckLessFactors`.

To remove the extension: go to `brave://extensions` and click Remove.
