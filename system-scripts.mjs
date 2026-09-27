// PowerShell helper scripts for the SKITZ PC Agent (Windows only).
// Kept in their own module so tooling can import the exact strings.

// Real now-playing via System Media Transport Controls (per-app sessions).
export const SMTC_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, Content = WindowsMedia.Control]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $t) { $m = $asTask.MakeGenericMethod($t); $task = $m.Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$mgr = Await ($mgrType::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$sessions = @($mgr.GetSessions())
$out = @()
foreach ($s in $sessions) {
  try {
    $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $pb = $s.GetPlaybackInfo()
    $out += [pscustomobject]@{
      app = [string]$s.SourceAppUserModelId
      title = [string]$props.Title
      artist = [string]$props.Artist
      status = [string]$pb.PlaybackStatus
    }
  } catch { }
}
ConvertTo-Json -Compress -InputObject @($out)
`

// Master output volume + mute via IAudioEndpointVolume COM.
export const VOLUME_SCRIPT = `
$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Runtime.InteropServices;
[Guid("5cdf2c82-841e-4546-9722-0cf74078229a"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr notify); int UnregisterControlChangeNotify(IntPtr notify);
  int GetChannelCount(out uint count);
  int SetMasterVolumeLevel(float level, Guid ctx); int SetMasterVolumeLevelScalar(float level, Guid ctx);
  int GetMasterVolumeLevel(out float level); int GetMasterVolumeLevelScalar(out float level);
  int SetChannelVolumeLevel(uint ch, float level, Guid ctx); int SetChannelVolumeLevelScalar(uint ch, float level, Guid ctx);
  int GetChannelVolumeLevel(uint ch, out float level); int GetChannelVolumeLevelScalar(uint ch, out float level);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid ctx); int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid iid, uint cls, IntPtr ptr, out IAudioEndpointVolume endpoint); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int flow, int mask, IntPtr list);
  int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
public static class Vol {
  static IAudioEndpointVolume Endpoint() {
    var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDevice dev; en.GetDefaultAudioEndpoint(0, 1, out dev);
    var iid = typeof(IAudioEndpointVolume).GUID;
    IAudioEndpointVolume ep; dev.Activate(ref iid, 1, IntPtr.Zero, out ep);
    return ep;
  }
  public static object Get() {
    var ep = Endpoint();
    float v; ep.GetMasterVolumeLevelScalar(out v);
    bool m; ep.GetMute(out m);
    return new { volume = (int)Math.Round(v * 100), mute = m };
  }
  public static object Set(double pct, int mute) {
    var ep = Endpoint();
    if (pct >= 0) ep.SetMasterVolumeLevelScalar((float)Math.Max(0, Math.Min(100, pct)) / 100, Guid.Empty);
    if (mute == 1) ep.SetMute(true, Guid.Empty);
    if (mute == 0) ep.SetMute(false, Guid.Empty);
    return Get();
  }
}
'@
Add-Type -TypeDefinition $code
`
