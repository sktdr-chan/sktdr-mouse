# scripts/dump-hid-caps.ps1 — dump HID report descriptor capabilities
# (read-only: opens each HID collection and parses HidP caps — nothing is sent
#  to the devices). Targets ROCCAT (0x1E7D) and Scyrox/Compx (0x3554).
#
# Protocol source for the read-only probe work:
#   https://github.com/FortisVoluntas/roccat-burst-pro-air-linux-tool (docs/protocol.md)

$src = @"
using System;
using System.Runtime.InteropServices;

public static class HidDump {
  [StructLayout(LayoutKind.Sequential)]
  public struct HIDP_CAPS {
    public ushort Usage;
    public ushort UsagePage;
    public ushort InputReportByteLength;
    public ushort OutputReportByteLength;
    public ushort FeatureReportByteLength;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] Reserved;
    public ushort NumberLinkCollectionNodes;
    public ushort NumberInputButtonCaps;
    public ushort NumberInputValueCaps;
    public ushort NumberInputDataIndices;
    public ushort NumberOutputButtonCaps;
    public ushort NumberOutputValueCaps;
    public ushort NumberOutputDataIndices;
    public ushort NumberFeatureButtonCaps;
    public ushort NumberFeatureValueCaps;
    public ushort NumberFeatureDataIndices;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct HIDP_VALUE_CAPS {
    public ushort UsagePage;
    public byte ReportID;
    public byte IsRange;
    public byte IsStringRange;
    public byte IsDesignatorRange;
    public byte IsAbsolute;
    public ushort BitSize;
    public ushort ReportCount;
    public ushort UsageMin;
    public ushort UsageMax;
    public ushort StringMin;
    public ushort StringMax;
    public ushort DesignatorMin;
    public ushort DesignatorMax;
    public ushort DataIndexMin;
    public ushort DataIndexMax;
  }

  [DllImport("hid.dll")] public static extern bool HidD_GetPreparsedData(IntPtr h, out IntPtr pp);
  [DllImport("hid.dll")] public static extern bool HidD_FreePreparsedData(IntPtr pp);
  [DllImport("hid.dll")] public static extern int HidP_GetCaps(IntPtr pp, ref HIDP_CAPS caps);
  [DllImport("hid.dll")] public static extern int HidP_GetValueCaps(int type, [Out] HIDP_VALUE_CAPS[] caps, ref uint count, IntPtr pp);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
}
"@
Add-Type -TypeDefinition $src -Language CSharp

$devs = node -e "const h=require('node-hid');console.log(JSON.stringify(h.devices().filter(d=>[0x1e7d,0x3554,0x373b,0x1915,0x046d,0x1532,0x25aa,0x03f0].includes(d.vendorId)).map(x=>({path:x.path,product:x.product,iface:x.interface,pid:x.productId}))))" | ConvertFrom-Json

foreach ($d in $devs) {
  $h = [HidDump]::CreateFile($d.path, [uint32]3221225472, [uint32]3, [IntPtr]::Zero, [uint32]3, [uint32]0, [IntPtr]::Zero)
  if ($h.ToInt64() -eq -1) {
    Write-Output ("[skip] open failed (access denied?) product={0} iface={1}" -f $d.product, $d.iface)
    continue
  }
  try {
    $pp = [IntPtr]::Zero
    if (-not [HidDump]::HidD_GetPreparsedData($h, [ref]$pp)) {
      Write-Output ("[skip] GetPreparsedData failed product={0} iface={1}" -f $d.product, $d.iface)
      continue
    }
    $caps = New-Object HidDump+HIDP_CAPS
    [void][HidDump]::HidP_GetCaps($pp, [ref]$caps)
    Write-Output ("")
    Write-Output ("=== product={0} pid=0x{1:x} iface={2} usagePage=0x{3:x4} usage=0x{4:x4}" -f $d.product, $d.pid, $d.iface, $caps.UsagePage, $caps.Usage)
    Write-Output ("    report byte lengths  in/out/feat: {0} / {1} / {2}" -f $caps.InputReportByteLength, $caps.OutputReportByteLength, $caps.FeatureReportByteLength)

    foreach ($t in 0, 1, 2) {
      $tname = @('Input', 'Output', 'Feature')[$t]
      $n = if ($t -eq 0) { $caps.NumberInputValueCaps } elseif ($t -eq 1) { $caps.NumberOutputValueCaps } else { $caps.NumberFeatureValueCaps }
      if ($n -le 0) {
        Write-Output ("    {0}: no value caps (buttons only or none)" -f $tname)
        continue
      }
      $arr = New-Object "HidDump+HIDP_VALUE_CAPS[]" ([int]$n)
      $cnt = [uint32]$n
      $st = [HidDump]::HidP_GetValueCaps($t, $arr, [ref]$cnt, $pp)
      Write-Output ("    {0} value caps (status={1}):" -f $tname, $st)
      $ids = @{}
      foreach ($c in $arr) {
        $key = ("0x{0:x2}" -f $c.ReportID)
        if (-not $ids.ContainsKey($key)) { $ids[$key] = New-Object System.Collections.ArrayList }
        $u = if ($c.IsRange -ne 0) { ("0x{0:x4}-0x{1:x4}" -f $c.UsageMin, $c.UsageMax) } else { ("0x{0:x4}" -f $c.UsageMin) }
        [void]$ids[$key].Add(("usagePage=0x{0:x4} usage={1} bits={2} count={3}" -f $c.UsagePage, $u, $c.BitSize, $c.ReportCount))
      }
      foreach ($k in ($ids.Keys | Sort-Object)) {
        Write-Output ("      reportID={0}" -f $k)
        foreach ($line in $ids[$k]) { Write-Output ("        {0}" -f $line) }
      }
    }
    [void][HidDump]::HidD_FreePreparsedData($pp)
  } finally {
    [void][HidDump]::CloseHandle($h)
  }
}
