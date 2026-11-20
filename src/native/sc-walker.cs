// sc-walker: fast multi-threaded directory enumerator for Dustmap.
//
// Built at build time with the C# compiler that ships with Windows
// (%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe, C# 5), so the
// project needs no extra SDK. It reads directories with NtQueryDirectoryFile,
// which returns sizes, allocation sizes and timestamps for every entry in bulk
// (no per-file stat calls), and streams the raw records to stdout:
//
//   block  := u32 dirId, u32 firstSubId, u32 byteLen, byte[byteLen]
//             (byteLen bytes of FILE_FULL_DIR_INFORMATION records)
//   error  := u32 dirId, u32 0xFFFFFFFF, u32 ntstatus
//   end    := u32 0xFFFFFFFF, u32 0, u32 0
//
// Every sub-directory entry (except "." and "..") in a block receives the id
// firstSubId + k, k counting sub-directories in order of appearance.
// Directory symlinks/junctions get an id but are not descended into.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

static class Program
{
    [StructLayout(LayoutKind.Sequential)]
    struct IO_STATUS_BLOCK
    {
        public IntPtr Status;
        public IntPtr Information;
    }

    [DllImport("ntdll.dll")]
    static extern int NtQueryDirectoryFile(SafeFileHandle FileHandle, IntPtr Event, IntPtr ApcRoutine, IntPtr ApcContext,
        out IO_STATUS_BLOCK IoStatusBlock, IntPtr FileInformation, uint Length, int FileInformationClass,
        [MarshalAs(UnmanagedType.U1)] bool ReturnSingleEntry, IntPtr FileName, [MarshalAs(UnmanagedType.U1)] bool RestartScan);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);

    const uint FILE_LIST_DIRECTORY = 0x1;
    const uint SHARE_ALL = 0x7;
    const uint OPEN_EXISTING = 3;
    const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    const int FileFullDirectoryInformation = 2;
    const int BUF = 128 * 1024;

    sealed class Work
    {
        public string Path;
        public uint Id;
    }

    static readonly Stack<Work> stack = new Stack<Work>();
    static readonly object qlock = new object();
    static readonly object olock = new object();
    static int pending;
    static int nextId = 1;
    static Stream output;

    static int Main(string[] args)
    {
        if (args.Length < 1) { Console.Error.WriteLine("usage: sc-walker <dir> [threads] | sc-walker --drives"); return 2; }
        if (args[0] == "--drives") { PrintDrives(); return 0; }
        int threads = Math.Min(Environment.ProcessorCount, 12);
        if (args.Length > 1) int.TryParse(args[1], out threads);
        if (threads < 1) threads = 1;

        output = new BufferedStream(Console.OpenStandardOutput(), 1 << 20);
        Work root = new Work();
        root.Path = args[0];
        root.Id = 0;
        stack.Push(root);
        pending = 1;

        Thread[] pool = new Thread[threads];
        for (int i = 0; i < threads; i++)
        {
            pool[i] = new Thread(Worker, 256 * 1024);
            pool[i].IsBackground = true;
            pool[i].Start();
        }
        foreach (Thread t in pool) t.Join();

        WriteHeader(0xFFFFFFFF, 0, 0, null, 0);
        output.Flush();
        return 0;
    }

    /// <summary>Prints ready drives as a JSON array (much lighter than asking PowerShell/WMI).</summary>
    static void PrintDrives()
    {
        System.Text.StringBuilder sb = new System.Text.StringBuilder("[");
        bool first = true;
        foreach (DriveInfo d in DriveInfo.GetDrives())
        {
            try
            {
                if (!d.IsReady) continue;
                string item = "{\"root\":" + Json(d.Name) + ",\"label\":" + Json(d.VolumeLabel) + ",\"fs\":" + Json(d.DriveFormat) +
                              ",\"total\":" + d.TotalSize + ",\"free\":" + d.AvailableFreeSpace + ",\"type\":" + Json(d.DriveType.ToString()) + "}";
                if (!first) sb.Append(',');
                sb.Append(item);
                first = false;
            }
            catch (Exception) { }
        }
        sb.Append(']');
        Console.Out.Write(sb.ToString());
    }

    static string Json(string s)
    {
        if (s == null) return "\"\"";
        System.Text.StringBuilder sb = new System.Text.StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    static string LongPath(string p)
    {
        if (p.StartsWith(@"\\?\")) return p;
        if (p.StartsWith(@"\\")) return @"\\?\UNC\" + p.Substring(2);
        return @"\\?\" + p;
    }

    static void Worker()
    {
        IntPtr buf = Marshal.AllocHGlobal(BUF);
        byte[] managed = new byte[BUF];
        List<string> subNames = new List<string>();
        List<bool> subRecurse = new List<bool>();
        try
        {
            while (true)
            {
                Work w;
                lock (qlock)
                {
                    while (stack.Count == 0)
                    {
                        if (pending == 0) { Monitor.PulseAll(qlock); return; }
                        Monitor.Wait(qlock);
                    }
                    w = stack.Pop();
                }
                try { ReadDir(w, buf, managed, subNames, subRecurse); }
                catch (Exception) { }
                lock (qlock)
                {
                    pending--;
                    if (pending == 0 || stack.Count > 0) Monitor.PulseAll(qlock);
                }
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buf);
        }
    }

    static void ReadDir(Work w, IntPtr buf, byte[] managed, List<string> subNames, List<bool> subRecurse)
    {
        string dirPath = w.Path;
        using (SafeFileHandle h = CreateFileW(LongPath(dirPath), FILE_LIST_DIRECTORY, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero))
        {
            if (h.IsInvalid)
            {
                WriteHeader(w.Id, 0xFFFFFFFF, (uint)Marshal.GetLastWin32Error(), null, 0);
                return;
            }
            bool restart = true;
            List<Work> newWork = new List<Work>();
            while (true)
            {
                IO_STATUS_BLOCK iosb;
                int status = NtQueryDirectoryFile(h, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out iosb, buf, BUF,
                    FileFullDirectoryInformation, false, IntPtr.Zero, restart);
                restart = false;
                if (status == unchecked((int)0x80000006) || status == unchecked((int)0xC000000F)) break; // no more files
                if (status < 0)
                {
                    WriteHeader(w.Id, 0xFFFFFFFF, (uint)status, null, 0);
                    break;
                }
                int len = (int)iosb.Information.ToInt64();
                if (len <= 0) break;
                Marshal.Copy(buf, managed, 0, len);

                subNames.Clear();
                subRecurse.Clear();
                int o = 0;
                while (true)
                {
                    int next = BitConverter.ToInt32(managed, o);
                    uint attrs = BitConverter.ToUInt32(managed, o + 56);
                    int nameLen = BitConverter.ToInt32(managed, o + 60);
                    if ((attrs & 0x10) != 0)
                    {
                        bool dot = (nameLen == 2 && managed[o + 68] == '.' && managed[o + 69] == 0) ||
                                   (nameLen == 4 && managed[o + 68] == '.' && managed[o + 70] == '.' && managed[o + 69] == 0 && managed[o + 71] == 0);
                        if (!dot)
                        {
                            uint tag = BitConverter.ToUInt32(managed, o + 64);
                            bool link = (attrs & 0x400) != 0 && (tag & 0x20000000) != 0; // name-surrogate reparse point
                            subNames.Add(System.Text.Encoding.Unicode.GetString(managed, o + 68, nameLen));
                            subRecurse.Add(!link);
                        }
                    }
                    if (next == 0) break;
                    o += next;
                }

                uint first = 0;
                if (subNames.Count > 0) first = (uint)(Interlocked.Add(ref nextId, subNames.Count) - subNames.Count);
                WriteHeader(w.Id, first, (uint)len, managed, len);
                string prefix = dirPath.EndsWith("\\") ? dirPath : dirPath + "\\";
                for (int k = 0; k < subNames.Count; k++)
                {
                    if (!subRecurse[k]) continue;
                    Work nw = new Work();
                    nw.Path = prefix + subNames[k];
                    nw.Id = first + (uint)k;
                    newWork.Add(nw);
                }
            }
            if (newWork.Count > 0)
            {
                lock (qlock)
                {
                    for (int i = newWork.Count - 1; i >= 0; i--) stack.Push(newWork[i]);
                    pending += newWork.Count;
                    Monitor.PulseAll(qlock);
                }
            }
        }
    }

    static readonly byte[] header = new byte[12];

    static void WriteHeader(uint id, uint first, uint len, byte[] data, int dataLen)
    {
        lock (olock)
        {
            header[0] = (byte)id; header[1] = (byte)(id >> 8); header[2] = (byte)(id >> 16); header[3] = (byte)(id >> 24);
            header[4] = (byte)first; header[5] = (byte)(first >> 8); header[6] = (byte)(first >> 16); header[7] = (byte)(first >> 24);
            header[8] = (byte)len; header[9] = (byte)(len >> 8); header[10] = (byte)(len >> 16); header[11] = (byte)(len >> 24);
            output.Write(header, 0, 12);
            if (data != null && dataLen > 0) output.Write(data, 0, dataLen);
        }
    }
}
