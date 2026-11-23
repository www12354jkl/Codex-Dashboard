import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import type { HitRect, OverlayConfig } from "../shared/types.js";

export interface CodexWindow {
  title: string;
  focused: boolean;
  foregroundPid: number;
  minimized: boolean;
  approval: boolean;
  rect: HitRect | null;
  composerSlot?: HitRect | null;
}

export function overlayPosition(
  anchor: HitRect,
  size: Pick<HitRect, "width" | "height">,
  config: OverlayConfig,
  { composerSlot, standalone = false }: { composerSlot?: HitRect | null; standalone?: boolean } = {}
): { x: number; y: number; alignmentSource: "uia" | "dwm" | "standalone" } {
  const stripFromBottom = 22;
  const bottom = anchor.y + anchor.height;
  const slot = standalone ? null : composerSlot;
  const sidebarWidth = !standalone && anchor.width >= 960 ? 240 : 0;
  const centerX = slot ? slot.x + slot.width / 2 : anchor.x + (anchor.width + sidebarWidth) / 2;
  const centerY = slot ? slot.y + slot.height / 2 : bottom - (standalone ? stripFromBottom : 52);
  return {
    x: Math.round(centerX - size.width / 2 + config.offsetX),
    y: Math.round(centerY - (size.height - stripFromBottom) - config.offsetY),
    alignmentSource: standalone ? "standalone" : slot ? "uia" : "dwm"
  };
}

const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function powershellArgs(script: string): string[] {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Mta", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

export function configureWindowsOverlayFrame(handle: Buffer): Promise<void> {
  if (process.platform !== "win32" || (handle.length !== 4 && handle.length !== 8)) return Promise.resolve();
  const hwnd = handle.length === 8 ? handle.readBigInt64LE() : handle.readInt32LE();
  return new Promise(resolve => {
    execFile(powershell, powershellArgs(overlayFrameScript), {
      windowsHide: true,
      timeout: 5000,
      env: { ...process.env, CODEX_HUD_HWND: String(hwnd), CODEX_HUD_OWNER_PID: String(process.pid) }
    }, () => resolve());
  });
}

export class WindowsWindowTracker {
  private child?: ChildProcessWithoutNullStreams;
  private readonly listeners = new Set<(window: CodexWindow | null) => void>();
  private detectApproval = false;
  private watchdog?: ReturnType<typeof setTimeout>;
  private restartTimer?: ReturnType<typeof setTimeout>;

  onUpdate(callback: (window: CodexWindow | null) => void): () => void {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }

  start(detectApproval: boolean): void {
    if (process.platform !== "win32") return;
    const changed = this.detectApproval !== detectApproval;
    this.detectApproval = detectApproval;
    if (this.child) {
      if (changed) this.child.stdin.write(detectApproval ? "approval\n" : "bounds\n");
    } else if (!this.restartTimer) {
      this.launch();
    }
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    clearTimeout(this.watchdog);
    clearTimeout(this.restartTimer);
    this.watchdog = undefined;
    this.restartTimer = undefined;
    child?.kill();
  }

  private publish(window: CodexWindow | null): void {
    for (const listener of this.listeners) listener(window);
  }

  private launch(): void {
    const bootstrap = "& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine()))))";
    const child = spawn(powershell, powershellArgs(bootstrap), {
      windowsHide: true,
      env: { ...process.env, CODEX_HUD_DETECT_APPROVAL: this.detectApproval ? "1" : "0" }
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const failed = () => {
      if (this.child !== child) return;
      this.stop();
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        this.launch();
      }, 3000);
      this.publish(null);
    };
    child.stderr.resume();
    child.once("error", failed);
    child.once("exit", failed);
    child.stdin.on("error", failed);
    this.watchdog = setTimeout(failed, 8000);
    let streaming = false;
    lines.on("line", line => {
      if (this.child !== child) return;
      let window: CodexWindow | null;
      try {
        window = JSON.parse(line) as CodexWindow | null;
      } catch {
        return;
      }
      if (streaming) {
        this.watchdog?.refresh();
      } else {
        clearTimeout(this.watchdog);
        this.watchdog = setTimeout(failed, 5000);
        streaming = true;
      }
      this.publish(window);
    });
    // Stream the probe once to stay below the Windows command-line length limit.
    child.stdin.write(Buffer.from(probeScript, "utf8").toString("base64") + "\n");
  }
}

const overlayFrameScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class OverlayFrame {
    private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    private const int DWMWA_BORDER_COLOR = 34;
    private const uint DWMWCP_DONOTROUND = 1;
    private const uint DWMWA_COLOR_NONE = 0xFFFFFFFEu;

    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref uint value, int size);

    public static void Disable(IntPtr window, uint ownerPid) {
        uint actualPid;
        if (GetWindowThreadProcessId(window, out actualPid) == 0 || actualPid != ownerPid) return;
        uint corner = DWMWCP_DONOTROUND;
        uint border = DWMWA_COLOR_NONE;
        DwmSetWindowAttribute(window, DWMWA_WINDOW_CORNER_PREFERENCE, ref corner, sizeof(uint));
        DwmSetWindowAttribute(window, DWMWA_BORDER_COLOR, ref border, sizeof(uint));
    }
}
"@
try { [OverlayFrame]::Disable([IntPtr]::new([long]$env:CODEX_HUD_HWND), [uint32]$env:CODEX_HUD_OWNER_PID) } catch {}
`;

export const composerGapScript = String.raw`
function Find-ComposerGap($buttons, $windowCenter, $scale = 1.0) {
    $bestSlot = $null
    $bestEvidence = 0
    $bestBottom = 0
    $rowTol = [Math]::Max(28, [int][Math]::Round(28 * $scale))
    $minGap = [Math]::Max(150, [int][Math]::Round(150 * $scale))
    foreach ($rowStart in ($buttons.CenterY | Sort-Object -Unique)) {
        $row = @($buttons | Where-Object { $_.CenterY -ge $rowStart -and $_.CenterY - $rowStart -le $rowTol })
        $namedLeftEnd = [double]::NegativeInfinity
        $namedRightStart = [double]::PositiveInfinity
        foreach ($button in $row) {
            if ($button.Side -eq 'left') { $namedLeftEnd = [Math]::Max($namedLeftEnd, $button.Right) }
            if ($button.Side -eq 'right') { $namedRightStart = [Math]::Min($namedRightStart, $button.Left) }
        }
        $splitX = $windowCenter
        if (-not [double]::IsInfinity($namedLeftEnd) -and -not [double]::IsInfinity($namedRightStart) -and
            $namedLeftEnd -lt $namedRightStart) {
            $splitX = ($namedLeftEnd + $namedRightStart) / 2
        } elseif (-not [double]::IsInfinity($namedLeftEnd) -and $splitX -lt $namedLeftEnd) {
            $splitX = $namedLeftEnd
        } elseif (-not [double]::IsInfinity($namedRightStart) -and $splitX -gt $namedRightStart) {
            $splitX = $namedRightStart
        }

        $leftEnd = [double]::NegativeInfinity
        $rightStart = [double]::PositiveInfinity
        $rowTop = [double]::PositiveInfinity
        $rowBottom = [double]::NegativeInfinity
        $leftLabel = $null
        $rightLabel = $null
        foreach ($button in $row) {
            if (($button.Left + $button.Right) / 2 -lt $splitX) {
                $leftEnd = [Math]::Max($leftEnd, $button.Right)
                if ($button.Side -eq 'left' -and ($null -eq $leftLabel -or $button.Right -gt $leftLabel.Right)) {
                    $leftLabel = $button
                }
            } else {
                $rightStart = [Math]::Min($rightStart, $button.Left)
                if ($button.Side -eq 'right' -and ($null -eq $rightLabel -or $button.Left -lt $rightLabel.Left)) {
                    $rightLabel = $button
                }
            }
            $rowTop = [Math]::Min($rowTop, $button.Top)
            $rowBottom = [Math]::Max($rowBottom, $button.Bottom)
        }
        $evidence = [int]($null -ne $leftLabel) + [int]($null -ne $rightLabel)
        if ($evidence -eq 0 -or [double]::IsInfinity($leftEnd) -or [double]::IsInfinity($rightStart)) { continue }
        $leftEnd = [int][Math]::Ceiling($leftEnd)
        $rightStart = [int][Math]::Floor($rightStart)
        if ($rightStart - $leftEnd -lt $minGap) { continue }
        if ($evidence -lt $bestEvidence -or ($evidence -eq $bestEvidence -and $rowBottom -le $bestBottom)) { continue }

        $bestEvidence = $evidence
        $bestBottom = $rowBottom
        $centerY = if ($evidence -eq 2) { ($leftLabel.CenterY + $rightLabel.CenterY) / 2 }
            elseif ($null -ne $leftLabel) { $leftLabel.CenterY } else { $rightLabel.CenterY }
        $height = [int][Math]::Ceiling($rowBottom - $rowTop)
        $top = [int][Math]::Round($centerY - 2 - $height / 2)
        $bestSlot = @{ x = $leftEnd; y = $top; width = $rightStart - $leftEnd; height = $height }
    }
    return $bestSlot
}
`;

const probeScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class CodexWindows {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    private delegate bool WindowCallback(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool QueryFullProcessImageName(IntPtr proc, uint flags, StringBuilder text, ref uint size);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flag);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int length);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out RECT rect, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    private static extern int GetDwmInt(IntPtr window, int attribute, out int value, int size);

    public static void EnablePerMonitorDpi() {
        // PowerShell's process default may already have been set by its host.
        if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) {
            SetThreadDpiAwarenessContext(new IntPtr(-4));
        }
    }

    public static string Title(IntPtr window) {
        var text = new StringBuilder(512);
        GetWindowText(window, text, text.Capacity);
        return text.ToString();
    }

    public static uint Pid(IntPtr window) {
        uint pid;
        GetWindowThreadProcessId(window, out pid);
        return pid;
    }

    private static string ImagePath(uint pid) {
        IntPtr proc = OpenProcess(0x1000u, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (proc == IntPtr.Zero) return "";
        try {
            var buf = new StringBuilder(1024);
            uint size = (uint)buf.Capacity;
            return QueryFullProcessImageName(proc, 0, buf, ref size) ? buf.ToString() : "";
        } finally {
            CloseHandle(proc);
        }
    }

    private static bool IsCodex(IntPtr window) {
        if (!IsWindowVisible(window)) return false;
        int cloaked;
        if (GetDwmInt(window, 14, out cloaked, 4) == 0 && cloaked != 0) return false;
        string title = Title(window);
        if (title.Length == 0) return false;
        uint pid = Pid(window);
        string image = ImagePath(pid);
        if (image.Length > 0) {
            string lower = image.ToLowerInvariant();
            // Windows Store / MSIX Codex Desktop runs as WindowsApps\OpenAI.Codex_*\app\ChatGPT.exe
            // even when the window title is the active thread's title.
            if (lower.Contains("\\openai.codex_") || lower.Contains("/openai.codex_")) return true;
        }
        try {
            using (var process = Process.GetProcessById((int)pid)) {
                string name = process.ProcessName.ToLowerInvariant();
                return name == "codex" || name == "codexdesktop" || name == "codex desktop"
                    || (name == "chatgpt" && System.Text.RegularExpressions.Regex.IsMatch(title,
                        @"(^Codex\b|\bCodex$)", System.Text.RegularExpressions.RegexOptions.IgnoreCase));
            }
        } catch (ArgumentException) {
            return false;
        } catch (InvalidOperationException) {
            return false;
        } catch (System.ComponentModel.Win32Exception) {
            return false;
        }
    }

    public static IntPtr Root(IntPtr window) {
        IntPtr root = GetAncestor(window, 3); // GA_ROOTOWNER
        return root == IntPtr.Zero ? window : root;
    }

    public static IntPtr Find(IntPtr foreground, IntPtr previous) {
        IntPtr root = Root(foreground);
        if (IsCodex(root)) return root;
        if (IsCodex(previous) && !IsIconic(previous)) return previous;
        IntPtr result = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr data) {
            if (GetWindow(window, 4) != IntPtr.Zero || !IsCodex(window)) return true;
            result = window;
            return IsIconic(window);
        }, IntPtr.Zero);
        return result;
    }

    public static bool TryBounds(IntPtr window, out RECT rect) {
        return DwmGetWindowAttribute(window, 9, out rect, Marshal.SizeOf(typeof(RECT))) == 0
            && rect.Right > rect.Left && rect.Bottom > rect.Top;
    }

    public static bool HasNativeDialog(IntPtr root) {
        bool found = false;
        EnumWindows(delegate(IntPtr window, IntPtr data) {
            if (window == root || !IsWindowVisible(window) || Root(window) != root) return true;
            var className = new StringBuilder(64);
            GetClassName(window, className, className.Capacity);
            found = !IsWindowEnabled(root) || className.ToString() == "#32770";
            return !found;
        }, IntPtr.Zero);
        return found;
    }
}

[Flags]
public enum WindowSignal {
    None = 0, Location = 1, Foreground = 2, MoveStarted = 4, MoveEnded = 8, Visibility = 16,
    Heartbeat = 32, Settled = 64, Inspection = 128, Configuration = 256, Stopped = 512
}

public sealed class WindowEvents : IDisposable {
    private const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    private const uint EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
    private const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    private const uint EVENT_SYSTEM_MOVESIZESTART = 0x000A;
    private const uint EVENT_SYSTEM_MOVESIZEEND = 0x000B;
    private const uint EVENT_SYSTEM_MINIMIZESTART = 0x0016;
    private const uint EVENT_SYSTEM_MINIMIZEEND = 0x0017;
    private const uint WM_TIMER = 0x0113;
    private const uint WM_SIGNAL = 0x8001;

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG {
        public IntPtr Window;
        public uint Message;
        public UIntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public int X, Y;
    }

    private delegate void WinEventCallback(IntPtr hook, uint kind, IntPtr window, int objectId,
        int childId, uint eventThread, uint time);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWinEventHook(uint first, uint last, IntPtr module, WinEventCallback callback,
        uint process, uint thread, uint flags);
    [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out MSG message, IntPtr window, uint first, uint last, uint remove);
    [DllImport("user32.dll")] private static extern int GetMessage(out MSG message, IntPtr window, uint first, uint last);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref MSG message);
    [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint thread, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern UIntPtr SetTimer(IntPtr window, UIntPtr id, uint interval, IntPtr callback);
    [DllImport("user32.dll")] private static extern bool KillTimer(IntPtr window, UIntPtr id);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();

    private readonly uint thread = GetCurrentThreadId();
    private readonly WinEventCallback callback;
    private IntPtr foregroundHook, moveHook, minimizeHook, locationHook, target;
    private UIntPtr frameTimer, heartbeatTimer, settleTimer;
    private long settleDeadline;
    private WindowSignal pending;
    private volatile bool moving;
    private volatile bool detectApproval;
    public bool Moving { get { return moving; } }
    public bool DetectApproval { get { return detectApproval; } }

    public WindowEvents(bool initialApproval) {
        detectApproval = initialApproval;
        callback = OnWinEvent;
        MSG message;
        PeekMessage(out message, IntPtr.Zero, 0, 0, 0); // Create this thread's message queue.
        try {
            foregroundHook = Hook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, 0);
            moveHook = Hook(EVENT_SYSTEM_MOVESIZESTART, EVENT_SYSTEM_MOVESIZEEND, 0);
            minimizeHook = Hook(EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND, 0);
            heartbeatTimer = StartTimer(1000);
            new Thread(ReadCommands) { IsBackground = true }.Start();
        } catch {
            Dispose();
            throw;
        }
    }

    private IntPtr Hook(uint first, uint last, uint process) {
        IntPtr hook = SetWinEventHook(first, last, IntPtr.Zero, callback, process, 0, WINEVENT_OUTOFCONTEXT);
        if (hook == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        return hook;
    }

    public void Track(IntPtr window) {
        if (target == window) return;
        if (locationHook != IntPtr.Zero) UnhookWinEvent(locationHook);
        Interlocked.Exchange(ref target, window);
        moving = false;
        uint pid = CodexWindows.Pid(window);
        locationHook = pid == 0 ? IntPtr.Zero : Hook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, pid);
        CancelTimer(ref settleTimer);
    }

    private void OnWinEvent(IntPtr hook, uint kind, IntPtr window, int objectId, int childId, uint eventThread, uint time) {
        if (kind == EVENT_SYSTEM_FOREGROUND) {
            pending |= WindowSignal.Foreground;
        } else {
            if (window == IntPtr.Zero || window != target) return;
            switch (kind) {
                case EVENT_OBJECT_LOCATIONCHANGE:
                    if (objectId != 0 || childId != 0) return; // OBJID_WINDOW / CHILDID_SELF
                    pending |= WindowSignal.Location;
                    break;
                case EVENT_SYSTEM_MOVESIZESTART: moving = true; pending |= WindowSignal.MoveStarted; break;
                case EVENT_SYSTEM_MOVESIZEEND: moving = false; pending |= WindowSignal.MoveEnded; break;
                case EVENT_SYSTEM_MINIMIZESTART:
                case EVENT_SYSTEM_MINIMIZEEND: moving = false; pending |= WindowSignal.Visibility; break;
            }
        }
        if (frameTimer == UIntPtr.Zero) frameTimer = SetTimer(IntPtr.Zero, UIntPtr.Zero, 16, IntPtr.Zero);
    }

    private static UIntPtr StartTimer(uint interval) {
        UIntPtr timer = SetTimer(IntPtr.Zero, UIntPtr.Zero, interval, IntPtr.Zero);
        if (timer == UIntPtr.Zero) throw new InvalidOperationException("Could not start window tracking timer.");
        return timer;
    }

    private static void CancelTimer(ref UIntPtr timer) {
        if (timer != UIntPtr.Zero) KillTimer(IntPtr.Zero, timer);
        timer = UIntPtr.Zero;
    }

    public void SettleAfterQuiet() {
        CancelTimer(ref settleTimer);
        settleDeadline = Stopwatch.GetTimestamp() + Stopwatch.Frequency * 150 / 1000;
        settleTimer = StartTimer(150);
    }

    public bool CanInspect(IntPtr window, CodexWindows.RECT expected) {
        CodexWindows.RECT current;
        return !moving && Interlocked.CompareExchange(ref target, IntPtr.Zero, IntPtr.Zero) == window
            && !CodexWindows.IsIconic(window) && CodexWindows.TryBounds(window, out current)
            && current.Left == expected.Left && current.Top == expected.Top
            && current.Right == expected.Right && current.Bottom == expected.Bottom;
    }

    public void WatchInspection(IAsyncResult inspection) {
        ThreadPool.RegisterWaitForSingleObject(inspection.AsyncWaitHandle,
            delegate { Post(WindowSignal.Inspection); }, null, Timeout.Infinite, true);
    }

    private void Post(WindowSignal signal) {
        PostThreadMessage(thread, WM_SIGNAL, new UIntPtr((uint)signal), IntPtr.Zero);
    }

    private void ReadCommands() {
        try {
            string command;
            while ((command = Console.ReadLine()) != null) {
                detectApproval = command == "approval";
                Post(WindowSignal.Configuration);
            }
        } finally {
            Post(WindowSignal.Stopped);
        }
    }

    public WindowSignal Next() {
        MSG message;
        while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) {
            if (message.Message == WM_SIGNAL && message.Window == IntPtr.Zero) {
                return (WindowSignal)message.WParam.ToUInt32();
            }
            if (message.Message == WM_TIMER && message.Window == IntPtr.Zero) {
                if (message.WParam == frameTimer) {
                    if (pending == WindowSignal.None) {
                        if (!moving) CancelTimer(ref frameTimer);
                        continue;
                    }
                    WindowSignal ready = pending;
                    pending = WindowSignal.None;
                    return ready;
                }
                if (message.WParam == heartbeatTimer) return WindowSignal.Heartbeat;
                if (message.WParam == settleTimer) {
                    CancelTimer(ref settleTimer);
                    long remaining = settleDeadline - Stopwatch.GetTimestamp();
                    if (remaining <= 0) return WindowSignal.Settled;
                    settleTimer = StartTimer((uint)Math.Ceiling(remaining * 1000.0 / Stopwatch.Frequency));
                }
            }
            DispatchMessage(ref message);
        }
        return WindowSignal.Stopped;
    }

    public void Dispose() {
        foreach (IntPtr hook in new[] { foregroundHook, moveHook, minimizeHook, locationHook }) {
            if (hook != IntPtr.Zero) UnhookWinEvent(hook);
        }
        CancelTimer(ref frameTimer);
        CancelTimer(ref heartbeatTimer);
        CancelTimer(ref settleTimer);
    }
}
"@
try { [CodexWindows]::EnablePerMonitorDpi() } catch {}

function Test-Approval($window) {
    if ([CodexWindows]::HasNativeDialog($window)) { return $true }
    if (-not $uiaAvailable) { return $false }
    try {
        $element = [System.Windows.Automation.AutomationElement]::FromHandle($window)
        $type = [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Button)
        $labels = @('Allow once', 'Allow for this session', 'Always allow', 'Approve once',
            'Approve for this session', 'Allow this time', 'Allow and continue', 'Yes, proceed', "Yes, and don't ask again",
            (-join [char[]](0x5141, 0x8BB8, 0x4E00, 0x6B21)),
            (-join [char[]](0x5141, 0x8A31, 0x4E00, 0x6B21)))
        $names = [System.Windows.Automation.Condition[]]@(
            foreach ($label in $labels) {
                [System.Windows.Automation.PropertyCondition]::new(
                    [System.Windows.Automation.AutomationElement]::NameProperty, $label,
                    [System.Windows.Automation.PropertyConditionFlags]::IgnoreCase)
            }
        )
        $condition = [System.Windows.Automation.AndCondition]::new(
            $type, [System.Windows.Automation.OrCondition]::new($names))
        $matches = $element.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
        foreach ($button in $matches) {
            if (-not $button.Current.IsOffscreen -and $button.Current.IsEnabled) { return $true }
        }
    } catch {}
    return $false
}

${composerGapScript}

function Get-ComposerSlot($window, $bounds) {
    if (-not $uiaAvailable) { return $null }
    try {
        $element = [System.Windows.Automation.AutomationElement]::FromHandle($window)
        $types = [System.Windows.Automation.Condition[]]@(
            foreach ($kind in @([System.Windows.Automation.ControlType]::Button,
                [System.Windows.Automation.ControlType]::SplitButton, [System.Windows.Automation.ControlType]::ComboBox)) {
                [System.Windows.Automation.PropertyCondition]::new(
                    [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $kind)
            }
        )
        $onScreen = [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::IsOffscreenProperty, $false)
        $condition = [System.Windows.Automation.AndCondition]::new(
            [System.Windows.Automation.OrCondition]::new($types), $onScreen)
        $cache = [System.Windows.Automation.CacheRequest]::new()
        $cache.Add([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty)
        $cache.Add([System.Windows.Automation.AutomationElement]::NameProperty)
        $cache.Add([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
        $cache.Push()
        try {
            $controls = $element.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
        } finally {
            $cache.Pop()
        }

        $dpi = 96
        try { $d = [CodexWindows]::GetDpiForWindow($window); if ($d -ge 96) { $dpi = $d } } catch {}
        $scale = $dpi / 96.0
        $windowCenter = ($bounds.Left + $bounds.Right) / 2
        $bandTop = [Math]::Max($bounds.Top, $bounds.Bottom - [int][Math]::Round(220 * $scale))
        $buttons = @(foreach ($control in $controls) {
            $cached = $control.Cached
            $rect = $cached.BoundingRectangle
            if ($rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) { continue }
            $centerY = $rect.Top + $rect.Height / 2
            if ($centerY -lt $bandTop -or $rect.Bottom -gt $bounds.Bottom -or
                $rect.Left -lt $bounds.Left -or $rect.Right -gt $bounds.Right) { continue }

            $side = $null
            if ($cached.Name -match '\b(?:Full\s+access|Agent|Auto|Attach)\b|^\s*\+\s*$|\u5B8C\u5168(?:\u8BBF\u95EE|\u5B58\u53D6)|\u6DFB\u52A0|\u65B0\u589E') {
                $side = 'left'
            } elseif ($cached.Name -match '\b(?:GPT|Sol(?=\b|[-\d])|o[34]\b)|\b(?:Model|Voice|Mic|Microphone)\b|\u6A21\u578B|\u8BED\u97F3|\u8A9E\u97F3|\u9EA6\u514B\u98CE|\u9EA5\u514B\u98A8' -or
                ($cached.ControlType -eq [System.Windows.Automation.ControlType]::ComboBox -and $rect.Left -ge $windowCenter)) {
                $side = 'right'
            }
            [pscustomobject]@{ Left = $rect.Left; Right = $rect.Right; Top = $rect.Top; Bottom = $rect.Bottom; CenterY = $centerY; Side = $side }
        })
        return Find-ComposerGap $buttons $windowCenter $scale
    } catch { return $null }
}

$state = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
foreach ($name in @('Test-Approval', 'Find-ComposerGap', 'Get-ComposerSlot')) {
    $definition = (Get-Command $name -CommandType Function).Definition
    $state.Commands.Add([System.Management.Automation.Runspaces.SessionStateFunctionEntry]::new($name, $definition))
}
$runspace = [runspacefactory]::CreateRunspace($state)
$runspace.ApartmentState = 'MTA'
$runspace.ThreadOptions = 'ReuseThread'
$runspace.Open()
$worker = [powershell]::Create()
$worker.Runspace = $runspace
$inspect = @'
param($events, $window, $bounds, $findSlot, $detectApproval)
if ($null -eq $global:uiaAvailable) {
    try { [CodexWindows]::EnablePerMonitorDpi() } catch {}
    $global:uiaAvailable = $true
    try { Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes -ErrorAction Stop } catch { $global:uiaAvailable = $false }
}
$slot = $null
$approval = $null
if ($findSlot -and $events.CanInspect($window, $bounds)) { $slot = Get-ComposerSlot $window $bounds }
if ($detectApproval -and $events.DetectApproval -and $events.CanInspect($window, $bounds)) {
    $approval = Test-Approval $window
}
@{ current = $events.CanInspect($window, $bounds); slot = $slot; approval = $approval }
'@

$events = [WindowEvents]::new($env:CODEX_HUD_DETECT_APPROVAL -eq '1')
$signals = [WindowSignal]::Heartbeat
$window = [IntPtr]::Zero
$title = ''
$rect = $null
$dpi = 0
$composerSlot = $null
$slotRect = $null
$slotAge = [System.Diagnostics.Stopwatch]::new()
$approval = $false
$detectApproval = $events.DetectApproval
$slotDirty = $true
$approvalDirty = $detectApproval
$settling = $false
$revision = 0
$inspection = $null
$inspectionFailed = $false
$lastPublished = ''

try {
    while ($signals -ne [WindowSignal]::Stopped) {
        $heartbeat = $signals.HasFlag([WindowSignal]::Heartbeat)
        if ($heartbeat) { $inspectionFailed = $false }
        $foregroundChanged = $signals.HasFlag([WindowSignal]::Foreground)
        $moveEnded = $signals.HasFlag([WindowSignal]::MoveEnded)
        if ($moveEnded -or $signals.HasFlag([WindowSignal]::Settled)) { $settling = $false }
        if ($signals.HasFlag([WindowSignal]::MoveStarted)) { $revision++ }

        $foreground = [CodexWindows]::GetForegroundWindow()
        if ($foregroundChanged -or ($heartbeat -and (-not $events.Moving -or -not [CodexWindows]::IsWindow($window)))) {
            $nextWindow = [CodexWindows]::Find($foreground, $window)
            if ($nextWindow -ne $window) {
                $window = $nextWindow
                $events.Track($window)
                $revision++
                $rect = $null
                $composerSlot = $null
                $slotRect = $null
                $approval = $false
                $settling = $false
                $slotDirty = $true
                $approvalDirty = $detectApproval
            }
            $title = [CodexWindows]::Title($window)
        }

        if ($detectApproval -ne $events.DetectApproval) {
            $detectApproval = $events.DetectApproval
            $approvalDirty = $detectApproval
            $approval = $false
        }

        $result = $null
        $bounds = [CodexWindows+RECT]::new()
        $nextRect = $null
        $minimized = $window -ne [IntPtr]::Zero -and [CodexWindows]::IsIconic($window)
        if ($window -ne [IntPtr]::Zero -and -not $minimized -and [CodexWindows]::TryBounds($window, [ref]$bounds)) {
            $nextRect = @{
                x = $bounds.Left; y = $bounds.Top
                width = $bounds.Right - $bounds.Left; height = $bounds.Bottom - $bounds.Top
            }
            $nextDpi = 96
            try { $nextDpi = [CodexWindows]::GetDpiForWindow($window) } catch {}
            $layoutChanged = $null -eq $rect -or $nextRect.width -ne $rect.width -or
                $nextRect.height -ne $rect.height -or $nextDpi -ne $dpi
            if ($layoutChanged -or $nextRect.x -ne $rect.x -or $nextRect.y -ne $rect.y) {
                $revision++
                if ($null -ne $rect -and -not $moveEnded) {
                    $settling = $true
                    if (-not $events.Moving) { $events.SettleAfterQuiet() }
                }
                if ($layoutChanged) {
                    $slotDirty = $true
                    $approvalDirty = $detectApproval
                }
            }
            $dpi = $nextDpi
        } elseif ($null -ne $rect) {
            $revision++
            $settling = $false
        }
        $rect = $nextRect
        $canInspect = $null -ne $rect -and -not $events.Moving -and -not $settling

        if ($null -ne $inspection -and $inspection.IsCompleted) {
            try {
                $measurement = $worker.EndInvoke($inspection)[0]
                if ($canInspect -and $revision -eq $inspectionRevision -and $measurement.current) {
                    if ($inspectionSlot) {
                        $composerSlot = $measurement.slot
                        $slotRect = $rect
                        $slotDirty = $false
                        $slotAge.Restart()
                    }
                    if ($inspectionApproval -and $detectApproval -and $null -ne $measurement.approval) {
                        $approval = $measurement.approval
                        $approvalDirty = $false
                    }
                }
            } catch {
                # Retry on the next heartbeat instead of spinning on a failed invocation.
                $inspectionFailed = $true
            } finally {
                $worker.Commands.Clear()
                $inspection = $null
            }
        }

        if ($window -ne [IntPtr]::Zero) {
            $focused = [CodexWindows]::Root($foreground) -eq $window
            $dialog = $detectApproval -and $focused -and $foreground -ne $window -and
                [CodexWindows]::Title($foreground) -match 'approv|permission|confirm|allow|authorize|\u5BA1\u6279|\u6B0A\u9650|\u6743\u9650'
            $positionedSlot = $null
            if ($null -ne $composerSlot -and $null -ne $rect) {
                # Translation keeps the measured slot. Resize estimates its center from the bottom edge and width delta.
                $positionedSlot = @{
                    x = $composerSlot.x + ($rect.x - $slotRect.x) + [int][Math]::Round(($rect.width - $slotRect.width) / 2)
                    y = $composerSlot.y + ($rect.y - $slotRect.y) + ($rect.height - $slotRect.height)
                    width = $composerSlot.width; height = $composerSlot.height
                }
            }
            $result = [ordered]@{
                title = $title; focused = $focused; foregroundPid = [CodexWindows]::Pid($foreground)
                minimized = $minimized; approval = $detectApproval -and ($approval -or $dialog)
                rect = $rect; composerSlot = $positionedSlot
            }
        }
        $json = if ($null -eq $result) { 'null' } else { ConvertTo-Json -InputObject $result -Compress -Depth 3 }
        if ($heartbeat -or $json -ne $lastPublished) {
            [Console]::WriteLine($json)
            $lastPublished = $json
        }

        # Heartbeats refresh stationary windows. Geometry frames never dispatch a traversal during an interaction.
        if ($heartbeat -and $canInspect) {
            $approvalDirty = $detectApproval
            $slotDirty = $slotDirty -or $slotAge.ElapsedMilliseconds -ge 1500
        }
        if ($canInspect -and $null -eq $inspection -and -not $inspectionFailed -and ($slotDirty -or $approvalDirty)) {
            $inspectionRevision = $revision
            $inspectionSlot = $slotDirty
            $inspectionApproval = $approvalDirty
            $null = $worker.AddScript($inspect).AddArgument($events).AddArgument($window).AddArgument($bounds)
            $null = $worker.AddArgument($inspectionSlot).AddArgument($inspectionApproval)
            $inspection = $worker.BeginInvoke()
            $events.WatchInspection($inspection)
        }
        $signals = $events.Next()
    }
} finally {
    $events.Dispose()
    if ($null -eq $inspection -or $inspection.IsCompleted) {
        $worker.Dispose()
        $runspace.Dispose()
    }
}
`;

